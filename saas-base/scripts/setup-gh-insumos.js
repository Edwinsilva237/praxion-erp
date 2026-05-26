'use strict'

/**
 * Setup de tenants reales para GH Insumos.
 *
 * Renombra los tenants existentes:
 *   gh-insumos → gh-insumos-prod   (producción real, vacío)
 *   sandbox    → gh-insumos-sandbox (pruebas)
 *
 * Aplica preset de extrusión plástico al tenant prod (idempotente).
 * Crea membresías cruzadas para que el admin de GH Insumos pueda cambiar
 * entre ambos tenants desde el switcher.
 *
 * Uso: node scripts/setup-gh-insumos.js
 *
 * Idempotente: corre las veces que necesites — si ya está renombrado o
 * ya tiene membresías, se salta esas partes.
 */

require('dotenv').config()
const request = require('supertest')
const app     = require('../src/app')
const { pool, query, withBypass } = require('../src/db')

const OLD_PROD    = 'gh-insumos'
const OLD_SANDBOX = 'sandbox'
const NEW_PROD    = 'gh-insumos-prod'
const NEW_SANDBOX = 'gh-insumos-sandbox'

const log  = (...args) => console.log(...args)
const ok   = (msg) => console.log('  ✓', msg)
const skip = (msg) => console.log('  ⊘', msg)
const fail = (msg, extra) => { console.error('  ✗', msg); if (extra) console.error('   ', extra); process.exit(1) }

// ─── 1. Renombrar slugs ───────────────────────────────────────────────────

async function renameSlug(oldSlug, newSlug, expectSandbox = false) {
  // Si ya existe el destino, no tocamos
  const target = await withBypass(() => query(`SELECT id FROM tenants WHERE slug = $1`, [newSlug]))
  if (target.rows.length > 0) {
    skip(`Slug '${newSlug}' ya existe — no se renombra`)
    return target.rows[0].id
  }

  const src = await withBypass(() => query(`SELECT id, is_sandbox FROM tenants WHERE slug = $1`, [oldSlug]))
  if (src.rows.length === 0) {
    skip(`Tenant '${oldSlug}' no encontrado — nada que renombrar`)
    return null
  }

  // Construimos los SET dinámicamente y dejamos el id al final.
  const params  = [newSlug]
  const updates = [`slug = $${params.length}`]
  if (src.rows[0].is_sandbox !== expectSandbox) {
    params.push(expectSandbox)
    updates.push(`is_sandbox = $${params.length}`)
  }
  params.push(src.rows[0].id)
  await withBypass(() => query(
    `UPDATE tenants SET ${updates.join(', ')} WHERE id = $${params.length}`,
    params
  ))
  ok(`Renombrado '${oldSlug}' → '${newSlug}'${expectSandbox ? ' (is_sandbox=true)' : ''}`)
  return src.rows[0].id
}

// ─── 2. Aplicar preset plástico al tenant prod ────────────────────────────

async function loginAs(slug, email, password) {
  const res = await request(app)
    .post('/api/auth/login')
    .set('X-Tenant-Slug', slug)
    .send({ email, password })
  if (res.status !== 200) fail(`Login falló para ${email} en ${slug} (${res.status})`, res.body)
  return res.body.accessToken
}

function clientFor(slug, token) {
  const headers = { 'X-Tenant-Slug': slug, 'Authorization': `Bearer ${token}` }
  const wrap = (method) => (path, body) => {
    const r = request(app)[method](path).set(headers)
    if (body) r.send(body)
    return r
  }
  return { get: wrap('get'), post: wrap('post'), patch: wrap('patch'), put: wrap('put') }
}

async function applyPlasticPreset(prodTenantId) {
  log('\n[3] Aplicando preset de extrusión plástico a gh-insumos-prod…')

  // Necesitamos un token para usar /api/process-config. Tomamos el admin del
  // tenant prod (el primer usuario activo) y le emitimos un token desde BD
  // — no podemos hacer login normal porque no conocemos su password.
  //
  // En realidad sí: el admin se logea con su password y nos pasa el token.
  // Para automatizar sin password, usamos un PATCH directo a la tabla
  // tenant_process_config saltando el endpoint. Es lo que hace el provision
  // de los pilotos también (vía endpoint, pero después de hacer login).
  //
  // Para evitar pedir credenciales acá, vamos directo a BD con withBypass:
  const wantedFlags = {
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

  // Verificar si ya existe el row
  const existing = await withBypass(() => query(
    `SELECT 1 FROM tenant_process_config WHERE tenant_id = $1`,
    [prodTenantId]
  ))

  const cols    = Object.keys(wantedFlags)
  const vals    = Object.values(wantedFlags)
  const placeholders = cols.map((_, i) => `$${i + 2}`).join(', ')

  if (existing.rows.length === 0) {
    await withBypass(() => query(
      `INSERT INTO tenant_process_config (tenant_id, ${cols.join(', ')})
       VALUES ($1, ${placeholders})`,
      [prodTenantId, ...vals]
    ))
    ok(`Insertado tenant_process_config para gh-insumos-prod`)
  } else {
    const setClause = cols.map((c, i) => `${c} = $${i + 2}`).join(', ')
    await withBypass(() => query(
      `UPDATE tenant_process_config SET ${setClause} WHERE tenant_id = $1`,
      [prodTenantId, ...vals]
    ))
    ok(`Actualizado tenant_process_config con preset plástico`)
  }
}

// ─── 3. Membresías cruzadas ───────────────────────────────────────────────

async function crossMemberships(prodTenantId, sandboxTenantId) {
  log('\n[4] Creando membresías cruzadas…')

  // El admin de prod (administracion@ghinsumos.com en gh-insumos-prod)
  const { rows: prodAdmins } = await withBypass(() => query(
    `SELECT id, email FROM users
       WHERE tenant_id = $1 AND email = 'administracion@ghinsumos.com'`,
    [prodTenantId]
  ))
  if (prodAdmins.length === 0) {
    skip('No se encontró admin de prod (administracion@ghinsumos.com) — omitiendo')
    return
  }

  // El user espejo en sandbox (mismo email, pero id distinto)
  const { rows: sandboxAdmins } = await withBypass(() => query(
    `SELECT id, email FROM users
       WHERE tenant_id = $1 AND email = 'administracion@ghinsumos.com'`,
    [sandboxTenantId]
  ))

  // Membresía prod-admin → sandbox (rol owner para acceso pleno al sandbox)
  const r1 = await withBypass(() => query(
    `INSERT INTO tenant_memberships (user_id, tenant_id, role)
       VALUES ($1, $2, 'owner')
       ON CONFLICT (user_id, tenant_id) DO NOTHING
       RETURNING id`,
    [prodAdmins[0].id, sandboxTenantId]
  ))
  if (r1.rows.length > 0) {
    ok(`Membresía nueva: prod-admin (${prodAdmins[0].id}) → sandbox como owner`)
  } else {
    skip(`Ya existía membership de prod-admin → sandbox`)
  }

  // Membresía sandbox-admin (espejo) → prod
  if (sandboxAdmins.length > 0) {
    const r2 = await withBypass(() => query(
      `INSERT INTO tenant_memberships (user_id, tenant_id, role)
         VALUES ($1, $2, 'owner')
         ON CONFLICT (user_id, tenant_id) DO NOTHING
         RETURNING id`,
      [sandboxAdmins[0].id, prodTenantId]
    ))
    if (r2.rows.length > 0) {
      ok(`Membresía nueva: sandbox-admin (${sandboxAdmins[0].id}) → prod como owner`)
    } else {
      skip(`Ya existía membership de sandbox-admin → prod`)
    }
  } else {
    skip(`No hay admin espejo en sandbox`)
  }
}

// ─── 4. Resumen final ─────────────────────────────────────────────────────

async function summary() {
  const { rows: tenants } = await withBypass(() => query(
    `SELECT id, slug, name, is_sandbox, is_active
       FROM tenants
      WHERE slug IN ($1, $2)
      ORDER BY slug`,
    [NEW_PROD, NEW_SANDBOX]
  ))

  log('\n' + '─'.repeat(70))
  log('Setup GH Insumos — resumen')
  log('─'.repeat(70))
  for (const t of tenants) {
    log(`  ${t.slug.padEnd(25)} id=${t.id}  sandbox=${t.is_sandbox}  active=${t.is_active}`)
    const { rows: members } = await withBypass(() => query(
      `SELECT u.email, m.role, (u.tenant_id = $1) AS is_home
         FROM tenant_memberships m
         JOIN users u ON u.id = m.user_id
        WHERE m.tenant_id = $1
        ORDER BY is_home DESC, u.email`,
      [t.id]
    ))
    for (const m of members) {
      log(`    - ${m.email.padEnd(40)} ${m.role.padEnd(8)} ${m.is_home ? '(home)' : '(invited)'}`)
    }
  }
  log('─'.repeat(70))
  log('')
  log('  Login URL: header X-Tenant-Slug = gh-insumos-prod (o gh-insumos-sandbox)')
  log('  Cuenta:    administracion@ghinsumos.com')
  log('  Switcher:  arriba a la derecha en el ERP, lista ambos tenants')
  log('')
}

// ─── Main ─────────────────────────────────────────────────────────────────

async function main() {
  try {
    log('[1] Renombrando tenants…')
    const prodId    = await renameSlug(OLD_PROD,    NEW_PROD,    false)
    const sandboxId = await renameSlug(OLD_SANDBOX, NEW_SANDBOX, true)

    // Si después del rename no resolvió ids (caso: ya estaba renombrado),
    // los buscamos por el slug nuevo.
    const resolveId = async (slug) => {
      const r = await withBypass(() => query(`SELECT id FROM tenants WHERE slug = $1`, [slug]))
      return r.rows[0]?.id
    }
    const prodTenantId    = prodId    || await resolveId(NEW_PROD)
    const sandboxTenantId = sandboxId || await resolveId(NEW_SANDBOX)

    if (!prodTenantId)    fail(`Tenant '${NEW_PROD}' no existe tras renombrado`)
    if (!sandboxTenantId) fail(`Tenant '${NEW_SANDBOX}' no existe tras renombrado`)

    log('\n[2] Verificando tenant prod…')
    log(`  prod    id=${prodTenantId}`)
    log(`  sandbox id=${sandboxTenantId}`)

    await applyPlasticPreset(prodTenantId)
    await crossMemberships(prodTenantId, sandboxTenantId)
    await summary()
  } catch (err) {
    console.error('\nError no manejado:', err.stack || err)
    process.exit(1)
  } finally {
    await pool.end()
  }
}

main()
