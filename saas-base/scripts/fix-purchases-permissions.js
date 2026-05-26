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
  // 1. Insertar permisos de purchases si no existen
  const { rows: existing } = await p.query(
    "SELECT id, resource, action FROM permissions WHERE resource = 'purchases'"
  )
  console.log('Permisos purchases existentes:', existing)

  if (existing.length === 0) {
    console.log('Insertando permisos...')
    await p.query(
      `INSERT INTO permissions (resource, action, description) VALUES
       ('purchases', 'read',   'Ver OC y recepciones'),
       ('purchases', 'create', 'Crear OC y recepciones'),
       ('purchases', 'update', 'Editar y confirmar OC/recepciones')`
    )
    console.log('Permisos insertados.')
  }

  // 2. Usar ID del rol super_admin directamente
  const roleId = 'fb8972ab-cbdc-4d42-af53-4da6343e01bb'

  // 3. Asignar permisos al rol
  const result = await p.query(
    `INSERT INTO role_permissions (role_id, permission_id)
     SELECT $1, id FROM permissions WHERE resource = 'purchases'
     ON CONFLICT DO NOTHING`,
    [roleId]
  )
  console.log('Permisos asignados al super_admin:', result.rowCount)

  // 4. Verificar
  const { rows: check } = await p.query(
    `SELECT p.resource, p.action FROM permissions p
     JOIN role_permissions rp ON rp.permission_id = p.id
     WHERE rp.role_id = $1 AND p.resource = 'purchases'`,
    [roleId]
  )
  console.log('Verificacion final:', check)

  await p.end()
}

run().catch(e => { console.error(e.message); p.end() })
