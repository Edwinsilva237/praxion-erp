'use strict'

const bcrypt = require('bcrypt')
const { withTransaction, query } = require('../../db')
const config = require('../../config')
const logger = require('../../config/logger')
const { enqueueEmail } = require('../../queues/emailQueue')
const { welcomeEmail } = require('../email/templates')

async function provisionTenant({ slug, name, plan = 'free', adminEmail, adminPassword, adminName, sendInitialPassword = false }) {
  return withTransaction(async (client) => {
    const { rows: tenantRows } = await client.query(
      `INSERT INTO tenants (slug, name, plan) VALUES ($1, $2, $3)
       RETURNING id, slug, name, plan`,
      [slug.toLowerCase().trim(), name.trim(), plan]
    )
    const tenant = tenantRows[0]
    logger.info(`Tenant created: ${tenant.slug} (${tenant.id})`)

    const passwordHash = await bcrypt.hash(adminPassword, config.bcrypt.rounds)

    const { rows: userRows } = await client.query(
      `INSERT INTO users (tenant_id, email, full_name) VALUES ($1, $2, $3)
       RETURNING id, email, full_name`,
      [tenant.id, adminEmail.toLowerCase().trim(), adminName.trim()]
    )
    const user = userRows[0]

    await client.query(
      `INSERT INTO user_credentials (user_id, password_hash) VALUES ($1, $2)`,
      [user.id, passwordHash]
    )

    const { rows: roleRows } = await client.query(
      `SELECT id FROM roles WHERE name = 'super_admin' AND tenant_id IS NULL`
    )

    if (roleRows.length === 0) throw new Error('System role super_admin not found. Run seed first.')

    await client.query(
      `INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)`,
      [user.id, roleRows[0].id]
    )

    // El admin que provisiona el tenant es su 'owner' (membresía explícita).
    // Sin esta fila el user no podría aparecer en su switcher ni cambiar a
    // otros tenants donde se le invite después.
    await client.query(
      `INSERT INTO tenant_memberships (user_id, tenant_id, role)
       VALUES ($1, $2, 'owner')
       ON CONFLICT (user_id, tenant_id) DO NOTHING`,
      [user.id, tenant.id]
    )

    // Almacenes default: crear uno por cada tipo activo en tenant_warehouse_types
    // (raw_material, packaging, wip, finished_product). Sin esto el tenant queda
    // operativo en producción solo a medias — recordProductionValidation no
    // puede mover MP→WIP→PT y los movimientos se pierden silenciosos.
    // Acompañado de mig 164 que backfilleó tenants vivos a los que les faltaban.
    await client.query(
      `INSERT INTO warehouses
         (tenant_id, warehouse_type_id, name, type, is_active)
       SELECT $1, twt.id, twt.name,
              (CASE twt.system_role
                WHEN 'input'  THEN CASE twt.code WHEN 'embalaje' THEN 'packaging' ELSE 'raw_material' END
                WHEN 'output' THEN 'finished_product'
                WHEN 'wip'    THEN 'wip'
              END)::warehouse_type,
              true
         FROM tenant_warehouse_types twt
        WHERE twt.tenant_id = $1
          AND twt.is_active = true
          AND twt.system_role IN ('input','output','wip')
          AND NOT EXISTS (
            SELECT 1 FROM warehouses w
             WHERE w.tenant_id = $1 AND w.warehouse_type_id = twt.id
          )`,
      [tenant.id]
    )

    // Crear suscripción trial: plan gratis, status='trialing',
    // trial_end = NOW + STRIPE_TRIAL_DAYS. Sin contactar Stripe — solo se
    // contacta cuando el tenant decide pagar (createCheckoutSession).
    const { rows: planRows } = await client.query(
      `SELECT id FROM plans WHERE slug = 'free' LIMIT 1`
    )
    if (planRows.length > 0) {
      const trialDays = config.stripe.trialDays
      await client.query(
        `INSERT INTO subscriptions (tenant_id, plan_id, status, current_period_start, current_period_end, trial_end)
         VALUES ($1, $2, 'trialing', NOW(), NOW() + ($3 || ' days')::interval, NOW() + ($3 || ' days')::interval)`,
        [tenant.id, planRows[0].id, String(trialDays)]
      )
      logger.info(`Trial creado: ${tenant.slug} (${trialDays} días, plan=free)`)
    } else {
      logger.warn(`No se creó trial: plan 'free' no existe en BD. ¿Corriste la migración 096?`)
    }

    logger.info(`Tenant provisioned: ${tenant.slug} — admin: ${user.email}`)

    // Enviar email de bienvenida (fuera de la transacción para no bloquearla)
    setImmediate(async () => {
      try {
        await enqueueEmail({
          tenantId: tenant.id,
          to:      user.email,
          subject: `Bienvenido a ${config.email.fromName}`,
          html:    welcomeEmail({
            fullName:   user.full_name,
            email:      user.email,
            tenantName: tenant.name,
            tenantSlug: tenant.slug,
            tempPassword: sendInitialPassword ? adminPassword : null,
          }),
        })
      } catch (err) {
        logger.warn('Welcome email failed', { tenantId: tenant.id, error: err.message })
      }
    })

    return { tenant, user }
  })
}

async function listTenants({ page = 1, limit = 20 }) {
  const offset = (page - 1) * limit
  const { rows } = await query(
    `SELECT id, slug, name, plan, is_active, created_at,
            (SELECT COUNT(*) FROM users WHERE tenant_id = tenants.id) AS user_count
     FROM tenants ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
    [limit, offset]
  )
  const { rows: countRows } = await query(`SELECT COUNT(*) FROM tenants`)
  return { data: rows, total: parseInt(countRows[0].count, 10), page, limit }
}

module.exports = { provisionTenant, listTenants }
