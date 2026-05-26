'use strict'

/**
 * SaaS v2 — Simula un turno completo en el tenant 'galletas-artesanales'.
 *
 * Propósito: demostrar que el motor SaaS v2 sirve para cualquier producto
 * alimentario sin cambios de código — solo configurando un nuevo tenant.
 *
 * El tenant 'galletas-artesanales' usa EXACTAMENTE los mismos flags que
 * 'palomitas-piloto':
 *   uses_lots=true, uses_expiry=true, uses_fefo=true, cost_method='fifo'
 *
 * Lo que cambia es puramente configuración:
 *   - Producto: Galletas de Mantequilla 250g (SKU: GAL-MTQ-250G)
 *   - Receta: harina + mantequilla + azúcar → galletas
 *   - Tipos de merma: 'fragmentos' (galletitas rotas) + 'quemadas'
 *   - Calidades: solo primera (igual que palomitas)
 *
 * Flujo:
 *   1. Provisionar tenant (idempotente)
 *   2. Login
 *   3. Aplicar flags alimentarios (idénticos a palomitas)
 *   4. Personalizar catálogos (scrap types, quality grades)
 *   5. Warehouses
 *   6. Materias primas: harina, mantequilla, azúcar
 *   7. Producto + receta
 *   8. Stock inicial
 *   9. Orden → release → turno
 *  10. Cargar MP, capturar producción, registrar merma
 *  11. Cerrar + validar
 *  12. Snapshot comparativo
 *
 * Uso:
 *   node scripts/simulate-galletas-shift.js
 */

require('dotenv').config()
const request = require('supertest')
const app = require('../src/app')
const { pool, query, withBypass, withTransaction } = require('../src/db')
const inventoryService = require('../src/modules/inventory/inventoryService')

const SLUG  = 'galletas-artesanales'
const EMAIL = 'admin@galletas-artesanales.local'
const PASS  = 'Galletas!2026'
const NAME  = 'Galletas Artesanales Piloto'

const log  = (...args) => console.log(...args)
const ok   = (msg)       => console.log('  ✓', msg)
const skip = (msg)       => console.log('  ⊘', msg)
const warn = (msg)       => console.log('  ⚠', msg)
const fail = (msg, extra) => { console.error('  ✗', msg); if (extra) console.error('   ', extra); process.exit(1) }

function clientFor(token) {
  const headers = { 'X-Tenant-Slug': SLUG, 'Authorization': `Bearer ${token}` }
  const wrap = (method) => (path, body) => {
    const r = request(app)[method](path).set(headers)
    if (body) r.send(body)
    return r
  }
  return { get: wrap('get'), post: wrap('post'), patch: wrap('patch'), put: wrap('put') }
}

// ─── 1. Provisionar tenant ────────────────────────────────────────────────

async function provisionOrFindTenant() {
  log('\n[1] Provisionando tenant "galletas-artesanales"…')
  const existing = await withBypass(() => query(
    `SELECT id, slug, name FROM tenants WHERE slug = $1`, [SLUG]
  ))
  if (existing.rows.length > 0) {
    skip(`Tenant '${SLUG}' ya existe (id=${existing.rows[0].id})`)
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
      adminName: 'Admin Galletas',
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
  const userRow = await withBypass(() => query(
    `SELECT u.id FROM users u JOIN tenants t ON t.id = u.tenant_id WHERE t.slug=$1 AND u.email=$2`,
    [SLUG, EMAIL]
  ))
  return { token: res.body.accessToken, userId: userRow.rows[0].id }
}

// ─── 3. Flags alimentarios — EXACTAMENTE iguales a palomitas ──────────────

async function applyFoodFlags(client) {
  log('\n[3] Aplicando flags alimentarios (mismos que palomitas-piloto)…')
  const current = await client.get('/api/process-config').expect(200)
  const wanted = {
    uses_lots:          true,
    uses_expiry:        true,
    uses_fefo:          true,
    cost_method:        'fifo',
    expiry_alert_days:  7,
    allergen_mode:      'strict',  // galletas tienen gluten/lácteos — modo estricto
  }
  const needsUpdate = Object.entries(wanted).some(([k, v]) => current.body[k] !== v)
  if (!needsUpdate) {
    skip('Flags alimentarios ya aplicados')
    log(`  uses_lots=${current.body.uses_lots}, uses_expiry=${current.body.uses_expiry}`)
    log(`  cost_method=${current.body.cost_method}, allergen_mode=${current.body.allergen_mode}`)
    return current.body
  }
  const res = await client.patch('/api/process-config', wanted)
  if (res.status !== 200) fail(`PATCH /api/process-config falló (${res.status})`, res.body)
  ok(`Flags aplicados: uses_lots=true, uses_expiry=true, uses_fefo=true, cost_method=fifo, allergen_mode=strict`)
  return res.body
}

// ─── 4. Tipos de merma para galletas ─────────────────────────────────────

async function customizeScrapTypes(client) {
  log('\n[4] Personalizando tipos de merma para galletas…')
  const list = await client.get('/api/process-config/scrap-types').expect(200)
  const byCode = Object.fromEntries(list.body.map(t => [t.code, t]))

  // Tipos nuevos para galletas
  const newTypes = [
    { code: 'fragmentos', name: 'Galletas fragmentadas', default_destination: 'discard',
      is_normal: true, sort_order: 50,
      description: 'Piezas rotas durante proceso — van a descarte o consumo interno' },
    { code: 'quemadas',   name: 'Galletas quemadas',     default_destination: 'discard',
      is_normal: false, sort_order: 60,
      description: 'Lote quemado por falla de temperatura — merma anormal' },
  ]
  for (const t of newTypes) {
    if (byCode[t.code]) {
      skip(`scrap-type '${t.code}' ya existe`)
    } else {
      const res = await client.post('/api/process-config/scrap-types', t)
      if (res.status !== 201) fail(`POST scrap-type '${t.code}' falló (${res.status})`, res.body)
      ok(`Creado scrap-type '${t.code}' — ${t.description}`)
    }
  }

  // Desactivar defaults que no aplican a galletas
  for (const code of ['arranque', 'operacion', 'contaminada']) {
    const t = byCode[code]
    if (!t || !t.is_active) { skip(`scrap-type '${code}' ya inactivo o no existe`); continue }
    const res = await client.patch(`/api/process-config/scrap-types/${t.id}`, { is_active: false })
    if (res.status === 200) ok(`Desactivado scrap-type '${code}'`)
  }
}

// ─── 5. Quality grades — solo primera ─────────────────────────────────────

async function simplifyQualityGrades(client) {
  log('\n[5] Galletas → solo primera calidad (igual que palomitas)…')
  const list = await client.get('/api/process-config/quality-grades').expect(200)
  const byCode = Object.fromEntries(list.body.map(g => [g.code, g]))
  for (const code of ['segunda', 'tercera']) {
    const g = byCode[code]
    if (!g || !g.is_active) { skip(`quality-grade '${code}' ya inactiva`); continue }
    const res = await client.patch(`/api/process-config/quality-grades/${g.id}`, { is_active: false })
    if (res.status === 200) ok(`Desactivada quality-grade '${code}'`)
  }
}

// ─── 6. Warehouses ─────────────────────────────────────────────────────────

async function ensureWarehouses(client, tenantId) {
  log('\n[6] Asegurando warehouses…')
  const list = await client.get('/api/warehouses').expect(200)
  const byName = Object.fromEntries(list.body.map(w => [w.name, w]))

  const wanted = [
    { name: 'Almacén Ingredientes', type: 'raw_material',    resin_type: 'PP', description: 'Harina, mantequilla, azúcar' },
    { name: 'Almacén PT Galletas',  type: 'finished_product', description: 'Galletas empacadas' },
    { name: 'WIP Galletas',          type: 'wip',              description: 'Producto pre-QA' },
    { name: 'Merma Galletas',        type: 'regrind',          resin_type: 'PE', description: 'Fragmentos y quemadas' },
  ]

  const result = {}
  for (const w of wanted) {
    if (byName[w.name]) { skip(`Warehouse '${w.name}' ya existe`); result[w.name] = byName[w.name]; continue }
    const res = await client.post('/api/warehouses', { ...w, is_active: true })
    if (res.status !== 201) { warn(`No se pudo crear '${w.name}'`); continue }
    ok(`Creado warehouse '${w.name}'`)
    result[w.name] = res.body
  }

  // Backfill warehouse_type_id
  const mapping = { raw_material: 'materia_prima', finished_product: 'producto_terminado', wip: 'wip', regrind: 'merma' }
  for (const w of Object.values(result)) {
    if (w.warehouse_type_id) continue
    const code = mapping[w.type]
    if (!code) continue
    await withBypass(() => query(
      `UPDATE warehouses
         SET warehouse_type_id = (SELECT id FROM tenant_warehouse_types WHERE tenant_id=warehouses.tenant_id AND code=$1)
       WHERE id=$2`,
      [code, w.id]
    ))
  }
  return result
}

// ─── 7. Materias primas ────────────────────────────────────────────────────

async function ensureRawMaterials(client) {
  log('\n[7] Asegurando materias primas (harina, mantequilla, azúcar)…')
  const list = await client.get('/api/raw-materials').expect(200)
  const items = Array.isArray(list.body) ? list.body : (list.body.data || list.body.rows || [])
  const byName = Object.fromEntries(items.map(r => [r.name, r]))

  const wanted = [
    { name: 'Harina de trigo',   resinType: 'PP', materialType: 'virgin', unit: 'kg', costPerKg:  8.50 },
    { name: 'Mantequilla sin sal', resinType: 'PE', materialType: 'virgin', unit: 'kg', costPerKg: 80.00 },
    { name: 'Azúcar refinada',   resinType: 'PP', materialType: 'virgin', unit: 'kg', costPerKg: 16.00 },
  ]

  const result = {}
  for (const mp of wanted) {
    if (byName[mp.name]) { skip(`MP '${mp.name}' ya existe`); result[mp.name] = byName[mp.name]; continue }
    const res = await client.post('/api/raw-materials', mp)
    if (res.status !== 201) fail(`POST raw-material '${mp.name}' falló (${res.status})`, res.body)
    ok(`Creada MP '${mp.name}' ($${mp.costPerKg}/kg)`)
    result[mp.name] = res.body
  }
  return result
}

// ─── 8. Producto ───────────────────────────────────────────────────────────

async function ensureProduct(client, tenantId) {
  log('\n[8] Asegurando producto "GAL-MTQ-250G"…')
  const list = await client.get('/api/products').expect(200)
  const items = Array.isArray(list.body) ? list.body : (list.body.data || list.body.rows || [])
  let p = items.find(x => x.sku === 'GAL-MTQ-250G')

  if (!p) {
    const res = await client.post('/api/products', {
      sku: 'GAL-MTQ-250G',
      name: 'Galletas de Mantequilla 250g',
      type: 'corner_protector',
      saleUnit: 'caja',
      basePrice: 45.00,
      baseCurrency: 'MXN',
      description: 'Caja 250g galletas de mantequilla artesanales',
    })
    if (res.status !== 201) fail(`POST /api/products falló (${res.status})`, res.body)
    ok(`Creado producto 'GAL-MTQ-250G' (id=${res.body.id})`)
    p = res.body
  } else {
    skip(`Producto 'GAL-MTQ-250G' ya existe (id=${p.id})`)
  }

  // Setear expected_sale_price e is_produced
  const patch = await client.patch(`/api/products/${p.id}`, {
    expected_sale_price: 45.00,
    is_produced: true,
  })
  if (patch.status === 200) ok('expected_sale_price=$45 e is_produced=true aplicados')
  return patch.status === 200 ? patch.body : p
}

// ─── 9. Receta ─────────────────────────────────────────────────────────────

async function ensureRecipe(client, productId, mps, kgUnitId) {
  log('\n[9] Asegurando receta galletas de mantequilla…')
  const list = await client.get(`/api/recipes?productId=${productId}&vigentOnly=true`).expect(200)
  if (list.body.length > 0) {
    skip(`Receta vigente ya existe (id=${list.body[0].id})`)
    return list.body[0]
  }

  // Por kg de galletas:
  //   0.65 kg harina + 0.25 kg mantequilla + 0.18 kg azúcar = 1.08 kg input
  //   yield: 1 kg galletas (hubo 0.08 kg de merma = 7.4%)
  const res = await client.post('/api/recipes', {
    product_id:         productId,
    name:               'Galletas Mantequilla — receta base',
    yield_quantity:     1.0,
    yield_unit_id:      kgUnitId,
    expected_scrap_pct: 7.0,
    components: [
      { raw_material_id: mps['Harina de trigo'].id,    quantity: 0.65, unit_id: kgUnitId, sort_order: 10 },
      { raw_material_id: mps['Mantequilla sin sal'].id, quantity: 0.25, unit_id: kgUnitId, sort_order: 20 },
      { raw_material_id: mps['Azúcar refinada'].id,    quantity: 0.18, unit_id: kgUnitId, sort_order: 30 },
    ],
  })
  if (res.status !== 201) fail(`POST /api/recipes falló (${res.status})`, res.body)
  ok(`Receta creada (id=${res.body.id}) → yield 1 kg, scrap 7%`)
  log('    Componentes: 0.65 kg harina + 0.25 kg mantequilla + 0.18 kg azúcar')
  return res.body
}

// ─── 10. Stock ─────────────────────────────────────────────────────────────

async function ensureStock(tenantId, mps, mpWarehouseId, userId) {
  log('\n[10] Sembrando stock de ingredientes (inventory_stock + raw_material_lots para FEFO)…')
  const seeds = [
    { mp: mps['Harina de trigo'],     qty: 300, cost:  8.50, lotNum: 'HAR-SIM-001', expiryDays: 180 },
    { mp: mps['Mantequilla sin sal'],  qty: 100, cost: 80.00, lotNum: 'MTQ-SIM-001', expiryDays:  60 },
    { mp: mps['Azúcar refinada'],     qty: 150, cost: 16.00, lotNum: 'AZU-SIM-001', expiryDays: 365 },
  ]
  for (const { mp, qty, cost, lotNum, expiryDays } of seeds) {
    const existingLot = await withBypass(() => query(
      `SELECT id, quantity_remaining FROM raw_material_lots
       WHERE tenant_id=$1 AND raw_material_id=$2 AND status='active' LIMIT 1`,
      [tenantId, mp.id]
    ))
    if (existingLot.rows.length > 0 && parseFloat(existingLot.rows[0].quantity_remaining) >= qty * 0.5) {
      skip(`Lote '${mp.name}': ${existingLot.rows[0].quantity_remaining} kg disponibles`)
      continue
    }

    const expiry = new Date(Date.now() + expiryDays * 86400000).toISOString().slice(0, 10)
    const lotRes = await withBypass(() => query(
      `INSERT INTO raw_material_lots
         (tenant_id, raw_material_id, lot_number, warehouse_id,
          quantity_received, quantity_remaining, unit_cost, total_cost,
          status, expiry_date, received_at, created_at, created_by_user_id)
       VALUES ($1,$2,$3,$4,$5,$5,$6,$7,'active',$8,NOW(),NOW(),$9)
       ON CONFLICT DO NOTHING RETURNING id`,
      [tenantId, mp.id, lotNum, mpWarehouseId, qty, cost, qty*cost, expiry, userId]
    ))
    if (lotRes.rows.length > 0) {
      ok(`Lote creado: '${mp.name}' ${qty}kg @ $${cost}/kg, vence ${expiry}`)
    } else {
      skip(`Lote '${lotNum}' para '${mp.name}' ya existía`)
    }

    await withBypass(() => query(
      `INSERT INTO inventory_stock
         (tenant_id, warehouse_id, item_type, item_id, quantity, avg_cost, status)
       VALUES ($1,$2,'raw_material',$3,$4,$5,'available')
       ON CONFLICT (tenant_id, warehouse_id, item_type, item_id, status)
       DO UPDATE SET quantity = GREATEST(inventory_stock.quantity, EXCLUDED.quantity)`,
      [tenantId, mpWarehouseId, mp.id, qty, cost]
    ))
  }
}

// ─── 11. Orden ─────────────────────────────────────────────────────────────

async function ensureOrder(client, productId, recipeId, harinaId) {
  log('\n[11] Creando orden de producción (80 kg de galletas ≈ 320 cajas de 250g)…')
  const list = await client.get('/api/production/orders').expect(200)
  const items = Array.isArray(list.body) ? list.body : (list.body.data || list.body.rows || [])
  const active = items.find(o => o.product_id === productId && ['draft','released','active','in_progress'].includes(o.status))
  if (active) { skip(`Orden activa ya existe (id=${active.id})`); return active }

  const res = await client.post('/api/production/orders', {
    productId,
    rawMaterialId: harinaId,
    quantityPackages: 80,
    priority: 'normal',
    recipeId,
    notes: 'Orden simulada — galletas de mantequilla',
  })
  if (res.status !== 201) fail(`POST /api/production/orders falló (${res.status})`, res.body)
  ok(`Orden creada (id=${res.body.id})`)
  return res.body
}

async function releaseOrder(client, orderId) {
  log('\n[12] Liberando orden…')
  const res = await client.post(`/api/production/orders/${orderId}/release`)
  if (res.status === 200) { ok('Orden liberada'); return }
  if (res.status === 409) { skip('Ya estaba liberada'); return }
  warn(`release devolvió ${res.status}: ${JSON.stringify(res.body).slice(0,120)}`)
}

// ─── 13. Turno ─────────────────────────────────────────────────────────────

async function openShift(client, tenantId, userId) {
  log('\n[13] Abriendo turno…')
  let shiftDate = new Date().toISOString().slice(0, 10)
  let n = 1
  for (let attempt = 0; attempt < 3; attempt++) {
    const used = await withBypass(() => query(
      `SELECT shift_number FROM production_shifts WHERE tenant_id=$1 AND shift_date::date=$2::date`,
      [tenantId, shiftDate]
    ))
    const taken = new Set(used.rows.map(r => parseInt(r.shift_number, 10)))
    n = 1; while (taken.has(n) && n <= 3) n++
    if (n <= 3) break
    const next = new Date(shiftDate + 'T12:00:00Z')
    next.setUTCDate(next.getUTCDate() + 1)
    shiftDate = next.toISOString().slice(0, 10)
    n = 1
  }
  const res = await client.post('/api/production/shifts', {
    shiftNumber: n, shiftDate, operatorId: userId, supervisorId: userId,
  })
  if (res.status !== 201) fail(`POST /api/production/shifts falló (${res.status})`, res.body)
  ok(`Turno #${n} (${shiftDate}) abierto (id=${res.body.id})`)
  return res.body
}

// ─── 14. Cargar MP ─────────────────────────────────────────────────────────

async function loadAllMp(client, shiftId, mps, kgUnitId) {
  log('\n[14] Cargando ingredientes — 3 componentes…')
  // Para 80 kg de galletas según receta:
  //   52 kg harina + 20 kg mantequilla + 14.4 kg azúcar = 86.4 kg input
  const loads = [
    { mp: mps['Harina de trigo'],    kg: 52,   label: '52 kg harina de trigo' },
    { mp: mps['Mantequilla sin sal'], kg: 20,   label: '20 kg mantequilla sin sal' },
    { mp: mps['Azúcar refinada'],    kg: 14.4, label: '14.4 kg azúcar refinada' },
  ]
  const loaded = []
  for (const { mp, kg, label } of loads) {
    const res = await client.post(`/api/production/shifts/${shiftId}/mp-loads`, {
      rawMaterialId: mp.id, kg, unitId: kgUnitId, quantity: kg,
      notes: `Carga simulada: ${label}`,
    })
    if (res.status !== 201) { warn(`loadMp '${label}' falló (${res.status})`); continue }
    ok(`Cargado: ${label}`)
    loaded.push(res.body)
  }
  const totalCost = 52*8.5 + 20*80 + 14.4*16
  log(`    Total: 86.4 kg (costo estimado: $${totalCost.toFixed(2)} MXN)`)
  return loaded
}

// ─── 15. Capturar producción ───────────────────────────────────────────────

async function capturePackages(client, shiftId, orderId) {
  log('\n[15] Capturando producción (primera calidad — galletas)…')
  // 86.4 kg input − 6.4 kg merma = 80 kg capturados (merma = 7.4%)
  const packs = [
    { label: 'Captura 1 — 25 kg (100 cajas de 250g)', kg: 25, units: 100 },
    { label: 'Captura 2 — 28 kg (112 cajas de 250g)', kg: 28, units: 112 },
    { label: 'Captura 3 — 27 kg (108 cajas de 250g)', kg: 27, units: 108 },
  ]
  const captured = []
  for (const p of packs) {
    const res = await client.post(`/api/production/shifts/${shiftId}/packages`, {
      productionOrderId: orderId,
      realWeightKg: p.kg,
      quantityUnits: p.units,
      gradeNumber: 1,
      notes: p.label,
    })
    if (res.status !== 201) { warn(`Captura falló (${res.status})`); continue }
    ok(`Capturado: ${p.label}`)
    captured.push(res.body)
  }
  log('    Total: 80 kg / 320 cajas')
  return captured
}

// ─── 16. Scrap ────────────────────────────────────────────────────────────

async function recordScraps(client, shiftId) {
  log('\n[16] Registrando merma (fragmentos + quemadas)…')
  // 86.4 − 80 = 6.4 kg de merma (7.4% — justo por encima del 7% esperado)
  const scraps = [
    { code: 'fragmentos', kg: 5.0, dest: 'discard', label: '5 kg fragmentos (merma normal)' },
    { code: 'quemadas',   kg: 1.4, dest: 'discard', label: '1.4 kg quemadas (anormal — supera 7% esperado)' },
  ]
  for (const s of scraps) {
    const res = await client.post(`/api/production/shifts/${shiftId}/scrap`, {
      scrapType: s.code, destination: s.dest, kg: s.kg, notes: s.label,
    })
    if (res.status !== 201) { warn(`Scrap '${s.code}' falló (${res.status})`); continue }
    const row = await withBypass(() => query(
      `SELECT scrap_type_id, recovery_value_pct, is_abnormal FROM shift_scrap WHERE id=$1`,
      [res.body.id]
    ))
    const db = row.rows[0]
    ok(`Scrap: ${s.label}`)
    log(`    → st_id=${db.scrap_type_id ? db.scrap_type_id.slice(0,8)+'…' : 'NULL'}, recovery=${db.recovery_value_pct ?? 0}%, abnormal=${db.is_abnormal}`)
  }
}

// ─── 17. Cerrar y validar ─────────────────────────────────────────────────

async function closeAndValidate(client, shiftId) {
  log('\n[17] Cerrando turno…')
  const close = await client.post(`/api/production/shifts/${shiftId}/close`)
  if (close.status !== 200) fail(`close falló (${close.status})`, JSON.stringify(close.body).slice(0,300))
  ok('Turno cerrado')

  log('\n[18] Validando turno…')
  const val = await client.post(`/api/production/shifts/${shiftId}/validate`, {
    approved: true, supervisorNotes: 'Turno galletas — aceptado (simulación)',
  })
  if (val.status !== 200) fail(`validate falló (${val.status})`, JSON.stringify(val.body).slice(0,300))
  ok('Turno validado')
  return val.body
}

// ─── 18. Snapshot comparativo ─────────────────────────────────────────────

async function printSnapshot(client, tenantId, shiftId) {
  log('\n' + '═'.repeat(70))
  log('SNAPSHOT FINAL — Turno Galletas de Mantequilla')
  log('═'.repeat(70))

  const summary = await client.get(`/api/production/shifts/${shiftId}/summary`)
  if (summary.status === 200) {
    const c = summary.body.costs || {}
    log('\n  ┌── Costos del turno ───────────────────────────────────────────')
    log(`  │  Costo MP total:      $${(c.mpCostTotal    || 0).toFixed(2)}`)
    log(`  │  Overhead (fijo):     $${(c.fixedTotal     || 0).toFixed(2)}`)
    log(`  │  NRV calidades inf.:  $${(c.nrvLowerGrades || 0).toFixed(2)}`)
    log(`  │  nrvWarning:          ${c.nrvWarning ?? 'n/a'}`)
    log(`  │  Costo asignado c-1:  $${(c.costGrade1     || 0).toFixed(2)}`)
    log(`  │  Costo total:         $${(c.totalCost      || 0).toFixed(2)}`)
    log(`  │  Costo/unidad:        $${(c.costPerUnit    || 0).toFixed(4)}`)
    log('  └───────────────────────────────────────────────────────────────')
  }

  // shift_progress
  const sp = await withBypass(() => query(
    `SELECT sp.real_weight_kg, sp.quantity_units, sp.is_second_quality,
            tqg.name AS grade_name, sp.microlot_number
     FROM shift_progress sp
     LEFT JOIN tenant_quality_grades tqg ON tqg.id = sp.quality_grade_id
     WHERE sp.shift_id=$1 ORDER BY sp.microlot_number`, [shiftId]
  ))
  log(`\n  shift_progress (${sp.rows.length} capturas):`)
  sp.rows.forEach(r =>
    log(`    #${r.microlot_number}: ${r.real_weight_kg} kg / ${r.quantity_units}u — ${r.grade_name || 'primera-legacy'}`)
  )

  // shift_scrap
  const ss = await withBypass(() => query(
    `SELECT ss.kg, tst.name AS type_name, ss.scrap_type,
            ss.recovery_value_pct, ss.is_abnormal
     FROM shift_scrap ss
     LEFT JOIN tenant_scrap_types tst ON tst.id = ss.scrap_type_id
     WHERE ss.shift_id=$1`, [shiftId]
  ))
  log(`\n  shift_scrap (${ss.rows.length} mermas):`)
  ss.rows.forEach(r =>
    log(`    ${r.kg} kg — ${r.type_name || r.scrap_type} (recovery=${r.recovery_value_pct ?? 0}%, abnormal=${r.is_abnormal})`)
  )

  // shift_mp_loads
  const ml = await withBypass(() => query(
    `SELECT sml.kg, rm.name AS mp_name, rm.cost_per_kg
     FROM shift_mp_loads sml
     JOIN raw_materials rm ON rm.id = sml.raw_material_id
     WHERE sml.shift_id=$1 ORDER BY sml.loaded_at`, [shiftId]
  ))
  log(`\n  shift_mp_loads (${ml.rows.length} cargas):`)
  let totalMpKg = 0; let totalMpCost = 0
  ml.rows.forEach(r => {
    const cost = parseFloat(r.kg) * parseFloat(r.cost_per_kg || 0)
    totalMpKg += parseFloat(r.kg); totalMpCost += cost
    log(`    ${r.kg} kg ${r.mp_name} @ $${r.cost_per_kg}/kg = $${cost.toFixed(2)}`)
  })
  log(`    ─────────────────────────────────────────────`)
  log(`    Total MP: ${totalMpKg.toFixed(1)} kg = $${totalMpCost.toFixed(2)}`)

  const totals = await withBypass(() => query(
    `SELECT SUM(real_weight_kg) AS kg, SUM(quantity_units) AS units
     FROM shift_progress WHERE shift_id=$1`, [shiftId]
  ))
  const r = totals.rows[0]
  log(`\n  Producción total: ${r.kg} kg / ${r.units} cajas`)
  log(`  Merma total:      ${(totalMpKg - parseFloat(r.kg || 0)).toFixed(1)} kg (${((totalMpKg - parseFloat(r.kg || 0)) / totalMpKg * 100).toFixed(1)}%)`)

  log('\n' + '═'.repeat(70))
  log('DEMOSTRACIÓN SaaS v2 — DOS VERTICALES, UN MISMO MOTOR')
  log('═'.repeat(70))
  log('')
  log('  ┌────────────────────────┬──────────────────────┬──────────────────────┐')
  log('  │ Aspecto                │ Palomitas Piloto      │ Galletas Artesanales │')
  log('  ├────────────────────────┼──────────────────────┼──────────────────────┤')
  log('  │ uses_lots              │ true                  │ true                  │')
  log('  │ uses_expiry            │ true                  │ true                  │')
  log('  │ uses_fefo              │ true                  │ true                  │')
  log('  │ cost_method            │ fifo                  │ fifo                  │')
  log('  │ Ingredientes           │ maíz+aceite+mantequil │ harina+mantq+azúcar  │')
  log('  │ Merma normal           │ sin_reventar          │ fragmentos            │')
  log('  │ Merma anormal          │ quemado               │ quemadas              │')
  log('  │ Calidades              │ solo primera          │ solo primera          │')
  log('  │ Cambios de código      │ CERO                  │ CERO                  │')
  log('  └────────────────────────┴──────────────────────┴──────────────────────┘')
  log('')
  log('  El mismo motor de producción, costeo y trazabilidad soporta ambos')
  log('  productos sin modificar una sola línea de código.')
  log('')
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main() {
  try {
    const tenant = await provisionOrFindTenant()
    const { token, userId } = await login()
    const client = clientFor(token)

    await applyFoodFlags(client)
    await customizeScrapTypes(client)
    await simplifyQualityGrades(client)

    const units    = await client.get('/api/process-config/units').expect(200)
    const kgUnitId = units.body.find(u => u.code === 'kg')?.id
    if (!kgUnitId) fail('No se encontró unidad "kg"')

    const warehouses = await ensureWarehouses(client, tenant.id)
    const mps        = await ensureRawMaterials(client)
    const product    = await ensureProduct(client, tenant.id)
    const recipe     = await ensureRecipe(client, product.id, mps, kgUnitId)

    const mpWarehouseId = warehouses['Almacén Ingredientes']?.id
    if (mpWarehouseId) {
      await ensureStock(tenant.id, mps, mpWarehouseId, userId)
    } else {
      warn('No se encontró warehouse de MP')
    }

    const order = await ensureOrder(client, product.id, recipe.id, mps['Harina de trigo'].id)
    await releaseOrder(client, order.id)

    const shift = await openShift(client, tenant.id, userId)
    await loadAllMp(client, shift.id, mps, kgUnitId)
    await capturePackages(client, shift.id, order.id)
    await recordScraps(client, shift.id)
    await closeAndValidate(client, shift.id)
    await printSnapshot(client, tenant.id, shift.id)

    log('Simulación galletas completada sin errores.')
  } catch (err) {
    console.error('\nError no manejado:', err.stack || err)
    process.exit(1)
  } finally {
    await pool.end()
  }
}

main()
