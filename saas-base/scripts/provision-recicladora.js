'use strict'

/**
 * SaaS v2 — Provisiona el tenant piloto "recicladora-piloto".
 *
 * Vertical 2 del roadmap (Fase 2): industrial no-alimentario, multi-calidad
 * con NRV, mermas con valor de recuperación. Sin lotes, sin caducidad, sin
 * alérgenos. Valida que el motor sirve fuera del mundo alimentario.
 *
 * Diseño: §6.3 de docs/saas-v2/00-design.md.
 *
 * Mismo patrón que provision-palomitas.js:
 *  - HTTP via supertest (no requiere server corriendo).
 *  - Idempotente.
 *
 * Uso:
 *   node scripts/provision-recicladora.js
 */

require('dotenv').config()
const request = require('supertest')
const app = require('../src/app')
const { pool, query, withBypass } = require('../src/db')

const SLUG  = 'recicladora-piloto'
const EMAIL = 'admin@recicladora-piloto.local'
const PASS  = 'Recicladora!2026'
const NAME  = 'Recicladora Piloto'

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
      plan: 'owner',
      adminEmail: EMAIL,
      adminPassword: PASS,
      adminName: 'Admin Recicladora',
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

function clientFor(token) {
  const headers = { 'X-Tenant-Slug': SLUG, 'Authorization': `Bearer ${token}` }
  const wrap = (method) => (path, body) => {
    const r = request(app)[method](path).set(headers)
    if (body) r.send(body)
    return r
  }
  return { get: wrap('get'), post: wrap('post'), patch: wrap('patch'), put: wrap('put') }
}

// ─── 3. Configurar flags industrial (no-alimentario) ───────────────────────

async function setIndustrialFlags(client) {
  log('\n[3] Configurando flags industrial…')
  const current = await client.get('/api/process-config').expect(200)

  // §6.3: industrial, multi-calidad, QA por tipo/color antes de liberar
  // uses_lots/uses_expiry/uses_fefo se quedan en false (defaults).
  const wantedFlags = {
    uses_lots: false,
    uses_expiry: false,
    uses_fefo: false,
    uses_handover: true,
    uses_supervisor: true,
    supervisor_validates: true,
    pt_goes_to_wip_first: true,           // QA antes de liberar
    mp_goes_to_wip_first: true,
    allow_second_quality_in_order: true,  // común sacar 1ª, 2ª y 3ª de la misma corrida
    default_intra_shift_proration: 'weight',
    cost_method: 'weighted_avg',
    treat_abnormal_scrap_as_loss: true,
    allergen_mode: 'alert_only',          // no aplica, pero deja la lógica en alerta
  }

  const needsUpdate = Object.entries(wantedFlags)
    .some(([k, v]) => current.body[k] !== v)

  if (!needsUpdate) {
    skip('Flags industrial ya aplicados')
    return current.body
  }

  const res = await client.patch('/api/process-config', wantedFlags)
  if (res.status !== 200) fail(`PATCH /api/process-config falló (${res.status})`, res.body)
  ok(`Flags actualizadas: ${Object.keys(wantedFlags).join(', ')}`)
  return res.body
}

// ─── 4. Personalizar scrap-types ───────────────────────────────────────────
//
// Recicladora: §6.3 — 3 tipos típicos.
//   - "Contaminación" (discard, 0%)        — basura/papel mezclado, va al desecho.
//   - "Finos/Polvo"   (sell, 10%)          — polvo vendible a otras recicladoras.
//   - "Etiquetas y tapas" (sell, 5%)       — material removido en clasificación.
//
// Los defaults (arranque/operacion/contaminada/desecho) NO aplican y se desactivan.

async function customizeScrapTypes(client) {
  log('\n[4] Personalizando tipos de merma para reciclaje…')

  const list = await client.get('/api/process-config/scrap-types').expect(200)
  const byCode = Object.fromEntries(list.body.map(t => [t.code, t]))

  const newTypes = [
    {
      code: 'contaminacion',
      name: 'Contaminación (basura mezclada)',
      default_destination: 'discard',
      default_recovery_value_pct: 0,
      is_normal: true,
      sort_order: 50,
    },
    {
      code: 'finos_polvo',
      name: 'Finos / Polvo',
      default_destination: 'sell',
      default_recovery_value_pct: 10,
      is_normal: true,
      sort_order: 60,
    },
    {
      code: 'etiquetas_tapas',
      name: 'Etiquetas y tapas',
      default_destination: 'sell',
      default_recovery_value_pct: 5,
      is_normal: true,
      sort_order: 70,
    },
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

  // Desactivar defaults que no aplican
  for (const code of ['arranque', 'operacion', 'contaminada', 'desecho']) {
    const t = byCode[code]
    if (!t) { skip(`scrap-type '${code}' no existe`); continue }
    if (!t.is_active) { skip(`scrap-type '${code}' ya está inactivo`); continue }
    const res = await client.patch(`/api/process-config/scrap-types/${t.id}`, { is_active: false })
    if (res.status !== 200) fail(`PATCH scrap-type '${code}' falló (${res.status})`, res.body)
    ok(`Desactivado scrap-type '${code}'`)
  }
}

// ─── 5. Personalizar quality-grades (3 calidades, naming sectorial) ────────
//
// Recicladora usa las 3 calidades default. Renombramos para que reflejen
// terminología de reciclaje (Primera = pellet limpio, etc.). Si ya están con
// el nombre nuevo, skip.

async function customizeQualityGrades(client) {
  log('\n[5] Personalizando calidades para reciclaje…')

  const list = await client.get('/api/process-config/quality-grades').expect(200)
  const byCode = Object.fromEntries(list.body.map(g => [g.code, g]))

  const wanted = [
    { code: 'primera', name: 'Primera (pellet limpio)' },
    { code: 'segunda', name: 'Segunda (color mixto)'   },
    { code: 'tercera', name: 'Tercera (rebabas / off-spec)' },
  ]

  for (const w of wanted) {
    const g = byCode[w.code]
    if (!g) { skip(`quality-grade '${w.code}' no existe`); continue }
    if (g.name === w.name) { skip(`quality-grade '${w.code}' ya tiene el nombre esperado`); continue }
    const res = await client.patch(`/api/process-config/quality-grades/${g.id}`, { name: w.name })
    if (res.status !== 200) fail(`PATCH quality-grade '${w.code}' falló (${res.status})`, res.body)
    ok(`Renombrado '${w.code}' → "${w.name}"`)
  }
}

// ─── 6. Crear product_kinds (pellet, molido) ───────────────────────────────

async function createProductKinds(client) {
  log('\n[6] Creando product_kinds pellet y molido…')

  const units = await client.get('/api/process-config/units').expect(200)
  const kgId  = units.body.find(u => u.code === 'kg')?.id
  if (!kgId) fail('No se encontró unidad "kg"')

  const grades = await client.get('/api/process-config/quality-grades').expect(200)
  const primeraId = grades.body.find(g => g.code === 'primera')?.id
  if (!primeraId) fail('No se encontró quality-grade "primera"')

  const existing = await client.get('/api/process-config/product-kinds').expect(200)
  const byCode = Object.fromEntries(existing.body.map(k => [k.code, k]))

  const kinds = [
    {
      code: 'pellet',
      name: 'Pellet',
      is_produced: true,
      base_unit_id: kgId,
      default_quality_grade_id: primeraId,
      requires_lots: false,
      default_shelf_life_days: null,
      attribute_schema: {
        fields: [
          { code: 'color',         label: 'Color',          type: 'select',
            options: ['blanco', 'negro', 'gris', 'mixto', 'natural'], required: true },
          { code: 'tipo_resina',   label: 'Tipo de resina', type: 'select',
            options: ['PE', 'PP', 'PET', 'HDPE', 'LDPE'], required: true },
          { code: 'densidad_g_cm3', label: 'Densidad (g/cm³)', type: 'number', required: false },
        ],
      },
      capture_schema: {
        fields: [
          { code: 'peso_kg', label: 'Peso (kg)', type: 'number',
            unit_code: 'kg', required: true, validation: { min: 0, max: 50000 } },
          { code: 'color_observado', label: 'Color observado', type: 'select',
            options: ['blanco', 'amarillento', 'gris', 'oscuro'], required: true, lot_critical: true },
          { code: 'humedad_pct', label: 'Humedad (%)', type: 'number', required: false,
            validation: { min: 0, max: 100 } },
        ],
      },
    },
    {
      code: 'molido',
      name: 'Molido',
      is_produced: true,
      base_unit_id: kgId,
      default_quality_grade_id: primeraId,
      requires_lots: false,
      default_shelf_life_days: null,
      attribute_schema: {
        fields: [
          { code: 'tipo_resina', label: 'Tipo de resina', type: 'select',
            options: ['PE', 'PP', 'PET', 'HDPE', 'LDPE'], required: true },
          { code: 'tamano_particula_mm', label: 'Tamaño partícula (mm)', type: 'number', required: false },
        ],
      },
      capture_schema: {
        fields: [
          { code: 'peso_kg', label: 'Peso (kg)', type: 'number',
            unit_code: 'kg', required: true, validation: { min: 0, max: 50000 } },
          { code: 'humedad_pct', label: 'Humedad (%)', type: 'number', required: false,
            validation: { min: 0, max: 100 } },
        ],
      },
    },
  ]

  for (const k of kinds) {
    if (byCode[k.code]) {
      skip(`product_kind '${k.code}' ya existe (id=${byCode[k.code].id})`)
      continue
    }
    const res = await client.post('/api/process-config/product-kinds', k)
    if (res.status !== 201) fail(`POST product-kinds '${k.code}' falló (${res.status})`, res.body)
    ok(`Creado product_kind '${res.body.code}' (id=${res.body.id}, attr_v=${res.body.attribute_schema.version}, cap_v=${res.body.capture_schema.version})`)
  }
}

// ─── 7. Resumen final ──────────────────────────────────────────────────────

async function summary(tenant, client) {
  log('\n' + '─'.repeat(70))
  log('Tenant Recicladora piloto — configuración aplicada')
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
  log(`    uses_handover=${cfg.uses_handover}, uses_supervisor=${cfg.uses_supervisor}, supervisor_validates=${cfg.supervisor_validates}`)
  log(`    pt_goes_to_wip_first=${cfg.pt_goes_to_wip_first}, mp_goes_to_wip_first=${cfg.mp_goes_to_wip_first}`)
  log(`    allow_second_quality_in_order=${cfg.allow_second_quality_in_order}`)
  log(`    cost_method=${cfg.cost_method}, default_intra_shift_proration=${cfg.default_intra_shift_proration}`)
  log(`    treat_abnormal_scrap_as_loss=${cfg.treat_abnormal_scrap_as_loss}, allergen_mode=${cfg.allergen_mode}`)
  log('')
  log('  Scrap types activos:')
  scrap.filter(s => s.is_active).forEach(s => {
    log(`    - ${s.code} (${s.name}) → ${s.default_destination}, recovery=${s.default_recovery_value_pct}%`)
  })
  log('')
  log('  Quality grades activas:')
  grades.filter(g => g.is_active).forEach(g => log(`    - ${g.grade_number}: ${g.code} (${g.name})`))
  log('')
  log('  Product kinds:')
  kinds.forEach(k => log(`    - ${k.code} (id=${k.id}, base=${k.base_unit_code}, shelf=${k.default_shelf_life_days}d)`))
  log('─'.repeat(70))
  log('')
  log('  Para resetear: DELETE FROM tenants WHERE slug = \'recicladora-piloto\';')
  log('')
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main() {
  try {
    const tenant = await provisionOrFindTenant()
    const token  = await login()
    const client = clientFor(token)

    await setIndustrialFlags(client)
    await customizeScrapTypes(client)
    await customizeQualityGrades(client)
    await createProductKinds(client)
    await summary(tenant, client)
  } catch (err) {
    console.error('\nError no manejado:', err.stack || err)
    process.exit(1)
  } finally {
    await pool.end()
  }
}

main()
