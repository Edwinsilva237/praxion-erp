'use strict'

/**
 * SaaS v2 §5h — Tests para expiración de lotes, validación de alérgenos y
 * sistema de alertas.
 *
 * Cubre:
 *  - expirationService.markExpiredLots: transiciones active→expired + alertas.
 *  - expirationService.getExpiringLots: lista lotes por vencer (con/sin dispatch).
 *  - alertService: dedupe, listado, acknowledge, resolve.
 *  - closeShift con validación de alérgenos según allergen_mode:
 *    - strict: bloquea closeShift por cualquier discrepancia.
 *    - priority_only: bloquea si alérgeno prioritario; alerta si no.
 *    - alert_only: nunca bloquea, siempre alerta.
 *  - Endpoints: GET /api/alerts, PATCH /:id/acknowledge, POST run-expiration-check.
 */

const { createTenant, loginAs, authedClient, cleanupTestTenants } = require('../helpers/factory')
const {
  createRawMaterial, createProduct, createOrder, releaseOrder,
  openShift, loadMp, capturePackage,
} = require('../helpers/productionFactory')
const { pool, query, withBypass } = require('../../src/db')
const { markExpiredLots, getExpiringLots } = require('../../src/modules/production/expirationService')
const { dispatchAlert, listAlerts, acknowledgeAlert, resolveAlert } =
  require('../../src/modules/alerts/alertService')

afterAll(async () => {
  await cleanupTestTenants()
  await pool.end()
})

let counter = 0
const uniq = (s) => `${s}${(Date.now() % 100000)}_${counter++}`

async function ensureWarehouses(tenantId) {
  return withBypass(async () => {
    for (const [name, type] of [
      ['Almacén MP', 'raw_material'],
      ['Almacén PT', 'finished_product'],
      ['Almacén WIP', 'wip'],
      ['Almacén Regrind', 'regrind'],
    ]) {
      await query(
        `INSERT INTO warehouses (tenant_id, name, type, is_active)
         SELECT $1, $2, $3, true
         WHERE NOT EXISTS (SELECT 1 FROM warehouses WHERE tenant_id = $1 AND type = $3)`,
        [tenantId, name, type]
      )
    }
  })
}

async function setupTenant({ label, usesLots = true, allergenMode = 'priority_only' }) {
  const info = await createTenant({ label, planSlug: 'owner' })
  const sess = await loginAs({ slug: info.tenant.slug, email: info.email, password: info.password })
  const client = authedClient({ slug: info.tenant.slug, token: sess.token })
  const tenantId = info.tenant.id

  await withBypass(() => query(
    `UPDATE tenant_process_config
     SET uses_lots = $2, allergen_mode = $3
     WHERE tenant_id = $1`,
    [tenantId, usesLots, allergenMode]
  ))

  await ensureWarehouses(tenantId)
  return { info, client, tenantId, sess }
}

async function insertLot(tenantId, rmId, warehouseId, extras = {}) {
  const cols = ['tenant_id', 'raw_material_id', 'lot_number', 'warehouse_id',
                'quantity_received', 'quantity_remaining']
  const vals = [tenantId, rmId, extras.lot_number || uniq('LOT'), warehouseId,
                extras.quantity_received ?? 100, extras.quantity_remaining ?? 100]
  const params = vals.map((_, i) => `$${i + 1}`)
  let i = vals.length + 1
  for (const [k, v] of Object.entries(extras)) {
    if (['lot_number', 'quantity_received', 'quantity_remaining'].includes(k)) continue
    cols.push(k); vals.push(v); params.push(`$${i++}`)
  }
  const { rows } = await withBypass(() => query(
    `INSERT INTO raw_material_lots (${cols.join(',')}) VALUES (${params.join(',')}) RETURNING *`, vals
  ))
  return rows[0]
}

// ═══════════════════════════════════════════════════════════════════════════
// markExpiredLots
// ═══════════════════════════════════════════════════════════════════════════

describe('expirationService.markExpiredLots', () => {
  let ctx, rm, wh
  beforeAll(async () => {
    ctx = await setupTenant({ label: 'expire' })
    rm = await createRawMaterial(ctx.client, { name: uniq('MP') })
    const { rows } = await withBypass(() => query(
      `SELECT id FROM warehouses WHERE tenant_id = $1 AND type='raw_material' LIMIT 1`,
      [ctx.tenantId]
    ))
    wh = rows[0].id
  })

  test('Marca lotes vencidos como expired y emite alertas', async () => {
    const oldLot = await insertLot(ctx.tenantId, rm.id, wh, {
      lot_number: 'OLD', expiry_date: '2020-01-01',
      manufacture_date: '2019-01-01',
    })
    const freshLot = await insertLot(ctx.tenantId, rm.id, wh, {
      lot_number: 'FRESH', expiry_date: '2099-12-31',
      manufacture_date: '2099-01-01',
    })

    const result = await markExpiredLots({ tenantId: ctx.tenantId })
    expect(result.rmLotsExpired).toBeGreaterThanOrEqual(1)
    expect(result.rmIds).toContain(oldLot.id)
    expect(result.rmIds).not.toContain(freshLot.id)

    const { rows: oldRow } = await withBypass(() => query(
      `SELECT status FROM raw_material_lots WHERE id = $1`, [oldLot.id]
    ))
    expect(oldRow[0].status).toBe('expired')

    // Alerta lot_expired creada
    const alerts = await listAlerts({ tenantId: ctx.tenantId, type: 'lot_expired' })
    expect(alerts.find(a => a.source_id === oldLot.id)).toBeTruthy()
  })

  test('Idempotente: corriendo de nuevo no crea alerta duplicada (dedupe)', async () => {
    const beforeCount = (await listAlerts({ tenantId: ctx.tenantId, type: 'lot_expired' })).length
    await markExpiredLots({ tenantId: ctx.tenantId })
    const afterCount = (await listAlerts({ tenantId: ctx.tenantId, type: 'lot_expired' })).length
    expect(afterCount).toBe(beforeCount)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// getExpiringLots
// ═══════════════════════════════════════════════════════════════════════════

describe('expirationService.getExpiringLots', () => {
  test('Devuelve lotes que vencen en N días', async () => {
    const ctx = await setupTenant({ label: 'expiring' })
    const rm = await createRawMaterial(ctx.client, { name: uniq('MP') })
    const { rows: whRows } = await withBypass(() => query(
      `SELECT id FROM warehouses WHERE tenant_id = $1 AND type='raw_material' LIMIT 1`,
      [ctx.tenantId]
    ))
    const wh = whRows[0].id

    // Lote vence en 10 días, otro en 100
    const soonExp = new Date(); soonExp.setDate(soonExp.getDate() + 10)
    const farExp = new Date(); farExp.setDate(farExp.getDate() + 100)

    await insertLot(ctx.tenantId, rm.id, wh, {
      lot_number: 'SOON', expiry_date: soonExp.toISOString().slice(0, 10),
      manufacture_date: '2026-01-01',
    })
    await insertLot(ctx.tenantId, rm.id, wh, {
      lot_number: 'FAR', expiry_date: farExp.toISOString().slice(0, 10),
      manufacture_date: '2026-01-01',
    })

    const r = await getExpiringLots({ tenantId: ctx.tenantId, daysAhead: 30 })
    const lotNumbers = r.rawMaterialLots.map(l => l.lot_number)
    expect(lotNumbers).toContain('SOON')
    expect(lotNumbers).not.toContain('FAR')
  })

  test('Con dispatch=true crea alertas lot_expiring', async () => {
    const ctx = await setupTenant({ label: 'expiring-dispatch' })
    const rm = await createRawMaterial(ctx.client, { name: uniq('MP') })
    const { rows: whRows } = await withBypass(() => query(
      `SELECT id FROM warehouses WHERE tenant_id = $1 AND type='raw_material' LIMIT 1`,
      [ctx.tenantId]
    ))
    const wh = whRows[0].id

    const soonExp = new Date(); soonExp.setDate(soonExp.getDate() + 5)
    await insertLot(ctx.tenantId, rm.id, wh, {
      lot_number: 'DISP', expiry_date: soonExp.toISOString().slice(0, 10),
      manufacture_date: '2026-01-01',
    })

    await getExpiringLots({ tenantId: ctx.tenantId, daysAhead: 30, dispatch: true })
    const alerts = await listAlerts({ tenantId: ctx.tenantId, type: 'lot_expiring' })
    expect(alerts.length).toBeGreaterThanOrEqual(1)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// alertService: dedupe + ack + resolve
// ═══════════════════════════════════════════════════════════════════════════

describe('alertService', () => {
  let ctx
  beforeAll(async () => { ctx = await setupTenant({ label: 'alerts', usesLots: false }) })

  test('dispatchAlert dedupe por (type, source_type, source_id)', async () => {
    const a1 = await dispatchAlert(null, {
      tenantId: ctx.tenantId, type: 'lot_expired', severity: 'critical',
      title: 'X', sourceType: 'raw_material_lot', sourceId: ctx.tenantId,
    })
    const a2 = await dispatchAlert(null, {
      tenantId: ctx.tenantId, type: 'lot_expired',
      title: 'X', sourceType: 'raw_material_lot', sourceId: ctx.tenantId,
    })
    expect(a2.deduped).toBe(true)
    expect(a2.id).toBe(a1.id)
  })

  test('acknowledgeAlert cambia status a acknowledged', async () => {
    const a = await dispatchAlert(null, {
      tenantId: ctx.tenantId, type: 'lot_expiring',
      title: 'Y', sourceType: 'raw_material_lot', sourceId: '00000000-0000-0000-0000-000000000001',
    })
    const acked = await acknowledgeAlert({
      tenantId: ctx.tenantId, alertId: a.id, userId: ctx.sess.user.id,
    })
    expect(acked.status).toBe('acknowledged')
    expect(acked.acknowledged_at).toBeTruthy()
  })

  test('resolveAlert cambia status a resolved', async () => {
    const a = await dispatchAlert(null, {
      tenantId: ctx.tenantId, type: 'allergen_discrepancy',
      title: 'Z', sourceType: 'product_lot', sourceId: '00000000-0000-0000-0000-000000000002',
    })
    const resolved = await resolveAlert({
      tenantId: ctx.tenantId, alertId: a.id, userId: ctx.sess.user.id,
    })
    expect(resolved.status).toBe('resolved')
  })

  test('GET /api/alerts respeta filtros', async () => {
    const res = await ctx.client.get('/api/alerts?status=pending&limit=10')
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body)).toBe(true)
    res.body.forEach(a => expect(a.status).toBe('pending'))
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// closeShift con validación de alérgenos
// ═══════════════════════════════════════════════════════════════════════════

async function setupShiftWithAllergens({ label, allergenMode, mpAllergens = [], ptAllergens = [] }) {
  const ctx = await setupTenant({ label, usesLots: true, allergenMode })
  const rm = await createRawMaterial(ctx.client, { name: uniq('MP') })
  const product = await createProduct(ctx.client, { sku: uniq('SKU'), name: 'P' })

  await ctx.client.post(`/api/products/${product.id}/quality-specs`, {
    gramsPerLinearMeter: 50, tolerancePct: 5, unitsPerPackage: 50,
  }).expect(201)

  const { rows: whRows } = await withBypass(() => query(
    `SELECT id FROM warehouses WHERE tenant_id = $1 AND type='raw_material' LIMIT 1`,
    [ctx.tenantId]
  ))
  const wh = whRows[0].id

  await withBypass(() => query(
    `INSERT INTO inventory_stock (tenant_id, warehouse_id, item_type, item_id, quantity, avg_cost, status)
     VALUES ($1, $2, 'raw_material', $3, 1000, 10, 'available')
     ON CONFLICT (tenant_id, warehouse_id, item_type, item_id, status)
     DO UPDATE SET quantity = EXCLUDED.quantity`,
    [ctx.tenantId, wh, rm.id]
  ))

  // Vincular alérgenos
  await withBypass(async () => {
    for (const code of mpAllergens) {
      const { rows: a } = await query(
        `SELECT id FROM tenant_allergens WHERE tenant_id = $1 AND code = $2`,
        [ctx.tenantId, code]
      )
      await query(
        `INSERT INTO raw_material_allergens (raw_material_id, allergen_id, declaration)
         VALUES ($1, $2, 'contains')`,
        [rm.id, a[0].id]
      )
    }
    for (const code of ptAllergens) {
      const { rows: a } = await query(
        `SELECT id FROM tenant_allergens WHERE tenant_id = $1 AND code = $2`,
        [ctx.tenantId, code]
      )
      await query(
        `INSERT INTO product_allergens (product_id, allergen_id, declaration)
         VALUES ($1, $2, 'contains')`,
        [product.id, a[0].id]
      )
    }
  })

  const order = await createOrder(ctx.client, { productId: product.id, rawMaterialId: rm.id, quantityPackages: 5 })
  await releaseOrder(ctx.client, order.id)
  const shift = await openShift(ctx.client, {
    lineId: 1, shiftNumber: '1',
    operatorId: ctx.sess.user.id, supervisorId: ctx.sess.user.id,
  })

  const rmLot = await insertLot(ctx.tenantId, rm.id, wh, { quantity_received: 100 })
  await loadMp(ctx.client, shift.id, { rawMaterialId: rm.id, kg: 20, lotId: rmLot.id })
  await capturePackage(ctx.client, shift.id, {
    productionOrderId: order.id, quantityUnits: 50,
    realWeightKg: 2.5, theoreticalWeightKg: 2.5, lengthMm: 1000,
  })

  return { ...ctx, rm, product, shift, order, wh, rmLot }
}

describe('closeShift validación de alérgenos', () => {
  test('strict bloquea cierre por cualquier discrepancia', async () => {
    const ctx = await setupShiftWithAllergens({
      label: 'allergen-strict',
      allergenMode: 'strict',
      mpAllergens: ['soy'],
      ptAllergens: [], // PT no declara soy → discrepancia
    })
    const res = await ctx.client.post(`/api/production/shifts/${ctx.shift.id}/close`)
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/strict|alérgen/i)

    // Shift sigue active (rollback)
    const { rows } = await withBypass(() => query(
      `SELECT status FROM production_shifts WHERE id = $1`, [ctx.shift.id]
    ))
    expect(rows[0].status).toBe('active')
  })

  test('priority_only bloquea si alérgeno prioritario (NOM-051) no declarado', async () => {
    const ctx = await setupShiftWithAllergens({
      label: 'allergen-prio-block',
      allergenMode: 'priority_only',
      mpAllergens: ['gluten'], // priority por seed
      ptAllergens: [],
    })
    const res = await ctx.client.post(`/api/production/shifts/${ctx.shift.id}/close`)
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/prioritario|gluten/i)
  })

  test('alert_only no bloquea, crea alerta', async () => {
    const ctx = await setupShiftWithAllergens({
      label: 'allergen-alert',
      allergenMode: 'alert_only',
      mpAllergens: ['gluten'],
      ptAllergens: [],
    })
    const res = await ctx.client.post(`/api/production/shifts/${ctx.shift.id}/close`)
    expect(res.status).toBe(200)

    const alerts = await listAlerts({ tenantId: ctx.tenantId, type: 'allergen_discrepancy' })
    expect(alerts.length).toBeGreaterThanOrEqual(1)
    expect(alerts[0].payload.missing.some(m => m.code === 'gluten')).toBe(true)
  })

  test('sin discrepancia (PT declara los mismos alérgenos que MP) no bloquea ni alerta', async () => {
    const ctx = await setupShiftWithAllergens({
      label: 'allergen-ok',
      allergenMode: 'strict',
      mpAllergens: ['soy'],
      ptAllergens: ['soy'], // declarado
    })
    const res = await ctx.client.post(`/api/production/shifts/${ctx.shift.id}/close`)
    expect(res.status).toBe(200)
    const alerts = await listAlerts({ tenantId: ctx.tenantId, type: 'allergen_discrepancy' })
    expect(alerts.length).toBe(0)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Endpoints lots
// ═══════════════════════════════════════════════════════════════════════════

describe('Endpoints /api/lots', () => {
  test('POST /api/lots/run-expiration-check ejecuta markExpiredLots', async () => {
    const ctx = await setupTenant({ label: 'endpoint-expire' })
    const rm = await createRawMaterial(ctx.client, { name: uniq('MP') })
    const { rows: whRows } = await withBypass(() => query(
      `SELECT id FROM warehouses WHERE tenant_id = $1 AND type='raw_material' LIMIT 1`,
      [ctx.tenantId]
    ))
    await insertLot(ctx.tenantId, rm.id, whRows[0].id, {
      lot_number: 'EXP', expiry_date: '2020-01-01', manufacture_date: '2019-01-01',
    })

    const res = await ctx.client.post('/api/lots/run-expiration-check')
    expect(res.status).toBe(200)
    expect(res.body.rmLotsExpired).toBeGreaterThanOrEqual(1)
  })

  test('GET /api/lots/expiring devuelve lotes por vencer', async () => {
    const ctx = await setupTenant({ label: 'endpoint-listing' })
    const rm = await createRawMaterial(ctx.client, { name: uniq('MP') })
    const { rows: whRows } = await withBypass(() => query(
      `SELECT id FROM warehouses WHERE tenant_id = $1 AND type='raw_material' LIMIT 1`,
      [ctx.tenantId]
    ))
    const soon = new Date(); soon.setDate(soon.getDate() + 7)
    await insertLot(ctx.tenantId, rm.id, whRows[0].id, {
      lot_number: 'SOON', expiry_date: soon.toISOString().slice(0, 10),
      manufacture_date: '2026-01-01',
    })

    const res = await ctx.client.get('/api/lots/expiring?days=30')
    expect(res.status).toBe(200)
    expect(res.body.rawMaterialLots.length).toBeGreaterThanOrEqual(1)
  })
})
