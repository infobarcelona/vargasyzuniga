const nodemailer = require('nodemailer');

function getTransporter() {
  return nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.GMAIL_USER,
      pass: process.env.GMAIL_APP_PASSWORD
    }
  });
}

async function enviarNotificacionOficina({ leadData, scoreInfo, eventLink, nombreBot, nombreEstudio }) {
  const transporter = getTransporter();
  const destino = process.env.OFFICE_NOTIFICATION_EMAIL || process.env.GMAIL_USER;

  await transporter.sendMail({
    from: `"${nombreBot} — ${nombreEstudio}" <${process.env.GMAIL_USER}>`,
    to: destino,
    subject: `${scoreInfo.clasificacion} — Nueva reunión agendada — ${leadData.nombre}`,
    html: `
      <p><strong>Nuevo lead calificado y agendado</strong></p>
      <p>
        Nombre: ${leadData.nombre}<br>
        Teléfono: ${leadData.telefono}<br>
        Email: ${leadData.email}<br>
        Área legal: ${leadData.area_legal || 'No especificada'}<br>
        Tipo de cliente: ${leadData.tipo_cliente || 'No especificado'}<br>
        Descripción del caso: ${leadData.descripcion_caso || 'No especificada'}<br>
        Urgencia: ${leadData.urgencia || 'No especificada'}<br>
        Reunión: ${leadData.fecha_visita} a las ${leadData.hora_visita}<br>
        Score de interés: ${scoreInfo.score}/100 (${scoreInfo.clasificacion})<br>
        Evento en Calendar: ${eventLink ? `<a href="${eventLink}">Ver evento</a>` : 'N/A'}
      </p>
    `
  });
}

async function enviarConfirmacionCliente({ leadData, nombreEstudio }) {
  if (!leadData.email) return { ok: false, error: 'Cliente no dejó email' };

  const transporter = getTransporter();
  try {
    await transporter.sendMail({
      from: `"Vargas & Z\u00faniga Reuniones" <${process.env.GMAIL_USER}>`,
      to: leadData.email,
      subject: `✅ Tu reunión en ${nombreEstudio} — ${leadData.fecha_visita} a las ${leadData.hora_visita}`,
      html: `
        <p>Hola ${leadData.nombre},</p>
        <p>Tu reunión está confirmada para el <strong>${leadData.fecha_visita}</strong> a las
        <strong>${leadData.hora_visita}</strong> en ${nombreEstudio}, Temuco.</p>
        <p>Dirección: Antonio Varas 687, oficina 1010, Torre Sinergia, Temuco.</p>
        <p>Si necesitas reprogramar, contáctanos respondiendo este correo.</p>
        <p>¡Te esperamos!</p>
      `
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = { enviarNotificacionOficina, enviarConfirmacionCliente };
