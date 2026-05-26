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
  const { rows } = await p.query(`
    SELECT p.name, p.resource, p.action
    FROM permissions p
    JOIN role_permissions rp ON rp.permission_id = p.id
    JOIN roles r ON r.id = rp.role_id
    WHERE r.name = 'super_admin'
    AND p.resource = 'purchases'
  `)
  console.log('Permisos purchases en super_admin:', rows)
  await p.end()
}

run().catch(e => { console.error(e.message); p.end() })
