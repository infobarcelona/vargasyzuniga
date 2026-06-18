require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { ImapFlow } = require('imapflow');

async function main() {
  const rutaEml = process.argv[2] || path.join(__dirname, '..', 'correo_prueba_pjud.eml');

  if (!fs.existsSync(rutaEml)) {
    console.error(`No se encontro el archivo: ${rutaEml}`);
    console.error('Uso: node scripts/inyectar-correo-prueba.js [ruta-al-archivo.eml]');
    process.exit(1);
  }

  const contenido = fs.readFileSync(rutaEml);

  const client = new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: {
      user: process.env.GMAIL_USER,
      pass: process.env.GMAIL_APP_PASSWORD
    },
    logger: false
  });

  await client.connect();
  try {
    const resultado = await client.append('INBOX', contenido, ['\\Seen'], new Date());
    console.log('Correo de prueba inyectado correctamente en la bandeja:', process.env.GMAIL_USER);
    console.log(resultado);
  } finally {
    await client.logout();
  }
}

main().catch((err) => {
  console.error('Error al inyectar el correo de prueba:', err);
  process.exit(1);
});
