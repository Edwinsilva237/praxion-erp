'use strict'

/**
 * SaaS v2 — Simula un turno end-to-end en el tenant 'recicladora-piloto'.
 *
 * Objetivo del bloque 6e (Fase 2): descubrir los gaps reales del motor cuando
 * se usa con flags industriales (uses_lots=false, allergen_mode='alert_only',
 * pt_goes_to_wip_first=true, multi-calidad). NO buscamos un turno "perfecto":
 * buscamos saber qué se rompe y dónde está cada bloqueo real para 6b/6c/6d.
 *
 * Pre-requisito: `node scripts/provision-recicladora.js` ya corrió.
 *
 * Flujo simulado:
 *   1. Login + verificar tenant + traer IDs base
 *   2. Crear / asegurar warehouses (MP, PT, scrap, WIP)
 *   3. Crear / asegurar raw material "PE crudo"
 *   4. Crear / asegurar producto "PEL-PE-BL"
 *   5. PATCH directo en DB campos no expuestos: product_kind_id,
 *      default_quality_grade_id, expected_sale_price (GAP reportado)
 *   6. Crear / asegurar receta (1 componente, 1.18 kg PE / kg pellet, 15% scrap)
 *   7. Crear orden de producción (1000 kg objetivo)
 *   8. Sembrar stock inicial de PE crudo (vía SQL — los API REST de inventario
 *      no tienen "ajuste manual de stock" para este caso)
 *   9. Liberar orden → activa
 *  10. Crear turno (operator+supervisor = admin)
 *  11. Cargar MP (1200 kg PE crudo)
 *  12. Capturar 3 paquetes:
 *        - 600 kg primera (isSecondQuality=false)
 *        - 200 kg segunda (isSecondQuality=true)
 *        - 100 kg tercera (isSecondQuality=true)   ← API no diferencia 2ª de 3ª
 *  13. Registrar scrap: 50 kg finos_polvo (sell, recovery 10%)
 *  14. Cerrar turno
 *  15. Validar turno (supervisor)
 *  16. Reporte final con todos los gaps detectados
 *
 * El script es destructivo SOLO si la orden/turno ya existieron — usa nombres
 * fijos para idempotencia y "skips" cuando detecta estado previo.
 *
 * Uso:
 *   node scripts/simulate-recicladora-shift.js
 */

require('dotenv').config()
const request = require('supertest')
const app = require('../src/app')
const { pool, query, withBypass, withTransaction } = require('../src/db')
const inventoryService = require('../src/modules/inventory/inventoryService')

const SLUG  = 'recicladora-piloto'
const EMAIL = 'admin@recicladora-piloto.local'
const PASS  = 'Recicladora!2026'

const log   = (...args) => console.log(...args)
const ok    = (msg) => console.log('  ✓', msg)
const skip  = (msg) => console.log('  ⊘', msg)
const gap   = (msg) => console.log('  ⚠ GAP:', msg)
const fail  = (msg, extra) => { console.error('  ✗', msg); if (extra) console.error('   ', extra); process.exit(1) }

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

// ─── 1. Login + verificar tenant ───────────────────────────────────────────

async function loginAndContext() {
  log('\n[1] Login + contexto del tenant…')
  const tenantRow = await withBypass(() => query(
    `SELECT id, slug, name FROM tenants WHERE slug = $1`, [SLUG]
  ))
  if (tenantRow.rows.length === 0) {
    fail(`Tenant '${SLUG}' no existe. Corre 'node scripts/provision-recicladora.js' primero.`)
  }
  const tenant = tenantRow.rows[0]
  ok(`Tenant: ${tenant.name} (${tenant.id})`)

  const res = await request(app)
    .post('/api/auth/login')
    .set('X-Tenant-Slug', SLUG)
    .send({ email: EMAIL, password: PASS })
  if (res.status !== 200) fail(`Login falló (${res.status})`, res.body)
  ok(`Logged in como ${EMAIL}`)

  // user.id no viene en el body de login → traemos del DB
  const userRow = await withBypass(() => query(
    `SELECT id FROM users WHERE tenant_id = $1 AND email = $2`,
    [tenant.id, EMAIL]
  ))
  const userId = userRow.rows[0].id
  ok(`User id: ${userId}`)

  return { tenant, token: res.body.accessToken, userId }
}

// ─── 2. Warehouses ─────────────────────────────────────────────────────────

async function ensureWarehouses(client) {
  log('\n[2] Asegurando warehouses…')
  const list = await client.get('/api/warehouses').expect(200)
  const existing = Object.fromEntries(list.body.map(w => [w.name, w]))

  // GAP detectado: el módulo legacy /api/warehouses acepta solo
  // 'raw_material'/'wip'/'finished_product'/'regrind'/'resale', NO los
  // system_role del catálogo SaaS v2 (tenant_warehouse_types: mp / embalaje /
  // producto_terminado / merma / wip). Workaround: usar los tipos legacy.
  // raw_material y regrind requieren `resin_type` (legacy: solo PP/PE).
  const wanted = [
    { name: 'Almacén PE Crudo',   type: 'raw_material',     resin_type: 'PE', description: 'MP plástico crudo PE' },
    { name: 'Almacén Pellet PE',  type: 'finished_product', description: 'PT pellet listo' },
    { name: 'Almacén WIP Pellet', type: 'wip',              description: 'PT pre-QA (pt_goes_to_wip_first=true)' },
    { name: 'Merma Vendible',     type: 'regrind',          resin_type: 'PE', description: 'Finos/polvo a vender (no hay tipo "scrap" en warehouses legacy)' },
  ]

  const created = {}
  for (const w of wanted) {
    if (existing[w.name]) {
      skip(`warehouse '${w.name}' ya existe (id=${existing[w.name].id})`)
      created[w.name] = existing[w.name]
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
  recordGap('WAREHOUSE_TYPES_LEGACY',
    'Módulo legacy /api/warehouses acepta solo tipos hardcoded (raw_material/wip/finished_product/regrind/resale). NO usa el catálogo SaaS v2 tenant_warehouse_types. Necesario refactor para que reads de "merma" correspondan a system_role="scrap".')

  // Higiene: el módulo legacy NO setea warehouse_type_id (FK a tenant_warehouse_types).
  // Hay un test global (process-config-warehouse-types.test.js) que invariante
  // verifica que TODOS los warehouses tengan warehouse_type_id. Lo poblamos a
  // mano según el mapeo legacy → SaaS v2 hasta que el módulo legacy se refactorice.
  const mapping = {
    raw_material:     'materia_prima',
    finished_product: 'producto_terminado',
    wip:              'wip',
    regrind:          'merma',
    resale:           'producto_terminado',  // sin equivalente directo
  }
  for (const w of Object.values(created)) {
    if (w.warehouse_type_id) continue
    const targetCode = mapping[w.type]
    if (!targetCode) continue
    await withBypass(() => query(
      `UPDATE warehouses
         SET warehouse_type_id = (
           SELECT id FROM tenant_warehouse_types
           WHERE tenant_id = warehouses.tenant_id AND code = $1
         )
       WHERE warehouses.id = $2`,
      [targetCode, w.id]
    ))
  }
  return created
}

// ─── 3. Raw material PE crudo ──────────────────────────────────────────────

async function ensureRawMaterial(client) {
  log('\n[3] Asegurando raw material "PE crudo"…')
  const list = await client.get('/api/raw-materials').expect(200)
  const items = Array.isArray(list.body) ? list.body : (list.body.data || list.body.items || list.body.rows || [])
  const existing = items.find(r => r.name === 'PE crudo')
  if (existing) {
    skip(`raw_material 'PE crudo' ya existe (id=${existing.id})`)
    return existing
  }
  const body = {
    name: 'PE crudo',
    resinType: 'PE',
    materialType: 'virgin',
    unit: 'kg',
    maxRegrindPct: 0,
    costPerKg: 8.50,
    description: 'Plástico PE post-consumo recibido por kg',
    leadTimeDays: 7,
  }
  const res = await client.post('/api/raw-materials', body)
  if (res.status !== 201) {
    fail(`POST /api/raw-materials falló (${res.status})`, res.body)
  }
  ok(`Creado raw_material 'PE crudo' (id=${res.body.id})`)
  return res.body
}

// ─── 4. Producto Pellet PE blanco ──────────────────────────────────────────

async function ensureProduct(client, tenantId, primeraGradeId, pelletKindId) {
  log('\n[4] Asegurando producto "PEL-PE-BL"…')
  const list = await client.get('/api/products').expect(200)
  const items = Array.isArray(list.body) ? list.body : (list.body.data || list.body.items || list.body.rows || [])
  let existing = items.find(p => p.sku === 'PEL-PE-BL')
  if (!existing) {
    // GAP: el enum product_type solo tiene 'corner_protector'/'resale' (legacy).
    // Hacemos workaround con 'corner_protector' y reportamos.
    const res = await client.post('/api/products', {
      sku: 'PEL-PE-BL',
      name: 'Pellet PE blanco',
      type: 'corner_protector',  // workaround enum legacy
      resinType: 'PE',
      saleUnit: 'kg',
      basePrice: 22.0,
      baseCurrency: 'MXN',
      description: 'Pellet de PE color blanco, post-consumo',
    })
    if (res.status !== 201) fail(`POST /api/products falló (${res.status})`, res.body)
    ok(`Creado product 'PEL-PE-BL' (id=${res.body.id})`)
    existing = res.body
    recordGap('PRODUCT_TYPE_ENUM', `products.type aún es enum legacy ('corner_protector'/'resale'). No expresa "pellet" / "molido" — workaround usado.`)
  } else {
    skip(`product 'PEL-PE-BL' ya existe (id=${existing.id})`)
  }

  // 4b. Setear campos SaaS v2 no expuestos en POST/PATCH del API REST.
  const needs = (
    existing.product_kind_id !== pelletKindId ||
    existing.default_quality_grade_id !== primeraGradeId ||
    existing.expected_sale_price == null ||
    !existing.is_produced
  )
  if (needs) {
    await withBypass(() => query(
      `UPDATE products
         SET product_kind_id = $1,
             default_quality_grade_id = $2,
             expected_sale_price = $3,
             is_produced = true
       WHERE id = $4 AND tenant_id = $5`,
      [pelletKindId, primeraGradeId, 22.0, existing.id, tenantId]
    ))
    ok(`PATCH SQL directo: product_kind_id, default_quality_grade_id, expected_sale_price, is_produced`)
    recordGap('PRODUCT_PATCH_FIELDS',
      'POST/PATCH /api/products NO acepta product_kind_id, default_quality_grade_id, expected_sale_price, is_produced. Workaround: UPDATE directo en DB.')
  } else {
    skip('Campos SaaS v2 del producto ya están seteados')
  }

  // Re-leer para devolver fresh
  const ref = await client.get(`/api/products/${existing.id}`).expect(200)
  return ref.body
}

// ─── 5. Receta ─────────────────────────────────────────────────────────────

async function ensureRecipe(client, productId, peCrudoId, kgUnitId) {
  log('\n[5] Asegurando receta para Pellet PE blanco…')
  const list = await client.get(`/api/recipes?productId=${productId}&vigentOnly=true`).expect(200)
  if (list.body.length > 0) {
    skip(`receta vigente ya existe (id=${list.body[0].id}, v${list.body[0].version})`)
    return list.body[0]
  }
  const res = await client.post('/api/recipes', {
    product_id: productId,
    name: 'Pellet PE — receta base',
    yield_quantity: 1.0,
    yield_unit_id: kgUnitId,
    expected_scrap_pct: 15.0,
    components: [
      {
        raw_material_id: peCrudoId,
        quantity: 1.18,
        unit_id: kgUnitId,
        sort_order: 10,
      },
    ],
  })
  if (res.status !== 201) fail(`POST /api/recipes falló (${res.status})`, res.body)
  ok(`Creada receta (id=${res.body.id}, v${res.body.version})`)
  return res.body
}

// ─── 6. Stock inicial de PE crudo ──────────────────────────────────────────

async function ensureRawMaterialStock(tenantId, peCrudoId, mpWarehouseId, userId) {
  log('\n[6] Sembrando stock inicial de PE crudo (2000 kg en MP)…')
  // Stock actual del item en el warehouse
  const stock = await withBypass(() => query(
    `SELECT COALESCE(SUM(quantity),0)::numeric AS qty
     FROM inventory_stock
     WHERE tenant_id = $1 AND item_type = 'raw_material' AND item_id = $2
       AND warehouse_id = $3 AND status = 'available'`,
    [tenantId, peCrudoId, mpWarehouseId]
  ))
  if (parseFloat(stock.rows[0].qty) >= 1500) {
    skip(`Stock actual: ${stock.rows[0].qty} kg — suficiente`)
    return
  }
  const need = 2000 - parseFloat(stock.rows[0].qty)
  await withBypass(() => withTransaction(async (client) => {
    await inventoryService.recordMovement(client, {
      tenantId,
      warehouseId: mpWarehouseId,
      itemType: 'raw_material',
      itemId: peCrudoId,
      movementType: 'adjustment_in',
      quantity: need,
      unit: 'kg',
      unitCost: 8.5,
      statusTo: 'available',
      referenceType: 'simulation',
      notes: 'Stock inicial simulado (script 6e)',
      createdBy: userId,
    })
  }))
  ok(`Insertados ${need} kg vía inventoryService.recordMovement (manual_adjustment)`)
  recordGap('STOCK_SEED_API',
    'No existe endpoint REST para "ajuste manual de stock" / siembra inicial. Workaround: invocar inventoryService.recordMovement directo desde Node.')
}

// ─── 7. Orden de producción ────────────────────────────────────────────────

async function ensureOrder(client, productId, recipeId, peCrudoId) {
  log('\n[7] Creando orden de producción (1000 kg objetivo)…')
  const list = await client.get('/api/production/orders').expect(200)
  const items = Array.isArray(list.body) ? list.body : (list.body.data || list.body.items || list.body.rows || [])
  let existing = items.find(o => o.product_id === productId && ['draft','active','planning','released'].includes(o.status))
  if (existing) {
    skip(`orden activa/draft ya existe (id=${existing.id}, status=${existing.status})`)
    return existing
  }
  const res = await client.post('/api/production/orders', {
    productId,
    rawMaterialId: peCrudoId,
    quantityPackages: 1000,  // 1000 kg objetivo (Pellet PE)
    priority: 'normal',
    recipeId,
    notes: 'Orden simulada Recicladora (6e)',
  })
  if (res.status !== 201) fail(`POST /api/production/orders falló (${res.status})`, res.body)
  ok(`Creada orden (id=${res.body.id}, número=${res.body.order_number || res.body.orderNumber || '?'})`)
  return res.body
}

// ─── 8. Liberar orden ──────────────────────────────────────────────────────

async function releaseOrder(client, orderId) {
  log('\n[8] Liberando orden a "active"…')
  const res = await client.post(`/api/production/orders/${orderId}/release`)
  if (res.status === 200) { ok('Orden activada'); return }
  if (res.status === 409 || res.status === 400) {
    skip(`Orden no necesita release (${res.status}): ${JSON.stringify(res.body).slice(0,100)}`)
    return
  }
  recordGap('ORDER_RELEASE', `POST /api/production/orders/:id/release devolvió ${res.status}: ${JSON.stringify(res.body)}`)
}

// ─── 9. Turno ──────────────────────────────────────────────────────────────

async function ensureShift(client, tenantId, userId) {
  log('\n[9] Creando turno…')
  const active = await client.get('/api/production/shifts/active')
  if (active.status === 200 && active.body && active.body.id) {
    skip(`turno activo ya existe (id=${active.body.id}, status=${active.body.status})`)
    return { ...active.body, _wasExisting: true }
  }
  // Si hay un turno cerrado/reviewed de hoy, lo reusamos para el snapshot
  const today = new Date().toISOString().slice(0, 10)
  const closed = await withBypass(() => query(
    `SELECT id, shift_number, shift_date, status FROM production_shifts
     WHERE tenant_id = $1 AND shift_date::date = $2::date
       AND status IN ('closed','reviewed','pending_handover')
     ORDER BY shift_number DESC LIMIT 1`,
    [tenantId, today]
  ))
  if (closed.rows.length > 0) {
    skip(`turno previo de hoy ya está cerrado (id=${closed.rows[0].id}, status=${closed.rows[0].status}) — lo reuso para snapshot`)
    return { ...closed.rows[0], _wasExisting: true }
  }
  // Buscar un shift_number libre (shift_number es VARCHAR)
  const used = await withBypass(() => query(
    `SELECT shift_number FROM production_shifts
     WHERE tenant_id = $1 AND shift_date::date = $2::date`,
    [tenantId, today]
  ))
  const taken = new Set(used.rows.map(r => parseInt(r.shift_number, 10)))
  let n = 1
  while (taken.has(n)) n++
  const res = await client.post('/api/production/shifts', {
    shiftNumber: n,
    shiftDate: today,
    operatorId: userId,
    supervisorId: userId,
  })
  if (res.status !== 201) fail(`POST /api/production/shifts falló (${res.status})`, res.body)
  ok(`Turno creado (id=${res.body.id}, número=${n})`)
  return res.body
}

// ─── 10. Carga MP ──────────────────────────────────────────────────────────

async function loadMp(client, shiftId, peCrudoId, kg, kgUnitId) {
  log(`\n[10] Cargando ${kg} kg de PE crudo…`)
  const res = await client.post(`/api/production/shifts/${shiftId}/mp-loads`, {
    rawMaterialId: peCrudoId,
    kg,
    unitId: kgUnitId,
    quantity: kg,
    notes: 'Carga simulada (6e)',
  })
  if (res.status !== 201) {
    recordGap('LOAD_MP', `POST mp-loads falló (${res.status}): ${JSON.stringify(res.body)}`)
    return null
  }
  ok(`MP cargada (id=${res.body.id})`)
  return res.body
}

// ─── 11. Capturar paquetes (3 calidades) ───────────────────────────────────

async function capturePackages(client, shiftId, orderId) {
  log('\n[11] Capturando 3 paquetes con calidades distintas (SaaS v2 path)…')

  // §6f: ahora pasamos gradeNumber explícito por cada calidad
  const packs = [
    { label: 'Primera (600 kg)', realWeightKg: 600, gradeNumber: 1 },
    { label: 'Segunda (200 kg)', realWeightKg: 200, gradeNumber: 2 },
    { label: 'Tercera (100 kg)', realWeightKg: 100, gradeNumber: 3 },
  ]
  const captured = []
  for (const p of packs) {
    const res = await client.post(`/api/production/shifts/${shiftId}/packages`, {
      productionOrderId: orderId,
      realWeightKg: p.realWeightKg,
      quantityUnits: 1,
      gradeNumber: p.gradeNumber,
      notes: `Captura simulada: ${p.label}`,
    })
    if (res.status !== 201) {
      recordGap('CAPTURE_PACKAGE', `POST packages '${p.label}' falló (${res.status}): ${JSON.stringify(res.body).slice(0,200)}`)
      continue
    }
    ok(`Capturado: ${p.label} (id=${res.body.id}, quality_grade_id=${res.body.quality_grade_id?.slice(0,8) || 'NULL'})`)
    captured.push(res.body)
  }
  return captured
}

// ─── 12. Scrap vendible ────────────────────────────────────────────────────

async function recordScrap(client, shiftId) {
  log('\n[12] Registrando 50 kg de scrap…')

  // Intento 1: usar el code SaaS v2 → confirma el gap del enum legacy
  const v2Attempt = await client.post(`/api/production/shifts/${shiftId}/scrap`, {
    scrapType: 'finos_polvo',
    destination: 'sell',
    kg: 50,
    notes: 'Polvo vendible (scrap recovery 10%)',
  })
  if (v2Attempt.status === 201) {
    ok(`Scrap registrado con code SaaS v2 (id=${v2Attempt.body.id})`)
  } else {
    recordGap('SCRAP_ENUM_LEGACY',
      `POST /shifts/:id/scrap requiere enum hardcoded scrap_type (arranque/operacion/contaminada/desecho). Code SaaS v2 'finos_polvo' rechazado (${v2Attempt.status}). recordScrap NO usa el catálogo tenant_scrap_types.`)
    // Fallback: usar el enum legacy para que el flujo termine
    log('    → fallback: scrapType="desecho" (enum legacy)')
    const fb = await client.post(`/api/production/shifts/${shiftId}/scrap`, {
      scrapType: 'desecho',
      destination: 'venta',
      kg: 50,
      notes: 'Polvo vendible — code "desecho" usado como fallback',
    })
    if (fb.status !== 201) {
      recordGap('RECORD_SCRAP_FALLBACK', `Incluso el fallback con 'desecho' falló (${fb.status}): ${JSON.stringify(fb.body)}`)
      return null
    }
    ok(`Scrap registrado (id=${fb.body.id}) con fallback`)
    v2Attempt.body = fb.body
  }
  const res = v2Attempt
  if (!res.body || !res.body.id) return null
  ok(`Scrap registrado (id=${res.body.id})`)
  // Verificar persistencia de scrap_type_id (debería ser NULL — el service no lo popula desde el code "finos_polvo")
  const row = await withBypass(() => query(
    `SELECT id, scrap_type, scrap_type_id, recovery_value_pct, is_abnormal FROM shift_scrap WHERE id = $1`,
    [res.body.id]
  ))
  log('    → DB row:', row.rows[0])
  if (row.rows[0].scrap_type_id == null) {
    recordGap('SCRAP_TYPE_FK_NOT_POPULATED',
      'recordScrap recibe el code string pero NO resuelve a scrap_type_id. shift_scrap.scrap_type_id queda NULL.')
  }
  if (row.rows[0].recovery_value_pct == null) {
    recordGap('SCRAP_RECOVERY_NOT_POPULATED',
      'recordScrap no popula shift_scrap.recovery_value_pct desde el catálogo tenant_scrap_types.default_recovery_value_pct.')
  }
  if (row.rows[0].is_abnormal !== false && row.rows[0].is_abnormal !== true) {
    // si quedó en default false, ok; pero deberíamos chequear que se evalúe contra expected_scrap_pct.
  }
  return res.body
}

// ─── 13. Close + validate ──────────────────────────────────────────────────

async function closeAndValidate(client, shiftId) {
  log('\n[13] Cerrando turno…')
  const close = await client.post(`/api/production/shifts/${shiftId}/close`)
  if (close.status !== 200) {
    recordGap('CLOSE_SHIFT', `POST close falló (${close.status}): ${JSON.stringify(close.body).slice(0,300)}`)
    return null
  }
  ok(`Turno cerrado (status post-close: ${close.body.status || '?'})`)

  log('\n[14] Validando turno (supervisor)…')
  const val = await client.post(`/api/production/shifts/${shiftId}/validate`, { approved: true, supervisorNotes: 'Aceptado (simulación)' })
  if (val.status !== 200) {
    recordGap('VALIDATE_SHIFT', `POST validate falló (${val.status}): ${JSON.stringify(val.body).slice(0,300)}`)
    return null
  }
  ok(`Turno validado (status post-validate: ${val.body.status || '?'})`)
  return val.body
}

// ─── 14. Snapshot final ────────────────────────────────────────────────────

async function snapshot(tenantId, shiftId) {
  log('\n[15] Snapshot final…')
  const sp = await withBypass(() => query(
    `SELECT id, real_weight_kg, quantity_units, is_second_quality, quality_grade_id
     FROM shift_progress WHERE shift_id = $1 ORDER BY captured_at`, [shiftId]
  ))
  log(`  shift_progress (${sp.rows.length}):`)
  sp.rows.forEach(r => log(`    - ${r.real_weight_kg} kg / ${r.quantity_units}u, is_sq=${r.is_second_quality}, grade_id=${r.quality_grade_id || 'NULL'}`))

  const ss = await withBypass(() => query(
    `SELECT id, kg, scrap_type, scrap_type_id, destination, recovery_value_pct, is_abnormal
     FROM shift_scrap WHERE shift_id = $1`, [shiftId]
  ))
  log(`  shift_scrap (${ss.rows.length}):`)
  ss.rows.forEach(r => log(`    - ${r.kg} kg ${r.scrap_type} → ${r.destination}, st_id=${r.scrap_type_id || 'NULL'}, rec_pct=${r.recovery_value_pct || 'NULL'}, abnormal=${r.is_abnormal}`))

  const mp = await withBypass(() => query(
    `SELECT id, raw_material_id, kg, quantity, unit_id, lot_id
     FROM shift_mp_loads WHERE shift_id = $1`, [shiftId]
  ))
  log(`  shift_mp_loads (${mp.rows.length}):`)
  mp.rows.forEach(r => log(`    - ${r.kg} kg, qty=${r.quantity}, unit=${r.unit_id}, lot=${r.lot_id || 'NULL'}`))

  const inv = await withBypass(() => query(
    `SELECT warehouse_id, COUNT(*) AS movs, SUM(quantity) AS qty
     FROM inventory_movements
     WHERE tenant_id = $1
       AND reference_type IN ('production_shift','shift_progress','shift_scrap','shift_mp_loads')
     GROUP BY warehouse_id`, [tenantId]
  ))
  log(`  inventory_movements (por warehouse):`)
  inv.rows.forEach(r => log(`    - wh=${r.warehouse_id}: ${r.movs} movs, neto=${r.qty} kg`))
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main() {
  try {
    const { tenant, token, userId } = await loginAndContext()
    const client = clientFor(token)

    // Pre-traer IDs base
    const units  = await client.get('/api/process-config/units').expect(200)
    const kgUnitId = units.body.find(u => u.code === 'kg').id
    const grades = await client.get('/api/process-config/quality-grades').expect(200)
    const primeraGradeId = grades.body.find(g => g.code === 'primera').id
    const kinds  = await client.get('/api/process-config/product-kinds').expect(200)
    const pelletKindId = kinds.body.find(k => k.code === 'pellet').id

    const warehouses = await ensureWarehouses(client)
    const peCrudo    = await ensureRawMaterial(client)
    const product    = await ensureProduct(client, tenant.id, primeraGradeId, pelletKindId)
    const recipe     = await ensureRecipe(client, product.id, peCrudo.id, kgUnitId)

    const mpWarehouseId = (warehouses['Almacén PE Crudo'] || {}).id
    if (mpWarehouseId) {
      await ensureRawMaterialStock(tenant.id, peCrudo.id, mpWarehouseId, userId)
    } else {
      recordGap('NO_MP_WAREHOUSE', 'No se pudo crear "Almacén PE Crudo"; salto el seed de stock.')
    }

    const order = await ensureOrder(client, product.id, recipe.id, peCrudo.id)
    await releaseOrder(client, order.id)

    const shift = await ensureShift(client, tenant.id, userId)
    if (!shift._wasExisting) {
      await loadMp(client, shift.id, peCrudo.id, 1200, kgUnitId)
      await capturePackages(client, shift.id, order.id)
      await recordScrap(client, shift.id)
      await closeAndValidate(client, shift.id)
    } else {
      log('  (saltando carga/captura/scrap/close — reusando turno existente)')
    }

    await snapshot(tenant.id, shift.id)

    log('\n' + '─'.repeat(70))
    log(`GAPS DETECTADOS: ${GAPS.length}`)
    log('─'.repeat(70))
    GAPS.forEach((g, i) => log(`  ${i+1}. [${g.id}] ${g.summary}`))
    log('─'.repeat(70))
    log('')
  } catch (err) {
    console.error('\nError no manejado:', err.stack || err)
    process.exit(1)
  } finally {
    await pool.end()
  }
}

main()
