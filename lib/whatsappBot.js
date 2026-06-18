const makeWASocket = require('@whiskeysockets/baileys').default;
const { DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');
const QRCode = require('qrcode');
const { useMongoAuthState, limpiarSesion } = require('./baileysMongoAuthState');
const { procesarMensaje } = require('./conversationEngine');

let sock = null;
let ultimoQR = null;
let estadoConexion = 'iniciando'; // iniciando | esperando_escaneo | conectado | desconectado

async function iniciarWhatsApp(db) {
  const authCollection = db.collection('whatsapp_auth');
  const { state, saveCreds } = await useMongoAuthState(authCollection);

  let version;
  try {
    const resultado = await fetchLatestBaileysVersion();
    version = resultado.version;
    console.log('[WHATSAPP] Usando version de protocolo:', version.join('.'));
  } catch (e) {
    console.error('[WHATSAPP] No se pudo obtener la version mas reciente, se usa la por defecto:', e.message);
  }

  sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      ultimoQR = qr;
      estadoConexion = 'esperando_escaneo';
      console.log('[WHATSAPP] Nuevo QR disponible — visita /whatsapp para escanearlo.');
    }

    if (connection === 'open') {
      estadoConexion = 'conectado';
      ultimoQR = null;
      console.log('[WHATSAPP] Conectado correctamente.');
    }

    if (connection === 'close') {
      estadoConexion = 'desconectado';
      const codigoError = lastDisconnect?.error?.output?.statusCode;
      const sesionCerrada = codigoError === DisconnectReason.loggedOut;
      console.log(
        `[WHATSAPP] Conexion cerrada (codigo ${codigoError}). ` +
        (sesionCerrada ? 'Sesion cerrada desde el telefono — limpiando credenciales viejas.' : 'Reintentando conexion...')
      );
      if (sesionCerrada) {
        limpiarSesion(db.collection('whatsapp_auth'))
          .then(() => setTimeout(() => iniciarWhatsApp(db), 1000))
          .catch((err) => console.error('[WHATSAPP] Error limpiando sesion:', err.message));
      } else {
        setTimeout(() => iniciarWhatsApp(db), 3000);
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const msg of messages) {
      try {
        if (!msg.message || msg.key.fromMe) continue;
        const remoteJid = msg.key.remoteJid;
        if (!remoteJid || remoteJid.endsWith('@g.us')) continue; // ignorar grupos

        const texto =
          msg.message.conversation ||
          msg.message.extendedTextMessage?.text ||
          '';
        if (!texto) continue;

        const resultado = await procesarMensaje(remoteJid, texto);
        await sock.sendMessage(remoteJid, { text: resultado.reply });
      } catch (err) {
        console.error('[WHATSAPP] Error procesando mensaje:', err.message);
      }
    }
  });

  return sock;
}

function getEstadoWhatsApp() {
  return { status: estadoConexion, qrDisponible: !!ultimoQR };
}

async function getQRComoImagenPNG() {
  if (!ultimoQR) return null;
  return QRCode.toBuffer(ultimoQR, { width: 320, margin: 2 });
}

module.exports = { iniciarWhatsApp, getEstadoWhatsApp, getQRComoImagenPNG };
