const XLSX = require('xlsx');

function normalizar(texto) {
  return (texto || '')
    .toString()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // quita tildes
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Convierte el valor crudo de una celda de hora de Excel (fraccion del dia,
 * ej 0.388888 = 9:20) a "HH:MM". Si ya viene como Date, lo extrae de ahi.
 */
function convertirHoraExcel(valor) {
  if (valor === null || valor === undefined || valor === '') return null;
  if (typeof valor === 'number') {
    const totalMinutos = Math.round(valor * 24 * 60);
    const h = Math.floor(totalMinutos / 60);
    const m = totalMinutos % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }
  if (valor instanceof Date) {
    return `${String(valor.getUTCHours()).padStart(2, '0')}:${String(valor.getUTCMinutes()).padStart(2, '0')}`;
  }
  return String(valor);
}

/**
 * Lee el buffer del .xlsx y devuelve la lista de bloques (audiencias),
 * cada uno con sus participantes.
 */
function parsearAgenda(buffer) {
  const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: false });
  const nombreHoja = workbook.SheetNames[0];
  const hoja = workbook.Sheets[nombreHoja];
  const filas = XLSX.utils.sheet_to_json(hoja, { header: 1, defval: null });

  // Buscar la fila de encabezados (la que tiene 'N°' en la primera columna
  // y 'PARTICIPANTE' mas adelante en la misma fila).
  let indiceEncabezado = -1;
  for (let i = 0; i < filas.length; i++) {
    const fila = filas[i];
    if (fila[0] && String(fila[0]).trim() === 'N°' && fila.some((c) => normalizar(c) === 'participante')) {
      indiceEncabezado = i;
      break;
    }
  }
  if (indiceEncabezado === -1) {
    throw new Error('No se encontro la fila de encabezados (N°, PARTICIPANTE) en el Excel.');
  }

  const bloques = [];
  let bloqueActual = null;

  for (let i = indiceEncabezado + 1; i < filas.length; i++) {
    const fila = filas[i];
    const tieneNumero = fila[0] !== null && fila[0] !== undefined && fila[0] !== '';
    const tieneParticipante = (fila[7] || fila[8]);

    if (tieneNumero) {
      // Empieza un nuevo bloque (nueva audiencia)
      if (bloqueActual) bloques.push(bloqueActual);
      bloqueActual = {
        numero: fila[0],
        hora: convertirHoraExcel(fila[1]),
        audiencia: fila[2] || '',
        delito: fila[3] || '',
        ruc: fila[4] || '',
        rit: fila[5] || '',
        anio: fila[6] || '',
        participantes: []
      };
      if (tieneParticipante) {
        bloqueActual.participantes.push({ rol: fila[7] || '', nombre: fila[8] || '' });
      }
    } else if (bloqueActual && tieneParticipante) {
      bloqueActual.participantes.push({ rol: fila[7] || '', nombre: fila[8] || '' });
    }
    // Filas completamente vacias se ignoran (no cierran el bloque explicitamente,
    // el siguiente N° es lo que marca el inicio del proximo bloque).
  }
  if (bloqueActual) bloques.push(bloqueActual);

  return bloques;
}

/**
 * Filtra los bloques que tengan a alguno de los abogados como "Defensor privado".
 * Devuelve un array de { ...datosDelBloque, abogadoEncontrado }.
 */
function filtrarPorAbogados(bloques, nombresAbogados) {
  const nombresNormalizados = nombresAbogados.map(normalizar);
  const resultados = [];

  for (const bloque of bloques) {
    for (const p of bloque.participantes) {
      const rolNormalizado = normalizar(p.rol);
      if (!rolNormalizado.includes('defensor privado')) continue;

      const nombreNormalizado = normalizar(p.nombre);
      const match = nombresNormalizados.find((n) => nombreNormalizado === n);
      if (match) {
        resultados.push({
          rit: bloque.rit,
          anio: bloque.anio,
          hora: bloque.hora,
          audiencia: bloque.audiencia,
          delito: bloque.delito,
          abogadoEncontrado: p.nombre
        });
        break; // un bloque solo cuenta una vez aunque calcen ambos abogados
      }
    }
  }

  return resultados;
}


/**
 * Lee el Excel de "Recordatorio de Audiencias" del PJUD.
 * Formato: pestañas Laboral/Familia/Penal con columnas
 * Rit, Fecha audiencia, Tribunal, Sala, Tipo Audiencia, Ruc, Juez, Hora, Caratulado
 */
function parsearRecordatorio(buffer) {
  const XLSX = require('xlsx');
  const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: false });
  const audiencias = [];

  for (const nombreHoja of workbook.SheetNames) {
    const hoja = workbook.Sheets[nombreHoja];
    const filas = XLSX.utils.sheet_to_json(hoja, { header: 1, defval: null });
    
    // Buscar fila de encabezados
    let indiceEncabezado = -1;
    for (let i = 0; i < filas.length; i++) {
      const fila = filas[i];
      if (fila.some(c => normalizar(c) === 'rit') && fila.some(c => normalizar(c).includes('fecha'))) {
        indiceEncabezado = i;
        break;
      }
    }
    if (indiceEncabezado === -1) continue;

    // Mapear columnas
    const encabezados = filas[indiceEncabezado].map(c => normalizar(c));
    const idx = {
      rit: encabezados.indexOf('rit'),
      fecha: encabezados.findIndex(c => c.includes('fecha')),
      tribunal: encabezados.indexOf('tribunal'),
      sala: encabezados.indexOf('sala'),
      tipo: encabezados.findIndex(c => c.includes('tipo')),
      hora: encabezados.indexOf('hora'),
      caratulado: encabezados.indexOf('caratulado'),
    };

    for (let i = indiceEncabezado + 1; i < filas.length; i++) {
      const fila = filas[i];
      if (!fila[idx.rit]) continue;
      
      // Convertir fecha Excel a DD/MM/YYYY
      let fechaStr = null;
      const fechaVal = fila[idx.fecha];
      if (typeof fechaVal === 'number') {
        const date = XLSX.SSF.parse_date_code(fechaVal);
        if (date) {
          fechaStr = String(date.d).padStart(2, '0') + '/' + String(date.m).padStart(2, '0') + '/' + date.y;
        }
      } else if (typeof fechaVal === 'string' && fechaVal.includes('/')) {
        fechaStr = fechaVal;
      }

      audiencias.push({
        rit: String(fila[idx.rit] || ''),
        fecha: fechaStr,
        tribunal: String(fila[idx.tribunal] || ''),
        sala: String(fila[idx.sala] || ''),
        tipo: String(fila[idx.tipo] || ''),
        hora: idx.hora >= 0 ? convertirHoraExcel(fila[idx.hora]) : null,
        caratulado: String(fila[idx.caratulado] || ''),
        competencia: nombreHoja
      });
    }
  }

  return audiencias;
}

module.exports = { parsearAgenda, filtrarPorAbogados, normalizar, parsearRecordatorio };
