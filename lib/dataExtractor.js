/**
 * Extrae el bloque ###DATA###{...}###END### de la respuesta del modelo,
 * fusiona los valores nuevos sobre el leadData existente (sin borrar
 * datos ya capturados si el modelo manda un campo vacío de nuevo),
 * y devuelve el texto limpio (sin el bloque) para mostrar al cliente.
 */
function extraerYFusionarDatos(textoCrudo, leadDataActual) {
  const match = textoCrudo.match(/###DATA###([\s\S]*?)###END###/);
  const cleanReply = textoCrudo.replace(/###DATA###[\s\S]*?###END###/, '').trim();

  if (!match) {
    return { leadData: leadDataActual, cleanReply, parsedOk: false };
  }

  let nuevo;
  try {
    nuevo = JSON.parse(match[1].trim());
  } catch (e) {
    return { leadData: leadDataActual, cleanReply, parsedOk: false, parseError: e.message };
  }

  const leadData = { ...leadDataActual };
  Object.keys(nuevo).forEach((key) => {
    const val = nuevo[key];
    if (val !== '' && val !== false && val !== null && val !== undefined) {
      leadData[key] = val;
    }
  });

  return { leadData, cleanReply, parsedOk: true };
}

module.exports = { extraerYFusionarDatos };
