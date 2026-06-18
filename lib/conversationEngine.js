const { construirSystemPrompt } = require('./prompt');
const { generarRespuesta } = require('./anthropic');
const { extraerYFusionarDatos } = require('./dataExtractor');
const { calcularScore } = require('./scoring');
const { consultarDisponibilidad } = require('./googleCalendar');
const { agendarYNotificar } = require('./scheduler');

const UMBRAL_SCORE = parseInt(process.env.UMBRAL_SCORE || '70', 10);
const NOMBRE_BOT = process.env.NOMBRE_BOT || 'Renata';
const NOMBRE_ESTUDIO = process.env.NOMBRE_ESTUDIO || 'Vargas y Zuñiga Abogados';

// Sesiones en memoria, identificadas por un sessionId generico — puede ser
// el id de sesion del chat web, o el JID de WhatsApp (ej "56912345678@s.whatsapp.net"),
// ambos comparten esta misma estructura sin distincion.
const sessions = new Map();

function getSession(sessionId) {
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, {
      conversation: [],
      leadData: {},
      citaAgendada: false,
      ultimaFechaConsultada: null,
      horariosOcupados: null
    });
  }
  return sessions.get(sessionId);
}

/**
 * Procesa un mensaje entrante de cualquier canal (web o WhatsApp) y devuelve
 * la respuesta limpia para mostrar/enviar, mas informacion de debug.
 */
async function procesarMensaje(sessionId, message) {
  const session = getSession(sessionId);
  session.conversation.push({ role: 'user', content: message });

  if (
    session.leadData.fecha_visita &&
    session.leadData.fecha_visita !== session.ultimaFechaConsultada
  ) {
    try {
      session.horariosOcupados = await consultarDisponibilidad(session.leadData.fecha_visita);
    } catch (e) {
      console.error('[Calendar] No se pudo consultar disponibilidad:', e.message);
      session.horariosOcupados = null;
    }
    session.ultimaFechaConsultada = session.leadData.fecha_visita;
  }

  const scoreInfoPrevio = calcularScore(session.leadData);
  const systemPrompt = construirSystemPrompt({
    nombreBot: NOMBRE_BOT,
    nombreEstudio: NOMBRE_ESTUDIO,
    horariosOcupados: session.horariosOcupados,
    scoreInfo: scoreInfoPrevio,
    umbral: UMBRAL_SCORE
  });

  const respuestaCruda = await generarRespuesta(systemPrompt, session.conversation);

  const { leadData, cleanReply, parsedOk, parseError } = extraerYFusionarDatos(
    respuestaCruda,
    session.leadData
  );
  session.leadData = leadData;
  session.conversation.push({ role: 'assistant', content: cleanReply });

  const scoreInfo = calcularScore(session.leadData);

  let schedulingResult = null;
  const datosMinimosCompletos =
    session.leadData.nombre &&
    session.leadData.telefono &&
    session.leadData.email &&
    session.leadData.fecha_visita &&
    session.leadData.hora_visita;

  if (datosMinimosCompletos && scoreInfo.score >= UMBRAL_SCORE && !session.citaAgendada) {
    session.citaAgendada = true;
    schedulingResult = await agendarYNotificar({
      leadData: session.leadData,
      scoreInfo,
      nombreBot: NOMBRE_BOT,
      nombreEstudio: NOMBRE_ESTUDIO
    });
    if (!schedulingResult.ok) {
      session.citaAgendada = false;
      console.error('[SCHEDULER] Fallo:', schedulingResult);
    }
  }

  return {
    reply: cleanReply,
    debug: {
      leadData: session.leadData,
      score: scoreInfo.score,
      clasificacion: scoreInfo.clasificacion,
      desglose: scoreInfo.desglose,
      umbral: UMBRAL_SCORE,
      citaAgendada: session.citaAgendada,
      datosMinimosCompletos: !!datosMinimosCompletos,
      parsedOk,
      parseError: parseError || null,
      schedulingResult
    }
  };
}

module.exports = { procesarMensaje };
