'use strict'
require('dotenv').config()
const { Pool } = require('pg')

const p = new Pool({
  host:     process.env.DB_HOST,
  port:     process.env.DB_PORT,
  database: process.env.DB_NAME,
  user:     process.env.DB_USER,
  password: process.env.DB_PASSWORD,
})

async function run() {
  // Ver columnas de la tabla permissions
  const { rows: cols } = await p.query(
    `SELECT column_name, data_type
     FROM information_schema.columns
     WHERE table_name = 'permissions'
     ORDER BY ordinal_position`
  )
  console.log('Columnas de permissions:', cols)

  // Ver primeros registros
  const { rows: sample } = await p.query('SELECT * FROM permissions LIMIT 5')
  console.log('Muestra:', sample)

  await p.end()
}

run().catch(e => { console.error(e.message); p.end() })
