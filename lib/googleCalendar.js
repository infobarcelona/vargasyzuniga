const { google } = require('googleapis');

// NOTA IMPORTANTE: Google Calendar ignora silenciosamente las alertas
// personalizadas (reminders.overrides) cuando quien crea el evento es
// una cuenta de servicio con permiso de "escritor" sobre un calendario
// que no le pertenece — no da error, simplemente aplica el valor por
// defecto del calendario en su lugar. Por eso, en vez de pelear con eso,
// le decimos que use el default — y ese default hay que configurarlo
// directamente en Google Calendar (Configuracion del calendario >
// Notificaciones de eventos) con las 3 alertas deseadas: 1 dia, 2 horas
// y 15 minutos antes. Asi cualquier evento que se cree ahi las hereda
// automaticamente, sin depender de la API.
const RECORDATORIOS_ESTANDAR = { useDefault: true };

function getAuth() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw || raw.includes('PEGA_AQUI')) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON no esta configurado en el .env');
  }
  let credentials;
  try {
    credentials = JSON.parse(raw);
  } catch (e) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON no es un JSON valido: ' + e.message);
  }
  return new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/calendar']
  });
}

function parseFechaHora(fechaStr, horaStr) {
  // fechaStr: DD/MM/YYYY, horaStr: HH:MM
  const [dia, mes, anio] = fechaStr.split('/').map(Number);
  const [hora, minuto] = (horaStr || '00:00').split(':').map(Number);
  if (!dia || !mes || !anio || isNaN(hora)) {
    throw new Error(`Fecha/hora invalida: fecha="${fechaStr}" hora="${horaStr}"`);
  }
  return { dia, mes, anio, hora, minuto: minuto || 0 };
}

function formatearISO(anio, mes, dia, hora, minuto) {
  const p = (n) => String(n).padStart(2, '0');
  return `${anio}-${p(mes)}-${p(dia)}T${p(hora)}:${p(minuto)}:00`;
}

/**
 * Consulta los eventos existentes para una fecha y devuelve los rangos
 * ocupados como strings "HH:MM-HH:MM", para inyectar en el prompt.
 */
async function consultarDisponibilidad(fechaStr) {
  const { dia, mes, anio } = parseFechaHora(fechaStr, '00:00');
  const auth = getAuth();
  const calendar = google.calendar({ version: 'v3', auth });

  const timeMin = formatearISO(anio, mes, dia, 0, 0) + '-04:00';
  const timeMax = formatearISO(anio, mes, dia, 23, 59) + '-04:00';

  const res = await calendar.events.list({
    calendarId: process.env.GOOGLE_CALENDAR_ID,
    timeMin,
    timeMax,
    singleEvents: true,
    orderBy: 'startTime'
  });

  const eventos = res.data.items || [];
  return eventos
    .filter((e) => e.start && e.start.dateTime)
    .map((e) => {
      const inicio = e.start.dateTime.slice(11, 16);
      const fin = (e.end && e.end.dateTime) ? e.end.dateTime.slice(11, 16) : inicio;
      return `${inicio}-${fin}`;
    });
}

/**
 * Revisa si el horario solicitado se solapa con algun evento ya existente
 * ese dia — es la verificacion definitiva, hecha justo antes de crear el
 * evento, para no depender solo de lo que el modelo recuerda dentro de la
 * conversacion (que puede quedar desactualizado si otra conversacion
 * agendo en el mismo rango mientras tanto).
 */
async function haySolapamiento(fechaStr, horaStr, duracionMinutos = 60) {
  const { hora, minuto } = parseFechaHora(fechaStr, horaStr);
  const inicioSolicitado = hora * 60 + minuto;
  const finSolicitado = inicioSolicitado + duracionMinutos;

  const ocupados = await consultarDisponibilidad(fechaStr); // ["HH:MM-HH:MM", ...]
  return ocupados.some((rango) => {
    const [ini, fin] = rango.split('-');
    const [hIni, mIni] = ini.split(':').map(Number);
    const [hFin, mFin] = fin.split(':').map(Number);
    const iniMin = hIni * 60 + mIni;
    const finMin = hFin * 60 + mFin;
    return inicioSolicitado < finMin && finSolicitado > iniMin;
  });
}

/**
 * Crea el evento real de la reunion en el calendario de la oficina.
 * Devuelve { ok, eventLink } o { ok: false, error } o { ok: false, conflict: true }.
 */
async function crearEvento(leadData) {
  try {
    const conflicto = await haySolapamiento(leadData.fecha_visita, leadData.hora_visita, 60);
    if (conflicto) {
      return {
        ok: false,
        conflict: true,
        error: 'El horario solicitado ya esta ocupado (otra reunion lo tomo justo antes de confirmar).'
      };
    }

    const { dia, mes, anio, hora, minuto } = parseFechaHora(leadData.fecha_visita, leadData.hora_visita);
    const inicio = formatearISO(anio, mes, dia, hora, minuto);
    const fin = formatearISO(anio, mes, dia, hora + 1, minuto);

    const auth = getAuth();
    const calendar = google.calendar({ version: 'v3', auth });

    const evt = await calendar.events.insert({
      calendarId: process.env.GOOGLE_CALENDAR_ID,
      requestBody: {
        summary: `Reunión — ${leadData.nombre} — ${leadData.area_legal || 'Consulta'}`,
        description: `Cliente: ${leadData.nombre}\nTeléfono: ${leadData.telefono}\nEmail: ${leadData.email}\nÁrea legal: ${leadData.area_legal || ''}\nTipo de cliente: ${leadData.tipo_cliente || ''}\nDescripción: ${leadData.descripcion_caso || ''}`,
        start: { dateTime: inicio, timeZone: 'America/Santiago' },
        end: { dateTime: fin, timeZone: 'America/Santiago' },
        reminders: RECORDATORIOS_ESTANDAR
      }
    });

    console.log('[CALENDAR] Evento creado, reminders devueltos por Google:', JSON.stringify(evt?.data?.reminders));

    return { ok: true, eventLink: evt?.data?.htmlLink || null };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Version generica: crea un evento dado titulo, descripcion, fecha y hora
 * (DD/MM/YYYY y HH:MM), con duracion en minutos configurable.
 */
async function crearEventoGenerico({ titulo, descripcion, fechaStr, horaStr, duracionMinutos = 60 }) {
  try {
    const { dia, mes, anio, hora, minuto } = parseFechaHora(fechaStr, horaStr);
    const inicio = formatearISO(anio, mes, dia, hora, minuto);

    const finMinutosTotal = hora * 60 + minuto + duracionMinutos;
    const finHora = Math.floor(finMinutosTotal / 60);
    const finMinuto = finMinutosTotal % 60;
    const fin = formatearISO(anio, mes, dia, finHora, finMinuto);

    const auth = getAuth();
    const calendar = google.calendar({ version: 'v3', auth });

    const evt = await calendar.events.insert({
      calendarId: process.env.GOOGLE_CALENDAR_ID,
      requestBody: {
        summary: titulo,
        description: descripcion,
        start: { dateTime: inicio, timeZone: 'America/Santiago' },
        end: { dateTime: fin, timeZone: 'America/Santiago' },
        reminders: RECORDATORIOS_ESTANDAR
      }
    });

    console.log('[CALENDAR] Evento creado, reminders devueltos por Google:', JSON.stringify(evt?.data?.reminders));

    return { ok: true, eventLink: evt?.data?.htmlLink || null };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = { consultarDisponibilidad, crearEvento, crearEventoGenerico };
