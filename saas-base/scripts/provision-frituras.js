'use strict'

/**
 * SaaS v2 — Provisiona el tenant piloto "frituras-piloto".
 *
 * Vertical 3 del roadmap (Fase 4): alimento con múltiples sabores, alérgenos
 * críticos (lácteos en queso), merma reprocesable (papas rotas → Combo).
 * Valida allergen_mode=priority_only, pt_goes_to_wip_first=false y el patrón
 * "merma como MP" via linked_raw_material_id.
 *
 * Diseño: §6.4 de docs/saas-v2/00-design.md.
 *
 * Uso:
 *   node scripts/provision-frituras.js
 */

require('dotenv').config()
const request = require('supertest')
const app     = require('../src/app')
const { pool, query, withBypass } = require('../src/db')

const SLUG  = 'frituras-piloto'
const EMAIL = 'admin@frituras-piloto.local'
const PASS  = 'Frituras!2026'
const NAME  = 'Frituras Piloto'

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
      adminName: 'Admin Frituras',
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

// ─── 3. Flags alimentario con allergen_mode priority_only ─────────────────
//
// §6.4: frituras sale directo a venta (pt_goes_to_wip_first=false),
// usa FEFO, allergen_mode=priority_only bloquea cierre si hay lácteos/gluten
// no declarados.

async function setFriturasFlags(client) {
  log('\n[3] Configurando flags de frituras…')
  const current = await client.get('/api/process-config').expect(200)

  const wantedFlags = {
    uses_lots:                     true,
    uses_expiry:                   true,
    uses_fefo:                     true,
    uses_handover:                 true,
    uses_supervisor:               true,
    supervisor_validates:          true,
    pt_goes_to_wip_first:          false,  // línea continua → directo a PT
    mp_goes_to_wip_first:          true,
    allow_second_quality_in_order: false,  // rotas (Combo) no cuentan al objetivo
    default_intra_shift_proration: 'time',
    cost_method:                   'fifo',
    treat_abnormal_scrap_as_loss:  true,
    allergen_mode:                 'priority_only', // bloquea cierre si hay alérgeno prioritario sin declarar
    expiry_alert_days:             7,
  }

  const needsUpdate = Object.entries(wantedFlags)
    .some(([k, v]) => current.body[k] !== v)

  if (!needsUpdate) {
    skip('Flags de frituras ya aplicados')
    return current.body
  }

  const res = await client.patch('/api/process-config', wantedFlags)
  if (res.status !== 200) fail(`PATCH /api/process-config falló (${res.status})`, res.body)
  ok(`Flags actualizadas: ${Object.keys(wantedFlags).join(', ')}`)
  return res.body
}

// ─── 4. Alérgenos prioritarios ─────────────────────────────────────────────
//
// Con allergen_mode=priority_only, los alérgenos marcados is_priority=true
// bloquean el cierre de turno si no están declarados en el producto.
// §6.4: gluten, lácteos, soya, ajonjolí.
//
// El seed de Foundation crea 8 alérgenos NOM-051. Solo necesitamos verificar
// que los 4 clave estén marcados como is_priority=true.

async function ensureAllergenPriorities(client) {
  log('\n[4] Verificando alérgenos prioritarios…')

  const list = await client.get('/api/process-config/allergens').expect(200)
  const byCode = Object.fromEntries(list.body.map(a => [a.code, a]))

  const priorityCodes = ['lacteos', 'gluten', 'soya', 'ajonjoli']

  for (const code of priorityCodes) {
    const a = byCode[code]
    if (!a) {
      // No existe: crear
      const res = await client.post('/api/process-config/allergens', {
        code,
        name: {
          lacteos:  'Lácteos',
          gluten:   'Gluten',
          soya:     'Soya',
          ajonjoli: 'Ajonjolí',
        }[code],
        is_priority: true,
      })
      if (res.status !== 201) fail(`POST alérgeno '${code}' falló (${res.status})`, res.body)
      ok(`Creado alérgeno '${code}' (is_priority=true)`)
    } else if (!a.is_priority) {
      const res = await client.patch(`/api/process-config/allergens/${a.id}`, { is_priority: true })
      if (res.status !== 200) fail(`PATCH alérgeno '${code}' falló (${res.status})`, res.body)
      ok(`Marcado '${code}' como prioritario`)
    } else {
      skip(`Alérgeno '${code}' ya es prioritario`)
    }
  }
}

// ─── 5. Tipos de merma ─────────────────────────────────────────────────────
//
// §6.4:
//   - "Rotas/Quebradas"   (reprocess, 30%) → Merma Reproceso (linked_raw_material_id se enlaza en paso 8)
//   - "Quemadas"          (discard, 0%)
//   - "Sin saborizar"     (reprocess, 80%) → se re-saboriza
//   - "Cortes irregulares"(sell, 20%)      → snacks a granel

async function customizeScrapTypes(client) {
  log('\n[5] Personalizando tipos de merma para frituras…')

  const list = await client.get('/api/process-config/scrap-types').expect(200)
  const byCode = Object.fromEntries(list.body.map(t => [t.code, t]))

  const newTypes = [
    {
      code: 'rotas_quebradas',
      name: 'Rotas / Quebradas',
      default_destination: 'reprocess',
      default_recovery_value_pct: 30,
      is_normal: true,
      allows_reprocess_of_expired: false,
      sort_order: 50,
    },
    {
      code: 'quemadas',
      name: 'Quemadas',
      default_destination: 'discard',
      default_recovery_value_pct: 0,
      is_normal: true,
      sort_order: 60,
    },
    {
      code: 'sin_saborizar',
      name: 'Sin saborizar',
      default_destination: 'reprocess',
      default_recovery_value_pct: 80,
      is_normal: true,
      allows_reprocess_of_expired: false,
      sort_order: 70,
    },
    {
      code: 'cortes_irregulares',
      name: 'Cortes irregulares',
      default_destination: 'sell',
      default_recovery_value_pct: 20,
      is_normal: true,
      sort_order: 80,
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

  // Desactivar defaults genéricos que no aplican en frituras
  for (const code of ['arranque', 'operacion', 'contaminada', 'desecho']) {
    const t = byCode[code]
    if (!t) { skip(`scrap-type '${code}' no existe`); continue }
    if (!t.is_active) { skip(`scrap-type '${code}' ya está inactivo`); continue }
    const res = await client.patch(`/api/process-config/scrap-types/${t.id}`, { is_active: false })
    if (res.status !== 200) fail(`PATCH scrap-type '${code}' falló (${res.status})`, res.body)
    ok(`Desactivado scrap-type '${code}'`)
  }
}

// ─── 6. Calidades: Apta (1ª) y Combo (2ª) ─────────────────────────────────
//
// §6.4: solo dos calidades.
//   Grade 1 — "Apta" (cuenta para fulfillment)
//   Grade 2 — "Combo" (rotas reprocesadas; NO cuenta para fulfillment de órdenes normales)
//   Grade 3 — desactivada

async function customizeQualityGrades(client) {
  log('\n[6] Configurando calidades Apta / Combo…')

  const list = await client.get('/api/process-config/quality-grades').expect(200)
  const byCode = Object.fromEntries(list.body.map(g => [g.code, g]))

  const renames = [
    { code: 'primera', name: 'Apta', counts_for_order_fulfillment: true  },
    { code: 'segunda', name: 'Combo (reprocesada)', counts_for_order_fulfillment: false },
  ]

  for (const w of renames) {
    const g = byCode[w.code]
    if (!g) { skip(`quality-grade '${w.code}' no existe`); continue }
    const needsUpdate = g.name !== w.name || g.counts_for_order_fulfillment !== w.counts_for_order_fulfillment
    if (!needsUpdate) { skip(`quality-grade '${w.code}' ya está configurada`); continue }
    const res = await client.patch(`/api/process-config/quality-grades/${g.id}`, {
      name: w.name,
      counts_for_order_fulfillment: w.counts_for_order_fulfillment,
    })
    if (res.status !== 200) fail(`PATCH quality-grade '${w.code}' falló (${res.status})`, res.body)
    ok(`Configurada '${w.code}' → "${w.name}" (fulfillment=${w.counts_for_order_fulfillment})`)
  }

  // Desactivar tercera
  const tercera = byCode['tercera']
  if (tercera && tercera.is_active) {
    const res = await client.patch(`/api/process-config/quality-grades/${tercera.id}`, { is_active: false })
    if (res.status !== 200) fail(`PATCH quality-grade 'tercera' falló (${res.status})`, res.body)
    ok(`Desactivada quality-grade 'tercera'`)
  } else {
    skip("quality-grade 'tercera' ya inactiva o no existe")
  }
}

// ─── 7. Product kind: frituras_saladas ─────────────────────────────────────
//
// §6.4: sabor + tamaño como atributos, capture por peso+unidades+temperatura.

async function createProductKinds(client) {
  log('\n[7] Creando product_kind frituras_saladas…')

  const units  = await client.get('/api/process-config/units').expect(200)
  const grades = await client.get('/api/process-config/quality-grades').expect(200)

  const kgId     = units.body.find(u => u.code === 'kg')?.id
  const primeraId = grades.body.find(g => g.code === 'primera')?.id
  if (!kgId)     fail('No se encontró unidad "kg"')
  if (!primeraId) fail('No se encontró quality-grade "primera"')

  const existing = await client.get('/api/process-config/product-kinds').expect(200)
  const byCode   = Object.fromEntries(existing.body.map(k => [k.code, k]))

  const kinds = [
    {
      code: 'frituras_saladas',
      name: 'Frituras saladas',
      is_produced: true,
      base_unit_id: kgId,
      default_quality_grade_id: primeraId,
      requires_lots: true,
      default_shelf_life_days: 90,
      attribute_schema: {
        fields: [
          {
            code: 'sabor', label: 'Sabor', type: 'select', required: true,
            options: ['original', 'limon', 'chile', 'queso', 'adobada', 'crema_y_finas_hierbas'],
          },
          {
            code: 'tamano', label: 'Tamaño', type: 'select', required: true,
            options: ['50g', '100g', '200g', '450g'],
          },
        ],
      },
      capture_schema: {
        fields: [
          { code: 'peso_kg',              label: 'Peso (kg)',           type: 'number', unit_code: 'kg',  required: true,  validation: { min: 0, max: 5000 } },
          { code: 'unidades',             label: 'Unidades (bolsas)',   type: 'number',                   required: true,  validation: { min: 0 } },
          { code: 'temperatura_aceite_c', label: 'Temp. aceite (°C)',   type: 'number',                   required: false, validation: { min: 100, max: 220 } },
        ],
      },
    },
    {
      // Combo: producto de papas rotas reprocesadas — su propio SKU
      code: 'frituras_combo',
      name: 'Frituras Combo (reprocesado)',
      is_produced: true,
      base_unit_id: kgId,
      default_quality_grade_id: grades.body.find(g => g.code === 'segunda')?.id || primeraId,
      requires_lots: true,
      default_shelf_life_days: 60,
      attribute_schema: {
        fields: [
          {
            code: 'tamano', label: 'Tamaño', type: 'select', required: true,
            options: ['200g', '450g'],
          },
        ],
      },
      capture_schema: {
        fields: [
          { code: 'peso_kg',  label: 'Peso (kg)',        type: 'number', unit_code: 'kg', required: true, validation: { min: 0, max: 2000 } },
          { code: 'unidades', label: 'Unidades (bolsas)', type: 'number',                 required: true, validation: { min: 0 } },
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
    ok(`Creado product_kind '${res.body.code}' (id=${res.body.id})`)
  }
}

// ─── 8. Materia prima "Merma Reproceso — Papas Rotas" ──────────────────────
//
// Para que el patrón "merma como MP" funcione necesitamos un raw_material que
// represente las papas rotas. El scrap-type 'rotas_quebradas' enlaza a este RM
// via linked_raw_material_id: al registrar merma de tipo 'rotas_quebradas',
// el motor incrementa automáticamente el stock de esta MP en el almacén de
// Merma Reproceso.
//
// El raw_material se crea directamente en BD via withBypass porque no hay
// endpoint REST de raw_materials que acepte `item_kind='raw_material'` con
// linked_raw_material_id.

async function createScrapRawMaterial(client) {
  log('\n[8] Creando MP "Papas Rotas (Reproceso)" y enlazando scrap-type…')

  // Obtener tenant_id
  const { rows: [tenant] } = await withBypass(() =>
    query(`SELECT id FROM tenants WHERE slug = $1`, [SLUG])
  )
  const tenantId = tenant.id

  // Verificar si ya existe por nombre
  const { rows: existing } = await withBypass(() =>
    query(
      `SELECT id FROM raw_materials WHERE tenant_id = $1 AND name = $2`,
      [tenantId, 'Papas Rotas (Reproceso)']
    )
  )

  let rawMaterialId
  if (existing.length > 0) {
    rawMaterialId = existing[0].id
    skip(`Raw material 'Papas Rotas (Reproceso)' ya existe (id=${rawMaterialId})`)
  } else {
    const { rows: [rm] } = await withBypass(() =>
      query(
        `INSERT INTO raw_materials
           (tenant_id, name, unit, cost_per_kg, item_kind, resin_type)
         VALUES ($1, $2, $3, $4, 'raw_material', 'PP')
         RETURNING id`,
        [tenantId, 'Papas Rotas (Reproceso)', 'kg', 0]
      )
    )
    rawMaterialId = rm.id
    ok(`Creado raw_material 'Papas Rotas (Reproceso)' (id=${rawMaterialId})`)
  }

  // Enlazar scrap-type 'rotas_quebradas' → linked_raw_material_id
  const list   = await client.get('/api/process-config/scrap-types').expect(200)
  const rotas  = list.body.find(t => t.code === 'rotas_quebradas')
  if (!rotas) {
    fail("scrap-type 'rotas_quebradas' no encontrado — ejecutar paso 5 primero")
  }

  if (rotas.linked_raw_material_id === rawMaterialId) {
    skip("scrap-type 'rotas_quebradas' ya enlazado a MP-PAPAS-ROTAS")
  } else {
    const res = await client.patch(`/api/process-config/scrap-types/${rotas.id}`, {
      linked_raw_material_id: rawMaterialId,
    })
    if (res.status !== 200) fail(`PATCH scrap-type 'rotas_quebradas' falló (${res.status})`, res.body)
    ok(`Enlazado scrap-type 'rotas_quebradas' → raw_material id=${rawMaterialId}`)
  }

  return rawMaterialId
}

// ─── 9. Gastos indirectos (overhead) ──────────────────────────────────────
//
// §6.4 — 5 conceptos típicos de frituras.

async function createOverheadItems(client) {
  log('\n[9] Creando gastos indirectos…')

  const list   = await client.get('/api/overhead/items').expect(200)
  const byCode = Object.fromEntries(list.body.map(i => [i.code, i]))

  const items = [
    { code: 'renta',       name: 'Renta',                          allocation_base: 'shifts', capture_frequency: 'monthly',  default_estimated_amount: 50000, sort_order: 10 },
    { code: 'luz_gas',     name: 'Luz / Gas',                      allocation_base: 'hours',  capture_frequency: 'monthly',  default_estimated_amount: 40000, sort_order: 20 },
    { code: 'aceite_cons', name: 'Aceite freidora (consumible)',    allocation_base: 'hours',  capture_frequency: 'monthly',  default_estimated_amount: 25000, sort_order: 30 },
    { code: 'nomina',      name: 'Nómina',                         allocation_base: 'shifts', capture_frequency: 'biweekly', default_estimated_amount: 120000, sort_order: 40 },
    { code: 'saborizantes_cons', name: 'Saborizantes (consumibles)', allocation_base: 'weight', capture_frequency: 'monthly', default_estimated_amount: 30000, sort_order: 50 },
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

// ─── 10. Resumen ──────────────────────────────────────────────────────────

async function summary(tenant, client) {
  log('\n' + '─'.repeat(70))
  log('Tenant Frituras piloto — configuración aplicada')
  log('─'.repeat(70))
  log(`  Slug:        ${tenant.slug}`)
  log(`  Tenant ID:   ${tenant.id}`)
  log(`  Admin email: ${EMAIL}`)
  log(`  Admin pass:  ${PASS}`)
  log('')

  const cfg       = (await client.get('/api/process-config').expect(200)).body
  const allergens = (await client.get('/api/process-config/allergens').expect(200)).body
  const scrap     = (await client.get('/api/process-config/scrap-types').expect(200)).body
  const grades    = (await client.get('/api/process-config/quality-grades').expect(200)).body
  const kinds     = (await client.get('/api/process-config/product-kinds').expect(200)).body
  const overhead  = (await client.get('/api/overhead/items').expect(200)).body

  log('  Flags:')
  log(`    uses_lots=${cfg.uses_lots}, uses_expiry=${cfg.uses_expiry}, uses_fefo=${cfg.uses_fefo}`)
  log(`    pt_goes_to_wip_first=${cfg.pt_goes_to_wip_first}, allow_second_quality=${cfg.allow_second_quality_in_order}`)
  log(`    allergen_mode=${cfg.allergen_mode}, cost_method=${cfg.cost_method}`)
  log('')
  log('  Alérgenos prioritarios:')
  allergens.filter(a => a.is_priority && a.is_active)
    .forEach(a => log(`    - ${a.code} (${a.name})`))
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
  kinds.forEach(k => log(`    - ${k.code} (id=${k.id}, shelf=${k.default_shelf_life_days}d)`))
  log('')
  log('  Gastos indirectos:')
  overhead.forEach(i => log(`    - ${i.code}: ${i.name} ($${Number(i.default_estimated_amount).toLocaleString()} / ${i.capture_frequency})`))
  log('─'.repeat(70))
  log('')
  log("  Para resetear: DELETE FROM tenants WHERE slug = 'frituras-piloto';")
  log('')
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main() {
  try {
    const tenant = await provisionOrFindTenant()
    const token  = await login()
    const client = clientFor(token)

    await setFriturasFlags(client)
    await ensureAllergenPriorities(client)
    await customizeScrapTypes(client)
    await customizeQualityGrades(client)
    await createProductKinds(client)
    await createScrapRawMaterial(client)
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
