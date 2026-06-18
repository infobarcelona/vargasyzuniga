const { initAuthCreds, BufferJSON } = require('@whiskeysockets/baileys');

/**
 * Reemplaza el comportamiento por defecto de Baileys (useMultiFileAuthState,
 * que guarda la sesion en archivos locales) por almacenamiento en MongoDB.
 * Esto es necesario porque en Render el disco se borra en cada reinicio o
 * redeploy — sin esto, habria que volver a escanear el QR cada vez.
 *
 * @param {import('mongodb').Collection} authCollection coleccion dedicada,
 *   por convencion "whatsapp_auth"
 */
async function useMongoAuthState(authCollection) {
  const escribir = async (key, data) => {
    await authCollection.updateOne(
      { _id: key },
      { $set: { value: JSON.stringify(data, BufferJSON.replacer) } },
      { upsert: true }
    );
  };

  const leer = async (key) => {
    const doc = await authCollection.findOne({ _id: key });
    if (!doc) return null;
    try {
      return JSON.parse(doc.value, BufferJSON.reviver);
    } catch (e) {
      return null;
    }
  };

  const eliminar = async (key) => {
    await authCollection.deleteOne({ _id: key });
  };

  const credsGuardadas = await leer('creds');
  const creds = credsGuardadas || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          await Promise.all(
            ids.map(async (id) => {
              const value = await leer(`${type}-${id}`);
              data[id] = value;
            })
          );
          return data;
        },
        set: async (data) => {
          const tareas = [];
          for (const categoria in data) {
            for (const id in data[categoria]) {
              const value = data[categoria][id];
              const key = `${categoria}-${id}`;
              tareas.push(value ? escribir(key, value) : eliminar(key));
            }
          }
          await Promise.all(tareas);
        }
      }
    },
    saveCreds: async () => {
      await escribir('creds', creds);
    }
  };
}

/**
 * Borra por completo la sesion guardada — se usa cuando WhatsApp informa
 * que la sesion fue cerrada desde el telefono (logout), para que el
 * proximo intento de conexion arranque limpio y genere un QR nuevo en
 * vez de quedarse atascado con credenciales muertas.
 */
async function limpiarSesion(authCollection) {
  await authCollection.deleteMany({});
}

module.exports = { useMongoAuthState, limpiarSesion };
