const { leerCorreosNuevos } = require('./gmailImapWatcher');
const { extraerZoom, extraerFechaAgenda, esRelevante } = require('./emailBodyParser');
const { parsearAgenda, filtrarPorAbogados } = require('./excelParser');
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
      // Sin fecha: crear evento de todas formas con fecha pendiente
      console.log(`[PJUD] Sin fecha para "${correo.subject}", creando evento sin fecha definida.`);
      const titulo = correo.subject || 'Audiencia PJUD';
      const descripcion = `⚠️ FECHA PENDIENTE — El correo no incluía fecha de audiencia.\n\nZoom: ${zoom.link || 'No disponible'}\nID de reunión: ${zoom.meetingId || 'N/A'}\nCódigo de acceso: ${zoom.codigoAcceso || 'N/A'}\n\nCuerpo del correo:\n${cuerpoCompleto.slice(0, 500)}`;
      const resultado = await crearEventoGenerico({
        titulo,
        descripcion,
        fechaStr: new Date().toLocaleDateString('es-CL'),
        horaStr: '09:00',
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
      const descripcion = `Notificación del PJUD\nFecha: ${fechaAgenda}\n\nZoom: ${zoom.link || 'No disponible'}\nID de reunión: ${zoom.meetingId || 'N/A'}\nCódigo de acceso: ${zoom.codigoAcceso || 'N/A'}\n\nCuerpo del correo:\n${cuerpoCompleto.slice(0, 1000)}`;
      const resultado = await crearEventoGenerico({
        titulo,
        descripcion,
        fechaStr: fechaAgenda,
        horaStr: '09:00',
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
