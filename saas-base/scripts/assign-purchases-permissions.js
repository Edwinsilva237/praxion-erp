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
  const { rows } = await p.query("SELECT id FROM roles WHERE name = 'super_admin' LIMIT 1")
  if (!rows.length) { console.log('Rol super_admin no encontrado'); return }
  const roleId = rows[0].id

  const result = await p.query(
    `INSERT INTO role_permissions (role_id, permission_id)
     SELECT $1, id FROM permissions WHERE resource = 'purchases'
     ON CONFLICT DO NOTHING`,
    [roleId]
  )
  console.log(`Permisos de purchases asignados al super_admin: ${result.rowCount}`)
  await p.end()
}

run().catch(e => { console.error(e.message); p.end() })
