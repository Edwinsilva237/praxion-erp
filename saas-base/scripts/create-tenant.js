'use strict'

/**
 * Crea un tenant + super_admin en la BD actual. Pensado para arrancar
 * un entorno nuevo (incluida producción).
 *
 * Acepta los datos via env vars — no hay defaults peligrosos para evitar
 * que alguien ejecute esto en prod por accidente y termine con un admin
 * con credenciales públicas.
 *
 * Uso:
 *   TENANT_SLUG=praxion \
 *   TENANT_NAME="Praxion Demo" \
 *   ADMIN_EMAIL=admin@example.com \
 *   ADMIN_PASSWORD='clave-fuerte' \
 *   ADMIN_NAME="Admin Praxion" \
 *   node scripts/create-tenant.js
 *
 * Idempotente: si el tenant/usuario ya existen, los actualiza (refresca
 * password y nombre). Útil para resetear credenciales.
 *
 * Usa withBypass() para que las RLS policies no estorben la creación de
 * datos cross-tenant fundamentales.
 */

require('dotenv').config()
const bcrypt = require('bcrypt')
const { withTransaction, withBypass, pool } = require('../src/db')
const config = require('../src/config')

const required = ['TENANT_SLUG', 'TENANT_NAME', 'ADMIN_EMAIL', 'ADMIN_PASSWORD']
const missing = required.filter((k) => !process.env[k])
if (missing.length > 0) {
  console.error(`Faltan variables de entorno: ${missing.join(', ')}`)
  console.error('Ver header del script para el uso correcto.')
  process.exit(1)
}

const TENANT_SLUG    = process.env.TENANT_SLUG
const TENANT_NAME    = process.env.TENANT_NAME
const ADMIN_EMAIL    = process.env.ADMIN_EMAIL.toLowerCase().trim()
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD
const ADMIN_NAME     = process.env.ADMIN_NAME || ADMIN_EMAIL.split('@')[0]

if (ADMIN_PASSWORD.length < 8) {
  console.error('ADMIN_PASSWORD debe tener al menos 8 caracteres.')
  process.exit(1)
}

async function createTenant() {
  await withBypass(() => withTransaction(async (client) => {
    const { rows: tenantRows } = await client.query(
      `INSERT INTO tenants (slug, name, plan)
       VALUES ($1, $2, 'owner')
       ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
       RETURNING id, slug, name`,
      [TENANT_SLUG, TENANT_NAME]
    )
    const tenant = tenantRows[0]

    const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, config.bcrypt.rounds)

    const { rows: userRows } = await client.query(
      `INSERT INTO users (tenant_id, email, full_name)
       VALUES ($1, $2, $3)
       ON CONFLICT (tenant_id, email) DO UPDATE SET full_name = EXCLUDED.full_name
       RETURNING id, email`,
      [tenant.id, ADMIN_EMAIL, ADMIN_NAME]
    )
    const user = userRows[0]

    await client.query(
      `INSERT INTO user_credentials (user_id, password_hash)
       VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE SET password_hash = EXCLUDED.password_hash`,
      [user.id, passwordHash]
    )

    const { rows: roleRows } = await client.query(
      `SELECT id FROM roles WHERE name = 'super_admin' AND tenant_id IS NULL`
    )
    if (roleRows.length === 0) {
      throw new Error('Rol global super_admin no encontrado — ¿corrieron las migraciones?')
    }
    await client.query(
      `INSERT INTO user_roles (user_id, role_id)
       VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [user.id, roleRows[0].id]
    )

    console.log('─────────────────────────────────────')
    console.log('Tenant + super_admin listos:')
    console.log(`  Tenant slug: ${tenant.slug}`)
    console.log(`  Tenant ID:   ${tenant.id}`)
    console.log(`  Email:       ${ADMIN_EMAIL}`)
    console.log(`  User ID:     ${user.id}`)
    console.log('─────────────────────────────────────')
  }))
}

createTenant()
  .then(() => pool.end())
  .catch((err) => {
    console.error('Error:', err.message)
    pool.end()
    process.exit(1)
  })
