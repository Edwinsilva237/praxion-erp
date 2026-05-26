'use strict'

/**
 * SaaS v2 — Simula un turno end-to-end en el tenant 'frituras-piloto'.
 *
 * Objetivo (Fase 4): validar los 3 criterios de done del diseño §7.6:
 *   1. Frituras produce con múltiples sabores (limón, queso).
 *   2. Papas rotas → Merma Reproceso → increments stock de MP-PAPAS-ROTAS.
 *   3. Saborizante queso (lácteos prioritario) bloquea cierre si no declarado
 *      en el producto → se desbloquea al declarar el alérgeno.
 *
 * Validaciones secundarias:
 *   - pt_goes_to_wip_first=false → paquetes van directo a PT (no WIP).
 *   - scrapTypeResolver resuelve 'rotas_quebradas' desde catálogo tenant.
 *
 * Pre-requisito: `node scripts/provision-frituras.js` ya corrió.
 *
 * Uso:
 *   node scripts/simulate-frituras-shift.js
 */

require('dotenv').config()
const request = require('supertest')
const app     = require('../src/app')
const { pool, query, withBypass, withTransaction } = require('../src/db')
const inventoryService = require('../src/modules/inventory/inventoryService')

const SLUG  = 'frituras-piloto'
const EMAIL = 'admin@frituras-piloto.local'
const PASS  = 'Frituras!2026'

const log  = (...args) => console.log(...args)
const ok   = (msg) => console.log('  ✓', msg)
const skip = (msg) => console.log('  ⊘', msg)
const warn = (msg) => console.log('  ⚠', msg)
const fail = (msg, extra) => { console.error('  ✗', msg); if (extra) console.error('   ', extra); process.exit(1) }
const gap  = (msg) => console.log('  ⚠ GAP:', msg)

const GAPS = []
const recordGap = (id, summary) => { GAPS.push({ id, summary }); gap(`[${id}] ${summary}`) }

function clientFor(token) {
  const headers = { 'X-Tenant-Slug': SLUG, 'Authorization': `Bearer ${token}` }
  const wrap = (method) => (path, body) => {
    const r = request(app)[method](path).set(headers)
    if (body) r.send(body)
    return r
  }
  return { get: wrap('get'), post: wrap('post'), patch: wrap('patch'), put: wrap('put'), delete: wrap('delete') }
}

// ─── 1. Login + contexto ──────────────────────────────────────────────────

async function loginAndContext() {
  log('\n[1] Login + contexto…')
  const tenantRow = await withBypass(() => query(
    `SELECT id, slug, name FROM tenants WHERE slug = $1`, [SLUG]
  ))
  if (tenantRow.rows.length === 0) {
    fail(`Tenant '${SLUG}' no existe. Corre 'node scripts/provision-frituras.js' primero.`)
  }
  const tenant = tenantRow.rows[0]
  ok(`Tenant: ${tenant.name} (${tenant.id})`)

  const res = await request(app)
    .post('/api/auth/login')
    .set('X-Tenant-Slug', SLUG)
    .send({ email: EMAIL, password: PASS })
  if (res.status !== 200) fail(`Login falló (${res.status})`, res.body)
  ok(`Logged in como ${EMAIL}`)

  const userRow = await withBypass(() => query(
    `SELECT id FROM users WHERE tenant_id = $1 AND email = $2`, [tenant.id, EMAIL]
  ))
  const userId = userRow.rows[0].id
  ok(`User id: ${userId}`)

  return { tenant, token: res.body.accessToken, userId }
}

// ─── 2. Warehouses ────────────────────────────────────────────────────────

async function ensureWarehouses(client) {
  log('\n[2] Asegurando warehouses…')
  const list = await client.get('/api/warehouses').expect(200)
  const byName = Object.fromEntries(list.body.map(w => [w.name, w]))

  // Frituras: MP · Saborizantes · Embalaje · WIP · PT · Merma Reproceso · Merma Desecho
  // WIP requerido: lot-mode siempre pasa por WIP (Diseño §21), sin importar pt_goes_to_wip_first.
  // "Merma Reproceso" mapea a 'regrind' (lo más cercano), "Merma Desecho" a 'regrind' tmb.
  const wanted = [
    { name: 'MP Papa Cruda',       type: 'raw_material',     resin_type: 'PE',  description: 'Materia prima papa fresca' },
    { name: 'Saborizantes',        type: 'raw_material',     resin_type: 'PE',  description: 'Saborizantes y condimentos' },
    { name: 'Embalaje Frituras',   type: 'raw_material',     resin_type: 'PE',  description: 'Bolsas y empaques' },
    { name: 'WIP Frituras',        type: 'wip',                                 description: 'WIP — lotes en proceso (lot-mode §21)' },
    { name: 'PT Frituras',         type: 'finished_product',                    description: 'Producto terminado listo para venta' },
    { name: 'Merma Reproceso',     type: 'regrind',          resin_type: 'PE',  description: 'Papas rotas pendientes de reproceso' },
    { name: 'Merma Desecho',       type: 'regrind',          resin_type: 'PE',  description: 'Merma sin valor (quemadas)' },
  ]

  const created = {}
  for (const w of wanted) {
    if (byName[w.name]) {
      skip(`warehouse '${w.name}' ya existe (id=${byName[w.name].id})`)
      created[w.name] = byName[w.name]
      continue
    }
    const res = await client.post('/api/warehouses', { ...w, is_active: true })
    if (res.status !== 201) {
      recordGap('WAREHOUSE_CREATE', `POST /api/warehouses '${w.name}' falló (${res.status}): ${JSON.stringify(res.body)}`)
      continue
    }
    ok(`Creado warehouse '${w.name}' (id=${res.body.id})`)
    created[w.name] = res.body
  }

  // Actualizar warehouse_type_id (legacy API no lo setea)
  const typeCodeMap = {
    raw_material:     'materia_prima',
    finished_product: 'producto_terminado',
    wip:              'wip',
    regrind:          'merma',
  }
  for (const w of Object.values(created)) {
    if (w.warehouse_type_id) continue
    const targetCode = typeCodeMap[w.type]
    if (!targetCode) continue
    await withBypass(() => query(
      `UPDATE warehouses
         SET warehouse_type_id = (
           SELECT id FROM tenant_warehouse_types
           WHERE tenant_id = warehouses.tenant_id AND code = $1
         )
       WHERE id = $2`,
      [targetCode, w.id]
    ))
  }
  return created
}

// ─── 3. Materias primas ───────────────────────────────────────────────────

async function ensureRawMaterials(client, tenantId) {
  log('\n[3] Asegurando materias primas…')

  const list = await client.get('/api/raw-materials').expect(200)
  const items = Array.isArray(list.body) ? list.body : (list.body.data || list.body.items || list.body.rows || [])
  const byName = Object.fromEntries(items.map(r => [r.name, r]))

  const wanted = [
    { name: 'Papa cruda',               resinType: 'PP', materialType: 'virgin', unit: 'kg',  costPerKg: 4.50,  description: 'Papa fresca por kg' },
    { name: 'Aceite vegetal',            resinType: 'PP', materialType: 'virgin', unit: 'kg',  costPerKg: 28.00, description: 'Aceite vegetal de freído' },
    { name: 'Sal',                       resinType: 'PP', materialType: 'virgin', unit: 'kg',  costPerKg: 3.00,  description: 'Sal de mesa' },
    { name: 'Saborizante limón',         resinType: 'PP', materialType: 'virgin', unit: 'kg',  costPerKg: 120.0, description: 'Saborizante natural de limón — sin alérgenos' },
    { name: 'Saborizante queso',         resinType: 'PP', materialType: 'virgin', unit: 'kg',  costPerKg: 150.0, description: 'Saborizante queso — CONTIENE LÁCTEOS' },
    { name: 'Bolsa metalizada 100g',     resinType: 'PP', materialType: 'virgin', unit: 'pza', costPerKg: 0.80,  description: 'Bolsa metalizada sellable 100g' },
  ]

  const result = {}
  for (const w of wanted) {
    if (byName[w.name]) {
      skip(`raw_material '${w.name}' ya existe (id=${byName[w.name].id})`)
      result[w.name] = byName[w.name]
      continue
    }
    const res = await client.post('/api/raw-materials', w)
    if (res.status !== 201) fail(`POST /api/raw-materials '${w.name}' falló (${res.status})`, res.body)
    ok(`Creado raw_material '${w.name}' (id=${res.body.id})`)
    result[w.name] = res.body
  }

  // Asociar alérgeno 'lacteos' al saborizante queso (via SQL — no hay REST para esto)
  const sabQueso = result['Saborizante queso']
  const { rows: allergenRows } = await withBypass(() => query(
    `SELECT id FROM tenant_allergens WHERE tenant_id = $1 AND code = 'lacteos'`, [tenantId]
  ))
  if (allergenRows.length > 0) {
    const allergenId = allergenRows[0].id
    // Verificar si ya está asociado
    const { rows: assoc } = await withBypass(() => query(
      `SELECT 1 FROM raw_material_allergens WHERE raw_material_id = $1 AND allergen_id = $2`,
      [sabQueso.id, allergenId]
    ))
    if (assoc.length > 0) {
      skip(`alérgeno 'lacteos' ya asociado a 'Saborizante queso'`)
    } else {
      await withBypass(() => query(
        `INSERT INTO raw_material_allergens (raw_material_id, allergen_id, declaration)
         VALUES ($1, $2, 'contains')
         ON CONFLICT DO NOTHING`,
        [sabQueso.id, allergenId]
      ))
      ok(`Asociado alérgeno 'lacteos' → 'Saborizante queso' (declaration=contains)`)
    }
  } else {
    recordGap('ALLERGEN_LACTEOS_NOT_FOUND', `No se encontró tenant_allergen con code='lacteos' para tenant ${tenantId}`)
  }

  return result
}

// ─── 4. Productos ─────────────────────────────────────────────────────────

async function ensureProducts(client, tenantId) {
  log('\n[4] Asegurando productos (Papas Limón y Papas Queso)…')

  const list = await client.get('/api/products').expect(200)
  const items = Array.isArray(list.body) ? list.body : (list.body.data || list.body.items || list.body.rows || [])
  const bySku = Object.fromEntries(items.map(p => [p.sku, p]))

  const grades = await client.get('/api/process-config/quality-grades').expect(200)
  const primeraGrade = grades.body.find(g => g.code === 'primera')
  const kinds = await client.get('/api/process-config/product-kinds').expect(200)
  const friturasKind = kinds.body.find(k => k.code === 'frituras_saladas')

  const wanted = [
    {
      sku: 'FRI-PAP-LIM-100G',
      name: 'Papas Limón 100g',
      expected_sale_price: 18.0,
      allergens_to_declare: [],  // sin alérgenos prioritarios
    },
    {
      sku: 'FRI-PAP-QUE-100G',
      name: 'Papas Queso 100g',
      expected_sale_price: 20.0,
      allergens_to_declare: [],  // ← inicialmente SIN declarar — para probar el bloqueo
    },
  ]

  const result = {}
  for (const w of wanted) {
    let product = bySku[w.sku]
    if (!product) {
      const res = await client.post('/api/products', {
        sku: w.sku,
        name: w.name,
        type: 'corner_protector',  // workaround enum legacy
        resinType: 'PP',
        saleUnit: 'kg',
        basePrice: w.expected_sale_price,
        baseCurrency: 'MXN',
      })
      if (res.status !== 201) fail(`POST /api/products '${w.sku}' falló (${res.status})`, res.body)
      ok(`Creado producto '${w.sku}' (id=${res.body.id})`)
      product = res.body
    } else {
      skip(`producto '${w.sku}' ya existe (id=${product.id})`)
    }

    // Setear campos SaaS v2 via SQL (no expuestos en REST)
    const needs = !product.product_kind_id || !product.default_quality_grade_id || !product.is_produced
    if (needs) {
      await withBypass(() => query(
        `UPDATE products
           SET product_kind_id = $1,
               default_quality_grade_id = $2,
               expected_sale_price = $3,
               is_produced = true
         WHERE id = $4 AND tenant_id = $5`,
        [friturasKind?.id, primeraGrade?.id, w.expected_sale_price, product.id, tenantId]
      ))
      ok(`  Campos SaaS v2 seteados para '${w.sku}'`)
    }

    result[w.sku] = product
  }

  return result
}

// ─── 5. Recetas ───────────────────────────────────────────────────────────

async function ensureRecipes(client, products, rawMaterials) {
  log('\n[5] Asegurando recetas…')

  const units   = await client.get('/api/process-config/units').expect(200)
  const kgUnit  = units.body.find(u => u.code === 'kg')
  const pzaUnit = units.body.find(u => u.code === 'pza') || units.body.find(u => u.symbol === 'pza')

  if (!kgUnit) fail('No se encontró unidad "kg"')

  const recipes = {}

  // Receta Papas Limón (sin alérgenos)
  {
    const prodId = products['FRI-PAP-LIM-100G'].id
    const existing = await client.get(`/api/recipes?productId=${prodId}&vigentOnly=true`).expect(200)
    if (existing.body.length > 0) {
      skip(`receta Papas Limón ya existe (id=${existing.body[0].id})`)
      recipes['FRI-PAP-LIM-100G'] = existing.body[0]
    } else {
      const components = [
        { raw_material_id: rawMaterials['Papa cruda'].id,           quantity: 0.40,  unit_id: kgUnit.id,  sort_order: 10 },
        { raw_material_id: rawMaterials['Aceite vegetal'].id,       quantity: 0.050, unit_id: kgUnit.id,  sort_order: 20 },
        { raw_material_id: rawMaterials['Sal'].id,                  quantity: 0.002, unit_id: kgUnit.id,  sort_order: 30 },
        { raw_material_id: rawMaterials['Saborizante limón'].id,    quantity: 0.003, unit_id: kgUnit.id,  sort_order: 40 },
      ]
      if (pzaUnit) {
        components.push({ raw_material_id: rawMaterials['Bolsa metalizada 100g'].id, quantity: 1, unit_id: pzaUnit.id, sort_order: 50 })
      }
      const res = await client.post('/api/recipes', {
        product_id: prodId,
        name: 'Papas Limón — receta base',
        yield_quantity: 0.1,
        yield_unit_id: kgUnit.id,
        expected_scrap_pct: 12.0,
        components,
      })
      if (res.status !== 201) fail(`POST /api/recipes Papas Limón falló (${res.status})`, res.body)
      ok(`Creada receta Papas Limón (id=${res.body.id})`)
      recipes['FRI-PAP-LIM-100G'] = res.body
    }
  }

  // Receta Papas Queso (CONTIENE saborizante queso → lácteos)
  {
    const prodId = products['FRI-PAP-QUE-100G'].id
    const existing = await client.get(`/api/recipes?productId=${prodId}&vigentOnly=true`).expect(200)
    if (existing.body.length > 0) {
      skip(`receta Papas Queso ya existe (id=${existing.body[0].id})`)
      recipes['FRI-PAP-QUE-100G'] = existing.body[0]
    } else {
      const components = [
        { raw_material_id: rawMaterials['Papa cruda'].id,           quantity: 0.40,  unit_id: kgUnit.id,  sort_order: 10 },
        { raw_material_id: rawMaterials['Aceite vegetal'].id,       quantity: 0.050, unit_id: kgUnit.id,  sort_order: 20 },
        { raw_material_id: rawMaterials['Sal'].id,                  quantity: 0.002, unit_id: kgUnit.id,  sort_order: 30 },
        { raw_material_id: rawMaterials['Saborizante queso'].id,    quantity: 0.003, unit_id: kgUnit.id,  sort_order: 40 },
      ]
      if (pzaUnit) {
        components.push({ raw_material_id: rawMaterials['Bolsa metalizada 100g'].id, quantity: 1, unit_id: pzaUnit.id, sort_order: 50 })
      }
      const res = await client.post('/api/recipes', {
        product_id: prodId,
        name: 'Papas Queso — receta base',
        yield_quantity: 0.1,
        yield_unit_id: kgUnit.id,
        expected_scrap_pct: 12.0,
        components,
      })
      if (res.status !== 201) fail(`POST /api/recipes Papas Queso falló (${res.status})`, res.body)
      ok(`Creada receta Papas Queso (id=${res.body.id}) — incluye saborizante queso (lácteos)`)
      recipes['FRI-PAP-QUE-100G'] = res.body
    }
  }

  return { recipes, kgUnitId: kgUnit.id }
}

// ─── 6. Stock inicial ─────────────────────────────────────────────────────

async function seedStock(tenantId, rawMaterials, warehouses, userId) {
  log('\n[6] Sembrando stock inicial de MP…')

  const mpWh = warehouses['MP Papa Cruda']
  const sabWh = warehouses['Saborizantes'] || warehouses['MP Papa Cruda']
  const embWh = warehouses['Embalaje Frituras'] || warehouses['MP Papa Cruda']

  const seeds = [
    { rm: rawMaterials['Papa cruda'],           warehouse: mpWh,  qty: 500,  cost: 4.50,  note: 'Papa cruda seed' },
    { rm: rawMaterials['Aceite vegetal'],        warehouse: mpWh,  qty: 100,  cost: 28.00, note: 'Aceite vegetal seed' },
    { rm: rawMaterials['Sal'],                   warehouse: mpWh,  qty: 50,   cost: 3.00,  note: 'Sal seed' },
    { rm: rawMaterials['Saborizante limón'],     warehouse: sabWh, qty: 10,   cost: 120.0, note: 'Sab. limón seed' },
    { rm: rawMaterials['Saborizante queso'],     warehouse: sabWh, qty: 10,   cost: 150.0, note: 'Sab. queso seed' },
    { rm: rawMaterials['Bolsa metalizada 100g'], warehouse: embWh, qty: 5000, cost: 0.80,  note: 'Bolsas seed' },
  ]

  for (const s of seeds) {
    if (!s.warehouse?.id) { warn(`Sin warehouse para '${s.rm.name}' — saltando seed`); continue }

    const { rows: stock } = await withBypass(() => query(
      `SELECT COALESCE(SUM(quantity),0)::numeric AS qty
       FROM inventory_stock
       WHERE tenant_id = $1 AND item_type = 'raw_material'
         AND item_id = $2 AND warehouse_id = $3 AND status = 'available'`,
      [tenantId, s.rm.id, s.warehouse.id]
    ))
    if (parseFloat(stock[0].qty) >= s.qty * 0.5) {
      skip(`Stock de '${s.rm.name}': ${stock[0].qty} — suficiente`)
      continue
    }
    const need = s.qty - parseFloat(stock[0].qty)
    await withBypass(() => withTransaction(async (txClient) => {
      await inventoryService.recordMovement(txClient, {
        tenantId,
        warehouseId: s.warehouse.id,
        itemType: 'raw_material',
        itemId: s.rm.id,
        movementType: 'adjustment_in',
        quantity: need,
        unit: s.rm.unit || 'kg',
        unitCost: s.cost,
        statusTo: 'available',
        referenceType: 'simulation',
        notes: s.note,
        createdBy: userId,
      })
    }))
    ok(`Sembrados ${need} ${s.rm.unit || 'kg'} de '${s.rm.name}'`)
  }

  // Sembrar raw_material_lots: requerido para loadMp con uses_lots=true.
  // lotSelector.js consulta raw_material_lots (no inventory_stock) al seleccionar lote.
  const { rows: cfgRows } = await withBypass(() => query(
    `SELECT uses_lots FROM tenant_process_config WHERE tenant_id = $1`, [tenantId]
  ))
  if (cfgRows[0]?.uses_lots) {
    log('  → uses_lots=true: sembrando raw_material_lots…')
    for (const s of seeds) {
      if (!s.warehouse?.id) continue
      const { rows: existing } = await withBypass(() => query(
        `SELECT id FROM raw_material_lots
         WHERE tenant_id = $1 AND raw_material_id = $2 AND status = 'active' AND quantity_remaining > 0
         LIMIT 1`,
        [tenantId, s.rm.id]
      ))
      if (existing.length > 0) {
        skip(`lot activo de '${s.rm.name}' ya existe`)
        continue
      }
      const lotNum = `SEED-${s.rm.name.replace(/\s+/g, '-').slice(0, 12).toUpperCase()}`
      await withBypass(() => query(
        `INSERT INTO raw_material_lots
           (tenant_id, raw_material_id, lot_number, warehouse_id,
            quantity_received, quantity_remaining, status, unit_cost, received_at)
         VALUES ($1, $2, $3, $4, $5, $5, 'active', $6, NOW())`,
        [tenantId, s.rm.id, lotNum, s.warehouse.id, s.qty, s.cost]
      ))
      ok(`Lot sembrado: '${s.rm.name}' — ${s.qty} ${s.rm.unit || 'kg'} @ $${s.cost}`)
    }
  }
}

// ─── 7. Orden de producción ───────────────────────────────────────────────

async function ensureOrder(client, product, recipeId, rawMaterialId) {
  log(`\n[7] Creando orden de producción para '${product.sku}'…`)

  const list  = await client.get('/api/production/orders').expect(200)
  const items = Array.isArray(list.body) ? list.body : (list.body.data || list.body.items || list.body.rows || [])
  const existing = items.find(o =>
    o.product_id === product.id &&
    ['draft','active','planning','released'].includes(o.status)
  )
  if (existing) {
    skip(`orden activa para '${product.sku}' ya existe (id=${existing.id}, status=${existing.status})`)
    return existing
  }

  const res = await client.post('/api/production/orders', {
    productId:        product.id,
    rawMaterialId,
    quantityPackages: 500,
    priority:         'normal',
    recipeId,
    notes: `Orden simulada Frituras (${product.sku})`,
  })
  if (res.status !== 201) fail(`POST /api/production/orders falló (${res.status})`, res.body)
  ok(`Creada orden (id=${res.body.id})`)
  return res.body
}

// ─── 8. Liberar orden ────────────────────────────────────────────────────

async function releaseOrder(client, orderId) {
  const res = await client.post(`/api/production/orders/${orderId}/release`)
  if (res.status === 200)       { ok('Orden activada'); return }
  if ([400,409].includes(res.status)) {
    skip(`Orden no necesita release (${res.status})`)
    return
  }
  recordGap('ORDER_RELEASE', `release devolvió ${res.status}: ${JSON.stringify(res.body).slice(0,100)}`)
}

// ─── 9. Turno ─────────────────────────────────────────────────────────────

async function ensureShift(client, tenantId, userId) {
  log('\n[9] Creando turno…')

  const active = await client.get('/api/production/shifts/active')
  if (active.status === 200 && active.body?.id) {
    skip(`turno activo ya existe (id=${active.body.id})`)
    return { ...active.body, _wasExisting: true }
  }

  // Buscar el primer slot libre en today → today+7. El enum solo admite '1','2','3'.
  const VALID_SLOTS = ['1', '2', '3']
  let shiftDate = null
  let availableSlot = null

  for (let offset = 0; offset < 7; offset++) {
    const d = new Date(); d.setDate(d.getDate() + offset)
    const dateStr = d.toISOString().slice(0, 10)
    const usedResult = await withBypass(() => query(
      `SELECT shift_number FROM production_shifts
       WHERE tenant_id = $1 AND shift_date::date = $2::date`,
      [tenantId, dateStr]
    ))
    const takenSlots = new Set(usedResult.rows.map(r => r.shift_number))
    const free = VALID_SLOTS.find(s => !takenSlots.has(s))
    if (free) { shiftDate = dateStr; availableSlot = free; break }
  }
  if (!availableSlot) fail('Sin slots libres en los próximos 7 días para crear un turno.')

  const res = await client.post('/api/production/shifts', {
    shiftNumber: parseInt(availableSlot), shiftDate, operatorId: userId, supervisorId: userId,
  })
  if (res.status !== 201) fail(`POST /api/production/shifts falló (${res.status})`, res.body)
  ok(`Turno creado (id=${res.body.id}, número=${availableSlot}, fecha=${shiftDate})`)
  return res.body
}

// ─── 10. Cargar MP ────────────────────────────────────────────────────────

async function loadRawMaterials(client, shiftId, rawMaterials, kgUnitId) {
  log('\n[10] Cargando materias primas al turno…')

  const loads = [
    { rm: rawMaterials['Papa cruda'],           kg: 40, label: 'Papa cruda' },
    { rm: rawMaterials['Aceite vegetal'],        kg: 5,  label: 'Aceite vegetal' },
    { rm: rawMaterials['Sal'],                   kg: 0.2, label: 'Sal' },
    { rm: rawMaterials['Saborizante limón'],     kg: 0.3, label: 'Sab. limón' },
    { rm: rawMaterials['Saborizante queso'],     kg: 0.3, label: 'Sab. queso (lácteos)' },
  ]

  for (const l of loads) {
    const res = await client.post(`/api/production/shifts/${shiftId}/mp-loads`, {
      rawMaterialId: l.rm.id,
      kg: l.kg,
      unitId: kgUnitId,
      quantity: l.kg,
      notes: `Carga simulada: ${l.label}`,
    })
    if (res.status !== 201) {
      recordGap('LOAD_MP', `POST mp-loads '${l.label}' falló (${res.status}): ${JSON.stringify(res.body).slice(0,150)}`)
      continue
    }
    ok(`Cargado: ${l.kg} kg de ${l.label} (id=${res.body.id})`)
  }
}

// ─── 11. Capturar paquetes ────────────────────────────────────────────────

async function capturePackages(client, shiftId, limOrder, queOrder) {
  log('\n[11] Capturando paquetes…')

  const packs = [
    { label: 'Papas Limón — 10 kg',  orderId: limOrder.id,  realWeightKg: 10, quantityUnits: 100, gradeNumber: 1 },
    { label: 'Papas Queso — 8 kg',   orderId: queOrder.id,  realWeightKg: 8,  quantityUnits: 80,  gradeNumber: 1 },
    { label: 'Papas Queso Combo — 2 kg', orderId: queOrder.id, realWeightKg: 2, quantityUnits: 10, gradeNumber: 2 },
  ]

  for (const p of packs) {
    const res = await client.post(`/api/production/shifts/${shiftId}/packages`, {
      productionOrderId: p.orderId,
      realWeightKg:      p.realWeightKg,
      quantityUnits:     p.quantityUnits,
      gradeNumber:       p.gradeNumber,
      notes: `Captura simulada: ${p.label}`,
    })
    if (res.status !== 201) {
      recordGap('CAPTURE_PACKAGE', `POST packages '${p.label}' falló (${res.status}): ${JSON.stringify(res.body).slice(0,200)}`)
      continue
    }
    const wip = res.body.wip_entry_at ? '→WIP' : '→PT directo'
    ok(`Capturado: ${p.label} ${wip} (id=${res.body.id})`)
  }
}

// ─── 12. Scrap: papas rotas → Merma Reproceso ─────────────────────────────

async function recordScrap(client, shiftId) {
  log('\n[12] Registrando merma…')

  // Papas rotas (reprocess 30%) — debe linkear via scrapTypeResolver al RM Papas Rotas
  const rotasRes = await client.post(`/api/production/shifts/${shiftId}/scrap`, {
    scrapType:   'rotas_quebradas',
    destination: 'reprocess',
    kg:          3,
    notes:       'Papas rotas — reproceso a Combo',
  })
  if (rotasRes.status !== 201) {
    recordGap('SCRAP_ROTAS', `POST scrap 'rotas_quebradas' falló (${rotasRes.status}): ${JSON.stringify(rotasRes.body).slice(0,200)}`)
  } else {
    ok(`Scrap rotas registrado (id=${rotasRes.body.id})`)
  }

  // Papas quemadas (discard) — no tienen valor de recuperación
  const quemRes = await client.post(`/api/production/shifts/${shiftId}/scrap`, {
    scrapType:   'quemadas',
    destination: 'discard',
    kg:          1,
    notes:       'Papas quemadas — a desecho',
  })
  if (quemRes.status !== 201) {
    recordGap('SCRAP_QUEMADAS', `POST scrap 'quemadas' falló (${quemRes.status}): ${JSON.stringify(quemRes.body).slice(0,200)}`)
  } else {
    ok(`Scrap quemadas registrado (id=${quemRes.body.id})`)
  }
}

// ─── 13. Test del bloqueo por alérgeno ───────────────────────────────────
//
// allergen_mode=priority_only: el cierre de turno debe bloquearse si el
// saborizante queso (lácteos prioritario) fue cargado pero el producto
// FRI-PAP-QUE-100G NO tiene declarado el alérgeno 'lacteos'.
//
// Luego lo declaramos y verificamos que el segundo intento pase.

async function testAllergenBlock(client, shiftId, products, tenantId) {
  log('\n[13] Test de bloqueo por alérgeno — priority_only…')

  // Intento 1: cerrar SIN lácteos declarados en ningún producto
  log('  → Intento 1: cierre SIN declarar alérgeno (debe bloquearse)…')
  const close1 = await client.post(`/api/production/shifts/${shiftId}/close`)

  if (close1.status === 400 || close1.status === 422) {
    const body = JSON.stringify(close1.body)
    if (body.includes('alérgeno') || body.includes('allergen') || body.includes('lacteo') || body.includes('lacteos')) {
      ok(`✓ VALIDADO: cierre bloqueado por alérgeno (${close1.status}): ${close1.body.error || close1.body.message || ''}`)
    } else {
      warn(`Cierre bloqueado pero NO por alérgeno. Respuesta: ${body.slice(0,200)}`)
      recordGap('ALLERGEN_BLOCK_MSG', `Cierre bloqueado (${close1.status}) pero el mensaje no menciona alérgenos: ${body.slice(0,200)}`)
    }
  } else if (close1.status === 200) {
    warn('Cierre NO fue bloqueado — allergen_mode=priority_only no bloqueó el turno con lácteos sin declarar')
    recordGap('ALLERGEN_NOT_BLOCKING',
      'allergen_mode=priority_only debería bloquear closeShift cuando hay MP con alérgeno prioritario no declarado en el producto. El turno cerró sin error.')
    return { alreadyClosed: true }
  } else {
    warn(`Cierre respondió ${close1.status}: ${JSON.stringify(close1.body).slice(0,200)}`)
    recordGap('CLOSE_UNEXPECTED', `closeShift respondió ${close1.status}`)
  }

  // La distribución de lot_consumption es proporcional al peso producido (shift-level).
  // Todos los productos del turno heredan los alérgenos de TODO lo cargado al turno,
  // no solo los de su receta. Esto modela contaminación cruzada por equipo compartido.
  // → Declarar 'lacteos' en TODOS los productos del turno.
  log('  → Declarando alérgeno "lácteos" en todos los productos del turno…')
  const { rows: allergenRows } = await withBypass(() => query(
    `SELECT id FROM tenant_allergens WHERE tenant_id = $1 AND code = 'lacteos'`, [tenantId]
  ))
  if (allergenRows.length === 0) {
    recordGap('ALLERGEN_LACTEOS_MISSING', 'No existe tenant_allergen con code=lacteos — no se puede declarar')
  } else {
    const allergenId = allergenRows[0].id
    for (const prod of Object.values(products)) {
      await withBypass(() => query(
        `INSERT INTO product_allergens (product_id, allergen_id, declaration)
         VALUES ($1, $2, 'contains')
         ON CONFLICT DO NOTHING`,
        [prod.id, allergenId]
      ))
      ok(`Alérgeno 'lacteos' declarado en '${prod.sku}' (contains)`)
    }
  }

  return { alreadyClosed: false }
}

// ─── 14. Cerrar y validar ─────────────────────────────────────────────────

async function closeAndValidate(client, shiftId) {
  log('\n[14] Cerrando turno (con alérgeno declarado)…')
  const close = await client.post(`/api/production/shifts/${shiftId}/close`)
  if (close.status !== 200) {
    recordGap('CLOSE_SHIFT', `POST close falló (${close.status}): ${JSON.stringify(close.body).slice(0,300)}`)
    return null
  }
  ok(`Turno cerrado (status=${close.body.status || '?'})`)

  log('\n[15] Validando turno…')
  const val = await client.post(`/api/production/shifts/${shiftId}/validate`, {
    approved: true, supervisorNotes: 'Validado (simulación frituras)',
  })
  if (val.status !== 200) {
    recordGap('VALIDATE_SHIFT', `POST validate falló (${val.status}): ${JSON.stringify(val.body).slice(0,300)}`)
    return null
  }
  ok(`Turno validado (status=${val.body.status || '?'})`)
  return val.body
}

// ─── 15. Verificar stock de MP-PAPAS-ROTAS ───────────────────────────────

async function verifyScrapReproceso(tenantId, rawMaterials) {
  log('\n[16] Verificando que "Papas Rotas (Reproceso)" recibió stock por el scrap…')

  // Buscar el raw_material creado por provision-frituras
  const { rows: rmRows } = await withBypass(() => query(
    `SELECT id, name FROM raw_materials WHERE tenant_id = $1 AND name = 'Papas Rotas (Reproceso)'`,
    [tenantId]
  ))
  if (rmRows.length === 0) {
    recordGap('MP_PAPAS_ROTAS_NOT_FOUND', 'No existe raw_material "Papas Rotas (Reproceso)" — corre provision-frituras primero')
    return
  }
  const papasRotasId = rmRows[0].id

  const { rows: stock } = await withBypass(() => query(
    `SELECT COALESCE(SUM(quantity),0)::numeric AS qty
     FROM inventory_stock
     WHERE tenant_id = $1 AND item_type = 'raw_material'
       AND item_id = $2 AND status = 'available'`,
    [tenantId, papasRotasId]
  ))
  const qty = parseFloat(stock[0].qty)

  if (qty > 0) {
    ok(`✓ VALIDADO: MP "Papas Rotas (Reproceso)" tiene ${qty} kg de stock (vía scrap reprocess)`)
  } else {
    recordGap('SCRAP_REPROCESS_STOCK_NOT_INCREMENTED',
      'Se registró merma "rotas_quebradas" (destination=reprocess, linked_raw_material_id seteado) pero el stock de MP-PAPAS-ROTAS no aumentó. El motor de merma posiblemente no implementa el flujo linked_raw_material_id todavía.')
    warn(`MP "Papas Rotas (Reproceso)" sigue en 0 kg`)
  }

  // También verificar vía inventory_movements
  const { rows: movs } = await withBypass(() => query(
    `SELECT movement_type, quantity, reference_type
     FROM inventory_movements
     WHERE tenant_id = $1 AND item_id = $2 AND item_type = 'raw_material'
     ORDER BY created_at DESC LIMIT 5`,
    [tenantId, papasRotasId]
  ))
  if (movs.length > 0) {
    log(`  inventory_movements para MP-Papas-Rotas:`)
    movs.forEach(m => log(`    - ${m.movement_type}: ${m.quantity} (ref=${m.reference_type})`))
  } else {
    log(`  Sin movimientos para MP-Papas-Rotas (esperado si el motor no está implementado aún)`)
  }
}

// ─── 16. Verificar pt_goes_to_wip_first=false ────────────────────────────

async function verifyDirectToPT(tenantId, shiftId) {
  log('\n[17] Verificando flujo de inventario PT/WIP…')

  const { rows: cfgRows } = await withBypass(() => query(
    `SELECT uses_lots, pt_goes_to_wip_first FROM tenant_process_config WHERE tenant_id = $1`,
    [tenantId]
  ))
  const usesLots = cfgRows[0]?.uses_lots
  const ptFirst  = cfgRows[0]?.pt_goes_to_wip_first

  // inventory_movements de captura referencian shift_progress.id, no shift_id.
  // Se unen vía shift_progress para filtrar por turno.
  const { rows: wipMovs } = await withBypass(() => query(
    `SELECT COUNT(*)::int AS cnt
     FROM inventory_movements im
     JOIN warehouses w ON w.id = im.warehouse_id
     WHERE im.tenant_id = $1
       AND im.reference_type = 'shift_progress'
       AND im.reference_id IN (SELECT id FROM shift_progress WHERE shift_id = $2)
       AND w.type = 'wip'`,
    [tenantId, shiftId]
  ))
  const wipCount = wipMovs[0]?.cnt || 0

  const { rows: ptMovs } = await withBypass(() => query(
    `SELECT COUNT(*)::int AS cnt
     FROM inventory_movements im
     JOIN warehouses w ON w.id = im.warehouse_id
     WHERE im.tenant_id = $1
       AND im.reference_type = 'shift_progress'
       AND im.reference_id IN (SELECT id FROM shift_progress WHERE shift_id = $2)
       AND w.type = 'finished_product'`,
    [tenantId, shiftId]
  ))
  const ptCount = ptMovs[0]?.cnt || 0

  log(`  uses_lots=${usesLots} | pt_goes_to_wip_first=${ptFirst} | WIP movs: ${wipCount} | PT movs: ${ptCount}`)

  if (usesLots) {
    // Lot-mode §21: siempre pasa por WIP sin importar pt_goes_to_wip_first.
    if (wipCount > 0) {
      ok(`✓ VALIDADO: lot-mode usa WIP (${wipCount} movs) — comportamiento correcto §21`)
    } else {
      warn(`Lot-mode esperaba movimientos WIP pero no hay (¿captura falló?)`)
    }
  } else if (ptFirst === false) {
    // Non-lot mode + pt_goes_to_wip_first=false → debe ir directo a PT
    if (wipCount > 0) {
      recordGap('WIP_NOT_SKIPPED',
        `pt_goes_to_wip_first=false pero hay ${wipCount} movimiento(s) hacia WIP. ` +
        'productionService no respeta el flag.')
    } else if (ptCount > 0) {
      ok(`✓ VALIDADO: ${ptCount} mov(s) a PT directo, sin WIP — pt_goes_to_wip_first=false funciona`)
    } else {
      warn(`Sin movimientos a PT (captura puede haber fallado)`)
    }
  }
}

// ─── 17. Snapshot final ───────────────────────────────────────────────────

async function finalSnapshot(tenantId, shiftId) {
  log('\n[18] Snapshot final…')

  const shift = await withBypass(() => query(
    `SELECT id, status, shift_number,
            estimated_overhead_total, real_overhead_total, recosted_at
     FROM production_shifts WHERE id = $1`, [shiftId]
  ))
  if (shift.rows[0]) {
    const s = shift.rows[0]
    log(`  Turno: #${s.shift_number} status=${s.status}`)
    log(`  Overhead estimado: ${s.estimated_overhead_total || 0}`)
    log(`  Overhead real: ${s.real_overhead_total || 'pendiente cierre mes'}`)
  }

  const scrap = await withBypass(() => query(
    `SELECT scrap_type, scrap_type_id, destination, kg, recovery_value_pct, is_abnormal
     FROM shift_scrap WHERE shift_id = $1`, [shiftId]
  ))
  log(`  Scrap (${scrap.rows.length}):`)
  scrap.rows.forEach(r =>
    log(`    - ${r.scrap_type}(id=${r.scrap_type_id?.slice(0,8)||'NULL'}) → ${r.destination}, ${r.kg}kg, rec=${r.recovery_value_pct||'NULL'}%, abnormal=${r.is_abnormal}`)
  )

  const overhead = await withBypass(() => query(
    `SELECT soa.basis_value, soa.estimated_amount, toi.name
     FROM shift_overhead_application soa
     JOIN tenant_overhead_items toi ON toi.id = soa.overhead_item_id
     WHERE soa.shift_id = $1`, [shiftId]
  ))
  if (overhead.rows.length > 0) {
    log(`  Overhead aplicado (${overhead.rows.length} items):`)
    overhead.rows.forEach(r => log(`    - ${r.name}: basis=${r.basis_value}, estimado=$${r.estimated_amount||0}`))
  } else {
    log(`  Overhead: no aplicado (normal si no hay períodos activos)`)
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────

async function main() {
  try {
    const { tenant, token, userId } = await loginAndContext()
    const client = clientFor(token)

    const warehouses  = await ensureWarehouses(client)
    const rawMaterials = await ensureRawMaterials(client, tenant.id)
    const products    = await ensureProducts(client, tenant.id)

    const { recipes, kgUnitId } = await ensureRecipes(client, products, rawMaterials)

    await seedStock(tenant.id, rawMaterials, warehouses, userId)

    // Órdenes para ambos productos
    log('\n[8] Creando y liberando órdenes…')
    const limOrder = await ensureOrder(client, products['FRI-PAP-LIM-100G'], recipes['FRI-PAP-LIM-100G'].id, rawMaterials['Papa cruda'].id)
    await releaseOrder(client, limOrder.id)
    const queOrder = await ensureOrder(client, products['FRI-PAP-QUE-100G'], recipes['FRI-PAP-QUE-100G'].id, rawMaterials['Papa cruda'].id)
    await releaseOrder(client, queOrder.id)

    const shift = await ensureShift(client, tenant.id, userId)

    if (!shift._wasExisting) {
      await loadRawMaterials(client, shift.id, rawMaterials, kgUnitId)
      await capturePackages(client, shift.id, limOrder, queOrder)
      await recordScrap(client, shift.id)

      // Test del bloqueo por alérgeno (paso clave de Fase 4)
      const allergenResult = await testAllergenBlock(client, shift.id, products, tenant.id)

      if (!allergenResult.alreadyClosed) {
        await closeAndValidate(client, shift.id)
      }
    } else {
      log('  (saltando carga/captura/scrap/close — reusando turno existente)')
    }

    await verifyScrapReproceso(tenant.id, rawMaterials)
    await verifyDirectToPT(tenant.id, shift.id)
    await finalSnapshot(tenant.id, shift.id)

    log('\n' + '═'.repeat(70))
    log(`FASE 4 — GAPS DETECTADOS: ${GAPS.length}`)
    log('═'.repeat(70))
    if (GAPS.length === 0) {
      log('  🎉 Sin gaps — Frituras pasa end-to-end')
    } else {
      GAPS.forEach((g, i) => log(`  ${i+1}. [${g.id}] ${g.summary}`))
    }
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
