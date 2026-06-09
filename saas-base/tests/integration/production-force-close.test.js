'use strict'

/**
 * Mig 200 — Cierre forzado / finalización de turnos atorados por admin.
 *
 * Reproduce el problema reportado (2026-06-09): un turno se cierra ("Finalizar
 * mi turno" → /close → pending_handover) pero NO se valida, así que sigue
 * apareciendo como "activo" en el tablero (getActiveShifts incluye
 * pending_handover) y bloquea al siguiente operador ("El turno no está activo").
 *
 * Verifica que POST /shifts/:id/force-close:
 *   1. Finaliza un turno YA cerrado (pending_handover) → status 'reviewed', sale
 *      del tablero, finalized=true.
 *   2. Finaliza un turno ACTIVO sin relevo → lo cierra y lo finaliza en un paso.
 *
 * El gating (production:update O production:force_close) es middleware estándar
 * (checkAnyPermission); aquí probamos el COMPORTAMIENTO con el owner.
 */

const { createTenant, loginAs, authedClient, cleanupTestTenants } = require('../helpers/factory')
const {
  createRawMaterial, createProduct, createOrder, releaseOrder, openShift, loadMp,
} = require('../helpers/productionFactory')
const { pool, query, withBypass } = require('../../src/db')

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

async function statusOf(shiftId) {
  const { rows } = await withBypass(() => query(
    `SELECT status FROM production_shifts WHERE id = $1`, [shiftId]
  ))
  return rows[0]?.status
}

describe('mig 200 — force-close finaliza turnos atorados', () => {
  let client, tenantId, sess, rm, product

  beforeAll(async () => {
    const info = await createTenant({ label: uniq('forceclose'), planSlug: 'owner' })
    sess = await loginAs({ slug: info.tenant.slug, email: info.email, password: info.password })
    client = authedClient({ slug: info.tenant.slug, token: sess.token })
    tenantId = info.tenant.id

    await ensureWarehouses(tenantId)

    rm = await createRawMaterial(client, { name: uniq('PE'), costPerKg: 10 })
    product = await createProduct(client, { sku: uniq('PROD'), name: 'Esquinero forceclose' })
    await client.post(`/api/products/${product.id}/quality-specs`, {
      gramsPerLinearMeter: 50, tolerancePct: 5, unitsPerPackage: 10, notes: 'test',
    }).expect(201)

    const { rows: whRows } = await withBypass(() => query(
      `SELECT id FROM warehouses WHERE tenant_id=$1 AND type='raw_material' LIMIT 1`, [tenantId]
    ))
    await withBypass(() => query(
      `INSERT INTO inventory_stock (tenant_id, warehouse_id, item_type, item_id, quantity, avg_cost, status)
       VALUES ($1, $2, 'raw_material', $3, 100000, 10, 'available')
       ON CONFLICT (tenant_id, warehouse_id, item_type, item_id, status)
       DO UPDATE SET quantity = EXCLUDED.quantity`,
      [tenantId, whRows[0].id, rm.id]
    ))
  })

  async function seedCapturedShift({ shiftNumber }) {
    const order = await createOrder(client, { productId: product.id, rawMaterialId: rm.id, quantityPackages: 50 })
    await releaseOrder(client, order.id)
    const shift = await openShift(client, {
      lineId: 1, shiftNumber, operatorId: sess.user.id, supervisorId: sess.user.id,
    })
    await loadMp(client, shift.id, { rawMaterialId: rm.id, kg: 100 })
    await client.post(`/api/production/shifts/${shift.id}/packages`, {
      productionOrderId: order.id, quantityUnits: 100, realWeightKg: 100,
    }).expect(201)
    return shift
  }

  test('force-close de un turno YA cerrado (pending_handover) lo finaliza y libera la línea', async () => {
    const shift = await seedCapturedShift({ shiftNumber: '1' })

    // El operador "finaliza su turno" → pending_handover (queda atorado en el tablero).
    await client.post(`/api/production/shifts/${shift.id}/close`).expect(200)
    expect(await statusOf(shift.id)).toBe('pending_handover')

    // Antes del force-close: el turno cerrado SIGUE en el tablero de activos.
    const before = await client.get('/api/production/shifts/active').expect(200)
    expect(before.body.some(s => s.id === shift.id)).toBe(true)

    // Admin/supervisor fuerza el cierre → finaliza (valida).
    const res = await client.post(`/api/production/shifts/${shift.id}/force-close`, {
      reason: 'Turno atorado: operador olvidó dejarlo validar',
    }).expect(200)

    expect(res.body.finalized).toBe(true)
    expect(res.body.activated_shift_id).toBeNull()

    // El turno quedó finalizado y FUERA del tablero de activos.
    expect(await statusOf(shift.id)).toBe('reviewed')
    const after = await client.get('/api/production/shifts/active').expect(200)
    expect(after.body.some(s => s.id === shift.id)).toBe(false)
  })

  test('force-close de un turno ACTIVO sin relevo lo cierra y finaliza en un paso', async () => {
    const shift = await seedCapturedShift({ shiftNumber: '2' })
    expect(await statusOf(shift.id)).toBe('active')

    const res = await client.post(`/api/production/shifts/${shift.id}/force-close`, {
      reason: 'Operador abandonó la línea',
    }).expect(200)

    expect(res.body.finalized).toBe(true)
    expect(await statusOf(shift.id)).toBe('reviewed')

    // El cierre forzado quedó registrado (quién y por qué) para auditoría.
    const { rows } = await withBypass(() => query(
      `SELECT force_closed_by, force_close_reason, force_closed_at
         FROM production_shifts WHERE id = $1`, [shift.id]
    ))
    expect(rows[0].force_closed_by).toBe(sess.user.id)
    expect(rows[0].force_close_reason).toMatch(/abandonó/)
    expect(rows[0].force_closed_at).toBeTruthy()
  })
})
