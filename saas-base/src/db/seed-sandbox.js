'use strict'

/**
 * Crea (o re-asegura) un tenant 'sandbox' marcado como is_sandbox=true,
 * con un usuario admin, datos fiscales con RFC genérico de pruebas SAT,
 * una cuenta bancaria de prueba y un cliente demo.
 *
 * Idempotente: si el tenant ya existe, NO recrea cosas — solo asegura
 * que is_sandbox=true. Para vaciar movimientos transaccionales corre
 * `npm run reset:sandbox`.
 *
 * Uso:
 *   npm run seed:sandbox
 *
 * Variables opcionales:
 *   SANDBOX_SLUG          (default: 'sandbox')
 *   SANDBOX_TENANT_NAME   (default: 'Sandbox · Pruebas')
 *   SANDBOX_ADMIN_EMAIL   (default: 'sandbox@local')
 *   SANDBOX_ADMIN_PASS    (default: 'sandbox123')
 *   SANDBOX_ADMIN_NAME    (default: 'Admin Sandbox')
 */

require('dotenv').config()
const bcrypt = require('bcrypt')
const { withTransaction, pool } = require('./index')
const config = require('../config')
const logger = require('../config/logger')

const SLUG       = process.env.SANDBOX_SLUG       || 'sandbox'
const TENANT_NM  = process.env.SANDBOX_TENANT_NAME|| 'Sandbox · Pruebas'
const ADMIN_MAIL = process.env.SANDBOX_ADMIN_EMAIL|| 'sandbox@sandbox.local'
const ADMIN_PASS = process.env.SANDBOX_ADMIN_PASS || 'sandbox123'
const ADMIN_NAME = process.env.SANDBOX_ADMIN_NAME || 'Admin Sandbox'

// RFCs genéricos SAT para pruebas (Facturapi sandbox los acepta):
//   EKU9003173C9 — persona moral genérica
//   XAXX010101000 — público en general
const EMISOR_RFC      = 'EKU9003173C9'
const EMISOR_RAZON    = 'ESCUELA KEMPER URGATE SA DE CV'
const EMISOR_REGIME   = '601'   // General de Ley Personas Morales
const EMISOR_ZIP      = '42501'

async function seed() {
  await withTransaction(async (client) => {
    // ── Tenant ───────────────────────────────────────────────────────────
    let { rows: tr } = await client.query(
      `SELECT id, slug, is_sandbox FROM tenants WHERE slug = $1`, [SLUG]
    )
    let tenant
    let created = false
    if (tr.length) {
      tenant = tr[0]
      if (!tenant.is_sandbox) {
        await client.query(
          `UPDATE tenants SET is_sandbox = TRUE, is_active = TRUE WHERE id = $1`,
          [tenant.id]
        )
        logger.info(`Tenant existente '${SLUG}' marcado como sandbox.`)
      } else {
        logger.info(`Tenant sandbox '${SLUG}' ya existía — sin cambios al tenant.`)
      }
    } else {
      const { rows } = await client.query(
        `INSERT INTO tenants (slug, name, plan, is_sandbox)
         VALUES ($1, $2, 'free', TRUE)
         RETURNING id, slug`,
        [SLUG, TENANT_NM]
      )
      tenant = rows[0]
      created = true
      logger.info(`Tenant sandbox creado: ${tenant.slug} (${tenant.id})`)
    }

    // ── Usuario admin ────────────────────────────────────────────────────
    const { rows: ur } = await client.query(
      `SELECT id FROM users WHERE email = $1 AND tenant_id = $2`,
      [ADMIN_MAIL.toLowerCase(), tenant.id]
    )
    let userId
    if (ur.length) {
      userId = ur[0].id
      logger.info(`Usuario admin '${ADMIN_MAIL}' ya existía.`)
    } else {
      const { rows } = await client.query(
        `INSERT INTO users (tenant_id, email, full_name) VALUES ($1, $2, $3)
         RETURNING id`,
        [tenant.id, ADMIN_MAIL.toLowerCase(), ADMIN_NAME]
      )
      userId = rows[0].id
      const hash = await bcrypt.hash(ADMIN_PASS, config.bcrypt.rounds)
      await client.query(
        `INSERT INTO user_credentials (user_id, password_hash) VALUES ($1, $2)`,
        [userId, hash]
      )
      const { rows: rr } = await client.query(
        `SELECT id FROM roles WHERE name = 'super_admin' AND tenant_id IS NULL`
      )
      if (!rr.length) throw new Error('Role super_admin no existe. Corre `npm run seed` primero.')
      await client.query(
        `INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [userId, rr[0].id]
      )
      logger.info(`Usuario admin creado: ${ADMIN_MAIL} / ${ADMIN_PASS}`)
    }

    // ── Datos fiscales del emisor ───────────────────────────────────────
    await client.query(
      `INSERT INTO tenant_fiscal_info (tenant_id, rfc, razon_social, tax_regime, zip_code, serie_default)
       VALUES ($1, $2, $3, $4, $5, 'A')
       ON CONFLICT (tenant_id) DO UPDATE
         SET rfc = EXCLUDED.rfc, razon_social = EXCLUDED.razon_social,
             tax_regime = EXCLUDED.tax_regime, zip_code = EXCLUDED.zip_code`,
      [tenant.id, EMISOR_RFC, EMISOR_RAZON, EMISOR_REGIME, EMISOR_ZIP]
    )

    // ── Cuenta bancaria demo ────────────────────────────────────────────
    await client.query(
      `INSERT INTO bank_accounts (tenant_id, bank_name, alias, account_number, currency)
       SELECT $1, 'BBVA', 'Sandbox MXN', '0000000001', 'MXN'
        WHERE NOT EXISTS (
          SELECT 1 FROM bank_accounts WHERE tenant_id = $1
        )`,
      [tenant.id]
    )

    // ── Cliente demo (persona moral con RFC genérico) ───────────────────
    await client.query(
      `INSERT INTO business_partners
         (tenant_id, type, name, tax_name, rfc, tax_regime_code, zip_code,
          payment_method, payment_form, cfdi_use, credit_type, credit_days, is_active)
       SELECT $1, 'customer', 'CLIENTE DEMO SANDBOX', 'CLIENTE DEMO SA DE CV',
              'XAXX010101000', '616', $2,
              'PUE', '03', 'G03', 'credit', 15, TRUE
        WHERE NOT EXISTS (
          SELECT 1 FROM business_partners
           WHERE tenant_id = $1 AND rfc = 'XAXX010101000'
        )`,
      [tenant.id, EMISOR_ZIP]
    )

    logger.info('')
    logger.info('════════════════════════════════════════════════════════════')
    logger.info(`  SANDBOX listo — slug:    ${SLUG}`)
    logger.info(`              · email:   ${ADMIN_MAIL}`)
    logger.info(`              · pass:    ${ADMIN_PASS}`)
    logger.info(`              · RFC:     ${EMISOR_RFC}`)
    logger.info('')
    logger.info('  Login: pon "sandbox" en el campo Tenant y entra.')
    logger.info('  Para vaciar movimientos: npm run reset:sandbox')
    logger.info('  Asegura FACTURAPI_KEY_TEST en .env para timbrar sin SAT real.')
    logger.info('════════════════════════════════════════════════════════════')
    if (created) logger.info('(Tenant creado desde cero.)')
  })
}

seed()
  .then(() => pool.end())
  .catch((err) => {
    logger.error('Seed sandbox falló:', err.message)
    if (err.stack) console.error(err.stack)
    pool.end()
    process.exit(1)
  })
