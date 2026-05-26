'use strict'

/**
 * SaaS v2 — Provisiona el tenant piloto "esquineros-piloto".
 *
 * Vertical 5 del roadmap: extrusión de plástico (industrial no-alimentario).
 * El motor original fue construido para este negocio. Valida que el SaaS
 * multi-tenant soporta el vertical base con uses_lots=false, sin alérgenos
 * bloqueantes, mpFormula, rebaba como MP vía linked_raw_material_id, y
 * costeo por promedio ponderado.
 *
 * Uso:
 *   node scripts/provision-esquineros.js
 */

require('dotenv').config()
const request = require('supertest')
const app     = require('../src/app')
const { pool, query, withBypass } = require('../src/db')

const SLUG  = 'esquineros-piloto'
const EMAIL = 'admin@esquineros-piloto.local'
const PASS  = 'Esquineros!2026'
const NAME  = 'Esquineros Piloto'

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
      adminName: 'Admin Esquineros',
    })

  if (res.status !== 201) fail(`POST /api/tenants/provision falló (${res.status})`, res.body)
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

  if (res.status !== 200) fail(`Login falló (${res.status})`, res.body)
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

// ─── 3. Flags industrial plástico ─────────────────────────────────────────
//
// Extrusión de plástico:
//   - Sin lotes ni caducidad (plastic no-food)
//   - PT directo a disponible (pt_goes_to_wip_first=false)
//   - allergen_mode='alert_only' — no-food, sin bloqueo
//   - cost_method='weighted_avg' — promedio ponderado de mezcla de resinas

async function setEsquinerosFlags(client) {
  log('\n[3] Configurando flags de extrusión plástico…')
  const current = await client.get('/api/process-config').expect(200)

  const wantedFlags = {
    uses_lots:                     false,
    uses_expiry:                   false,
    uses_fefo:                     false,
    uses_handover:                 true,
    uses_supervisor:               true,
    supervisor_validates:          true,
    pt_goes_to_wip_first:          false,   // extrusión → directo a PT
    mp_goes_to_wip_first:          false,
    allow_second_quality_in_order: false,
    default_intra_shift_proration: 'time',
    cost_method:                   'weighted_avg',
    treat_abnormal_scrap_as_loss:  true,
    allergen_mode:                 'alert_only', // no-food, sin bloqueo
    expiry_alert_days:             30,           // no aplica, default
  }

  const needsUpdate = Object.entries(wantedFlags)
    .some(([k, v]) => current.body[k] !== v)

  if (!needsUpdate) {
    skip('Flags de esquineros ya aplicados')
    return current.body
  }

  const res = await client.patch('/api/process-config', wantedFlags)
  if (res.status !== 200) fail(`PATCH /api/process-config falló (${res.status})`, res.body)
  ok(`Flags actualizadas: ${Object.keys(wantedFlags).join(', ')}`)
  return res.body
}

// ─── 4. Tipos de merma ─────────────────────────────────────────────────────
//
// Extrusión plástico:
//   - "Rebaba"        (reprocess, 40%) → linked a "Rebaba (Reproceso)" RM (paso 8)
//   - "Quemado"       (discard, 0%)    → material degradado térmicamente
//   - "Inicio de línea" (discard, 0%)  → purga hasta estabilizar perfil

async function customizeScrapTypes(client) {
  log('\n[4] Personalizando tipos de merma para extrusión…')

  const list   = await client.get('/api/process-config/scrap-types').expect(200)
  const byCode = Object.fromEntries(list.body.map(t => [t.code, t]))

  const newTypes = [
    {
      code: 'rebaba',
      name: 'Rebaba',
      default_destination: 'reprocess',
      default_recovery_value_pct: 40,
      is_normal: true,
      sort_order: 50,
    },
    {
      code: 'quemado',
      name: 'Quemado',
      default_destination: 'discard',
      default_recovery_value_pct: 0,
      is_normal: true,
      sort_order: 60,
    },
    {
      code: 'inicio_linea',
      name: 'Inicio de línea (purga)',
      default_destination: 'discard',
      default_recovery_value_pct: 0,
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

  // Desactivar defaults genéricos que no aplican en extrusión
  for (const code of ['arranque', 'operacion', 'contaminada', 'desecho']) {
    const t = byCode[code]
    if (!t) { skip(`scrap-type '${code}' no existe`); continue }
    if (!t.is_active) { skip(`scrap-type '${code}' ya está inactivo`); continue }
    const res = await client.patch(`/api/process-config/scrap-types/${t.id}`, { is_active: false })
    if (res.status !== 200) fail(`PATCH scrap-type '${code}' falló (${res.status})`, res.body)
    ok(`Desactivado scrap-type '${code}'`)
  }
}

// ─── 5. Calidades: Apta (1ª) y Segunda calidad ────────────────────────────
//
// Extrusión: solo dos calidades en práctica.
//   Grade 1 — "Apta"           (cuenta para fulfillment)
//   Grade 2 — "Segunda calidad" (defecto visual menor, NO cuenta por defecto)
//   Grade 3 — desactivada

async function customizeQualityGrades(client) {
  log('\n[5] Configurando calidades Apta / Segunda…')

  const list   = await client.get('/api/process-config/quality-grades').expect(200)
  const byCode = Object.fromEntries(list.body.map(g => [g.code, g]))

  const renames = [
    { code: 'primera', name: 'Apta',           counts_for_order_fulfillment: true  },
    { code: 'segunda', name: 'Segunda calidad', counts_for_order_fulfillment: false },
  ]

  for (const w of renames) {
    const g = byCode[w.code]
    if (!g) { skip(`quality-grade '${w.code}' no existe`); continue }
    const needsUpdate = g.name !== w.name || g.counts_for_order_fulfillment !== w.counts_for_order_fulfillment
    if (!needsUpdate) { skip(`quality-grade '${w.code}' ya está configurada`); continue }
    const res = await client.patch(`/api/process-config/quality-grades/${g.id}`, {
      name: w.name, counts_for_order_fulfillment: w.counts_for_order_fulfillment,
    })
    if (res.status !== 200) fail(`PATCH quality-grade '${w.code}' falló (${res.status})`, res.body)
    ok(`Configurada '${w.code}' → "${w.name}"`)
  }

  const tercera = byCode['tercera']
  if (tercera?.is_active) {
    const res = await client.patch(`/api/process-config/quality-grades/${tercera.id}`, { is_active: false })
    if (res.status !== 200) fail(`PATCH quality-grade 'tercera' falló (${res.status})`, res.body)
    ok(`Desactivada quality-grade 'tercera'`)
  } else {
    skip("quality-grade 'tercera' ya inactiva o no existe")
  }
}

// ─── 6. Product kind: esquinero ────────────────────────────────────────────
//
// Capture schema: peso_kg + piezas (sin temperatura, sin lotes).
// Attribute schema: perfil (sección transversal) + color.

async function createProductKind(client) {
  log('\n[6] Creando product_kind esquinero…')

  const units  = await client.get('/api/process-config/units').expect(200)
  const grades = await client.get('/api/process-config/quality-grades').expect(200)

  const kgId     = units.body.find(u => u.code === 'kg')?.id
  const primeraId = grades.body.find(g => g.code === 'primera')?.id
  if (!kgId)     fail('No se encontró unidad "kg"')
  if (!primeraId) fail('No se encontró quality-grade "primera"')

  const existing = await client.get('/api/process-config/product-kinds').expect(200)
  const byCode   = Object.fromEntries(existing.body.map(k => [k.code, k]))

  if (byCode['esquinero']) {
    skip(`product_kind 'esquinero' ya existe (id=${byCode['esquinero'].id})`)
    return byCode['esquinero']
  }

  const kind = {
    code: 'esquinero',
    name: 'Esquinero de plástico',
    is_produced: true,
    base_unit_id: kgId,
    default_quality_grade_id: primeraId,
    requires_lots: false,
    attribute_schema: {
      fields: [
        {
          code: 'perfil', label: 'Perfil (mm)', type: 'select', required: true,
          options: ['50x50', '75x75', '100x100', '50x50x3', '75x75x3'],
        },
        {
          code: 'color', label: 'Color', type: 'select', required: false,
          options: ['natural', 'negro', 'blanco', 'gris'],
        },
      ],
    },
    capture_schema: {
      fields: [
        { code: 'peso_kg', label: 'Peso (kg)', type: 'number', unit_code: 'kg', required: true, validation: { min: 0, max: 5000 } },
        { code: 'piezas',  label: 'Piezas',    type: 'number',                  required: true, validation: { min: 0 } },
      ],
    },
  }

  const res = await client.post('/api/process-config/product-kinds', kind)
  if (res.status !== 201) fail(`POST product-kinds 'esquinero' falló (${res.status})`, res.body)
  ok(`Creado product_kind '${res.body.code}' (id=${res.body.id})`)
  return res.body
}

// ─── 7. Materias primas ────────────────────────────────────────────────────
//
// Inserción directa via withBypass para controlar resin_type y item_kind.

async function createRawMaterials(tenantId) {
  log('\n[7] Creando materias primas…')

  const wanted = [
    { name: 'PP Virgen',            resin_type: 'PP', cost_per_kg: 18.00 },
    { name: 'LDPE Reciclado',       resin_type: 'PE', cost_per_kg: 12.00 },
    { name: 'Pigmento Negro',       resin_type: 'PP', cost_per_kg: 45.00 },
    { name: 'Pigmento Blanco',      resin_type: 'PP', cost_per_kg: 40.00 },
    { name: 'Rebaba (Reproceso)',   resin_type: 'PP', cost_per_kg:  0.00 },
  ]

  const ids = {}
  for (const rm of wanted) {
    const { rows: existing } = await withBypass(() =>
      query(`SELECT id FROM raw_materials WHERE tenant_id = $1 AND name = $2`, [tenantId, rm.name])
    )
    if (existing.length > 0) {
      ids[rm.name] = existing[0].id
      skip(`raw_material '${rm.name}' ya existe (id=${existing[0].id})`)
      continue
    }
    const { rows: [row] } = await withBypass(() =>
      query(
        `INSERT INTO raw_materials (tenant_id, name, unit, cost_per_kg, item_kind, resin_type)
         VALUES ($1, $2, 'kg', $3, 'raw_material', $4)
         RETURNING id`,
        [tenantId, rm.name, rm.cost_per_kg, rm.resin_type]
      )
    )
    ids[rm.name] = row.id
    ok(`Creado RM '${rm.name}' (id=${row.id}, ${rm.resin_type}, $${rm.cost_per_kg}/kg)`)
  }
  return ids
}

// ─── 8. Productos finales ──────────────────────────────────────────────────
//
// type='corner_protector' (legacy — frontend ProduccionOrdenes filtra por este tipo).
// product_kind_id → kind esquinero.

async function createProducts(tenantId, kindId) {
  log('\n[8] Creando productos finales (esquineros)…')

  const { rows: grades } = await withBypass(() =>
    query(`SELECT id, code FROM tenant_quality_grades WHERE tenant_id = $1`, [tenantId])
  )
  const primeraId = grades.find(g => g.code === 'primera')?.id
  if (!primeraId) fail('No se encontró quality-grade "primera" en BD')

  // corner_protector requiere resin_type + dimensions por constraint de BD
  const products = [
    { name: 'Esquinero 50×50mm Natural',   sku: 'ESQ-50-50-N',   base_price: 1.80, resin_type: 'PP', length_mm: 50,  width_mm: 50,  thickness_mm: 3 },
    { name: 'Esquinero 75×75mm Natural',   sku: 'ESQ-75-75-N',   base_price: 2.50, resin_type: 'PP', length_mm: 75,  width_mm: 75,  thickness_mm: 3 },
    { name: 'Esquinero 100×100mm Natural', sku: 'ESQ-100-100-N', base_price: 3.40, resin_type: 'PP', length_mm: 100, width_mm: 100, thickness_mm: 3 },
    { name: 'Esquinero 50×50mm Negro',     sku: 'ESQ-50-50-B',   base_price: 2.10, resin_type: 'PP', length_mm: 50,  width_mm: 50,  thickness_mm: 3 },
  ]

  const ids = {}
  for (const p of products) {
    const { rows: existing } = await withBypass(() =>
      query(`SELECT id FROM products WHERE tenant_id = $1 AND sku = $2`, [tenantId, p.sku])
    )
    if (existing.length > 0) {
      ids[p.sku] = existing[0].id
      skip(`Producto '${p.sku}' ya existe (id=${existing[0].id})`)
      continue
    }

    const { rows: [prod] } = await withBypass(() =>
      query(
        `INSERT INTO products
           (tenant_id, name, sku, type, base_price, is_active,
            resin_type, length_mm, width_mm, thickness_mm,
            product_kind_id, is_produced, default_quality_grade_id)
         VALUES ($1, $2, $3, 'corner_protector', $4, true,
                 $5, $6, $7, $8,
                 $9, true, $10)
         RETURNING id`,
        [tenantId, p.name, p.sku, p.base_price,
         p.resin_type, p.length_mm, p.width_mm, p.thickness_mm,
         kindId, primeraId]
      )
    )

    ids[p.sku] = prod.id
    ok(`Creado producto '${p.name}' (id=${prod.id}, sku=${p.sku})`)
  }
  return ids
}

// ─── 9. Enlazar rebaba → MP Rebaba ─────────────────────────────────────────

async function linkRebaba(client, rebabaMpId) {
  log('\n[9] Enlazando scrap-type "rebaba" → RM Rebaba (Reproceso)…')

  const list  = await client.get('/api/process-config/scrap-types').expect(200)
  const rebaba = list.body.find(t => t.code === 'rebaba')
  if (!rebaba) fail("scrap-type 'rebaba' no encontrado — ejecutar paso 4 primero")

  if (rebaba.linked_raw_material_id === rebabaMpId) {
    skip("scrap-type 'rebaba' ya enlazado a MP-REBABA")
    return
  }

  const res = await client.patch(`/api/process-config/scrap-types/${rebaba.id}`, {
    linked_raw_material_id: rebabaMpId,
  })
  if (res.status !== 200) fail(`PATCH scrap-type 'rebaba' falló (${res.status})`, res.body)
  ok(`Enlazado scrap-type 'rebaba' → raw_material id=${rebabaMpId}`)
}

// ─── 10. Gastos indirectos ─────────────────────────────────────────────────

async function createOverheadItems(client) {
  log('\n[10] Creando gastos indirectos…')

  const list   = await client.get('/api/overhead/items').expect(200)
  const byCode = Object.fromEntries(list.body.map(i => [i.code, i]))

  const items = [
    { code: 'renta',        name: 'Renta',                    allocation_base: 'shifts', capture_frequency: 'monthly',  default_estimated_amount: 35000 },
    { code: 'luz',          name: 'Luz / CFE',                allocation_base: 'hours',  capture_frequency: 'monthly',  default_estimated_amount: 28000 },
    { code: 'nomina',       name: 'Nómina',                   allocation_base: 'shifts', capture_frequency: 'biweekly', default_estimated_amount: 80000 },
    { code: 'mantenimiento',name: 'Mantenimiento extrusora',  allocation_base: 'hours',  capture_frequency: 'monthly',  default_estimated_amount: 12000 },
    { code: 'agua',         name: 'Agua (enfriamiento)',      allocation_base: 'weight', capture_frequency: 'monthly',  default_estimated_amount:  4000 },
  ]

  for (const item of items) {
    if (byCode[item.code]) {
      skip(`overhead item '${item.code}' ya existe`)
    } else {
      const res = await client.post('/api/overhead/items', item)
      if (res.status !== 201) fail(`POST overhead item '${item.code}' falló (${res.status})`, res.body)
      ok(`Creado overhead '${item.code}' — ${item.name} ($${item.default_estimated_amount.toLocaleString()})`)
    }
  }
}

// ─── 11. Resumen ──────────────────────────────────────────────────────────

async function summary(tenant, client) {
  log('\n' + '─'.repeat(70))
  log('Tenant Esquineros piloto — configuración aplicada')
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
  const overhead= (await client.get('/api/overhead/items').expect(200)).body

  log('  Flags:')
  log(`    uses_lots=${cfg.uses_lots}, uses_expiry=${cfg.uses_expiry}, pt_goes_to_wip_first=${cfg.pt_goes_to_wip_first}`)
  log(`    allergen_mode=${cfg.allergen_mode}, cost_method=${cfg.cost_method}`)
  log('')
  log('  Scrap types activos:')
  scrap.filter(s => s.is_active).forEach(s => {
    const linked = s.linked_raw_material_id ? ` → linked_rm=${s.linked_raw_material_id}` : ''
    log(`    - ${s.code} (${s.default_destination}, ${s.default_recovery_value_pct}%)${linked}`)
  })
  log('')
  log('  Quality grades activas:')
  grades.filter(g => g.is_active)
    .forEach(g => log(`    - ${g.grade_number}: ${g.code} (${g.name}) fulfillment=${g.counts_for_order_fulfillment}`))
  log('')
  log('  Product kinds:')
  kinds.forEach(k => log(`    - ${k.code} (id=${k.id})`))
  log('')
  log('  Gastos indirectos:')
  overhead.forEach(i => log(`    - ${i.code}: ${i.name} ($${Number(i.default_estimated_amount).toLocaleString()} / ${i.capture_frequency})`))
  log('─'.repeat(70))
  log('')
  log("  Para resetear: DELETE FROM tenants WHERE slug = 'esquineros-piloto';")
  log('')
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main() {
  try {
    const tenant   = await provisionOrFindTenant()
    const token    = await login()
    const client   = clientFor(token)
    const tenantId = tenant.id

    await setEsquinerosFlags(client)
    await customizeScrapTypes(client)
    await customizeQualityGrades(client)
    const kind   = await createProductKind(client)
    const rmIds  = await createRawMaterials(tenantId)
    await createProducts(tenantId, kind.id)
    await linkRebaba(client, rmIds['Rebaba (Reproceso)'])
    await createOverheadItems(client)
    await summary(tenant, client)
  } catch (err) {
    console.error('\nError no manejado:', err.stack || err)
    process.exit(1)
  } finally {
    await pool.end()
  }
}

main()
