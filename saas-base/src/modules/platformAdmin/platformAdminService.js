'use strict'

const { query, withBypass } = require('../../db')
const tenantSvc = require('../tenants/tenantService')
const config = require('../../config')

// Lista canónica de módulos que el super-admin puede prender/apagar.
// El frontend espeja esta lista para construir el editor de interruptores.
const SUPPORTED_MODULES = [
  'invoicing',
  'production',
  'inventory',
  'purchases',
  'quotations',
  'sales',
  'petty_cash',
  'reports',
]

const VALID_PLANS = ['free', 'starter', 'pro', 'enterprise', 'owner']
const HEX_REGEX   = /^#[0-9A-Fa-f]{6}$/

/**
 * Lista todos los tenants con su estado de pago, plan, modulos, usuarios y
 * última fecha de actividad. Pensado para la tabla del super-admin.
 */
async function listAllTenants({ q = null, page = 1, limit = 50 } = {}) {
  const offset = (page - 1) * limit
  const params = []
  let where = '1=1'
  if (q && q.trim()) {
    params.push(`%${q.trim().toLowerCase()}%`)
    where += ` AND (LOWER(t.name) LIKE $${params.length} OR LOWER(t.slug) LIKE $${params.length} OR LOWER(COALESCE(t.display_name,'')) LIKE $${params.length})`
  }

  params.push(limit, offset)
  const sql = `
    SELECT
      t.id, t.slug, t.name, t.display_name, t.plan, t.is_active, t.is_sandbox,
      t.modules, t.brand_color_primary, t.brand_color_secondary,
      t.suspended_reason, t.suspended_at,
      t.created_at,
      (SELECT COUNT(*)::int FROM users u WHERE u.tenant_id = t.id) AS user_count,
      (SELECT MAX(u.last_login_at) FROM users u WHERE u.tenant_id = t.id) AS last_login_at,
      s.status                 AS subscription_status,
      s.trial_end,
      s.current_period_end,
      s.cancel_at_period_end,
      p.slug                   AS subscription_plan_slug,
      p.name                   AS subscription_plan_name,
      p.price_mxn_cents        AS subscription_price_cents
    FROM tenants t
    LEFT JOIN subscriptions s ON s.tenant_id = t.id
    LEFT JOIN plans p         ON p.id        = s.plan_id
    WHERE ${where}
    ORDER BY t.created_at DESC
    LIMIT $${params.length - 1} OFFSET $${params.length}
  `
  const { rows } = await withBypass(() => query(sql, params))

  const countParams = q && q.trim() ? [params[0]] : []
  const countSql = q && q.trim()
    ? `SELECT COUNT(*)::int AS n FROM tenants t WHERE LOWER(t.name) LIKE $1 OR LOWER(t.slug) LIKE $1 OR LOWER(COALESCE(t.display_name,'')) LIKE $1`
    : `SELECT COUNT(*)::int AS n FROM tenants`
  const { rows: countRows } = await withBypass(() => query(countSql, countParams))

  return { data: rows, total: countRows[0].n, page, limit }
}

/**
 * Detalle de un tenant — datos para la pantalla de edición. Incluye plan,
 * suscripción, módulos, branding y dueños.
 */
async function getTenantDetail(tenantId) {
  const { rows } = await withBypass(() => query(
    `SELECT t.id, t.slug, t.name, t.display_name, t.plan, t.is_active, t.is_sandbox,
            t.modules, t.brand_color_primary, t.brand_color_secondary,
            t.notification_email, t.created_at, t.updated_at,
            t.suspended_reason, t.suspended_at,
            s.status                 AS subscription_status,
            s.trial_end,
            s.current_period_start,
            s.current_period_end,
            s.cancel_at_period_end,
            s.canceled_at,
            s.stripe_customer_id,
            s.stripe_subscription_id,
            p.slug                   AS subscription_plan_slug,
            p.name                   AS subscription_plan_name,
            p.price_mxn_cents        AS subscription_price_cents,
            p.max_users              AS subscription_max_users,
            p.max_invoices_per_month AS subscription_max_invoices
       FROM tenants t
       LEFT JOIN subscriptions s ON s.tenant_id = t.id
       LEFT JOIN plans p         ON p.id        = s.plan_id
      WHERE t.id = $1`,
    [tenantId]
  ))
  if (!rows.length) return null
  return rows[0]
}

async function listTenantUsers(tenantId) {
  const { rows } = await withBypass(() => query(
    `SELECT u.id, u.email, u.full_name, u.is_active, u.is_platform_admin,
            u.last_login_at, u.created_at,
            ARRAY(
              SELECT r.name FROM user_roles ur
              JOIN roles r ON r.id = ur.role_id
              WHERE ur.user_id = u.id
            ) AS roles
       FROM users u
      WHERE u.tenant_id = $1
      ORDER BY u.created_at ASC`,
    [tenantId]
  ))
  return rows
}

/**
 * Provisiona un tenant nuevo + admin inicial. Reusa la lógica existente
 * de tenantService.provisionTenant pero la envuelve en withBypass porque
 * la sesión del super-admin tiene tenant_id del SU tenant y RLS lo
 * bloquearía al insertar en tenants/users de otro tenant.
 */
async function createTenant({ slug, name, plan = 'free', adminEmail, adminPassword, adminName, modules, sendInitialPassword = false }) {
  if (!VALID_PLANS.includes(plan)) {
    throwHttp(400, `Plan inválido. Debe ser uno de: ${VALID_PLANS.join(', ')}`)
  }
  const result = await withBypass(() => tenantSvc.provisionTenant({
    slug, name, plan, adminEmail, adminPassword, adminName,
    sendInitialPassword,
  }))

  // Si se pasaron módulos iniciales, aplicarlos.
  if (modules && typeof modules === 'object') {
    const sanitized = sanitizeModules(modules)
    await withBypass(() => query(
      `UPDATE tenants SET modules = $1 WHERE id = $2`,
      [JSON.stringify(sanitized), result.tenant.id]
    ))
    result.tenant.modules = sanitized
  }

  // URL que tiene que usar el cliente para entrar — siempre la del subdominio
  // del tenant en producción (acme.praxionops.com); en dev cae al APP_URL
  // configurado. El frontend la muestra para que el super-admin pueda
  // copiarla o compartirla por WhatsApp.
  const baseUrl = config.appUrl || ''
  let loginUrl = `${baseUrl}/login`
  try {
    if (baseUrl) {
      const u = new URL(baseUrl)
      // Si el host raíz no es localhost, anteponer el slug como subdominio.
      if (!/^(localhost|127\.|192\.168\.)/.test(u.hostname)) {
        u.hostname = `${result.tenant.slug}.${u.hostname.replace(/^[^.]+\./, '') || u.hostname}`
        loginUrl = `${u.toString().replace(/\/$/, '')}/login`
      }
    }
  } catch (_e) { /* loginUrl fallback ya seteado */ }

  return {
    ...result,
    loginUrl,
    emailSent: sendInitialPassword === true,
  }
}

/**
 * Actualiza datos del tenant desde el panel super-admin. Campos opcionales:
 *   name, displayName, plan, modules, brandColorPrimary, brandColorSecondary,
 *   notificationEmail
 *
 * Devuelve el tenant actualizado.
 */
async function updateTenant(tenantId, patch = {}) {
  const fields = []
  const params = [tenantId]

  if (patch.name !== undefined) {
    if (!patch.name || typeof patch.name !== 'string') throwHttp(400, 'name no puede estar vacío.')
    params.push(patch.name.trim())
    fields.push(`name = $${params.length}`)
  }
  if (patch.displayName !== undefined) {
    const v = patch.displayName ? String(patch.displayName).trim() : null
    if (v && v.length > 120) throwHttp(400, 'displayName excede 120 caracteres.')
    params.push(v)
    fields.push(`display_name = $${params.length}`)
  }
  if (patch.plan !== undefined) {
    if (!VALID_PLANS.includes(patch.plan)) {
      throwHttp(400, `Plan inválido. Debe ser uno de: ${VALID_PLANS.join(', ')}`)
    }
    params.push(patch.plan)
    fields.push(`plan = $${params.length}`)
  }
  if (patch.modules !== undefined) {
    const sanitized = sanitizeModules(patch.modules)
    params.push(JSON.stringify(sanitized))
    fields.push(`modules = $${params.length}::jsonb`)
  }
  if (patch.brandColorPrimary !== undefined) {
    if (patch.brandColorPrimary && !HEX_REGEX.test(patch.brandColorPrimary)) {
      throwHttp(400, 'brandColorPrimary debe ser hex #RRGGBB.')
    }
    params.push(patch.brandColorPrimary || null)
    fields.push(`brand_color_primary = $${params.length}`)
  }
  if (patch.brandColorSecondary !== undefined) {
    if (patch.brandColorSecondary && !HEX_REGEX.test(patch.brandColorSecondary)) {
      throwHttp(400, 'brandColorSecondary debe ser hex #RRGGBB.')
    }
    params.push(patch.brandColorSecondary || null)
    fields.push(`brand_color_secondary = $${params.length}`)
  }
  if (patch.notificationEmail !== undefined) {
    const v = patch.notificationEmail || null
    if (v && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) {
      throwHttp(400, 'notificationEmail no tiene formato válido.')
    }
    params.push(v)
    fields.push(`notification_email = $${params.length}`)
  }

  if (!fields.length) throwHttp(400, 'Nada que actualizar.')

  fields.push(`updated_at = NOW()`)

  const { rows } = await withBypass(() => query(
    `UPDATE tenants SET ${fields.join(', ')} WHERE id = $1
     RETURNING id, slug, name, display_name, plan, is_active, modules,
               brand_color_primary, brand_color_secondary, notification_email`,
    params
  ))
  if (!rows.length) throwHttp(404, 'Tenant no encontrado.')
  return rows[0]
}

const VALID_SUSPENSION_REASONS = ['payment', 'manual']

async function suspendTenant(tenantId, { reason = 'manual' } = {}) {
  if (!VALID_SUSPENSION_REASONS.includes(reason)) {
    throwHttp(400, `reason inválido. Debe ser: ${VALID_SUSPENSION_REASONS.join(', ')}`)
  }
  const { rows } = await withBypass(() => query(
    `UPDATE tenants
        SET is_active        = FALSE,
            suspended_reason = $2,
            suspended_at     = NOW(),
            updated_at       = NOW()
      WHERE id = $1
      RETURNING id, is_active, suspended_reason, suspended_at`,
    [tenantId, reason]
  ))
  if (!rows.length) throwHttp(404, 'Tenant no encontrado.')
  return rows[0]
}

async function reactivateTenant(tenantId) {
  const { rows } = await withBypass(() => query(
    `UPDATE tenants
        SET is_active        = TRUE,
            suspended_reason = NULL,
            suspended_at     = NULL,
            updated_at       = NOW()
      WHERE id = $1
      RETURNING id, is_active`,
    [tenantId]
  ))
  if (!rows.length) throwHttp(404, 'Tenant no encontrado.')
  return rows[0]
}

/**
 * Métricas agregadas para la cabecera del dashboard de plataforma:
 *   - tenants activos / suspendidos
 *   - suscripciones por estado
 *   - MRR estimado (suma de price_mxn_cents de subs activas con plan ≠ free/owner)
 *   - facturas timbradas en el mes
 */
async function getPlatformMetrics() {
  const sql = `
    WITH
    tenants_cnt AS (
      SELECT
        COUNT(*) FILTER (WHERE is_active = TRUE)  AS active,
        COUNT(*) FILTER (WHERE is_active = FALSE) AS suspended,
        COUNT(*)                                  AS total
      FROM tenants
    ),
    subs_by_status AS (
      SELECT status, COUNT(*)::int AS n
        FROM subscriptions
       GROUP BY status
    ),
    mrr AS (
      SELECT COALESCE(SUM(p.price_mxn_cents), 0)::bigint AS cents
        FROM subscriptions s
        JOIN plans p ON p.id = s.plan_id
       WHERE s.status IN ('active', 'trialing', 'past_due')
         AND p.slug NOT IN ('free', 'owner')
    ),
    invoices_month AS (
      SELECT COUNT(*)::int AS n
        FROM invoices
       WHERE status = 'stamped'
         AND stamp_date >= date_trunc('month', NOW())
    )
    SELECT
      (SELECT row_to_json(tenants_cnt.*) FROM tenants_cnt)         AS tenants,
      (SELECT json_agg(subs_by_status.*) FROM subs_by_status)      AS subscriptions,
      (SELECT cents FROM mrr)                                       AS mrr_cents,
      (SELECT n FROM invoices_month)                                AS invoices_this_month
  `
  const { rows } = await withBypass(() => query(sql))
  return rows[0]
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sanitizeModules(input) {
  const out = {}
  for (const key of SUPPORTED_MODULES) {
    if (Object.prototype.hasOwnProperty.call(input, key)) {
      // Solo guardamos false explícito. true = no entry (default).
      if (input[key] === false) out[key] = false
    }
  }
  return out
}

function throwHttp(status, message) {
  const err = new Error(message)
  err.status = status
  throw err
}

// ─── Planes de suscripción ────────────────────────────────────────────────

// Campos que el super-admin puede editar. El slug NO se toca (es referencia
// dura en código). El precio en BD es display-only — Stripe es la fuente de
// verdad para cobros vía stripe_price_id.
const EDITABLE_PLAN_FIELDS = [
  'name', 'description', 'price_mxn_cents', 'currency',
  'stripe_price_id', 'max_users', 'max_invoices_per_month',
  'active', 'sort_order',
]

/**
 * Lista todos los planes con conteo de suscripciones activas (active,
 * trialing, past_due). Para mostrar en el panel del super-admin.
 */
async function listPlans() {
  const { rows } = await withBypass(() => query(
    `SELECT p.*,
            COALESCE((SELECT COUNT(*) FROM subscriptions s
                       WHERE s.plan_id = p.id
                         AND s.status IN ('active','trialing','past_due')), 0)::int
              AS active_subscriptions_count
       FROM plans p
      ORDER BY p.sort_order ASC, p.created_at ASC`
  ))
  return rows
}

async function getPlan(planId) {
  const { rows } = await withBypass(() => query(
    `SELECT p.*,
            COALESCE((SELECT COUNT(*) FROM subscriptions s
                       WHERE s.plan_id = p.id
                         AND s.status IN ('active','trialing','past_due')), 0)::int
              AS active_subscriptions_count
       FROM plans p
      WHERE p.id = $1`,
    [planId]
  ))
  return rows[0] || null
}

/**
 * Actualiza un plan. Solo los campos en EDITABLE_PLAN_FIELDS son aceptados;
 * el resto se ignora silenciosamente.
 *
 * Restricciones:
 *   - El plan 'owner' no puede desactivarse (es crítico del sistema).
 *   - Si quieres desactivar un plan que tiene suscripciones activas, hay que
 *     primero migrar esas suscripciones a otro plan — bloqueamos con un
 *     error estructurado.
 */
async function updatePlan(planId, patch) {
  const current = await getPlan(planId)
  if (!current) throwHttp(404, 'Plan no encontrado.')

  if (current.slug === 'owner' && patch.active === false) {
    throwHttp(400, 'El plan "owner" no se puede desactivar — es del sistema.')
  }

  if (patch.active === false && current.active === true && current.active_subscriptions_count > 0) {
    const err = new Error(
      `No se puede desactivar el plan: ${current.active_subscriptions_count} suscripción(es) activa(s). ` +
      `Migra esas suscripciones a otro plan primero.`
    )
    err.code = 'PLAN_HAS_ACTIVE_SUBS'
    err.status = 409
    throw err
  }

  const sets = []
  const params = []
  for (const k of EDITABLE_PLAN_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(patch, k)) {
      params.push(patch[k])
      sets.push(`${k} = $${params.length}`)
    }
  }
  if (!sets.length) return current

  params.push(planId)
  await withBypass(() => query(
    `UPDATE plans SET ${sets.join(', ')} WHERE id = $${params.length}`,
    params
  ))
  return getPlan(planId)
}

module.exports = {
  SUPPORTED_MODULES,
  VALID_PLANS,
  VALID_SUSPENSION_REASONS,
  EDITABLE_PLAN_FIELDS,
  listAllTenants,
  getTenantDetail,
  listTenantUsers,
  createTenant,
  updateTenant,
  suspendTenant,
  reactivateTenant,
  getPlatformMetrics,
  listPlans,
  getPlan,
  updatePlan,
}
