'use strict'

/**
 * Crea un tenant de prueba y su usuario super_admin.
 * Uso: node scripts/create-test-tenant.js
 */

require('dotenv').config()
const bcrypt = require('bcrypt')
const { withTransaction, pool } = require('../src/db')
const config = require('../src/config')
const logger = require('../src/config/logger')

const TENANT_SLUG = 'demo'
const TENANT_NAME = 'Demo Company'
const ADMIN_EMAIL = 'admin@demo.com'
const ADMIN_PASSWORD = 'Admin1234!'
const ADMIN_NAME = 'Admin Demo'

async function createTestTenant() {
  await withTransaction(async (client) => {
    // 1. Crear tenant
    const { rows: tenantRows } = await client.query(
      `INSERT INTO tenants (slug, name, plan)
       VALUES ($1, $2, 'pro')
       ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
       RETURNING id, slug, name`,
      [TENANT_SLUG, TENANT_NAME]
    )
    const tenant = tenantRows[0]
    logger.info(`Tenant: ${tenant.name} (${tenant.slug}) — ${tenant.id}`)

    // 2. Crear usuario admin
    const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, config.bcrypt.rounds)

    const { rows: userRows } = await client.query(
      `INSERT INTO users (tenant_id, email, full_name)
       VALUES ($1, $2, $3)
       ON CONFLICT (tenant_id, email) DO UPDATE SET full_name = EXCLUDED.full_name
       RETURNING id, email`,
      [tenant.id, ADMIN_EMAIL, ADMIN_NAME]
    )
    const user = userRows[0]
    logger.info(`User: ${user.email} — ${user.id}`)

    // 3. Guardar credenciales
    await client.query(
      `INSERT INTO user_credentials (user_id, password_hash)
       VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE SET password_hash = EXCLUDED.password_hash`,
      [user.id, passwordHash]
    )

    // 4. Asignar rol super_admin
    const { rows: roleRows } = await client.query(
      `SELECT id FROM roles WHERE name = 'super_admin' AND tenant_id IS NULL`
    )
    if (roleRows.length > 0) {
      await client.query(
        `INSERT INTO user_roles (user_id, role_id)
         VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [user.id, roleRows[0].id]
      )
      logger.info('Role super_admin assigned.')
    }

    logger.info('─────────────────────────────────────')
    logger.info('Test tenant ready. Use these credentials:')
    logger.info(`  Header:   X-Tenant-Slug: ${tenant.slug}`)
    logger.info(`  Email:    ${ADMIN_EMAIL}`)
    logger.info(`  Password: ${ADMIN_PASSWORD}`)
    logger.info('─────────────────────────────────────')
  })
}

createTestTenant()
  .then(() => pool.end())
  .catch((err) => { logger.error(err.message); pool.end(); process.exit(1) })
