const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');

/**
 * Se conecta a la bandeja por IMAP, revisa los correos recientes,
 * y devuelve solo los que: (a) no han sido procesados antes (segun
 * su Message-ID, contra la coleccion de Mongo) y (b) son relevantes
 * segun el filtro que se le pase.
 *
 * @param {(messageId: string) => Promise<boolean>} yaProcesado
 * @param {number} diasHaciaAtras cuantos dias atras revisar (ventana de busqueda)
 */
async function leerCorreosNuevos({ yaProcesado, diasHaciaAtras = 7 }) {
  const client = new ImapFlow({
    host: process.env.IMAP_HOST || 'mail.vargasyzuniga.cl',
    port: parseInt(process.env.IMAP_PORT || '993'),
    secure: true,
    auth: {
      user: process.env.IMAP_USER || process.env.GMAIL_USER,
      pass: process.env.IMAP_PASS || process.env.GMAIL_APP_PASSWORD
    },
    logger: false,
    connectionTimeout: 30000,
    greetingTimeout: 30000,
    socketTimeout: 60000,
    tls: { rejectUnauthorized: false }
  });

  const resultados = [];

  await client.connect();
  try {
    const lock = await client.getMailboxLock('INBOX');
    try {
      const desde = new Date();
      desde.setDate(desde.getDate() - diasHaciaAtras);

      // Buscamos correos del PJUD dentro de la ventana de dias.
      const uids = await client.search({
        since: desde,
        from: '@pjud.cl'
      });
      console.log('[PJUD] Correos encontrados en Gmail:', uids.length);

      for (const uid of uids) {
        const { source } = await client.fetchOne(uid, { source: true });
        const parsed = await simpleParser(source);

        const messageId = parsed.messageId || `${uid}-${parsed.date?.toISOString()}`;
        console.log('[PJUD] Correo:', parsed.from?.text, '|', parsed.subject);
        if (await yaProcesado(messageId)) continue;

        resultados.push({
          messageId,
          from: parsed.from?.text || '',
          subject: parsed.subject || '',
          textBody: parsed.text || '',
          htmlBody: parsed.html || '',
          attachments: (parsed.attachments || []).filter((a) =>
            /\.xlsx?$/i.test(a.filename || '')
          )
        });
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout();
  }

  return resultados;
}

module.exports = { leerCorreosNuevos };
