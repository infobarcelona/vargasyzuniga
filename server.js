require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

const { connectDB } = require('./lib/db');
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { MongoClient } = require('mongodb');
const { procesarMensaje } = require('./lib/conversationEngine');
const { correrCicloWatcher } = require('./lib/pjudWatcher');
const { iniciarWhatsApp, getEstadoWhatsApp, getQRComoImagenPNG } = require('./lib/whatsappBot');

const app = express();
app.use(cors({
  origin: [
    'https://vargasyzuniga-web.onrender.com',
    'https://vargasyzuniga.cl',
    'http://localhost:3000'
  ],
  credentials: true,
}));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/chat', async (req, res) => {
  const { sessionId, message, portalToken, archivoActivo } = req.body;
  if (!sessionId || !message) {
    return res.status(400).json({ error: 'Faltan sessionId o message' });
  }
  try {
    let contextoPortal = null;
    if (portalToken) {
      try {
        const decoded = jwt.verify(portalToken, process.env.JWT_SECRET || 'vyz_portal_secret_2026');
        contextoPortal = { nombre: decoded.nombre, email: decoded.email, archivoActivo: archivoActivo || null };
        console.log('[PORTAL] archivoActivo recibido:', archivoActivo ? archivoActivo.nombre : 'null');
        console.log('[CHAT] contextoPortal:', contextoPortal.nombre);
      } catch (e) {
        console.log('[CHAT] Error verificando token:', e.message);
      }
    }
    const resultado = await procesarMensaje(sessionId, message, contextoPortal);
    res.json(resultado);
  } catch (err) {
    console.error('[CHAT] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/health', (req, res) => res.json({ ok: true }));

// ── GOOGLE DRIVE ─────────────────────────────────────────────────────────────
const { google } = require('googleapis');
const { Readable } = require('stream');

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_OAUTH_CLIENT_ID,
  process.env.GOOGLE_OAUTH_CLIENT_SECRET,
  'https://vargasyzuniga.onrender.com/api/auth/google/callback'
);

// Si hay refresh token guardado, lo usamos
let driveRefreshToken = process.env.GOOGLE_DRIVE_REFRESH_TOKEN || null;

if (driveRefreshToken) {
  oauth2Client.setCredentials({ refresh_token: driveRefreshToken });
}

function getDriveClient() {
  if (driveRefreshToken) {
    oauth2Client.setCredentials({ refresh_token: driveRefreshToken });
    return google.drive({ version: 'v3', auth: oauth2Client });
  }
  // Fallback a service account para lectura
  const raw = process.env.GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('No hay credenciales de Google Drive configuradas');
  const credentials = JSON.parse(raw);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/drive'],
  });
  return google.drive({ version: 'v3', auth });
}

// Ruta 1: genera URL de autorización
app.get('/api/auth/google', (req, res) => {
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: ['https://www.googleapis.com/auth/drive'],
  });
  res.redirect(url);
});

// Ruta 2: callback de Google
app.get('/api/auth/google/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send('Código no recibido');
  try {
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);
    if (tokens.refresh_token) {
      driveRefreshToken = tokens.refresh_token;
      console.log('[OAUTH] Nuevo refresh token obtenido y guardado en MongoDB');
      try {
        const mongoClient = new MongoClient(process.env.MONGODB_URI);
        await mongoClient.connect();
        const mdb = mongoClient.db();
        await mdb.collection('config').updateOne(
          { key: 'google_drive_refresh_token' },
          { $set: { key: 'google_drive_refresh_token', value: tokens.refresh_token, updatedAt: new Date() } },
          { upsert: true }
        );
        await mongoClient.close();
        console.log('[OAUTH] Token guardado en MongoDB correctamente');
      } catch (dbErr) {
        console.error('[OAUTH] Error guardando token en MongoDB:', dbErr.message);
      }
    }
    res.send('<h2>✅ Autorización exitosa</h2><p>Ya puedes cerrar esta ventana y volver al portal. El refresh token aparece en los logs de Render.</p>');
  } catch (err) {
    console.error('[OAUTH] Error:', err.message);
    res.status(500).send('Error al obtener token: ' + err.message);
  }
});

// Subir archivo a una carpeta
app.post('/api/drive/subir/:folderId', upload.single('archivo'), async (req, res) => {
  try {
    const drive = getDriveClient();
    const { folderId } = req.params;
    const file = req.file;
    if (!file) return res.status(400).json({ ok: false, error: 'No se recibió archivo' });

    const stream = Readable.from(file.buffer);
    const response = await drive.files.create({
      requestBody: {
        name: file.originalname,
        parents: [folderId],
      },
      media: {
        mimeType: file.mimetype,
        body: stream,
      },
      fields: 'id, name, mimeType, modifiedTime, webViewLink',
    });

    res.json({ ok: true, archivo: response.data });
  } catch (err) {
    console.error('[DRIVE] Error subir:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Crear documento Google dentro de una carpeta
app.post('/api/drive/crear/:folderId', async (req, res) => {
  try {
    const drive = getDriveClient();
    const { folderId } = req.params;
    const { nombre, tipo } = req.body;

    const mimeTypes = {
      'doc': 'application/vnd.google-apps.document',
      'sheet': 'application/vnd.google-apps.spreadsheet',
      'slide': 'application/vnd.google-apps.presentation',
    };

    const mimeType = mimeTypes[tipo] || mimeTypes['doc'];

    const response = await drive.files.create({
      requestBody: {
        name: nombre || 'Nuevo documento',
        mimeType,
        parents: [folderId],
      },
      fields: 'id, name, mimeType, modifiedTime, webViewLink',
    });

    res.json({ ok: true, archivo: response.data });
  } catch (err) {
    console.error('[DRIVE] Error crear:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Archivos recientes para Renata
app.get('/api/drive/recientes', async (req, res) => {
  try {
    const drive = getDriveClient();
    const response = await drive.files.list({
      q: "trashed = false and mimeType != 'application/vnd.google-apps.folder'",
      fields: 'files(id, name, mimeType, modifiedTime, parents)',
      orderBy: 'modifiedTime desc',
      pageSize: 10,
    });
    res.json({ ok: true, archivos: response.data.files });
  } catch (err) {
    console.error('[DRIVE] Error recientes:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Leer contenido de un archivo para Renata
app.get('/api/drive/contenido/:fileId', async (req, res) => {
  try {
    const drive = getDriveClient();
    const { fileId } = req.params;
    const fileMeta = await drive.files.get({ fileId, fields: 'mimeType, name' });
    const mimeType = fileMeta.data.mimeType;

    let texto = '';

    if (mimeType === 'application/vnd.google-apps.document') {
      const response = await drive.files.export({ fileId, mimeType: 'text/plain' }, { responseType: 'text' });
      texto = response.data.substring(0, 8000);
    } else if (mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
               mimeType === 'application/msword') {
      const response = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'arraybuffer' });
      const mammoth = require('mammoth');
      const result = await mammoth.extractRawText({ buffer: Buffer.from(response.data) });
      texto = result.value.substring(0, 8000);
    } else if (mimeType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
               mimeType === 'application/vnd.ms-excel' ||
               mimeType === 'application/vnd.google-apps.spreadsheet') {
      let buffer;
      if (mimeType === 'application/vnd.google-apps.spreadsheet') {
        const response = await drive.files.export({ fileId, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }, { responseType: 'arraybuffer' });
        buffer = Buffer.from(response.data);
      } else {
        const response = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'arraybuffer' });
        buffer = Buffer.from(response.data);
      }
      const XLSX = require('xlsx');
      const workbook = XLSX.read(buffer, { type: 'buffer' });
      const textos = workbook.SheetNames.map(sheetName => {
        const sheet = workbook.Sheets[sheetName];
        return `[Hoja: ${sheetName}]
${XLSX.utils.sheet_to_csv(sheet)}`;
      });
      texto = textos.join('\n\n').substring(0, 8000);
    } else if (mimeType === 'text/plain') {
      const response = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'text' });
      texto = response.data.substring(0, 8000);
    } else {
      texto = `[Archivo de tipo ${mimeType} — no se puede leer el contenido directamente]`;
    }

    res.json({ ok: true, nombre: fileMeta.data.name, contenido: texto });
  } catch (err) {
    console.error('[DRIVE] Error contenido:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Renombrar archivo o carpeta
app.patch('/api/drive/renombrar/:fileId', async (req, res) => {
  try {
    const drive = getDriveClient();
    const { fileId } = req.params;
    const { nombre } = req.body;
    if (!nombre) return res.status(400).json({ ok: false, error: 'Nombre requerido' });
    const response = await drive.files.update({
      fileId,
      requestBody: { name: nombre },
      fields: 'id, name, mimeType, modifiedTime',
    });
    res.json({ ok: true, archivo: response.data });
  } catch (err) {
    console.error('[DRIVE] Error renombrar:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Eliminar archivo o carpeta
app.delete('/api/drive/eliminar/:fileId', async (req, res) => {
  try {
    const drive = getDriveClient();
    const { fileId } = req.params;
    await drive.files.delete({ fileId });
    res.json({ ok: true });
  } catch (err) {
    console.error('[DRIVE] Error eliminar:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Crear carpeta dentro de otra carpeta
app.post('/api/drive/carpeta/:folderId', async (req, res) => {
  try {
    const drive = getDriveClient();
    const { folderId } = req.params;
    const { nombre } = req.body;
    const response = await drive.files.create({
      requestBody: {
        name: nombre || 'Nueva carpeta',
        mimeType: 'application/vnd.google-apps.folder',
        parents: [folderId],
      },
      fields: 'id, name, mimeType, modifiedTime',
    });
    res.json({ ok: true, carpeta: response.data });
  } catch (err) {
    console.error('[DRIVE] Error crear carpeta:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/drive/archivos/:folderId', async (req, res) => {
  try {
    const drive = getDriveClient();
    const { folderId } = req.params;

    const response = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      fields: 'files(id, name, mimeType, modifiedTime, size, webViewLink)',
      orderBy: 'name',
      pageSize: 500,
    });

    res.json({ ok: true, archivos: response.data.files });
  } catch (err) {
    console.error('[DRIVE] Error archivos:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/drive/carpetas', async (req, res) => {
  try {
    const drive = getDriveClient();
    const FOLDER_ID = '1A_pJ-3Nqe1_1r0zzX7KwZKNp4mN9oNYs';

    let allFolders = [];
    let pageToken = null;

    do {
      const response = await drive.files.list({
        q: `'${FOLDER_ID}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
        fields: 'nextPageToken, files(id, name, mimeType, modifiedTime)',
        orderBy: 'name',
        pageSize: 500,
        ...(pageToken ? { pageToken } : {}),
      });
      allFolders = allFolders.concat(response.data.files || []);
      pageToken = response.data.nextPageToken || null;
    } while (pageToken);

    console.log(`[DRIVE] Carpetas cargadas: ${allFolders.length}`);
    res.json({ ok: true, carpetas: allFolders });
  } catch (err) {
    console.error('[DRIVE] Error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── ONLYOFFICE ───────────────────────────────────────────────────────────────
app.post('/api/onlyoffice/token', async (req, res) => {
  try {
    const { fileId, fileName, mimeType } = req.body;
    if (!fileId) return res.status(400).json({ ok: false, error: 'fileId requerido' });

    const drive = getDriveClient();
    
    // Obtener link de descarga del archivo
    const fileRes = await drive.files.get({
      fileId,
      fields: 'id, name, mimeType, webViewLink, webContentLink',
    });

    const file = fileRes.data;
    
    // URL de descarga directa para OnlyOffice
    let downloadUrl;
    if (file.mimeType.startsWith('application/vnd.google-apps')) {
      // Exportar Google Docs a formato Office
      const exportMime = {
        'application/vnd.google-apps.document': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'application/vnd.google-apps.spreadsheet': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'application/vnd.google-apps.presentation': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      };
      downloadUrl = `https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=${encodeURIComponent(exportMime[file.mimeType] || 'application/pdf')}&access_token=${(await getDriveClient().context._options.auth.getAccessToken()).token}`;
    } else {
      downloadUrl = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&access_token=TOKEN`;
    }

    const ONLYOFFICE_SECRET = process.env.JWT_SECRET || 'vyz_onlyoffice_secret_2026';
    
    const mimeToExt = {
      'application/vnd.google-apps.document': 'docx',
      'application/vnd.google-apps.spreadsheet': 'xlsx',
      'application/vnd.google-apps.presentation': 'pptx',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
      'application/pdf': 'pdf',
    };
    const fileExt = mimeToExt[file.mimeType] || fileName.split('.').pop() || 'docx';

    const payload = {
      document: {
        fileType: fileExt,
        key: ('doc' + Date.now().toString(36) + Math.random().toString(36).substr(2,5)).substr(0, 20),
        title: fileName,
        url: `https://vargasyzuniga.onrender.com/api/onlyoffice/download/${fileId}`,
        permissions: { download: true, edit: true, print: true },
      },
      documentType: file.mimeType.includes('spreadsheet') ? 'cell' : file.mimeType.includes('presentation') ? 'slide' : 'word',
      editorConfig: {
        callbackUrl: `https://vargasyzuniga.onrender.com/api/onlyoffice/callback/${fileId}`,
        lang: 'es',
        mode: 'edit',
        user: { id: 'abogado', name: 'Abogado V&Z' },
      },
    };

    await registrarAuditoria(req, fileId, fileName, 'abrir_editor');
    const token = jwt.sign(payload, ONLYOFFICE_SECRET);
    payload.token = token;

    res.json({ ok: true, config: payload });
  } catch (err) {
    console.error('[ONLYOFFICE] Error token:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Registrar acceso en auditoría
async function registrarAuditoria(req, fileId, fileName, accion) {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return;
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'vyz_portal_secret_2026');
    const client = new MongoClient(process.env.MONGODB_URI);
    await client.connect();
    const db = client.db();
    await db.collection('auditoria').insertOne({
      abogado_nombre: decoded.nombre,
      abogado_email: decoded.email,
      archivo_id: fileId,
      archivo_nombre: fileName,
      accion,
      fecha: new Date(),
      ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress,
    });
    await client.close();
  } catch (err) {
    console.error('[AUDITORIA] Error:', err.message);
  }
}

// Descargar archivo desde Drive para OnlyOffice
app.get('/api/onlyoffice/download/:fileId', async (req, res) => {
  try {
    const drive = getDriveClient();
    const { fileId } = req.params;
    
    const fileMeta = await drive.files.get({ fileId, fields: 'mimeType, name' });
    const mimeType = fileMeta.data.mimeType;

    if (mimeType.startsWith('application/vnd.google-apps')) {
      const exportMimes = {
        'application/vnd.google-apps.document': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'application/vnd.google-apps.spreadsheet': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'application/vnd.google-apps.presentation': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      };
      const exportMime = exportMimes[mimeType] || 'application/pdf';
      const response = await drive.files.export({ fileId, mimeType: exportMime }, { responseType: 'stream' });
      res.setHeader('Content-Type', exportMime);
      response.data.pipe(res);
    } else {
      const response = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'stream' });
      res.setHeader('Content-Type', mimeType);
      response.data.pipe(res);
    }
  } catch (err) {
    console.error('[ONLYOFFICE] Error download:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Callback de OnlyOffice — guarda el archivo editado de vuelta en Drive
app.post('/api/onlyoffice/callback/:fileId', async (req, res) => {
  try {
    const { fileId } = req.params;
    const { status, url } = req.body;
    
    // Status 2 = documento guardado
    if (status === 2 || status === 6) {
      const https = require('https');
      const drive = getDriveClient();
      
      // Descargar el archivo editado desde OnlyOffice
      const fileStream = await new Promise((resolve, reject) => {
        https.get(url, resolve).on('error', reject);
      });

      // Subir de vuelta a Drive
      await drive.files.update({
        fileId,
        media: { body: fileStream },
      });
      
      console.log(`[ONLYOFFICE] Archivo ${fileId} guardado en Drive`);
    }
    
    res.json({ error: 0 });
  } catch (err) {
    console.error('[ONLYOFFICE] Error callback:', err.message);
    res.json({ error: 1 });
  }
});

// Obtener registros de auditoría (solo admin)
app.get('/api/auditoria', async (req, res) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ ok: false });
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'vyz_portal_secret_2026');
    if (decoded.email !== 'avargas@vargasyzuniga.cl') {
      return res.status(403).json({ ok: false, error: 'Solo el administrador puede ver la auditoría' });
    }
    const client = new MongoClient(process.env.MONGODB_URI);
    await client.connect();
    const db = client.db();
    const registros = await db.collection('auditoria')
      .find({})
      .sort({ fecha: -1 })
      .limit(200)
      .toArray();
    await client.close();
    res.json({ ok: true, registros });
  } catch (err) {
    console.error('[AUDITORIA] Error get:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

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
    res.json({ ok: true, nombre: decoded.nombre, email: decoded.email });
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
  .then(async (db) => {
    // Cargar refresh token desde MongoDB si no está en variable de entorno
    if (!driveRefreshToken) {
      try {
        const cfg = await db.collection('config').findOne({ key: 'google_drive_refresh_token' });
        if (cfg && cfg.value) {
          driveRefreshToken = cfg.value;
          oauth2Client.setCredentials({ refresh_token: driveRefreshToken });
          console.log('[OAUTH] Refresh token cargado desde MongoDB');
        }
      } catch (e) {
        console.error('[OAUTH] Error cargando token desde MongoDB:', e.message);
      }
    }
    app.listen(PORT, () => {
      console.log(`[SERVER] Kit Legal backoffice corriendo en puerto ${PORT}`);
    });

    // Ciclo automatico del watcher del PJUD
    const intervaloMin = parseInt(process.env.PJUD_WATCHER_INTERVALO_MINUTOS || '10', 10);
    setInterval(async () => {
      console.log('[PJUD] Iniciando ciclo automatico...');
      try {
        const resumen = await correrCicloWatcher();
        console.log('[PJUD] Ciclo automatico completado:', resumen);
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
