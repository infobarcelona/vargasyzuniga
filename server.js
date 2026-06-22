require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

const { connectDB } = require('./lib/db');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { MongoClient } = require('mongodb');
const { procesarMensaje } = require('./lib/conversationEngine');
const { correrCicloWatcher } = require('./lib/pjudWatcher');
const { iniciarWhatsApp, getEstadoWhatsApp, getQRComoImagenPNG } = require('./lib/whatsappBot');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/chat', async (req, res) => {
  const { sessionId, message } = req.body;
  if (!sessionId || !message) {
    return res.status(400).json({ error: 'Faltan sessionId o message' });
  }
  try {
    const resultado = await procesarMensaje(sessionId, message);
    res.json(resultado);
  } catch (err) {
    console.error('[CHAT] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/health', (req, res) => res.json({ ok: true }));

// ── PORTAL ABOGADOS ──────────────────────────────────────────────────────────
app.post('/api/portal/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ message: 'Email y contraseña son requeridos.' });
    }

    const client = new MongoClient(process.env.MONGODB_URI);
    await client.connect();
    const db = client.db();
    const user = await db.collection('portal_users').findOne({ email: email.toLowerCase().trim() });
    await client.close();

    if (!user) {
      return res.status(401).json({ message: 'Credenciales incorrectas.' });
    }

    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) {
      return res.status(401).json({ message: 'Credenciales incorrectas.' });
    }

    const token = jwt.sign(
      { id: user._id, email: user.email, nombre: user.nombre },
      process.env.JWT_SECRET || 'vyz_portal_secret_2026',
      { expiresIn: '8h' }
    );

    res.json({ token, nombre: user.nombre });
  } catch (err) {
    console.error('[PORTAL] Error en login:', err.message);
    res.status(500).json({ message: 'Error interno del servidor.' });
  }
});

app.get('/api/portal/verify', (req, res) => {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ ok: false });
  }
  try {
    const token = auth.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'vyz_portal_secret_2026');
    res.json({ ok: true, nombre: decoded.nombre });
  } catch {
    res.status(401).json({ ok: false });
  }
});

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

// --- WhatsApp ---
app.get('/api/whatsapp/status', (req, res) => res.json(getEstadoWhatsApp()));

app.get('/api/whatsapp/qr-image', async (req, res) => {
  const buffer = await getQRComoImagenPNG();
  if (!buffer) return res.status(404).json({ error: 'No hay QR disponible en este momento.' });
  res.set('Content-Type', 'image/png');
  res.send(buffer);
});

app.get('/whatsapp', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8" />
<title>Conectar WhatsApp — Kit Legal</title>
<style>
  body { font-family: -apple-system, sans-serif; text-align: center; padding: 40px 20px; }
  img { margin-top: 20px; border: 1px solid #ddd; border-radius: 8px; }
  #status { font-size: 18px; margin-top: 16px; }
  .conectado { color: #22c55e; font-weight: bold; }
  .esperando { color: #f59e0b; }
</style>
</head>
<body>
  <h2>Conectar WhatsApp del estudio</h2>
  <p>Abre WhatsApp en el teléfono dedicado → Ajustes → Dispositivos vinculados → Vincular dispositivo, y escanea el código.</p>
  <div id="qr-container"></div>
  <div id="status">Cargando estado...</div>
  <script>
    async function actualizar() {
      const res = await fetch('/api/whatsapp/status');
      const data = await res.json();
      const statusEl = document.getElementById('status');
      const qrContainer = document.getElementById('qr-container');

      if (data.status === 'conectado') {
        statusEl.innerHTML = '<span class="conectado">✅ Conectado correctamente</span>';
        qrContainer.innerHTML = '';
      } else if (data.qrDisponible) {
        statusEl.innerHTML = '<span class="esperando">⏳ Esperando que escanees el código</span>';
        qrContainer.innerHTML = '<img src="/api/whatsapp/qr-image?t=' + Date.now() + '" width="320" height="320" />';
      } else {
        statusEl.textContent = 'Generando código QR...';
        qrContainer.innerHTML = '';
      }
    }
    actualizar();
    setInterval(actualizar, 4000);
  </script>
</body>
</html>`);
});

const PORT = process.env.PORT || 3000;

connectDB()
  .then((db) => {
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

    // Conexion de WhatsApp
    iniciarWhatsApp(db).catch((err) => {
      console.error('[WHATSAPP] Error al iniciar:', err.message);
    });
  })
  .catch((err) => {
    console.error('[SERVER] No se pudo conectar a MongoDB:', err.message);
    process.exit(1);
  });
