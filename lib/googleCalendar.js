const { google } = require('googleapis');

// Recordatorios estandar: 1 dia, 2 horas y 15 minutos antes.
// Todas tipo "popup" (no "email"), porque los abogados van a sincronizar
// este calendario via CalDAV en su iPhone/Mac (agregando la cuenta de
// Google solo como Calendario, no como correo) — ese protocolo traduce
// las alertas "popup" en una alarma nativa real del dispositivo, mientras
// que las alertas "email" solo llegarian a la bandeja de Gmail del bot,
// no al correo personal de cada abogado.
const RECORDATORIOS_ESTANDAR = {
  useDefault: false,
  overrides: [
    { method: 'popup', minutes: 24 * 60 },
    { method: 'popup', minutes: 120 },
    { method: 'popup', minutes: 15 }
  ]
};

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
 * Crea el evento real de la reunion en el calendario de la oficina.
 * Devuelve { ok, eventLink } o { ok: false, error }.
 */
async function crearEvento(leadData) {
  try {
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

    return { ok: true, eventLink: evt?.data?.htmlLink || null };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = { consultarDisponibilidad, crearEvento, crearEventoGenerico };
