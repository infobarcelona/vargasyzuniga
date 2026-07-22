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
  if (!textoCompleto) return null;

  // Formato DD.MM.YYYY o DD/MM/YYYY o DD-MM-YYYY
  const m1 = textoCompleto.match(/\b(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{4})\b/);
  if (m1) {
    const [, dia, mes, anio] = m1;
    return `${dia.padStart(2, '0')}/${mes.padStart(2, '0')}/${anio}`;
  }

  // Formato DD.MM.YY o DD/MM/YY (año de 2 dígitos)
  const m2 = textoCompleto.match(/\b(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{2})\b/);
  if (m2) {
    const [, dia, mes, anio] = m2;
    return `${dia.padStart(2, '0')}/${mes.padStart(2, '0')}/20${anio}`;
  }

  // Formato escrito: "lunes 07 de julio de 2026" o "07 de julio de 2026"
  const MESES = { enero:1, febrero:2, marzo:3, abril:4, mayo:5, junio:6,
    julio:7, agosto:8, septiembre:9, octubre:10, noviembre:11, diciembre:12 };
  const m3 = textoCompleto.toLowerCase().match(/\b(\d{1,2})\s+de\s+(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)\s+de\s+(\d{4})\b/);
  if (m3) {
    const [, dia, mesNombre, anio] = m3;
    const mes = MESES[mesNombre];
    return `${dia.padStart(2, '0')}/${String(mes).padStart(2, '0')}/${anio}`;
  }

  return null;
}


function extraerHoraAudiencia(textoCompleto) {
  if (!textoCompleto) return null;
  const t = textoCompleto.toLowerCase();
  const m1 = t.match(/\b(\d{1,2})[:.](\d{2})\s*(?:horas?|hrs?\.?|am|pm)?\b/);
  if (m1) {
    const hora = m1[1].padStart(2, '0');
    const min = m1[2];
    return hora + ':' + min;
  }
  return null;
}

function extraerLugarAudiencia(textoCompleto) {
  if (!textoCompleto) return null;
  const t = textoCompleto;
  const sala = t.match(/sala\s*(?:n[o]?\s*)?(\d+|[a-zA-Z]+)/i);
  const direccion = t.match(/(?:ubicado en|en calle|en\s+)([a-z0-9\s#-]+?)(?:,|\.|\n)/i);
  const comuna = t.match(/comuna\s+(?:de\s+)?([a-zA-Z\s]+?)(?:,|\.|$|\n)/i);
  let lugar = '';
  if (sala) lugar += 'Sala ' + sala[1].toUpperCase() + ' — ';
  if (direccion) lugar += direccion[1].trim();
  if (comuna) lugar += ', ' + comuna[1].trim();
  return lugar || null;
}

function esRelevante(fromAddress, asunto, cuerpo) {
  const desdePjud = /pjud\.cl/i.test(fromAddress || '');
  if (!desdePjud) return false;

  // Descartar correos que NO son citaciones a audiencia
  const asuntoLower = (asunto || '').toLowerCase();
  if (/notificaci[oó]n litigante|notificacion litigante|estado diario|movimientos de sus causas|oficina judicial virtual informa|notificaci[oó]n de resoluci[oó]n|notificacion de resolucion|recordatorio de audiencias/i.test(asuntoLower)) {
    return false;
  }

  const textoCompleto = `${asunto || ''} ${cuerpo || ''}`.toLowerCase();
  return /audiencia|comparecencia|zoom\.us|sala|programacion|agenda|tabla|reprogramacion|reprogramación|reprogramada|nueva fecha|nuevo día|nuevo dia|se fija|fijandose|fijándose|tribunal|juzgado|corte|citacion|citación|notificacion|notificación judicial|resolucion|resolución|vista de causa|alegato|alegatos|juicio oral|juicio simplificado|imputado|defensor|fiscal|víctima|victima|ministerio público|defensoría|defensoria|turno|reemplaz|suspendida|suspendido|postergada|postergado|nueva hora|nuevo horario|cambio de fecha|cambio de hora|trasladada|trasladado|habilitado|habilitada/.test(textoCompleto);
}

module.exports = { extraerZoom, extraerFechaAgenda, esRelevante, extraerHoraAudiencia, extraerLugarAudiencia };
