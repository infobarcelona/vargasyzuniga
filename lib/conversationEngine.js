const { construirSystemPrompt } = require('./prompt');
const { generarRespuesta } = require('./anthropic');
const { extraerYFusionarDatos } = require('./dataExtractor');
const { calcularScore } = require('./scoring');
const { consultarDisponibilidad } = require('./googleCalendar');
const { agendarYNotificar } = require('./scheduler');

const UMBRAL_SCORE = parseInt(process.env.UMBRAL_SCORE || '70', 10);
const NOMBRE_BOT = process.env.NOMBRE_BOT || 'Renata';
const NOMBRE_ESTUDIO = process.env.NOMBRE_ESTUDIO || 'Vargas y Zuñiga Abogados';

// Las reuniones con clientes nuevos solo se agendan en la tarde — esto es
// un respaldo a nivel de codigo, por si el modelo no sigue la regla del
// prompt y de todas formas propone/acepta un horario de mañana.
const HORA_MINIMA_REUNION = '15:00';
const HORA_MAXIMA_REUNION = '18:30';

function esHorarioDeTardeValido(horaStr) {
  if (!horaStr || !/^\d{1,2}:\d{2}$/.test(horaStr)) return false;
  const [h, m] = horaStr.split(':').map(Number);
  const minutosTotales = h * 60 + m;
  const [hMin, mMin] = HORA_MINIMA_REUNION.split(':').map(Number);
  const [hMax, mMax] = HORA_MAXIMA_REUNION.split(':').map(Number);
  return minutosTotales >= (hMin * 60 + mMin) && minutosTotales <= (hMax * 60 + mMax);
}

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
  let respuestaFinal = cleanReply; // puede ajustarse mas abajo si hay un conflicto de horario de ultimo momento

  const scoreInfo = calcularScore(session.leadData);

  let schedulingResult = null;
  const datosMinimosCompletos =
    session.leadData.nombre &&
    session.leadData.telefono &&
    session.leadData.email &&
    session.leadData.fecha_visita &&
    session.leadData.hora_visita;

  const horarioValido = esHorarioDeTardeValido(session.leadData.hora_visita);
  if (datosMinimosCompletos && !horarioValido) {
    console.warn(
      `[SCHEDULER] Hora de reunion fuera del rango de tarde permitido (${session.leadData.hora_visita}), no se agenda. sessionId=${sessionId}`
    );
  }

  if (datosMinimosCompletos && horarioValido && scoreInfo.score >= UMBRAL_SCORE && !session.citaAgendada) {
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

      if (schedulingResult.conflict) {
        // Calcular que franjas de tarde quedan realmente disponibles,
        // para no sugerir horarios que tambien esten ocupados.
        const SLOTS_TARDE = ['15:00','15:30','16:00','16:30','17:00','17:30','18:00','18:30'];
        const DURACION = 60; // minutos por reunion

        function toMin(hhmm) {
          const [h, m] = hhmm.split(':').map(Number);
          return h * 60 + m;
        }

        // Rangos ocupados ese dia como pares de minutos [inicio, fin]
        const ocupadosMin = (session.horariosOcupados || []).map((rango) => {
          const [ini, fin] = rango.split('-');
          return [toMin(ini), toMin(fin)];
        });

        // Un slot esta libre si no se solapa con ningun rango ocupado
        const slotsLibres = SLOTS_TARDE.filter((slot) => {
          const ini = toMin(slot);
          const fin = ini + DURACION;
          return ocupadosMin.every(([oIni, oFin]) => fin <= oIni || ini >= oFin);
        });

        let sugerencia;
        if (slotsLibres.length === 0) {
          sugerencia = 'Lamentablemente no quedan horarios disponibles en la tarde de ese día. ¿Le acomoda otro día?';
        } else if (slotsLibres.length === 1) {
          sugerencia = `El único horario disponible en la tarde de ese día es a las ${slotsLibres[0]}. ¿Le acomoda?`;
        } else {
          sugerencia = `Los horarios disponibles en la tarde de ese día son: ${slotsLibres.join(', ')}. ¿Cuál le acomoda mejor?`;
        }

        respuestaFinal = `Lo siento, ese horario no está disponible. ${sugerencia}`;
        session.leadData.hora_visita = '';
        session.ultimaFechaConsultada = null;
      }
    }
  }

  session.conversation.push({ role: 'assistant', content: respuestaFinal });

  return {
    reply: respuestaFinal,
    debug: {
      leadData: session.leadData,
      score: scoreInfo.score,
      clasificacion: scoreInfo.clasificacion,
      desglose: scoreInfo.desglose,
      umbral: UMBRAL_SCORE,
      citaAgendada: session.citaAgendada,
      datosMinimosCompletos: !!datosMinimosCompletos,
      horarioValido,
      parsedOk,
      parseError: parseError || null,
      schedulingResult
    }
  };
}

module.exports = { procesarMensaje };
