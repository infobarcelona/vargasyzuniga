const { leerCorreosNuevos } = require('./gmailImapWatcher');
const { extraerZoom, extraerFechaAgenda, esRelevante, extraerHoraAudiencia, extraerLugarAudiencia } = require('./emailBodyParser');
const { parsearAgenda, filtrarPorAbogados, parsearRecordatorio } = require('./excelParser');
const { crearEventoGenerico } = require('./googleCalendar');
const { getAudienciasProcesadasCollection } = require('./db');

const NOMBRES_ABOGADOS = (process.env.NOMBRES_ABOGADOS || '')
  .split('|')
  .map((s) => s.trim())
  .filter(Boolean);

async function yaProcesado(messageId) {
  const col = getAudienciasProcesadasCollection();
  const existe = await col.findOne({ messageId });
  return !!existe;
}

async function marcarProcesado(messageId, detalle) {
  const col = getAudienciasProcesadasCollection();
  await col.updateOne(
    { messageId },
    { $set: { messageId, ...detalle, procesadoEn: new Date() } },
    { upsert: true }
  );
}

/**
 * Corre un ciclo completo: revisa la bandeja, procesa los correos relevantes
 * nuevos, crea los eventos que correspondan. Devuelve un resumen para logging.
 */
async function correrCicloWatcher() {
  if (NOMBRES_ABOGADOS.length === 0) {
    throw new Error('NOMBRES_ABOGADOS no esta configurado en el .env (separa los nombres con "|").');
  }

  const correos = await leerCorreosNuevos({ yaProcesado, diasHaciaAtras: 7 });
  const resumen = { correosRevisados: correos.length, eventosCreados: 0, errores: [] };

  for (const correo of correos) {
    const cuerpoCompleto = correo.textBody || correo.htmlBody || '';

    if (!esRelevante(correo.from, correo.subject, cuerpoCompleto)) {
      // No es una notificacion de audiencia real, no la volvemos a revisar.
      await marcarProcesado(correo.messageId, { relevante: false, subject: correo.subject });
      continue;
    }

    const zoom = extraerZoom(cuerpoCompleto);
    const fechaAgenda = extraerFechaAgenda(correo.subject) || extraerFechaAgenda(cuerpoCompleto);

    if (!fechaAgenda) {
      // Sin fecha: usar fecha y hora de recepción del correo
      const fechaRecepcion = correo.date ? new Date(correo.date) : new Date();
      const dia = String(fechaRecepcion.getDate()).padStart(2, '0');
      const mes = String(fechaRecepcion.getMonth() + 1).padStart(2, '0');
      const anio = fechaRecepcion.getFullYear();
      const horaRec = String(fechaRecepcion.getHours()).padStart(2, '0');
      const minRec = String(fechaRecepcion.getMinutes()).padStart(2, '0');
      const fechaAgendaFallback = `${dia}/${mes}/${anio}`;
      const horaFallback = `${horaRec}:${minRec}`;
      console.log(`[PJUD] Sin fecha en texto para "${correo.subject}", usando fecha/hora de recepción: ${fechaAgendaFallback} ${horaFallback}`);
      const titulo = correo.subject || 'Audiencia PJUD';
      const descripcion = `📅 Fecha y hora tomadas del momento de recepción del correo.\n\nZoom: ${zoom.link || 'No disponible'}\nID de reunión: ${zoom.meetingId || 'N/A'}\nCódigo de acceso: ${zoom.codigoAcceso || 'N/A'}\n\nCuerpo del correo:\n${cuerpoCompleto.slice(0, 500)}`;
      const resultado = await crearEventoGenerico({
        titulo,
        descripcion,
        fechaStr: fechaAgendaFallback,
        horaStr: horaFallback,
        duracionMinutos: 60
      });
      if (resultado.ok) {
        resumen.eventosCreados += 1;
      } else {
        resumen.errores.push(`No se pudo crear evento para "${correo.subject}": ${resultado.error}`);
      }
      await marcarProcesado(correo.messageId, { relevante: true, sinFecha: true, eventoCreado: resultado.ok, subject: correo.subject });
      continue;
    }

    // Si no hay adjunto, crear evento generico con datos del cuerpo del correo
    if (correo.attachments.length === 0) {
      const titulo = correo.subject || 'Audiencia PJUD';
      const horaExtraida = extraerHoraAudiencia(cuerpoCompleto) || extraerHoraAudiencia(correo.subject) || '09:00';
      const lugarExtraido = extraerLugarAudiencia(cuerpoCompleto);
      const descripcion = `Notificación del PJUD\nFecha: ${fechaAgenda}\nHora: ${horaExtraida}\n${lugarExtraido ? 'Lugar: ' + lugarExtraido + '\n' : ''}\nZoom: ${zoom.link || 'No disponible'}\nID de reunión: ${zoom.meetingId || 'N/A'}\nCódigo de acceso: ${zoom.codigoAcceso || 'N/A'}\n\nCuerpo del correo:\n${cuerpoCompleto.slice(0, 1000)}`;
      const resultado = await crearEventoGenerico({
        titulo,
        descripcion,
        fechaStr: fechaAgenda,
        horaStr: horaExtraida,
        duracionMinutos: 60
      });
      if (resultado.ok) {
        resumen.eventosCreados += 1;
      } else {
        resumen.errores.push(`No se pudo crear evento para "${correo.subject}": ${resultado.error}`);
      }
      await marcarProcesado(correo.messageId, { relevante: true, sinAdjunto: true, eventoCreado: resultado.ok, subject: correo.subject });
      continue;
    }

    // Detectar si es Recordatorio de Audiencias (formato diferente)
    const esRecordatorio = /recordatorio de audiencias/i.test(correo.subject);

    if (esRecordatorio) {
      try {
        const audiencias = parsearRecordatorio(correo.attachments[0].content);
        console.log(`[PJUD] Recordatorio: ${audiencias.length} audiencias encontradas en Excel`);
        for (const a of audiencias) {
          if (!a.fecha) continue;
          const titulo = `${a.rit} — ${a.tipo} (${a.competencia})`;
          const descripcion = `Recordatorio semanal PJUD\nFecha: ${a.fecha}\nHora: ${a.hora || 'N/A'}\nTribunal: ${a.tribunal}\nSala: ${a.sala}\nCaratulado: ${a.caratulado}`;
          const resultado = await crearEventoGenerico({
            titulo,
            descripcion,
            fechaStr: a.fecha,
            horaStr: a.hora || '09:00',
            duracionMinutos: 60
          });
          if (resultado.ok) {
            resumen.eventosCreados += 1;
          } else {
            resumen.errores.push(`Error creando evento para ${a.rit}: ${resultado.error}`);
          }
        }
        await marcarProcesado(correo.messageId, { relevante: true, esRecordatorio: true, subject: correo.subject });
        continue;
      } catch (err) {
        resumen.errores.push(`Error leyendo Recordatorio "${correo.subject}": ${err.message}`);
        await marcarProcesado(correo.messageId, { relevante: true, errorExcel: err.message, subject: correo.subject });
        continue;
      }
    }

    let coincidencias = [];
    try {
      const bloques = parsearAgenda(correo.attachments[0].content);
      coincidencias = filtrarPorAbogados(bloques, NOMBRES_ABOGADOS);
    } catch (err) {
      resumen.errores.push(`Error leyendo el Excel de "${correo.subject}": ${err.message}`);
      await marcarProcesado(correo.messageId, { relevante: true, errorExcel: err.message, subject: correo.subject });
      continue;
    }

    const eventosDeEsteCorreo = [];
    for (const c of coincidencias) {
      const titulo = `RIT ${c.rit}-${c.anio} — ${c.audiencia}`;
      const descripcion = `Abogado: ${c.abogadoEncontrado}\nDelito: ${c.delito}\nFecha: ${fechaAgenda}\n\nZoom: ${zoom.link || 'No disponible'}\nID de reunión: ${zoom.meetingId || 'N/A'}\nCódigo de acceso: ${zoom.codigoAcceso || 'N/A'}`;

      const resultado = await crearEventoGenerico({
        titulo,
        descripcion,
        fechaStr: fechaAgenda,
        horaStr: c.hora,
        duracionMinutos: 60
      });

      if (resultado.ok) {
        resumen.eventosCreados += 1;
        eventosDeEsteCorreo.push({ rit: c.rit, abogado: c.abogadoEncontrado, eventLink: resultado.eventLink });
      } else {
        resumen.errores.push(`No se pudo crear el evento para RIT ${c.rit}: ${resultado.error}`);
      }
    }

    await marcarProcesado(correo.messageId, {
      relevante: true,
      subject: correo.subject,
      fechaAgenda,
      coincidenciasEncontradas: coincidencias.length,
      eventosCreados: eventosDeEsteCorreo
    });
  }

  return resumen;
}

module.exports = { correrCicloWatcher };
