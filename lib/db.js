const { MongoClient } = require('mongodb');

let client;
let db;

async function connectDB() {
  if (db) return db;

  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('Falta MONGODB_URI en el .env');

  client = new MongoClient(uri);
  await client.connect();

  db = client.db(process.env.MONGODB_DB_NAME || 'kit_legal_vyz');
  console.log(`[DB] Conectado a MongoDB, base: ${db.databaseName}`);
  return db;
}

function getLeadsCollection() {
  if (!db) throw new Error('DB no inicializada. Llama a connectDB() primero.');
  return db.collection('leads');
}

function getAudienciasProcesadasCollection() {
  if (!db) throw new Error('DB no inicializada. Llama a connectDB() primero.');
  return db.collection('audiencias_procesadas');
}

module.exports = { connectDB, getLeadsCollection, getAudienciasProcesadasCollection };
