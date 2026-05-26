'use strict'

/**
 * SaaS v2 — Provisiona el tenant piloto "pasteleria-piloto".
 *
 * Vertical 4 del roadmap (Fase 5): pastelería artesanal, valida recetas largas
 * (10-15 componentes), vida útil muy corta (2-3 días), pedidos personalizados
 * con texto + costos extras, alertas agresivas de caducidad.
 *
 * Flags clave:
 *   - uses_lots=true, uses_expiry=true, uses_fefo=true
 *   - allergen_mode='alert_only'  → gluten/huevo/lácteos están en TODO; no bloquea
 *   - pt_goes_to_wip_first=true   → pasteles van a WIP mientras se decoran
 *   - expiry_alert_days=3         → alerta global; por producto se override a 2d
 *   - products.expiry_alert_days=2 → migration 139
 *
 * Diseño: §7.7 de docs/saas-v2/00-design.md.
 *
 * Uso:
 *   node scripts/provision-pasteleria.js
 */

require('dotenv').config()
const request = require('supertest')
const app     = require('../src/app')
const { pool, query, withBypass } = require('../src/db')

const SLUG  = 'pasteleria-piloto'
const EMAIL = 'admin@pasteleria-piloto.local'
const PASS  = 'Pasteleria!2026'
const NAME  = 'Pastelería Piloto'

const log  = (...args) => console.log(...args)
const fail = (msg, extra) => { console.error('  ✗', msg); if (extra) console.error('   ', extra); process.exit(1) }
const ok   = (msg) => console.log('  ✓', msg)
const skip = (msg) => console.log('  ⊘', msg)

// ─── 1. Provisionar tenant ────────────────────────────────────────────────

async function provisionOrFindTenant() {
  log('\n[1] Provisionando tenant…')
  const existing = await withBypass(() => query(
    `SELECT id, slug, name FROM tenants WHERE slug = $1`, [SLUG]
  ))
  if (existing.rows.length > 0) {
    skip(`Tenant '${SLUG}' ya existe (id=${existing.rows[0].id})`)
    return existing.rows[0]
  }
  const res = await request(app)
    .post('/api/tenants/provision')
    .send({ slug: SLUG, name: NAME, plan: 'owner', adminEmail: EMAIL, adminPassword: PASS, adminName: 'Admin Pastelería' })
  if (res.status !== 201) fail(`POST /api/tenants/provision falló (${res.status})`, res.body)
  ok(`Tenant creado: id=${res.body.tenant.id}`)
  return res.body.tenant
}

// ─── 2. Login ─────────────────────────────────────────────────────────────

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

// ─── 3. Flags de pastelería ───────────────────────────────────────────────
//
// pt_goes_to_wip_first=true: los pasteles van a WIP mientras se decoran.
// allergen_mode='alert_only': gluten/huevo/lácteos están en casi todos los
//   productos — no tiene sentido bloquear cierre, solo alertar.
// expiry_alert_days=3: umbral global; cada producto override a 2 días.

async function setPasteleriaFlags(client) {
  log('\n[3] Configurando flags de pastelería…')
  const current = await client.get('/api/process-config').expect(200)

  const wantedFlags = {
    uses_lots:                     true,
    uses_expiry:                   true,
    uses_fefo:                     true,
    uses_handover:                 true,
    uses_supervisor:               true,
    supervisor_validates:          true,
    pt_goes_to_wip_first:          true,   // pasteles van a WIP (decorado antes de venta)
    mp_goes_to_wip_first:          false,
    allow_second_quality_in_order: false,
    default_intra_shift_proration: 'time',
    cost_method:                   'fifo',
    treat_abnormal_scrap_as_loss:  true,
    allergen_mode:                 'alert_only', // gluten/lácteos/huevo en todo → no bloquear
    expiry_alert_days:             3,            // alerta base a 3 días
  }

  const needsUpdate = Object.entries(wantedFlags).some(([k, v]) => current.body[k] !== v)
  if (!needsUpdate) { skip('Flags de pastelería ya aplicados'); return current.body }

  const res = await client.patch('/api/process-config', wantedFlags)
  if (res.status !== 200) fail(`PATCH /api/process-config falló (${res.status})`, res.body)
  ok(`Flags actualizadas: ${Object.keys(wantedFlags).join(', ')}`)
  return res.body
}

// ─── 4. Alérgenos (alert_only — todos los pasteles tienen gluten/huevo/lácteos)

async function ensureAllergens(client) {
  log('\n[4] Verificando alérgenos…')
  const list = await client.get('/api/process-config/allergens').expect(200)
  const byCode = Object.fromEntries(list.body.map(a => [a.code, a]))

  // Pastelería: gluten + lácteos + huevo son "de base" → alert_only, NO priority_block
  const expected = [
    { code: 'gluten',  name: 'Gluten',  is_priority: false },
    { code: 'lacteos', name: 'Lácteos', is_priority: false },
    { code: 'huevo',   name: 'Huevo',   is_priority: false },
  ]
  for (const a of expected) {
    const existing = byCode[a.code]
    if (!existing) {
      const res = await client.post('/api/process-config/allergens', a)
      if (res.status !== 201) fail(`POST alérgeno '${a.code}' falló (${res.status})`, res.body)
      ok(`Creado alérgeno '${a.code}'`)
    } else {
      skip(`Alérgeno '${a.code}' ya existe`)
    }
  }
}

// ─── 5. Tipos de merma ────────────────────────────────────────────────────

async function customizeScrapTypes(client) {
  log('\n[5] Personalizando tipos de merma para pastelería…')
  const list = await client.get('/api/process-config/scrap-types').expect(200)
  const byCode = Object.fromEntries(list.body.map(t => [t.code, t]))

  const newTypes = [
    { code: 'rebaba_betun',      name: 'Rebaba de betún',      default_destination: 'reprocess', default_recovery_value_pct: 70, is_normal: true,  sort_order: 50 },
    { code: 'pastel_roto',       name: 'Pastel roto',           default_destination: 'discard',   default_recovery_value_pct: 0,  is_normal: false, sort_order: 60 },
    { code: 'producto_caducado', name: 'Producto caducado',     default_destination: 'discard',   default_recovery_value_pct: 0,  is_normal: false, sort_order: 70 },
    { code: 'recorte_bizcocho',  name: 'Recorte de bizcocho',   default_destination: 'reprocess', default_recovery_value_pct: 60, is_normal: true,  sort_order: 80 },
  ]
  for (const t of newTypes) {
    if (byCode[t.code]) {
      skip(`scrap-type '${t.code}' ya existe`)
    } else {
      const res = await client.post('/api/process-config/scrap-types', t)
      if (res.status !== 201) fail(`POST scrap-type '${t.code}' falló (${res.status})`, res.body)
      ok(`Creado scrap-type '${t.code}'`)
    }
  }

  for (const code of ['arranque', 'operacion', 'contaminada', 'desecho']) {
    const t = byCode[code]
    if (!t || !t.is_active) { skip(`scrap-type '${code}' ya inactivo o no existe`); continue }
    const res = await client.patch(`/api/process-config/scrap-types/${t.id}`, { is_active: false })
    if (res.status !== 200) fail(`PATCH scrap-type '${code}' falló (${res.status})`, res.body)
    ok(`Desactivado scrap-type '${code}'`)
  }
}

// ─── 6. Calidades ─────────────────────────────────────────────────────────

async function customizeQualityGrades(client) {
  log('\n[6] Configurando calidades…')
  const list = await client.get('/api/process-config/quality-grades').expect(200)
  const byCode = Object.fromEntries(list.body.map(g => [g.code, g]))

  const renames = [
    { code: 'primera', name: 'Apto Venta',    counts_for_order_fulfillment: true  },
    { code: 'segunda', name: 'Muestra/Merma', counts_for_order_fulfillment: false },
  ]
  for (const w of renames) {
    const g = byCode[w.code]
    if (!g) { skip(`quality-grade '${w.code}' no existe`); continue }
    const needsUpdate = g.name !== w.name || g.counts_for_order_fulfillment !== w.counts_for_order_fulfillment
    if (!needsUpdate) { skip(`quality-grade '${w.code}' ya configurada`); continue }
    const res = await client.patch(`/api/process-config/quality-grades/${g.id}`, {
      name: w.name, counts_for_order_fulfillment: w.counts_for_order_fulfillment,
    })
    if (res.status !== 200) fail(`PATCH quality-grade '${w.code}' falló (${res.status})`, res.body)
    ok(`Configurada '${w.code}' → "${w.name}"`)
  }

  const tercera = byCode['tercera']
  if (tercera?.is_active) {
    const res = await client.patch(`/api/process-config/quality-grades/${tercera.id}`, { is_active: false })
    if (res.status !== 200) fail(`PATCH quality-grade 'tercera' falló`, res.body)
    ok(`Desactivada quality-grade 'tercera'`)
  } else {
    skip("quality-grade 'tercera' ya inactiva")
  }
}

// ─── 7. Product kinds ─────────────────────────────────────────────────────
//
// pastel_estandar (shelf 3d), pastel_personalizado (shelf 2d).

async function createProductKinds(client) {
  log('\n[7] Creando product_kinds…')

  const units  = await client.get('/api/process-config/units').expect(200)
  const grades = await client.get('/api/process-config/quality-grades').expect(200)
  const kgId      = units.body.find(u => u.code === 'kg')?.id
  const primeraId = grades.body.find(g => g.code === 'primera')?.id
  if (!kgId)      fail('No se encontró unidad "kg"')
  if (!primeraId) fail('No se encontró quality-grade "primera"')

  const existing = await client.get('/api/process-config/product-kinds').expect(200)
  const byCode   = Object.fromEntries(existing.body.map(k => [k.code, k]))

  const kinds = [
    {
      code: 'pastel_estandar',
      name: 'Pastel estándar',
      default_shelf_life_days: 3,
      base_unit_id: kgId,
      default_quality_grade_id: primeraId,
      is_produced: true,
      attribute_schema: [
        { code: 'sabor',   label: 'Sabor',   type: 'select', required: true,  options: ['chocolate','vainilla','zanahoria','red_velvet'] },
        { code: 'tamano',  label: 'Tamaño',  type: 'select', required: true,  options: ['chico_15cm','mediano_20cm','grande_25cm'] },
        { code: 'betun',   label: 'Betún',   type: 'select', required: false, options: ['queso_crema','buttercream','ganache','fondant'] },
      ],
      capture_schema: [
        { code: 'piezas',       label: 'Piezas',           type: 'number', required: true,  ui_hint: 'large_keypad' },
        { code: 'peso_real_kg', label: 'Peso real (kg)',   type: 'number', required: true  },
        { code: 'temp_horno_c', label: 'Temp. horno (°C)', type: 'number', required: false },
      ],
    },
    {
      code: 'pastel_personalizado',
      name: 'Pastel personalizado',
      default_shelf_life_days: 2,
      base_unit_id: kgId,
      default_quality_grade_id: primeraId,
      is_produced: true,
      attribute_schema: [
        { code: 'sabor',  label: 'Sabor',   type: 'select', required: true, options: ['chocolate','vainilla','zanahoria','red_velvet'] },
        { code: 'tamano', label: 'Tamaño',  type: 'select', required: true, options: ['chico_15cm','mediano_20cm','grande_25cm','extra_30cm'] },
        { code: 'betun',  label: 'Betún',   type: 'select', required: true, options: ['queso_crema','buttercream','ganache','fondant'] },
      ],
      capture_schema: [
        { code: 'piezas',       label: 'Piezas',         type: 'number', required: true, ui_hint: 'large_keypad' },
        { code: 'peso_real_kg', label: 'Peso real (kg)', type: 'number', required: true  },
      ],
    },
  ]

  const result = {}
  for (const k of kinds) {
    if (byCode[k.code]) {
      skip(`product-kind '${k.code}' ya existe (id=${byCode[k.code].id})`)
      result[k.code] = byCode[k.code]
      continue
    }
    const res = await client.post('/api/process-config/product-kinds', k)
    if (res.status !== 201) fail(`POST product-kind '${k.code}' falló (${res.status})`, res.body)
    ok(`Creado product-kind '${k.code}' (id=${res.body.id}, shelf=${k.default_shelf_life_days}d)`)
    result[k.code] = res.body
  }
  return result
}

// ─── 8. Unidades ─────────────────────────────────────────────────────────

async function ensureUnits(client) {
  log('\n[8] Verificando unidades…')
  const list = await client.get('/api/process-config/units').expect(200)
  const byCodes = Object.fromEntries(list.body.map(u => [u.code, u]))

  const needed = [
    { code: 'kg',  symbol: 'kg',  name: 'Kilogramo', unit_type: 'weight' },
    { code: 'g',   symbol: 'g',   name: 'Gramo',      unit_type: 'weight' },
    { code: 'pza', symbol: 'pza', name: 'Pieza',      unit_type: 'count'  },
    { code: 'ml',  symbol: 'ml',  name: 'Mililitro',  unit_type: 'volume' },
  ]
  for (const u of needed) {
    if (byCodes[u.code]) { skip(`unidad '${u.code}' ya existe`); continue }
    const res = await client.post('/api/process-config/units', u)
    if (res.status !== 201) fail(`POST unit '${u.code}' falló (${res.status})`, res.body)
    ok(`Creada unidad '${u.code}'`)
  }
}

// ─── 9. Materias primas (13 componentes) ──────────────────────────────────
//
// Pastelería valida recetas largas (10-15 componentes). Cubrimos 13.

async function ensureRawMaterials(client, tenantId) {
  log('\n[9] Asegurando materias primas (13 ingredientes)…')

  const list  = await client.get('/api/raw-materials').expect(200)
  const items = Array.isArray(list.body) ? list.body : (list.body.data || list.body.items || [])
  const byName = Object.fromEntries(items.map(r => [r.name, r]))

  const materials = [
    { name: 'Harina de trigo',      resinType: 'PP', materialType: 'virgin', unit: 'kg', costPerKg: 12.00, description: 'Harina de trigo todo uso' },
    { name: 'Azúcar refinada',      resinType: 'PP', materialType: 'virgin', unit: 'kg', costPerKg: 18.00, description: 'Azúcar blanca refinada' },
    { name: 'Mantequilla',          resinType: 'PP', materialType: 'virgin', unit: 'kg', costPerKg: 95.00, description: 'Mantequilla sin sal' },
    { name: 'Huevo entero',         resinType: 'PP', materialType: 'virgin', unit: 'kg', costPerKg: 45.00, description: 'Huevo fresco (precio por kg)' },
    { name: 'Leche entera',         resinType: 'PP', materialType: 'virgin', unit: 'kg', costPerKg: 14.00, description: 'Leche entera UHT' },
    { name: 'Polvo para hornear',   resinType: 'PP', materialType: 'virgin', unit: 'kg', costPerKg: 80.00, description: 'Polvo leudante doble acción' },
    { name: 'Extracto de vainilla', resinType: 'PP', materialType: 'virgin', unit: 'kg', costPerKg: 350.0, description: 'Vainilla pura mexicana' },
    { name: 'Cacao en polvo',       resinType: 'PP', materialType: 'virgin', unit: 'kg', costPerKg: 120.0, description: 'Cacao sin azúcar 100% cacao' },
    { name: 'Chocolate amargo',     resinType: 'PP', materialType: 'virgin', unit: 'kg', costPerKg: 180.0, description: 'Chocolate amargo para ganache' },
    { name: 'Crema para batir',     resinType: 'PP', materialType: 'virgin', unit: 'kg', costPerKg: 78.00, description: 'Crema 35% grasa para betún' },
    { name: 'Queso crema',          resinType: 'PP', materialType: 'virgin', unit: 'kg', costPerKg: 110.0, description: 'Queso crema para betún' },
    { name: 'Fondant blanco',       resinType: 'PP', materialType: 'virgin', unit: 'kg', costPerKg: 95.00, description: 'Fondant para cobertura decorativa' },
    { name: 'Colorante alimenticio',resinType: 'PP', materialType: 'virgin', unit: 'kg', costPerKg: 800.0, description: 'Colorantes gel food-grade (varios colores)' },
  ]

  const result = {}
  for (const m of materials) {
    if (byName[m.name]) {
      skip(`raw_material '${m.name}' ya existe`)
      result[m.name] = byName[m.name]
      continue
    }
    const res = await client.post('/api/raw-materials', m)
    if (res.status !== 201) fail(`POST raw_material '${m.name}' falló (${res.status})`, res.body)
    ok(`Creada MP '${m.name}' (id=${res.body.id})`)
    result[m.name] = res.body
  }

  // Asociar alérgenos a MPs vía SQL (gluten, lácteos, huevo)
  const allergenCodes = ['gluten', 'lacteos', 'huevo']
  const { rows: allergenRows } = await withBypass(() => query(
    `SELECT id, code FROM tenant_allergens WHERE tenant_id = $1 AND code = ANY($2)`,
    [tenantId, allergenCodes]
  ))
  const allergenByCode = Object.fromEntries(allergenRows.map(a => [a.code, a]))

  const rmaMap = {
    'Harina de trigo':       ['gluten'],
    'Mantequilla':           ['lacteos'],
    'Huevo entero':          ['huevo'],
    'Leche entera':          ['lacteos'],
    'Chocolate amargo':      ['lacteos'],
    'Crema para batir':      ['lacteos'],
    'Queso crema':           ['lacteos'],
    'Fondant blanco':        ['lacteos'],
  }
  for (const [rmName, codes] of Object.entries(rmaMap)) {
    const rm = result[rmName]
    if (!rm) continue
    for (const code of codes) {
      const allergen = allergenByCode[code]
      if (!allergen) continue
      await withBypass(() => query(
        `INSERT INTO raw_material_allergens (raw_material_id, allergen_id, declaration)
         VALUES ($1, $2, 'contains')
         ON CONFLICT DO NOTHING`,
        [rm.id, allergen.id]
      ))
    }
  }
  ok(`Alérgenos asociados a MPs`)

  return result
}

// ─── 10. Productos ────────────────────────────────────────────────────────

async function ensureProducts(client, tenantId, productKinds) {
  log('\n[10] Asegurando productos…')

  const list  = await client.get('/api/products').expect(200)
  const items = Array.isArray(list.body) ? list.body : (list.body.data || list.body.items || [])
  const bySku = Object.fromEntries(items.map(p => [p.sku, p]))

  const grades = await client.get('/api/process-config/quality-grades').expect(200)
  const primeraGrade = grades.body.find(g => g.code === 'primera')

  const products = [
    { sku: 'PAS-CHOC-20CM',  name: 'Pastel de Chocolate 20cm',  kindCode: 'pastel_estandar',      price: 350.0 },
    { sku: 'PAS-VAIN-20CM',  name: 'Pastel de Vainilla 20cm',   kindCode: 'pastel_estandar',      price: 320.0 },
    { sku: 'PAS-PERS-20CM',  name: 'Pastel Personalizado 20cm', kindCode: 'pastel_personalizado', price: 480.0 },
    { sku: 'PAS-PERS-25CM',  name: 'Pastel Personalizado 25cm', kindCode: 'pastel_personalizado', price: 680.0 },
  ]

  const result = {}
  for (const p of products) {
    let product = bySku[p.sku]
    if (!product) {
      const res = await client.post('/api/products', {
        sku: p.sku, name: p.name,
        type: 'corner_protector', resinType: 'PP',
        saleUnit: 'pza', basePrice: p.price, baseCurrency: 'MXN',
      })
      if (res.status !== 201) fail(`POST /api/products '${p.sku}' falló (${res.status})`, res.body)
      ok(`Creado producto '${p.sku}' (id=${res.body.id})`)
      product = res.body
    } else {
      skip(`producto '${p.sku}' ya existe (id=${product.id})`)
    }

    const kind = productKinds[p.kindCode]
    const needsV2 = !product.product_kind_id || !product.default_quality_grade_id || !product.is_produced || product.expiry_alert_days !== 2
    if (needsV2) {
      await withBypass(() => query(
        `UPDATE products
           SET product_kind_id = $1,
               default_quality_grade_id = $2,
               expected_sale_price = $3,
               is_produced = true,
               expiry_alert_days = 2
         WHERE id = $4 AND tenant_id = $5`,
        [kind?.id, primeraGrade?.id, p.price, product.id, tenantId]
      ))
      ok(`  SaaS v2 fields + expiry_alert_days=2 seteados para '${p.sku}'`)
    }

    result[p.sku] = product
  }

  // Declarar alérgenos en productos (gluten, lácteos, huevo — todos los pasteles los tienen)
  const { rows: allergenRows } = await withBypass(() => query(
    `SELECT id, code FROM tenant_allergens WHERE tenant_id = $1 AND code = ANY($2)`,
    [tenantId, ['gluten', 'lacteos', 'huevo']]
  ))
  for (const prod of Object.values(result)) {
    for (const a of allergenRows) {
      await withBypass(() => query(
        `INSERT INTO product_allergens (product_id, allergen_id, declaration)
         VALUES ($1, $2, 'contains') ON CONFLICT DO NOTHING`,
        [prod.id, a.id]
      ))
    }
  }
  ok(`Alérgenos declarados en todos los productos`)

  return result
}

// ─── 11. Recetas (10-15 componentes) ─────────────────────────────────────
//
// Pastel de Chocolate: 13 componentes
// Pastel de Vainilla:  11 componentes
// Pastel Personalizado: comparte receta base del tamaño correspondiente

async function ensureRecipes(client, products, rawMaterials) {
  log('\n[11] Asegurando recetas…')

  const units  = await client.get('/api/process-config/units').expect(200)
  const kgUnit = units.body.find(u => u.code === 'kg')
  const gUnit  = units.body.find(u => u.code === 'g')
  const mlUnit = units.body.find(u => u.code === 'ml')
  if (!kgUnit) fail('No se encontró unidad "kg"')
  const gId  = gUnit?.id  || kgUnit.id
  const mlId = mlUnit?.id || kgUnit.id

  const rm = rawMaterials

  // ── Receta pastel de chocolate 20cm (13 componentes) ──
  const chocolateComponents = [
    { raw_material_id: rm['Harina de trigo'].id,      quantity: 0.250, unit_id: kgUnit.id, sort_order: 10 },
    { raw_material_id: rm['Azúcar refinada'].id,       quantity: 0.300, unit_id: kgUnit.id, sort_order: 20 },
    { raw_material_id: rm['Mantequilla'].id,           quantity: 0.120, unit_id: kgUnit.id, sort_order: 30 },
    { raw_material_id: rm['Huevo entero'].id,          quantity: 0.200, unit_id: kgUnit.id, sort_order: 40 },
    { raw_material_id: rm['Leche entera'].id,          quantity: 0.150, unit_id: kgUnit.id, sort_order: 50 },
    { raw_material_id: rm['Cacao en polvo'].id,        quantity: 0.060, unit_id: kgUnit.id, sort_order: 60 },
    { raw_material_id: rm['Chocolate amargo'].id,      quantity: 0.100, unit_id: kgUnit.id, sort_order: 70 },
    { raw_material_id: rm['Polvo para hornear'].id,    quantity: 0.008, unit_id: kgUnit.id, sort_order: 80 },
    { raw_material_id: rm['Extracto de vainilla'].id,  quantity: 0.005, unit_id: kgUnit.id, sort_order: 90 },
    { raw_material_id: rm['Crema para batir'].id,      quantity: 0.200, unit_id: kgUnit.id, sort_order: 100 },
    { raw_material_id: rm['Queso crema'].id,            quantity: 0.080, unit_id: kgUnit.id, sort_order: 110, is_optional: true },
    { raw_material_id: rm['Fondant blanco'].id,        quantity: 0.050, unit_id: kgUnit.id, sort_order: 120, is_optional: true },
    { raw_material_id: rm['Colorante alimenticio'].id, quantity: 0.002, unit_id: kgUnit.id, sort_order: 130, is_optional: true },
  ]

  // ── Receta pastel de vainilla 20cm (11 componentes) ──
  const vanillaComponents = [
    { raw_material_id: rm['Harina de trigo'].id,      quantity: 0.250, unit_id: kgUnit.id, sort_order: 10 },
    { raw_material_id: rm['Azúcar refinada'].id,       quantity: 0.280, unit_id: kgUnit.id, sort_order: 20 },
    { raw_material_id: rm['Mantequilla'].id,           quantity: 0.130, unit_id: kgUnit.id, sort_order: 30 },
    { raw_material_id: rm['Huevo entero'].id,          quantity: 0.200, unit_id: kgUnit.id, sort_order: 40 },
    { raw_material_id: rm['Leche entera'].id,          quantity: 0.180, unit_id: kgUnit.id, sort_order: 50 },
    { raw_material_id: rm['Polvo para hornear'].id,    quantity: 0.010, unit_id: kgUnit.id, sort_order: 60 },
    { raw_material_id: rm['Extracto de vainilla'].id,  quantity: 0.008, unit_id: kgUnit.id, sort_order: 70 },
    { raw_material_id: rm['Crema para batir'].id,      quantity: 0.200, unit_id: kgUnit.id, sort_order: 80 },
    { raw_material_id: rm['Queso crema'].id,           quantity: 0.150, unit_id: kgUnit.id, sort_order: 90 },
    { raw_material_id: rm['Fondant blanco'].id,        quantity: 0.060, unit_id: kgUnit.id, sort_order: 100, is_optional: true },
    { raw_material_id: rm['Colorante alimenticio'].id, quantity: 0.001, unit_id: kgUnit.id, sort_order: 110, is_optional: true },
  ]

  const recipesDef = [
    { prodSku: 'PAS-CHOC-20CM', name: 'Pastel Chocolate 20cm — receta base', yieldKg: 1.0, components: chocolateComponents },
    { prodSku: 'PAS-VAIN-20CM', name: 'Pastel Vainilla 20cm — receta base',  yieldKg: 1.0, components: vanillaComponents  },
    { prodSku: 'PAS-PERS-20CM', name: 'Pastel Personalizado 20cm — base',    yieldKg: 1.0, components: vanillaComponents  },
    { prodSku: 'PAS-PERS-25CM', name: 'Pastel Personalizado 25cm — base',    yieldKg: 1.5, components: chocolateComponents },
  ]

  const result = {}
  for (const rd of recipesDef) {
    const prodId   = products[rd.prodSku]?.id
    if (!prodId) { skip(`Producto '${rd.prodSku}' no encontrado — saltando receta`); continue }

    const existing = await client.get(`/api/recipes?productId=${prodId}&vigentOnly=true`).expect(200)
    if (existing.body.length > 0) {
      skip(`receta '${rd.name}' ya existe (id=${existing.body[0].id}, ${existing.body[0].components?.length ?? '?'} componentes)`)
      result[rd.prodSku] = existing.body[0]
      continue
    }

    const res = await client.post('/api/recipes', {
      product_id:        prodId,
      name:              rd.name,
      yield_quantity:    rd.yieldKg,
      yield_unit_id:     kgUnit.id,
      expected_scrap_pct: 8.0,
      components:        rd.components,
    })
    if (res.status !== 201) fail(`POST /api/recipes '${rd.name}' falló (${res.status})`, res.body)
    ok(`Creada receta '${rd.name}' (id=${res.body.id}, ${rd.components.length} componentes)`)
    result[rd.prodSku] = res.body
  }
  return result
}

// ─── 12. Gastos indirectos ────────────────────────────────────────────────

async function ensureOverheadItems(client) {
  log('\n[12] Asegurando gastos indirectos…')

  const list    = await client.get('/api/overhead/items').expect(200)
  const byCode  = Object.fromEntries(list.body.map(i => [i.code, i]))

  const items = [
    { code: 'renta',          name: 'Renta del local',      basis: 'units_produced', amount: 25000, frequency: 'monthly'  },
    { code: 'luz_gas',        name: 'Luz / Gas',            basis: 'units_produced', amount: 8000,  frequency: 'monthly'  },
    { code: 'nomina',         name: 'Nómina',               basis: 'units_produced', amount: 60000, frequency: 'biweekly' },
    { code: 'insumos_decor',  name: 'Insumos decoración',   basis: 'units_produced', amount: 5000,  frequency: 'monthly'  },
    { code: 'empaques',       name: 'Empaques y cajas',     basis: 'units_produced', amount: 3000,  frequency: 'monthly'  },
  ]
  for (const i of items) {
    if (byCode[i.code]) { skip(`overhead '${i.code}' ya existe`); continue }
    const res = await client.post('/api/overhead/items', {
      code: i.code, name: i.name,
      allocation_basis: i.basis,
      estimated_monthly_amount: i.amount,
      frequency: i.frequency,
      is_active: true,
    })
    if (res.status !== 201) fail(`POST overhead '${i.code}' falló (${res.status})`, res.body)
    ok(`Creado overhead '${i.code}' ($${i.amount.toLocaleString()} / ${i.frequency})`)
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────

async function main() {
  try {
    const tenant = await provisionOrFindTenant()
    const token  = await login()
    const client = clientFor(token)

    await setPasteleriaFlags(client)
    await ensureAllergens(client)
    await customizeScrapTypes(client)
    await customizeQualityGrades(client)
    const productKinds = await createProductKinds(client)
    await ensureUnits(client)
    const rawMaterials = await ensureRawMaterials(client, tenant.id)
    const products     = await ensureProducts(client, tenant.id, productKinds)
    await ensureRecipes(client, products, rawMaterials)
    await ensureOverheadItems(client)

    log('\n' + '─'.repeat(70))
    log('Verificación de estado:')
    log('─'.repeat(70))

    const cfg    = await client.get('/api/process-config').expect(200)
    const scraps = await client.get('/api/process-config/scrap-types').expect(200)
    const kinds  = await client.get('/api/process-config/product-kinds').expect(200)
    const prods  = await client.get('/api/products').expect(200)
    const prodItems = Array.isArray(prods.body) ? prods.body : (prods.body.data || prods.body.items || [])

    log(`\n  Flags clave:`)
    log(`    - uses_lots=${cfg.body.uses_lots} uses_expiry=${cfg.body.uses_expiry} uses_fefo=${cfg.body.uses_fefo}`)
    log(`    - allergen_mode=${cfg.body.allergen_mode}`)
    log(`    - pt_goes_to_wip_first=${cfg.body.pt_goes_to_wip_first}`)
    log(`    - expiry_alert_days=${cfg.body.expiry_alert_days} (global; por producto: 2d vía migration 139)`)

    log(`\n  Tipos de merma activos:`)
    scraps.body.filter(s => s.is_active).forEach(s =>
      log(`    - ${s.code} (${s.default_destination}, ${s.default_recovery_value_pct}%)`)
    )

    log(`\n  Product kinds:`)
    kinds.body.forEach(k => log(`    - ${k.code} (id=${k.id}, shelf=${k.default_shelf_life_days}d)`))

    log(`\n  Productos:`)
    prodItems.forEach(p =>
      log(`    - ${p.sku}: expiry_alert_days=${p.expiry_alert_days ?? 'NULL (hereda global)'} kind=${p.product_kind_id ? 'seteado' : 'sin kind'}`)
    )

    log('\n' + '═'.repeat(70))
    log('  Provisión de pastelería-piloto completada.')
    log(`\n  Para resetear: DELETE FROM tenants WHERE slug = 'pasteleria-piloto';`)
    log('═'.repeat(70))
    log('')
  } catch (err) {
    console.error('\nError no manejado:', err.stack || err)
    process.exit(1)
  } finally {
    await pool.end()
  }
}

main()
