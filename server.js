require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

const { connectDB } = require('./lib/db');
const { construirSystemPrompt } = require('./lib/prompt');
const { generarRespuesta } = require('./lib/anthropic');
const { extraerYFusionarDatos } = require('./lib/dataExtractor');
const { calcularScore } = require('./lib/scoring');
const { consultarDisponibilidad } = require('./lib/googleCalendar');
const { agendarYNotificar } = require('./lib/scheduler');
const { correrCicloWatcher } = require('./lib/pjudWatcher');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const UMBRAL_SCORE = parseInt(process.env.UMBRAL_SCORE || '70', 10);
const NOMBRE_BOT = process.env.NOMBRE_BOT || 'Renata';
const NOMBRE_ESTUDIO = process.env.NOMBRE_ESTUDIO || 'Vargas y Zuñiga Abogados';

// Sesiones en memoria — suficiente para esta fase de pruebas.
// session = { conversation: [], leadData: {}, citaAgendada: bool,
//             ultimaFechaConsultada: string|null, horariosOcupados: array|null }
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

app.post('/api/chat', async (req, res) => {
  const { sessionId, message } = req.body;
  if (!sessionId || !message) {
    return res.status(400).json({ error: 'Faltan sessionId o message' });
  }

  const session = getSession(sessionId);
  session.conversation.push({ role: 'user', content: message });

  try {
    // Si el modelo ya conoce una fecha distinta a la última consultada,
    // refrescamos disponibilidad antes de construir el prompt.
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
      session.citaAgendada = true; // optimista, se revierte si falla un paso critico
      schedulingResult = await agendarYNotificar({
        leadData: session.leadData,
        scoreInfo,
        nombreBot: NOMBRE_BOT,
        nombreEstudio: NOMBRE_ESTUDIO
      });
      if (!schedulingResult.ok) {
        session.citaAgendada = false; // permite reintentar en el proximo turno
        console.error('[SCHEDULER] Fallo:', schedulingResult);
      }
    }

    res.json({
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
    });
  } catch (err) {
    console.error('[CHAT] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/health', (req, res) => res.json({ ok: true }));

// Endpoint manual para correr el watcher del PJUD a demanda (pruebas).
app.post('/api/pjud/run-once', async (req, res) => {
  try {
    const resumen = await correrCicloWatcher();
    res.json(resumen);
  } catch (err) {
    console.error('[PJUD] Error en ejecucion manual:', err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;

connectDB()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`[SERVER] Kit Legal backoffice corriendo en puerto ${PORT}`);
    });

    // Ciclo automatico del watcher del PJUD
    const intervaloMin = parseInt(process.env.PJUD_WATCHER_INTERVALO_MINUTOS || '10', 10);
    setInterval(async () => {
      try {
        const resumen = await correrCicloWatcher();
        if (resumen.correosRevisados > 0 || resumen.errores.length > 0) {
          console.log('[PJUD] Ciclo automatico:', resumen);
        }
      } catch (err) {
        console.error('[PJUD] Error en ciclo automatico:', err.message);
      }
    }, intervaloMin * 60 * 1000);
    console.log(`[PJUD] Watcher automatico activo cada ${intervaloMin} minutos.`);
  })
  .catch((err) => {
    console.error('[SERVER] No se pudo conectar a MongoDB:', err.message);
    process.exit(1);
  });
