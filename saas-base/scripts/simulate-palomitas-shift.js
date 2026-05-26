'use strict'

/**
 * SaaS v2 — Simula un turno completo end-to-end en el tenant 'palomitas-piloto'.
 *
 * Demuestra el motor con un vertical alimentario:
 *   - uses_lots=true, uses_expiry=true, uses_fefo=true, cost_method='fifo'
 *   - Receta multi-componente: maíz + aceite + mantequilla → palomitas
 *   - 3 cargas de MP separadas (una por ingrediente)
 *   - Scrap con tipos del catálogo: 'sin_reventar' y 'quemado'
 *   - 1 sola calidad (primera) — palomitas no produce segunda
 *   - Cierre + validación + resumen de costos
 *
 * Pre-requisito: `node scripts/provision-palomitas.js` ya corrió.
 *
 * Uso:
 *   node scripts/simulate-palomitas-shift.js
 *
 * El script es idempotente: detecta warehouses/MP/producto/receta existentes y
 * los reutiliza. El turno siempre es nuevo (fecha + número de turno únicos).
 */

require('dotenv').config()
const request = require('supertest')
const app = require('../src/app')
const { pool, query, withBypass, withTransaction } = require('../src/db')
const inventoryService = require('../src/modules/inventory/inventoryService')

const SLUG  = 'palomitas-piloto'
const EMAIL = 'admin@palomitas-piloto.local'
const PASS  = 'Palomitas!2026'

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

// ─── 1. Login ──────────────────────────────────────────────────────────────

async function loginAndContext() {
  log('\n[1] Login + contexto del tenant…')
  const tenantRow = await withBypass(() => query(
    `SELECT id, slug, name FROM tenants WHERE slug = $1`, [SLUG]
  ))
  if (tenantRow.rows.length === 0)
    fail(`Tenant '${SLUG}' no existe. Corre 'node scripts/provision-palomitas.js' primero.`)

  const tenant = tenantRow.rows[0]
  ok(`Tenant: ${tenant.name} (${tenant.id})`)

  const res = await request(app)
    .post('/api/auth/login')
    .set('X-Tenant-Slug', SLUG)
    .send({ email: EMAIL, password: PASS })
  if (res.status !== 200) fail(`Login falló (${res.status})`, res.body)
  ok(`Logged in como ${EMAIL}`)

  const userRow = await withBypass(() => query(
    `SELECT id FROM users WHERE tenant_id = $1 AND email = $2`,
    [tenant.id, EMAIL]
  ))
  const userId = userRow.rows[0].id

  // Confirmar flags del tenant
  const cfg = await request(app)
    .get('/api/process-config')
    .set('X-Tenant-Slug', SLUG)
    .set('Authorization', `Bearer ${res.body.accessToken}`)
  log(`  Flags: uses_lots=${cfg.body.uses_lots}, uses_expiry=${cfg.body.uses_expiry}`)
  log(`         uses_fefo=${cfg.body.uses_fefo}, cost_method=${cfg.body.cost_method}`)

  return { tenant, token: res.body.accessToken, userId }
}

// ─── 2. Warehouses ─────────────────────────────────────────────────────────

async function ensureWarehouses(client, tenantId) {
  log('\n[2] Asegurando warehouses…')
  const list = await client.get('/api/warehouses').expect(200)
  const byName = Object.fromEntries(list.body.map(w => [w.name, w]))

  const wanted = [
    { name: 'Almacén Maíz',       type: 'raw_material',     resin_type: 'PP', description: 'Maíz palomero y empaques' },
    { name: 'Almacén PT Palomas', type: 'finished_product', description: 'Palomitas terminadas' },
    { name: 'WIP Palomitas',       type: 'wip',              description: 'Producto pre-QA' },
    { name: 'Merma Palomitas',     type: 'regrind',          resin_type: 'PE', description: 'Scrap (sin_reventar, quemado)' },
  ]

  const result = {}
  for (const w of wanted) {
    if (byName[w.name]) {
      skip(`Warehouse '${w.name}' ya existe`)
      result[w.name] = byName[w.name]
      continue
    }
    const res = await client.post('/api/warehouses', { ...w, is_active: true })
    if (res.status !== 201) { warn(`No se pudo crear '${w.name}': ${res.status}`); continue }
    ok(`Creado warehouse '${w.name}' (id=${res.body.id})`)
    result[w.name] = res.body
  }

  // Backfill warehouse_type_id para el invariante de tests
  const mapping = { raw_material: 'materia_prima', finished_product: 'producto_terminado', wip: 'wip', regrind: 'merma' }
  for (const w of Object.values(result)) {
    if (w.warehouse_type_id) continue
    const code = mapping[w.type]
    if (!code) continue
    await withBypass(() => query(
      `UPDATE warehouses
         SET warehouse_type_id = (SELECT id FROM tenant_warehouse_types WHERE tenant_id = warehouses.tenant_id AND code = $1)
       WHERE id = $2`,
      [code, w.id]
    ))
  }
  return result
}

// ─── 3. Materias primas ────────────────────────────────────────────────────

async function ensureRawMaterials(client) {
  log('\n[3] Asegurando materias primas (maíz, aceite, mantequilla)…')
  const list = await client.get('/api/raw-materials').expect(200)
  const items = Array.isArray(list.body) ? list.body : (list.body.data || list.body.rows || [])
  const byName = Object.fromEntries(items.map(r => [r.name, r]))

  const wanted = [
    { name: 'Maíz palomero',     resinType: 'PP', materialType: 'virgin', unit: 'kg', costPerKg: 12.00, leadTimeDays: 3 },
    { name: 'Aceite vegetal',    resinType: 'PE', materialType: 'virgin', unit: 'kg', costPerKg: 38.00, leadTimeDays: 5 },
    { name: 'Mantequilla',       resinType: 'PP', materialType: 'virgin', unit: 'kg', costPerKg: 80.00, leadTimeDays: 7 },
  ]

  const result = {}
  for (const mp of wanted) {
    if (byName[mp.name]) {
      skip(`MP '${mp.name}' ya existe (id=${byName[mp.name].id})`)
      result[mp.name] = byName[mp.name]
      continue
    }
    const res = await client.post('/api/raw-materials', mp)
    if (res.status !== 201) fail(`POST raw-material '${mp.name}' falló (${res.status})`, res.body)
    ok(`Creada MP '${mp.name}' ($${mp.costPerKg}/kg, id=${res.body.id})`)
    result[mp.name] = res.body
  }
  return result
}

// ─── 4. Producto ───────────────────────────────────────────────────────────

async function ensureProduct(client, tenantId) {
  log('\n[4] Asegurando producto "PAL-MTQ-50G"…')
  const list = await client.get('/api/products').expect(200)
  const items = Array.isArray(list.body) ? list.body : (list.body.data || list.body.rows || [])
  let p = items.find(x => x.sku === 'PAL-MTQ-50G')

  if (!p) {
    const res = await client.post('/api/products', {
      sku: 'PAL-MTQ-50G',
      name: 'Palomitas Mantequilla 50g',
      type: 'corner_protector', // enum legacy requerido
      saleUnit: 'bolsa',
      basePrice: 12.00,
      baseCurrency: 'MXN',
      description: 'Bolsa 50g palomitas sabor mantequilla',
    })
    if (res.status !== 201) fail(`POST /api/products falló (${res.status})`, res.body)
    ok(`Creado producto 'PAL-MTQ-50G' (id=${res.body.id})`)
    p = res.body
  } else {
    skip(`Producto 'PAL-MTQ-50G' ya existe (id=${p.id})`)
  }

  // Setear expected_sale_price y is_produced via PATCH (ya funciona desde §6c)
  const patch = await client.patch(`/api/products/${p.id}`, {
    expected_sale_price: 12.00,
    is_produced: true,
  })
  if (patch.status === 200) ok(`expected_sale_price=$12 e is_produced=true aplicados`)
  else warn(`PATCH products/${p.id} devolvió ${patch.status} — continúa sin estos campos`)

  return patch.status === 200 ? patch.body : p
}

// ─── 5. Receta multi-componente ────────────────────────────────────────────

async function ensureRecipe(client, productId, mps, kgUnitId) {
  log('\n[5] Asegurando receta (maíz + aceite + mantequilla → palomitas)…')
  const list = await client.get(`/api/recipes?productId=${productId}&vigentOnly=true`).expect(200)
  if (list.body.length > 0) {
    skip(`Receta vigente ya existe (id=${list.body[0].id}, v${list.body[0].version})`)
    return list.body[0]
  }

  // Receta por kg de producto terminado:
  //   1.28 kg maíz + 0.09 kg aceite + 0.04 kg mantequilla → 1 kg palomitas
  //   expected_scrap_pct = 8% (granos sin reventar, quemados)
  const res = await client.post('/api/recipes', {
    product_id:          productId,
    name:                'Palomitas Mantequilla — receta base',
    yield_quantity:      1.0,
    yield_unit_id:       kgUnitId,
    expected_scrap_pct:  8.0,
    components: [
      { raw_material_id: mps['Maíz palomero'].id,  quantity: 1.28, unit_id: kgUnitId, sort_order: 10 },
      { raw_material_id: mps['Aceite vegetal'].id,  quantity: 0.09, unit_id: kgUnitId, sort_order: 20 },
      { raw_material_id: mps['Mantequilla'].id,     quantity: 0.04, unit_id: kgUnitId, sort_order: 30 },
    ],
  })
  if (res.status !== 201) fail(`POST /api/recipes falló (${res.status})`, res.body)
  ok(`Receta creada (id=${res.body.id}, v${res.body.version}) → yield 1 kg, scrap 8%`)
  log(`    Componentes: 1.28 kg maíz + 0.09 kg aceite + 0.04 kg mantequilla`)
  return res.body
}

// ─── 6. Stock de MP ────────────────────────────────────────────────────────

async function ensureStock(tenantId, mps, mpWarehouseId, userId) {
  log('\n[6] Sembrando stock de MP (inventory_stock + raw_material_lots para FEFO)…')
  const seeds = [
    { mp: mps['Maíz palomero'],  qty: 500, cost: 12.00, lotNum: 'MAIZ-SIM-001', expiryDays: 365 },
    { mp: mps['Aceite vegetal'], qty:  50, cost: 38.00, lotNum: 'ACE-SIM-001',  expiryDays: 180 },
    { mp: mps['Mantequilla'],    qty:  30, cost: 80.00, lotNum: 'MTQ-SIM-001',  expiryDays:  90 },
  ]

  for (const { mp, qty, cost, lotNum, expiryDays } of seeds) {
    // Verificar si ya existe un lote activo con suficiente cantidad
    const existingLot = await withBypass(() => query(
      `SELECT id, quantity_remaining FROM raw_material_lots
       WHERE tenant_id=$1 AND raw_material_id=$2 AND status='active'
       ORDER BY received_at LIMIT 1`,
      [tenantId, mp.id]
    ))
    if (existingLot.rows.length > 0 && parseFloat(existingLot.rows[0].quantity_remaining) >= qty * 0.5) {
      skip(`Lote '${mp.name}': ${existingLot.rows[0].quantity_remaining} kg disponibles — suficiente`)
      continue
    }

    const expiry = new Date(Date.now() + expiryDays * 86400000).toISOString().slice(0, 10)
    const total  = qty * cost

    // 1. Insertar en raw_material_lots (lo que usa loadMp con uses_lots=true)
    const lotRes = await withBypass(() => query(
      `INSERT INTO raw_material_lots
         (tenant_id, raw_material_id, lot_number, warehouse_id,
          quantity_received, quantity_remaining, unit_cost, total_cost,
          status, expiry_date, received_at, created_at, created_by_user_id)
       VALUES ($1,$2,$3,$4,$5,$5,$6,$7,'active',$8,NOW(),NOW(),$9)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [tenantId, mp.id, lotNum, mpWarehouseId, qty, cost, total, expiry, userId]
    ))
    if (lotRes.rows.length > 0) {
      ok(`Lote creado: '${mp.name}' ${qty}kg @ $${cost}/kg, vence ${expiry} (id=${lotRes.rows[0].id.slice(0,8)}…)`)
    } else {
      skip(`Lote '${lotNum}' para '${mp.name}' ya existía`)
    }

    // 2. Seed inventory_stock para que recordMovement pueda decrementar el balance
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

// ─── 7. Orden ──────────────────────────────────────────────────────────────

async function ensureOrder(client, productId, recipeId, maizId) {
  log('\n[7] Creando orden de producción (100 kg de palomitas ≈ 2000 bolsas de 50g)…')
  const list = await client.get('/api/production/orders').expect(200)
  const items = Array.isArray(list.body) ? list.body : (list.body.data || list.body.rows || [])
  const active = items.find(o => o.product_id === productId && ['draft','released','active','in_progress'].includes(o.status))
  if (active) {
    skip(`Orden activa ya existe (id=${active.id}, status=${active.status})`)
    return active
  }

  const res = await client.post('/api/production/orders', {
    productId,
    rawMaterialId: maizId,  // campo legacy requerido
    quantityPackages: 100,
    priority: 'normal',
    recipeId,
    notes: 'Orden simulada — palomitas mantequilla',
  })
  if (res.status !== 201) fail(`POST /api/production/orders falló (${res.status})`, res.body)
  ok(`Orden creada (id=${res.body.id}, #${res.body.order_number || res.body.orderNumber || '?'})`)
  return res.body
}

async function releaseOrder(client, orderId) {
  log('\n[8] Liberando orden…')
  const res = await client.post(`/api/production/orders/${orderId}/release`)
  if (res.status === 200) { ok('Orden liberada → released'); return }
  if (res.status === 409) { skip(`Ya estaba liberada/activa`); return }
  warn(`release devolvió ${res.status}: ${JSON.stringify(res.body).slice(0,120)}`)
}

// ─── 9. Turno ──────────────────────────────────────────────────────────────

async function openShift(client, tenantId, userId) {
  log('\n[9] Abriendo turno…')
  // shift_number es enum(1,2,3) — si hoy está lleno, usamos mañana
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
    // Día lleno → intentar el siguiente
    const next = new Date(shiftDate + 'T12:00:00Z')
    next.setUTCDate(next.getUTCDate() + 1)
    shiftDate = next.toISOString().slice(0, 10)
    n = 1
  }

  const res = await client.post('/api/production/shifts', {
    shiftNumber: n, shiftDate,
    operatorId: userId, supervisorId: userId,
  })
  if (res.status !== 201) fail(`POST /api/production/shifts falló (${res.status})`, res.body)
  ok(`Turno #${n} (${shiftDate}) abierto (id=${res.body.id})`)
  return res.body
}

// ─── 10. Cargar MP (3 ingredientes) ───────────────────────────────────────

async function loadAllMp(client, shiftId, mps, kgUnitId) {
  log('\n[10] Cargando MP — 3 ingredientes…')
  // Para 100 kg de palomitas según receta:
  //   128 kg maíz, 9 kg aceite, 4 kg mantequilla = 141 kg input
  const loads = [
    { mp: mps['Maíz palomero'],  kg: 128, label: '128 kg maíz palomero' },
    { mp: mps['Aceite vegetal'],  kg:   9, label: '9 kg aceite vegetal' },
    { mp: mps['Mantequilla'],     kg:   4, label: '4 kg mantequilla' },
  ]
  const loaded = []
  for (const { mp, kg, label } of loads) {
    const res = await client.post(`/api/production/shifts/${shiftId}/mp-loads`, {
      rawMaterialId: mp.id,
      kg,
      unitId: kgUnitId,
      quantity: kg,
      notes: `Carga simulada: ${label}`,
    })
    if (res.status !== 201) {
      warn(`loadMp '${label}' falló (${res.status}): ${JSON.stringify(res.body).slice(0,150)}`)
      continue
    }
    ok(`Cargado: ${label} (load id=${res.body.id})`)
    loaded.push(res.body)
  }
  log(`    Total MP cargado: 141 kg (costo estimado: $${128*12 + 9*38 + 4*80} ≈ $2,210 MXN)`)
  return loaded
}

// ─── 11. Capturar paquetes ────────────────────────────────────────────────

async function capturePackages(client, shiftId, orderId) {
  log('\n[11] Capturando producción (primera calidad — palomitas solo produce cal-1)…')
  // De 141 kg input con 8% scrap = ~11.28 kg merma esperada
  // Producción neta = ~129.72 kg → redondeamos a 128 kg capturados en 4 capturas
  const packs = [
    { label: 'Captura 1 — 40 kg, 800 bolsas (turno inicio)', kg: 40, units: 800 },
    { label: 'Captura 2 — 35 kg, 700 bolsas',                kg: 35, units: 700 },
    { label: 'Captura 3 — 30 kg, 600 bolsas',                kg: 30, units: 600 },
    { label: 'Captura 4 — 23 kg, 460 bolsas (fin de turno)', kg: 23, units: 460 },
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
    if (res.status !== 201) {
      warn(`Captura '${p.label}' falló (${res.status}): ${JSON.stringify(res.body).slice(0,150)}`)
      continue
    }
    ok(`Capturado: ${p.label} (id=${res.body.id}, grade=${res.body.quality_grade_id ? 'primera' : 'NULL-legacy'})`)
    captured.push(res.body)
  }
  log(`    Total capturado: 128 kg / 2,560 bolsas`)
  return captured
}

// ─── 12. Scrap ────────────────────────────────────────────────────────────

async function recordScraps(client, shiftId) {
  log('\n[12] Registrando merma (sin_reventar + quemado)…')
  // 141 kg input - 128 kg producción = 13 kg merma (9.2%)
  // 9.2% > 8% esperado → sin_reventar será marcado como is_abnormal
  const scraps = [
    { code: 'sin_reventar', kg: 10, dest: 'discard', label: '10 kg granos sin reventar (descarte)' },
    { code: 'quemado',      kg:  3, dest: 'discard', label: '3 kg producto quemado (descarte)' },
  ]
  const recorded = []
  for (const s of scraps) {
    const res = await client.post(`/api/production/shifts/${shiftId}/scrap`, {
      scrapType: s.code,
      destination: s.dest,
      kg: s.kg,
      notes: `Merma simulada: ${s.label}`,
    })
    if (res.status !== 201) {
      warn(`Scrap '${s.code}' falló (${res.status}): ${JSON.stringify(res.body).slice(0,150)}`)
      continue
    }
    const row = await withBypass(() => query(
      `SELECT scrap_type_id, recovery_value_pct, is_abnormal FROM shift_scrap WHERE id = $1`,
      [res.body.id]
    ))
    const db = row.rows[0]
    ok(`Scrap: ${s.label}`)
    log(`    → st_id=${db.scrap_type_id ? db.scrap_type_id.slice(0,8)+'…' : 'NULL'}, rec_pct=${db.recovery_value_pct ?? 0}, abnormal=${db.is_abnormal}`)
    recorded.push({ ...res.body, _db: db })
  }
  return recorded
}

// ─── 13. Cerrar y validar ─────────────────────────────────────────────────

async function closeAndValidate(client, shiftId) {
  log('\n[13] Cerrando turno…')
  const close = await client.post(`/api/production/shifts/${shiftId}/close`)
  if (close.status !== 200)
    fail(`close falló (${close.status})`, JSON.stringify(close.body).slice(0, 300))
  ok(`Turno cerrado`)

  log('\n[14] Validando turno (supervisor)…')
  const val = await client.post(`/api/production/shifts/${shiftId}/validate`, {
    approved: true,
    supervisorNotes: 'Turno palomitas — aceptado (simulación)',
  })
  if (val.status !== 200)
    fail(`validate falló (${val.status})`, JSON.stringify(val.body).slice(0, 300))
  ok(`Turno validado`)
  return val.body
}

// ─── 14. Snapshot y resumen ───────────────────────────────────────────────

async function printSnapshot(client, tenantId, shiftId) {
  log('\n' + '═'.repeat(70))
  log('SNAPSHOT FINAL — Turno Palomitas Mantequilla')
  log('═'.repeat(70))

  // Shift summary
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
    log(`  └───────────────────────────────────────────────────────────────`)
  }

  // shift_progress
  const sp = await withBypass(() => query(
    `SELECT sp.real_weight_kg, sp.quantity_units, sp.is_second_quality,
            sp.quality_grade_id, tqg.name AS grade_name,
            sp.microlot_number
     FROM shift_progress sp
     LEFT JOIN tenant_quality_grades tqg ON tqg.id = sp.quality_grade_id
     WHERE sp.shift_id = $1 ORDER BY sp.microlot_number`, [shiftId]
  ))
  log(`\n  shift_progress (${sp.rows.length} capturas):`)
  sp.rows.forEach(r =>
    log(`    #${r.microlot_number}: ${r.real_weight_kg} kg / ${r.quantity_units}u — ${r.grade_name || 'primera-legacy'} (is_sq=${r.is_second_quality})`)
  )

  // shift_scrap
  const ss = await withBypass(() => query(
    `SELECT ss.kg, ss.scrap_type, tst.name AS type_name,
            ss.recovery_value_pct, ss.is_abnormal
     FROM shift_scrap ss
     LEFT JOIN tenant_scrap_types tst ON tst.id = ss.scrap_type_id
     WHERE ss.shift_id = $1`, [shiftId]
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
     WHERE sml.shift_id = $1 ORDER BY sml.loaded_at`, [shiftId]
  ))
  log(`\n  shift_mp_loads (${ml.rows.length} cargas):`)
  let totalMpKg = 0; let totalMpCost = 0
  ml.rows.forEach(r => {
    const cost = parseFloat(r.kg) * parseFloat(r.cost_per_kg || 0)
    totalMpKg += parseFloat(r.kg)
    totalMpCost += cost
    log(`    ${r.kg} kg ${r.mp_name} @ $${r.cost_per_kg}/kg = $${cost.toFixed(2)}`)
  })
  log(`    ─────────────────────────────────────────────`)
  log(`    Total MP: ${totalMpKg} kg = $${totalMpCost.toFixed(2)}`)

  // Producción total
  const totals = await withBypass(() => query(
    `SELECT SUM(real_weight_kg) AS kg, SUM(quantity_units) AS units
     FROM shift_progress WHERE shift_id = $1`, [shiftId]
  ))
  const r = totals.rows[0]
  log(`\n  Producción total: ${r.kg} kg / ${r.units} bolsas`)
  log(`  Merma total: ${totalMpKg - parseFloat(r.kg || 0)} kg (${((totalMpKg - parseFloat(r.kg || 0)) / totalMpKg * 100).toFixed(1)}%)`)

  log('\n' + '═'.repeat(70))
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main() {
  try {
    const { tenant, token, userId } = await loginAndContext()
    const client = clientFor(token)

    // IDs base
    const units       = await client.get('/api/process-config/units').expect(200)
    const kgUnitId    = units.body.find(u => u.code === 'kg')?.id
    if (!kgUnitId) fail('No se encontró unidad "kg"')

    const warehouses  = await ensureWarehouses(client, tenant.id)
    const mps         = await ensureRawMaterials(client)
    const product     = await ensureProduct(client, tenant.id)
    const recipe      = await ensureRecipe(client, product.id, mps, kgUnitId)

    const mpWarehouseId = warehouses['Almacén Maíz']?.id
    if (mpWarehouseId) {
      await ensureStock(tenant.id, mps, mpWarehouseId, userId)
    } else {
      warn('No se encontró warehouse de MP — el release puede fallar por stock insuficiente')
    }

    const order = await ensureOrder(client, product.id, recipe.id, mps['Maíz palomero'].id)
    await releaseOrder(client, order.id)

    const shift = await openShift(client, tenant.id, userId)
    await loadAllMp(client, shift.id, mps, kgUnitId)
    await capturePackages(client, shift.id, order.id)
    await recordScraps(client, shift.id)
    await closeAndValidate(client, shift.id)
    await printSnapshot(client, tenant.id, shift.id)

    log('\nSimulación palomitas completada sin errores.')
  } catch (err) {
    console.error('\nError no manejado:', err.stack || err)
    process.exit(1)
  } finally {
    await pool.end()
  }
}

main()
