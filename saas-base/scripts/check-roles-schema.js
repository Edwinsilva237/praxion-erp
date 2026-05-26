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
  const { rows: roleCols } = await p.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'roles' ORDER BY ordinal_position`
  )
  console.log('Columnas roles:', roleCols.map(r => r.column_name))

  const { rows: roles } = await p.query('SELECT * FROM roles LIMIT 5')
  console.log('Roles:', roles)

  const { rows: urCols } = await p.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'user_roles' ORDER BY ordinal_position`
  )
  console.log('Columnas user_roles:', urCols.map(r => r.column_name))

  await p.end()
}

run().catch(e => { console.error(e.message); p.end() })
