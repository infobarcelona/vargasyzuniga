const { crearEvento } = require('./googleCalendar');
const { enviarNotificacionOficina, enviarConfirmacionCliente } = require('./mailer');
const { getLeadsCollection } = require('./db');

/**
 * Ejecuta las acciones reales una vez que el lead califica:
 *   1. Crear evento en Google Calendar          (si falla, ABORTA)
 *   2. Email a la oficina con score y datos      (si falla, ABORTA)
 *   3. Email de confirmación al cliente          (si falla, NO aborta)
 *   4. Guardar/actualizar el lead en MongoDB      (si falla, ABORTA)
 *
 * Devuelve { ok, eventLink, failedStep, error }.
 */
async function agendarYNotificar({ leadData, scoreInfo, nombreBot, nombreEstudio }) {
  // Paso 1/4 — Calendar
  const calResult = await crearEvento(leadData);
  if (!calResult.ok) {
    return { ok: false, failedStep: 'calendar.insert', error: calResult.error, conflict: !!calResult.conflict };
  }
  const eventLink = calResult.eventLink;

  // Paso 2/4 — Email a la oficina
  try {
    await enviarNotificacionOficina({ leadData, scoreInfo, eventLink, nombreBot, nombreEstudio });
  } catch (err) {
    return { ok: false, failedStep: 'sendMail.oficina', error: err.message, eventLink };
  }

  // Paso 3/4 — Email al cliente (no-fatal)
  let clienteEmailOk = true;
  let clienteEmailError = null;
  const clienteResult = await enviarConfirmacionCliente({ leadData, nombreEstudio });
  if (!clienteResult.ok) {
    clienteEmailOk = false;
    clienteEmailError = clienteResult.error;
  }

  // Paso 4/4 — Guardar lead en MongoDB
  try {
    const leads = getLeadsCollection();
    await leads.updateOne(
      { telefono: leadData.telefono },
      {
        $set: {
          ...leadData,
          score: scoreInfo.score,
          clasificacion: scoreInfo.clasificacion,
          desglose_score: scoreInfo.desglose,
          eventLink,
          fecha_ultimo_contacto: new Date()
        },
        $setOnInsert: { fecha_contacto: new Date() }
      },
      { upsert: true }
    );
  } catch (err) {
    return { ok: false, failedStep: 'db.upsert', error: err.message, eventLink };
  }

  return { ok: true, eventLink, clienteEmailOk, clienteEmailError };
}

module.exports = { agendarYNotificar };
