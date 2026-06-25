const { construirSystemPrompt } = require('./prompt');
const { generarRespuesta } = require('./anthropic');
const { extraerYFusionarDatos } = require('./dataExtractor');
const { calcularScore } = require('./scoring');
const { consultarDisponibilidad } = require('./googleCalendar');
const { agendarYNotificar } = require('./scheduler');
const https = require('https');

const BACKEND = 'vargasyzuniga.onrender.com';

async function consultarDrive(path) {
  return new Promise((resolve) => {
    const options = { hostname: BACKEND, path, method: 'GET' };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.end();
  });
}

async function obtenerContextoDrive() {
  try {
    const [recientesData, carpetasData] = await Promise.all([
      consultarDrive('/api/drive/recientes'),
      consultarDrive('/api/drive/carpetas'),
    ]);

    const recientes = recientesData?.ok ? recientesData.archivos.map(a => ({
      nombre: a.name,
      modificado: new Date(a.modifiedTime).toLocaleDateString('es-CL', { day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit' }),
      id: a.id,
      tipo: a.mimeType,
    })) : null;

    const carpetas = carpetasData?.ok ? carpetasData.carpetas : null;

    return { recientes, carpetas };
  } catch {
    return null;
  }
}

async function leerContenidoArchivo(fileId) {
  return new Promise((resolve) => {
    const options = { hostname: BACKEND, path: `/api/drive/contenido/${fileId}`, method: 'GET' };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (!parsed.ok) { resolve(null); return; }
          resolve({ nombre: parsed.nombre, contenido: parsed.contenido });
        } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.end();
  });
}

async function buscarArchivosDeCausa(carpetas, mensajeAbogado) {
  if (!carpetas || !mensajeAbogado) return null;
  try {
    // Buscar si el mensaje menciona alguna causa
    const mensajeLower = mensajeAbogado.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    // Palabras genericas que NO sirven para identificar una causa
    const palabrasGenericas = ['causa', 'carpeta', 'archivo', 'archivos', 'documento', 'documentos', 'expediente', 'expedientes', 'caso', 'oficina', 'laboral', 'civil', 'penal', 'familia', 'nuevo', 'nuevos', 'ultimo', 'ultimos', 'reciente', 'recientes'];

    // Extraer palabras distintivas del mensaje (>4 letras, no genericas)
    const palabrasMensaje = mensajeLower.split(/\s+/)
      .map(p => p.replace(/[^a-z0-9]/g, ''))
      .filter(p => p.length > 4 && !palabrasGenericas.includes(p));

    if (palabrasMensaje.length === 0) return null;

    let carpetaEncontrada = null;
    let mejorPuntaje = 0;

    for (const c of carpetas) {
      const nombreLower = c.name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
      let coincidencias = 0;
      // Buscar palabras distintivas del mensaje en el nombre de la carpeta
      for (const p of palabrasMensaje) {
        if (nombreLower.includes(p)) coincidencias++;
      }
      if (coincidencias > mejorPuntaje) {
        mejorPuntaje = coincidencias;
        carpetaEncontrada = c;
      }
    }

    if (!carpetaEncontrada || mejorPuntaje === 0) return null;

    const archivosData = await consultarDrive(`/api/drive/archivos/${carpetaEncontrada.id}`);
    if (!archivosData?.ok) return null;

    return {
      carpetaNombre: carpetaEncontrada.name,
      archivos: archivosData.archivos.map(a => ({
        id: a.id,
        nombre: a.name,
        modificado: new Date(a.modifiedTime).toLocaleDateString('es-CL', { day:'2-digit', month:'2-digit', year:'numeric' }),
        tipo: a.mimeType,
      })),
    };
  } catch {
    return null;
  }
}

const UMBRAL_SCORE = parseInt(process.env.UMBRAL_SCORE || '70', 10);
const UMBRAL_SCORE_SENSIBLE = parseInt(process.env.UMBRAL_SCORE_SENSIBLE || '35', 10);
const NOMBRE_BOT = process.env.NOMBRE_BOT || 'Renata';
const NOMBRE_ESTUDIO = process.env.NOMBRE_ESTUDIO || 'Vargas y Zuñiga Abogados';

// Palabras clave que identifican un caso sensible — en estos casos se
// aplica un umbral de score mas bajo porque el bot no hace preguntas de
// calificacion (para no incomodar a una persona en situacion vulnerable).
const PALABRAS_SENSIBLES = [
  'maltrato','violencia','abuso','violación','violacion','golpe','golpes',
  'agresión','agresion','acoso','hostigamiento','amenaza','amenazas',
  'femicidio','femicidio','pareja','conviviente','marido','esposo',
  'niño','niña','menor','hijo','hija','infancia','familia','familiar',
  'sexual','tocación','tocacion','manoseo','estupro','incesto',
  'discriminación','discriminacion','bullying','laboral','acoso laboral'
];

function esTemaSensible(leadData) {
  const texto = [
    leadData.descripcion_caso || '',
    leadData.area_legal || ''
  ].join(' ').toLowerCase();
  return PALABRAS_SENSIBLES.some((p) => texto.includes(p));
}

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
async function procesarMensaje(sessionId, message, contextoPortal = null) {
  const session = getSession(sessionId);
  session.conversation.push({ role: 'user', content: message });

  // Si hay abogado autenticado, obtener contexto de Drive
  let archivosRecientes = null;
  let carpetasCausas = null;
  let archivosDeCausa = null;
  let contenidoArchivo = null;
  if (contextoPortal) {
    const contextoDrive = await obtenerContextoDrive();
    archivosRecientes = contextoDrive?.recientes || null;
    const carpetasCompletas = contextoDrive?.carpetas || null;
    carpetasCausas = carpetasCompletas ? carpetasCompletas.map(c => c.name) : null;
    // Buscar archivos de causa específica mencionada en el mensaje
    archivosDeCausa = await buscarArchivosDeCausa(carpetasCompletas, message);

    // Leer contenido del archivo activo en OnlyOffice automáticamente
    if (contextoPortal?.archivoActivo && !contenidoArchivo) {
      const arch = contextoPortal.archivoActivo;
      if (arch.tipo && (
        arch.tipo.includes('document') ||
        arch.tipo.includes('spreadsheet') ||
        arch.tipo.includes('wordprocessing') ||
        arch.tipo.includes('spreadsheetml') ||
        arch.tipo === 'text/plain'
      )) {
        contenidoArchivo = await leerContenidoArchivo(arch.id);
        if (contenidoArchivo) contenidoArchivo.esArchivoActivo = true;
      }
    }

  // Leer contenido de archivo si el abogado lo solicita
    if (archivosDeCausa) {
      const mensajeLower = message.toLowerCase();
      const palabrasLectura = ['dice', 'contiene', 'contenido', 'datos', 'información', 'rut', 'leer', 'lee', 'muestra', 'detail', 'ver', 'abre', 'qué tiene', 'que tiene'];
      const quiereLeer = palabrasLectura.some(p => mensajeLower.includes(p));
      if (quiereLeer) {
        const mensajeNorm = mensajeLower.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
        const palabrasCarpeta = archivosDeCausa.carpetaNombre.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").split(/\s+/);
        const stopWords = ["documento", "archivo", "dice", "contiene", "datos", "informacion", "tiene", "cual", "como", "para", "desde", "hasta"];
        let mejorArchivo = null;
        let mejorPuntaje2 = 0;
        for (const a of archivosDeCausa.archivos) {
          const nombreNorm = a.nombre.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
          const palabrasArchivo = nombreNorm.split(/\s+/).filter(p => p.length > 3 && !palabrasCarpeta.includes(p) && !stopWords.includes(p));
          let pts = 0;
          for (const p of palabrasArchivo) { if (mensajeNorm.includes(p)) pts++; }
          if (pts > mejorPuntaje2) { mejorPuntaje2 = pts; mejorArchivo = a; }
        }
        const archivoMencionado = mejorPuntaje2 > 0 ? mejorArchivo : null;
        if (archivoMencionado) {
          contenidoArchivo = await leerContenidoArchivo(archivoMencionado.id);
        }
      }
    }

  }

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
  console.log('[PROMPT DEBUG] contextoPortal antes de prompt:', JSON.stringify(contextoPortal));
  const systemPrompt = construirSystemPrompt({
    nombreBot: NOMBRE_BOT,
    nombreEstudio: NOMBRE_ESTUDIO,
    horariosOcupados: session.horariosOcupados,
    scoreInfo: scoreInfoPrevio,
    umbral: UMBRAL_SCORE,
    contextoPortal,
    archivosRecientes,
    carpetasCausas,
    archivosDeCausa,
    contenidoArchivo,
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

  // Umbral diferenciado: casos sensibles usan un umbral mas bajo porque
  // el bot no hace preguntas de calificacion con esas personas — el
  // umbral normal (70) sigue aplicando para casos patrimoniales/comerciales.
  const sensible = esTemaSensible(session.leadData);
  const umbralEfectivo = sensible ? UMBRAL_SCORE_SENSIBLE : UMBRAL_SCORE;
  if (sensible) {
    console.log(`[ENGINE] Caso sensible detectado — umbral reducido a ${UMBRAL_SCORE_SENSIBLE}. sessionId=${sessionId}`);
  }

  const listo = datosMinimosCompletos && horarioValido && scoreInfo.score >= umbralEfectivo && !session.citaAgendada;

  if (listo) {
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
        // Consultar disponibilidad en tiempo real en este momento exacto,
        // NO usar session.horariosOcupados (puede estar vacio o desactualizado
        // si la primera consulta fue antes de que se agendara algo en paralelo).
        const SLOTS_TARDE = ['15:00','15:30','16:00','16:30','17:00','17:30','18:00','18:30'];
        const DURACION = 60;

        function toMin(hhmm) {
          const [h, m] = hhmm.split(':').map(Number);
          return h * 60 + m;
        }

        let ocupadosMin = [];
        try {
          const ocupadosAhora = await consultarDisponibilidad(session.leadData.fecha_visita);
          session.horariosOcupados = ocupadosAhora;
          session.ultimaFechaConsultada = session.leadData.fecha_visita;
          ocupadosMin = ocupadosAhora.map((rango) => {
            const [ini, fin] = rango.split('-');
            return [toMin(ini), toMin(fin)];
          });
        } catch (e) {
          console.error('[ENGINE] No se pudo re-consultar disponibilidad tras conflicto:', e.message);
        }

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
        // NO reseteamos ultimaFechaConsultada — ya la actualizamos arriba con datos frescos

      } else {
        // Cualquier otro fallo tecnico (error de API, calendario no disponible, etc.)
        // Es CRITICO sobreescribir aqui: el modelo ya genero una respuesta
        // de confirmacion, pero el evento NO se creo. Si esa confirmacion
        // llega al cliente, va a creer que tiene una cita que no existe.
        console.error('[SCHEDULER] Fallo tecnico inesperado — sobreescribiendo respuesta falsa de confirmacion.');
        respuestaFinal = 'Disculpe, hubo un problema técnico al registrar su reunión. Por favor llámenos directamente al +56 45 232 4418 para confirmar su hora y asegurarnos de que quede bien agendada.';
        // Liberamos los datos de fecha/hora para que pueda intentarlo de nuevo
        session.leadData.fecha_visita = '';
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
      umbral: umbralEfectivo,
      umbralNormal: UMBRAL_SCORE,
      caseSensible: sensible,
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
