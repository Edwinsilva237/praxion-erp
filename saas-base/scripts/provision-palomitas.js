'use strict'

/**
 * SaaS v2 — Provisiona el tenant piloto "palomitas-piloto".
 *
 * Ejercicio de validación de Camino A (§6 del 02-foundation-progress.md):
 * configura un tenant alimentario completo usando ÚNICAMENTE las APIs REST
 * de SaaS v2 (process-config), simulando lo que haría un onboarding humano.
 *
 * El script es:
 *  - HTTP via supertest contra app.js (no requiere server corriendo).
 *  - Idempotente: si el tenant ya existe, hace login con las credentials
 *    conocidas y aplica solo los pasos que no estén aplicados.
 *
 * Uso:
 *   node scripts/provision-palomitas.js
 *
 * Output: tenant_id, slug, credentials, IDs de los objetos clave creados.
 */

require('dotenv').config()
const request = require('supertest')
const app = require('../src/app')
const { pool, query, withBypass } = require('../src/db')

const SLUG  = 'palomitas-piloto'
const EMAIL = 'admin@palomitas-piloto.local'
const PASS  = 'Palomitas!2026'
const NAME  = 'Palomitas Piloto'

const log  = (...args) => console.log(...args)
const fail = (msg, extra) => { console.error('  ✗', msg); if (extra) console.error('   ', extra); process.exit(1) }
const ok   = (msg) => console.log('  ✓', msg)
const skip = (msg) => console.log('  ⊘', msg)

// ─── 1. Provisionar (o detectar existente) ─────────────────────────────────

async function provisionOrFindTenant() {
  log('\n[1] Provisionando tenant…')

  const existing = await withBypass(() => query(
    `SELECT id, slug, name FROM tenants WHERE slug = $1`, [SLUG]
  ))

  if (existing.rows.length > 0) {
    skip(`Tenant '${SLUG}' ya existe (id=${existing.rows[0].id}) — usando el existente`)
    return existing.rows[0]
  }

  const res = await request(app)
    .post('/api/tenants/provision')
    .send({
      slug: SLUG,
      name: NAME,
      plan: 'owner',  // necesario para tener process_config:* + tenant_catalogs:*
      adminEmail: EMAIL,
      adminPassword: PASS,
      adminName: 'Admin Palomitas',
    })

  if (res.status !== 201) {
    fail(`POST /api/tenants/provision falló (${res.status})`, res.body)
  }
  ok(`Tenant creado: id=${res.body.tenant.id}`)
  return res.body.tenant
}

// ─── 2. Login ──────────────────────────────────────────────────────────────

async function login() {
  log('\n[2] Login…')
  const res = await request(app)
    .post('/api/auth/login')
    .set('X-Tenant-Slug', SLUG)
    .send({ email: EMAIL, password: PASS })

  if (res.status !== 200) {
    fail(`Login falló (${res.status})`, res.body)
  }
  ok(`Logged in como ${EMAIL}`)
  return res.body.accessToken
}

// Helper para crear un cliente HTTP autenticado.
function clientFor(token) {
  const headers = { 'X-Tenant-Slug': SLUG, 'Authorization': `Bearer ${token}` }
  const wrap = (method) => (path, body) => {
    const r = request(app)[method](path).set(headers)
    if (body) r.send(body)
    return r
  }
  return { get: wrap('get'), post: wrap('post'), patch: wrap('patch'), put: wrap('put') }
}

// ─── 3. Activar flags de alimentos ─────────────────────────────────────────

async function setFoodFlags(client) {
  log('\n[3] Activando flags de alimentos…')
  const current = await client.get('/api/process-config').expect(200)
  const wantedFlags = {
    uses_lots: true,
    uses_expiry: true,
    uses_fefo: true,
    cost_method: 'fifo',
    expiry_alert_days: 7,
  }
  const needsUpdate = Object.entries(wantedFlags)
    .some(([k, v]) => current.body[k] !== v)

  if (!needsUpdate) {
    skip('Flags de alimentos ya aplicados')
    return current.body
  }

  const res = await client.patch('/api/process-config', wantedFlags)
  if (res.status !== 200) fail(`PATCH /api/process-config falló (${res.status})`, res.body)
  ok(`Flags actualizadas: ${Object.keys(wantedFlags).join(', ')}`)
  return res.body
}

// ─── 4. Personalizar scrap-types ───────────────────────────────────────────

async function customizeScrapTypes(client) {
  log('\n[4] Personalizando tipos de merma para palomitas…')

  const list = await client.get('/api/process-config/scrap-types').expect(200)
  const byCode = Object.fromEntries(list.body.map(t => [t.code, t]))

  // 4.1 Crear nuevos tipos
  const newTypes = [
    { code: 'sin_reventar', name: 'Granos sin reventar', default_destination: 'discard', is_normal: true, sort_order: 50 },
    { code: 'quemado',      name: 'Quemado',             default_destination: 'discard', is_normal: true, sort_order: 60 },
  ]
  for (const t of newTypes) {
    if (byCode[t.code]) {
      skip(`scrap-type '${t.code}' ya existe`)
    } else {
      const res = await client.post('/api/process-config/scrap-types', t)
      if (res.status !== 201) fail(`POST scrap-type '${t.code}' falló (${res.status})`, res.body)
      ok(`Creado scrap-type '${t.code}' (id=${res.body.id})`)
    }
  }

  // 4.2 Soft-delete de los defaults que no aplican (arranque, operacion, contaminada)
  // Mantengo 'desecho' como genérico, además de los nuevos sin_reventar y quemado.
  for (const code of ['arranque', 'operacion', 'contaminada']) {
    const t = byCode[code]
    if (!t) { skip(`scrap-type '${code}' no existe`); continue }
    if (!t.is_active) { skip(`scrap-type '${code}' ya está inactivo`); continue }
    const res = await client.patch(`/api/process-config/scrap-types/${t.id}`, { is_active: false })
    if (res.status !== 200) fail(`PATCH scrap-type '${code}' falló (${res.status})`, res.body)
    ok(`Desactivado scrap-type '${code}'`)
  }
}

// ─── 5. Simplificar quality-grades (palomitas solo tiene primera) ─────────

async function simplifyQualityGrades(client) {
  log('\n[5] Simplificando calidades (palomitas → solo primera)…')

  const list = await client.get('/api/process-config/quality-grades').expect(200)
  const byCode = Object.fromEntries(list.body.map(g => [g.code, g]))

  for (const code of ['segunda', 'tercera']) {
    const g = byCode[code]
    if (!g) { skip(`quality-grade '${code}' no existe`); continue }
    if (!g.is_active) { skip(`quality-grade '${code}' ya está inactiva`); continue }
    const res = await client.patch(`/api/process-config/quality-grades/${g.id}`, { is_active: false })
    if (res.status !== 200) fail(`PATCH quality-grade '${code}' falló (${res.status})`, res.body)
    ok(`Desactivada quality-grade '${code}'`)
  }
}

// ─── 6. Crear product_kind palomitas_dulces ────────────────────────────────

async function createProductKind(client) {
  log('\n[6] Creando product_kind palomitas_dulces…')

  // IDs que necesitamos referenciar
  const units = await client.get('/api/process-config/units').expect(200)
  const kgId  = units.body.find(u => u.code === 'kg')?.id
  if (!kgId) fail('No se encontró unidad "kg" (debería estar sembrada)')

  const grades = await client.get('/api/process-config/quality-grades').expect(200)
  const primeraId = grades.body.find(g => g.code === 'primera')?.id
  if (!primeraId) fail('No se encontró quality-grade "primera"')

  // Existencia
  const existing = await client.get('/api/process-config/product-kinds').expect(200)
  const palomitas = existing.body.find(k => k.code === 'palomitas_dulces')
  if (palomitas) {
    skip(`product_kind 'palomitas_dulces' ya existe (id=${palomitas.id})`)
    return palomitas
  }

  const body = {
    code: 'palomitas_dulces',
    name: 'Palomitas dulces',
    is_produced: true,
    base_unit_id: kgId,
    default_quality_grade_id: primeraId,
    requires_lots: true,
    default_shelf_life_days: 180,
    attribute_schema: {
      fields: [
        { code: 'sabor', label: 'Sabor', type: 'select',
          options: ['mantequilla', 'caramelo', 'queso', 'natural'], required: true },
        { code: 'tamano_bolsa', label: 'Tamaño bolsa', type: 'select',
          options: ['50g', '100g', '200g'], required: true },
        { code: 'es_organico', label: 'Orgánico', type: 'boolean', default: false },
      ],
    },
    capture_schema: {
      fields: [
        { code: 'peso_kg', label: 'Peso (kg)', type: 'number',
          unit_code: 'kg', required: true, validation: { min: 0, max: 1000 } },
        { code: 'color_observado', label: 'Color observado', type: 'select',
          options: ['blanco', 'amarillento', 'gris'], required: true, lot_critical: true },
        { code: 'humedad_pct', label: 'Humedad (%)', type: 'number', required: false,
          validation: { min: 0, max: 100 } },
      ],
    },
  }

  const res = await client.post('/api/process-config/product-kinds', body)
  if (res.status !== 201) fail(`POST product-kinds falló (${res.status})`, res.body)
  ok(`Creado product_kind '${res.body.code}' (id=${res.body.id}, attr_v=${res.body.attribute_schema.version}, cap_v=${res.body.capture_schema.version})`)
  return res.body
}

// ─── 7. Resumen final ──────────────────────────────────────────────────────

async function summary(tenant, client) {
  log('\n' + '─'.repeat(70))
  log('Tenant Palomitas piloto — configuración aplicada')
  log('─'.repeat(70))
  log(`  Slug:        ${tenant.slug}`)
  log(`  Tenant ID:   ${tenant.id}`)
  log(`  Admin email: ${EMAIL}`)
  log(`  Admin pass:  ${PASS}`)
  log('')

  const cfg     = (await client.get('/api/process-config').expect(200)).body
  const scrap   = (await client.get('/api/process-config/scrap-types').expect(200)).body
  const grades  = (await client.get('/api/process-config/quality-grades').expect(200)).body
  const kinds   = (await client.get('/api/process-config/product-kinds').expect(200)).body

  log('  Flags:')
  log(`    uses_lots=${cfg.uses_lots}, uses_expiry=${cfg.uses_expiry}, uses_fefo=${cfg.uses_fefo}`)
  log(`    cost_method=${cfg.cost_method}, expiry_alert_days=${cfg.expiry_alert_days}`)
  log('')
  log('  Scrap types activos:')
  scrap.filter(s => s.is_active).forEach(s => log(`    - ${s.code} (${s.name})`))
  log('')
  log('  Quality grades activas:')
  grades.filter(g => g.is_active).forEach(g => log(`    - ${g.grade_number}: ${g.code} (${g.name})`))
  log('')
  log('  Product kinds:')
  kinds.forEach(k => log(`    - ${k.code} (id=${k.id}, base=${k.base_unit_code}, shelf=${k.default_shelf_life_days}d)`))
  log('─'.repeat(70))
  log('')
  log('  Para resetear: DELETE FROM tenants WHERE slug = \'palomitas-piloto\';')
  log('  (CASCADE limpia todo. Las hijas problemáticas en tests no aplican porque')
  log('   este tenant no tiene shifts/órdenes/raw_materials creados aún.)')
  log('')
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main() {
  try {
    const tenant = await provisionOrFindTenant()
    const token  = await login()
    const client = clientFor(token)

    await setFoodFlags(client)
    await customizeScrapTypes(client)
    await simplifyQualityGrades(client)
    await createProductKind(client)
    await summary(tenant, client)
  } catch (err) {
    console.error('\nError no manejado:', err.stack || err)
    process.exit(1)
  } finally {
    await pool.end()
  }
}

main()
