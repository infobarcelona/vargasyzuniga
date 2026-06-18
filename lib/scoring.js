/**
 * Score de calificacion del lead (0-100).
 * Adaptado del patron de Kit AutoBot (presupuesto/forma de pago)
 * reemplazado por especificidad del caso + tipo de cliente, ya que
 * la consulta inicial del bufete es gratuita.
 *
 * Distribucion:
 *   - Urgencia:               0-30
 *   - Especificidad del caso: 0-25
 *   - Tipo de cliente:        0-20
 *   - Datos de contacto:      0-15
 *   - Cita propuesta:         0-10
 */

function evaluarUrgencia(urgencia, fechaVisita) {
  const text = ((urgencia || '') + ' ' + (fechaVisita || '')).toLowerCase();
  const tieneFechaConcreta = /lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo|hoy|ma[ñn]ana|pronto|urgente|\d{1,2}\/\d{1,2}\/\d{2,4}/.test(text);
  if (tieneFechaConcreta) return 30;
  if (text.includes('semana')) return 25;
  if (text.includes('meses')) return 10;
  if (text.includes('mes')) return 20;
  return 0;
}

function evaluarEspecificidad(descripcionCaso) {
  if (!descripcionCaso) return 0;
  const text = descripcionCaso.toLowerCase();
  let pts = 0;

  // Nivel de detalle general (largo del relato)
  if (descripcionCaso.length > 120) pts += 10;
  else if (descripcionCaso.length > 60) pts += 6;
  else if (descripcionCaso.length > 20) pts += 3;

  // Menciona un monto de dinero involucrado
  if (/\$|peso|mill[oó]n|millones|clp|monto|deuda de/i.test(text)) pts += 5;

  // Menciona numero de causa, RIT o ROL (ya tiene un proceso en curso)
  if (/\brit\b|\brol\b|causa\s*n?°?\s*\d+|expediente/i.test(text)) pts += 5;

  // Menciona una fecha, plazo o evento concreto (audiencia, notificacion, vencimiento)
  if (/\d{1,2}\/\d{1,2}|\bplazo\b|\bvence\b|audiencia|notificaci[oó]n|citaci[oó]n/i.test(text)) pts += 5;

  return Math.min(pts, 25);
}

function evaluarTipoCliente(tipoCliente) {
  const t = (tipoCliente || '').toLowerCase();
  if (t.includes('empresa') || t.includes('sociedad') || t.includes('compañ') || t.includes('negocio')) return 20;
  if (t.includes('persona') || t.includes('natural') || t.includes('particular')) return 10;
  return 0;
}

function evaluarContacto(data) {
  if (data.nombre && data.telefono && data.email) return 15;
  if (data.nombre && data.telefono) return 10;
  if (data.nombre) return 5;
  return 0;
}

function evaluarCitaPropuesta(data) {
  if (data.fecha_visita && data.hora_visita) return 10;
  if (data.fecha_visita) return 5;
  return 0;
}

function calcularScore(data) {
  const urgencia = evaluarUrgencia(data.urgencia, data.fecha_visita);
  const especificidad = evaluarEspecificidad(data.descripcion_caso);
  const tipoCliente = evaluarTipoCliente(data.tipo_cliente);
  const contacto = evaluarContacto(data);
  const citaPropuesta = evaluarCitaPropuesta(data);

  const score = Math.min(urgencia + especificidad + tipoCliente + contacto + citaPropuesta, 100);

  let clasificacion;
  if (score >= 70) clasificacion = '🟢 INTERÉS ALTO';
  else if (score >= 40) clasificacion = '🟡 INTERÉS MEDIO';
  else clasificacion = '🔴 INTERÉS BAJO';

  return {
    score,
    clasificacion,
    desglose: { urgencia, especificidad, tipoCliente, contacto, citaPropuesta }
  };
}

module.exports = { calcularScore };
