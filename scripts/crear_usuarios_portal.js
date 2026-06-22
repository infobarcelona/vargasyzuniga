require('dotenv').config();
const { MongoClient } = require('mongodb');
const bcrypt = require('bcryptjs');

const usuarios = [
  {
    nombre: 'Alejandro Vargas Casas',
    email: 'avargas@vargasyzuniga.cl',
    password: 'AGV@VyZ8040!',
  },
  {
    nombre: 'Mónica Zúñiga Lillo',
    email: 'mzuniga@vargasyzuniga.cl',
    password: 'MPZ@VyZ2005!',
  },
  {
    nombre: 'Nicole Muñoz Poblete',
    email: 'nmunoz@vargasyzuniga.cl',
    password: 'NsM@VyZ2026!',
  },
];

async function main() {
  const client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  const db = client.db();
  const col = db.collection('portal_users');

  for (const u of usuarios) {
    const hash = await bcrypt.hash(u.password, 12);
    await col.updateOne(
      { email: u.email },
      { $set: { nombre: u.nombre, email: u.email, password_hash: hash, creado: new Date() } },
      { upsert: true }
    );
    console.log(`✓ Usuario creado/actualizado: ${u.nombre} (${u.email})`);
  }

  await client.close();
  console.log('Listo.');
}

main().catch(console.error);
