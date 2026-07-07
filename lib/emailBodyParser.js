function extraerZoom(textoCompleto) {
  const linkMatch = textoCompleto.match(/(https?:\/\/[a-z0-9.-]*zoom\.us\/j\/\d+[^\s"'<>]*)/i);
  const idMatch = textoCompleto.match(/id\s*de\s*reuni[oó]n:?\s*([\d\s]+)/i);
  const codigoMatch = textoCompleto.match(/c[oó]digo\s*de\s*acceso:?\s*(\d+)/i);

  return {
    link: linkMatch ? linkMatch[1].trim() : null,
    meetingId: idMatch ? idMatch[1].replace(/\s+/g, ' ').trim() : null,
    codigoAcceso: codigoMatch ? codigoMatch[1].trim() : null
  };
}

/**
 * Busca una fecha tipo DD.MM.YYYY o DD/MM/YYYY o DD-MM-YYYY en el texto
 * (normalmente viene en el asunto, ej "AGENDA SALA DOS. LUNES 20.10.2025")
 * y la devuelve normalizada como DD/MM/YYYY.
 */
function extraerFechaAgenda(textoCompleto) {
  const match = textoCompleto.match(/\b(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{4})\b/);
  if (!match) return null;
  const [, dia, mes, anio] = match;
  return `${dia.padStart(2, '0')}/${mes.padStart(2, '0')}/${anio}`;
}

function esRelevante(fromAddress, asunto, cuerpo) {
  const desdePjud = /pjud\.cl/i.test(fromAddress || '');
  if (!desdePjud) return false;

  const textoCompleto = `${asunto || ''} ${cuerpo || ''}`.toLowerCase();
  return /audiencia|comparecencia|zoom\.us|sala|programacion|agenda|tabla/.test(textoCompleto);
}

module.exports = { extraerZoom, extraerFechaAgenda, esRelevante };
