'use strict'

/**
 * Bootstrap inicial de GH Insumos en BD limpia (producción).
 *
 * Diseñado para correr UNA sola vez en Render Shell después del primer
 * deploy, cuando la BD ya tiene el schema (migrations aplicadas por el
 * preDeployCommand) pero está sin tenants/users.
 *
 * Diferencia con setup-gh-insumos.js (que opera sobre datos legacy):
 *   - bootstrap → crea desde cero, asume BD limpia
 *   - setup    → renombra y configura datos pre-existentes (dev local)
 *
 * Crea:
 *   - tenant gh-insumos-prod (preset extrusión plástico, vacío)
 *   - admin administracion@ghinsumos.com en prod (is_platform_admin=true)
 *   - tenant gh-insumos-sandbox (is_sandbox=true)
 *   - admin espejo en sandbox (is_platform_admin=true)
 *   - membresías cruzadas (cada admin owner en ambos)
 *
 * Idempotente: si algo ya existe, se salta — puedes correrlo varias veces.
 *
 * Uso (en Render Shell del servicio praxion-api):
 *   node scripts/bootstrap-gh-insumos.js
 *
 * Password: pide ADMIN_PASSWORD en env. Si no está, usa default y avisa al
 * final que hay que cambiarlo desde el ERP.
 */

require('dotenv').config()
const { pool, query, withBypass } = require('../src/db')
const tenantService = require('../src/modules/tenants/tenantService')

const PROD_SLUG    = 'gh-insumos-prod'
const SANDBOX_SLUG = 'gh-insumos-sandbox'
const ADMIN_EMAIL  = 'administracion@ghinsumos.com'
const ADMIN_NAME   = 'Administración GH Insumos'
const ADMIN_PASS   = process.env.ADMIN_PASSWORD || 'GhInsumos!CambiameYa2026'

const log  = (...args) => console.log(...args)
const ok   = (msg) => console.log('  ✓', msg)
const skip = (msg) => console.log('  ⊘', msg)
const fail = (msg, extra) => { console.error('  ✗', msg); if (extra) console.error('   ', extra); process.exit(1) }

// ─── Helpers ──────────────────────────────────────────────────────────────

async function tenantBySlug(slug) {
  const { rows } = await withBypass(() =>
    query(`SELECT id, slug, name, is_sandbox FROM tenants WHERE slug = $1`, [slug])
  )
  return rows[0] || null
}

async function userByEmailInTenant(tenantId, email) {
  const { rows } = await withBypass(() =>
    query(
      `SELECT id, email, is_platform_admin FROM users WHERE tenant_id = $1 AND email = $2`,
      [tenantId, email]
    )
  )
  return rows[0] || null
}

// ─── 1. Provisionar tenants ───────────────────────────────────────────────

async function provisionTenant({ slug, name, isSandbox }) {
  const existing = await tenantBySlug(slug)
  if (existing) {
    skip(`Tenant '${slug}' ya existe (id=${existing.id})`)
    // Asegurar is_sandbox correcto
    if (existing.is_sandbox !== isSandbox) {
      await withBypass(() =>
        query(`UPDATE tenants SET is_sandbox = $1 WHERE id = $2`, [isSandbox, existing.id])
      )
      ok(`Actualizado is_sandbox=${isSandbox} en '${slug}'`)
    }
    return existing
  }

  // Llamar al service directo (sin HTTP) para evitar requerir supertest en
  // producción (es devDependency y el Docker corre con --omit=dev).
  // El service crea tenant + admin + suscripción trial + membresía 'owner'.
  let tenant
  try {
    const result = await tenantService.provisionTenant({
      slug,
      name,
      plan:          'owner',
      adminEmail:    ADMIN_EMAIL,
      adminPassword: ADMIN_PASS,
      adminName:     ADMIN_NAME,
    })
    tenant = result.tenant
  } catch (err) {
    fail(`provisionTenant falló para ${slug}: ${err.message}`, err.stack)
  }
  ok(`Tenant '${slug}' creado (id=${tenant.id})`)

  // Marcar is_sandbox si aplica
  if (isSandbox) {
    await withBypass(() =>
      query(`UPDATE tenants SET is_sandbox = TRUE WHERE id = $1`, [tenant.id])
    )
    ok(`Marcado '${slug}' como sandbox`)
  }

  return tenant
}

// ─── 2. Marcar admins como platform admin ─────────────────────────────────

async function makePlatformAdmin(tenantId, email) {
  const user = await userByEmailInTenant(tenantId, email)
  if (!user) fail(`Usuario ${email} no encontrado en tenant ${tenantId}`)

  if (user.is_platform_admin) {
    skip(`${email} ya es platform admin en tenant ${tenantId}`)
    return user
  }

  await withBypass(() =>
    query(`UPDATE users SET is_platform_admin = TRUE WHERE id = $1`, [user.id])
  )
  ok(`${email} marcado como platform admin (id=${user.id})`)
  return user
}

// ─── 3. Aplicar preset de extrusión plástico ──────────────────────────────

async function applyPlasticPreset(tenantId) {
  const flags = {
    uses_lots:                     false,
    uses_expiry:                   false,
    uses_fefo:                     false,
    uses_handover:                 true,
    uses_supervisor:               true,
    supervisor_validates:          true,
    pt_goes_to_wip_first:          false,
    mp_goes_to_wip_first:          false,
    allow_second_quality_in_order: false,
    default_intra_shift_proration: 'time',
    cost_method:                   'weighted_avg',
    treat_abnormal_scrap_as_loss:  true,
    allergen_mode:                 'alert_only',
    uses_resin_types:              true,
    tracks_material_origin:        true,
  }

  const existing = await withBypass(() =>
    query(`SELECT 1 FROM tenant_process_config WHERE tenant_id = $1`, [tenantId])
  )

  const cols = Object.keys(flags)
  const vals = Object.values(flags)
  const placeholders = cols.map((_, i) => `$${i + 2}`).join(', ')

  if (existing.rows.length === 0) {
    await withBypass(() =>
      query(
        `INSERT INTO tenant_process_config (tenant_id, ${cols.join(', ')})
         VALUES ($1, ${placeholders})`,
        [tenantId, ...vals]
      )
    )
    ok(`Insertado tenant_process_config (preset plástico)`)
  } else {
    const setClause = cols.map((c, i) => `${c} = $${i + 2}`).join(', ')
    await withBypass(() =>
      query(`UPDATE tenant_process_config SET ${setClause} WHERE tenant_id = $1`, [tenantId, ...vals])
    )
    ok(`Actualizado tenant_process_config (preset plástico)`)
  }
}

// ─── 4. Membresías cruzadas ───────────────────────────────────────────────

async function crossMemberships(prodTenantId, sandboxTenantId) {
  // Admin de prod
  const prodAdmin = await userByEmailInTenant(prodTenantId, ADMIN_EMAIL)
  if (!prodAdmin) fail(`Admin de prod no encontrado`)

  // Admin de sandbox (cuenta espejo creada por provisionTenant)
  const sandboxAdmin = await userByEmailInTenant(sandboxTenantId, ADMIN_EMAIL)
  if (!sandboxAdmin) fail(`Admin de sandbox no encontrado`)

  // Membresía prod-admin → sandbox como owner
  const r1 = await withBypass(() =>
    query(
      `INSERT INTO tenant_memberships (user_id, tenant_id, role)
       VALUES ($1, $2, 'owner')
       ON CONFLICT (user_id, tenant_id) DO NOTHING
       RETURNING id`,
      [prodAdmin.id, sandboxTenantId]
    )
  )
  if (r1.rows.length > 0) {
    ok(`Membresía nueva: prod-admin → sandbox (owner)`)
  } else {
    skip(`Membresía prod-admin → sandbox ya existía`)
  }

  // Membresía sandbox-admin → prod como owner
  const r2 = await withBypass(() =>
    query(
      `INSERT INTO tenant_memberships (user_id, tenant_id, role)
       VALUES ($1, $2, 'owner')
       ON CONFLICT (user_id, tenant_id) DO NOTHING
       RETURNING id`,
      [sandboxAdmin.id, prodTenantId]
    )
  )
  if (r2.rows.length > 0) {
    ok(`Membresía nueva: sandbox-admin → prod (owner)`)
  } else {
    skip(`Membresía sandbox-admin → prod ya existía`)
  }
}

// ─── Resumen ──────────────────────────────────────────────────────────────

async function summary(prodTenant, sandboxTenant) {
  const { rows: counts } = await withBypass(() =>
    query(
      `SELECT
        (SELECT COUNT(*) FROM tenants)              AS tenants,
        (SELECT COUNT(*) FROM users)                AS users,
        (SELECT COUNT(*) FROM tenant_memberships)   AS memberships`
    )
  )

  log('\n' + '─'.repeat(70))
  log('Bootstrap GH Insumos — listo')
  log('─'.repeat(70))
  log(`  ${PROD_SLUG.padEnd(25)} id=${prodTenant.id}  is_sandbox=false`)
  log(`  ${SANDBOX_SLUG.padEnd(25)} id=${sandboxTenant.id}  is_sandbox=true`)
  log('')
  log(`  Totales: ${counts[0].tenants} tenants · ${counts[0].users} users · ${counts[0].memberships} memberships`)
  log('')
  log(`  Login:`)
  log(`    Email:    ${ADMIN_EMAIL}`)
  log(`    Password: ${process.env.ADMIN_PASSWORD ? '(de env ADMIN_PASSWORD)' : ADMIN_PASS}`)
  if (!process.env.ADMIN_PASSWORD) {
    log(`    ⚠ Usaste el password default — cámbialo desde Mi Perfil al primer login.`)
  }
  log('')
  log(`  URLs:`)
  log(`    Frontend:  ${process.env.APP_URL || 'https://praxionops.com'}`)
  log(`    Backend:   ${process.env.APP_PUBLIC_URL || 'https://api.praxionops.com'}`)
  log('─'.repeat(70))
}

// ─── Main ─────────────────────────────────────────────────────────────────

async function main() {
  try {
    log('[1] Provisionando gh-insumos-prod…')
    const prodTenant = await provisionTenant({
      slug:      PROD_SLUG,
      name:      'GH Insumos',
      isSandbox: false,
    })

    log('\n[2] Provisionando gh-insumos-sandbox…')
    const sandboxTenant = await provisionTenant({
      slug:      SANDBOX_SLUG,
      name:      'GH Insumos · Sandbox',
      isSandbox: true,
    })

    log('\n[3] Marcando admins como platform admin…')
    await makePlatformAdmin(prodTenant.id,    ADMIN_EMAIL)
    await makePlatformAdmin(sandboxTenant.id, ADMIN_EMAIL)

    log('\n[4] Aplicando preset de extrusión plástico al tenant prod…')
    await applyPlasticPreset(prodTenant.id)

    log('\n[5] Aplicando preset de extrusión plástico al sandbox…')
    await applyPlasticPreset(sandboxTenant.id)

    log('\n[6] Creando membresías cruzadas…')
    await crossMemberships(prodTenant.id, sandboxTenant.id)

    await summary(prodTenant, sandboxTenant)
  } catch (err) {
    console.error('\nError no manejado:', err.stack || err)
    process.exit(1)
  } finally {
    await pool.end()
  }
}

main()
