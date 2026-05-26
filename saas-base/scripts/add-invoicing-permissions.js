'use strict'
require('dotenv').config()
const { Pool } = require('pg')
const p = new Pool({
  host: process.env.DB_HOST, port: process.env.DB_PORT,
  database: process.env.DB_NAME, user: process.env.DB_USER, password: process.env.DB_PASSWORD,
})
async function run() {
  await p.query(
    `INSERT INTO permissions (resource, action, description) VALUES
     ('invoicing', 'read',   'Ver facturas emitidas'),
     ('invoicing', 'create', 'Crear facturas'),
     ('invoicing', 'update', 'Cancelar facturas')
     ON CONFLICT (resource, action) DO NOTHING`
  )
  console.log('Permisos invoicing insertados.')
  const { rows: role } = await p.query("SELECT id FROM roles WHERE name = 'super_admin' LIMIT 1")
  const result = await p.query(
    `INSERT INTO role_permissions (role_id, permission_id)
     SELECT $1, id FROM permissions WHERE resource = 'invoicing'
     ON CONFLICT DO NOTHING`,
    [role[0].id]
  )
  console.log('Permisos asignados al super_admin:', result.rowCount)
  await p.end()
}
run().catch(e => { console.error(e.message); p.end() })
