'use strict'

/**
 * Devoluciones a proveedor (Fase 1) — mig 196/197.
 *
 * Verifica: catálogo de motivos sembrado, crear borrador con costo de lote,
 * confirmar (sale inventario + baja el lote + movimiento purchase_return),
 * cancelar una confirmada (revierte inventario y lote), y guards.
 */

const { createTenant, loginAs, authedClient, cleanupTestTenants } = require('../helpers/factory')
const { createRawMaterial } = require('../helpers/productionFactory')
const { pool, query, withBypass } = require('../../src/db')

afterAll(async () => {
  await cleanupTestTenants()
  await pool.end()
})

describe('Devoluciones a proveedor (Fase 1)', () => {
  let client, tenantId, sess, rm, warehouseId, lotId, partnerId, returnId

  beforeAll(async () => {
    const info = await createTenant({ label: 'devprov', planSlug: 'owner' })
    sess = await loginAs({ slug: info.tenant.slug, email: info.email, password: info.password })
    client = authedClient({ slug: info.tenant.slug, token: sess.token })
    tenantId = info.tenant.id

    rm = await createRawMaterial(client, { name: 'PE Devolución', costPerKg: 20 })

    const sup = await client.post('/api/business-partners', {
      name: 'Proveedor Devoluciones', type: 'supplier', rfc: 'XAXX010101000',
      tax_name: 'PROV DEV', is_active: true,
    }).expect(201)
    partnerId = sup.body.id

    // Simula una recepción confirmada: almacén MP + stock + lote.
    warehouseId = await withBypass(async () => {
      const w = await query(
        `INSERT INTO warehouses (tenant_id, name, type, is_active)
         VALUES ($1, 'MP Devol', 'raw_material', true) RETURNING id`, [tenantId])
      const wid = w.rows[0].id
      await query(
        `INSERT INTO inventory_stock (tenant_id, warehouse_id, item_type, item_id, quantity, avg_cost, status)
         VALUES ($1, $2, 'raw_material', $3, 100, 20, 'available')`, [tenantId, wid, rm.id])
      return wid
    })
    lotId = await withBypass(async () => {
      const l = await query(
        `INSERT INTO raw_material_lots
           (tenant_id, raw_material_id, lot_number, warehouse_id,
            quantity_received, quantity_remaining, unit_cost, total_cost, status)
         VALUES ($1,$2,'LOTE-DEV-1',$3,100,100,20,2000,'active') RETURNING id`,
        [tenantId, rm.id, warehouseId])
      return l.rows[0].id
    })
  })

  test('Los motivos de devolución se siembran por plantilla', async () => {
    const res = await client.get('/api/purchases/return-reasons').expect(200)
    expect(res.body.length).toBeGreaterThanOrEqual(5)
    expect(res.body.map(r => r.code)).toContain('defectuoso')
    expect(res.body.map(r => r.code)).toContain('caducado')
  })

  test('Crear devolución (borrador) toma el costo del lote', async () => {
    const res = await client.post('/api/purchases/returns', {
      partnerId, notes: 'lote defectuoso',
      lines: [{ itemType: 'raw_material', itemId: rm.id, warehouseId, rawMaterialLotId: lotId, quantity: 30 }],
    }).expect(201)
    returnId = res.body.id
    expect(res.body.status).toBe('draft')
    expect(res.body.credit_status).toBe('pending')
    expect(res.body.fiscal_resolution).toBe('none')
    expect(parseFloat(res.body.total_mxn)).toBeCloseTo(600, 2)   // 30 × $20
    expect(parseFloat(res.body.lines[0].unit_cost)).toBeCloseTo(20, 4)
  })

  test('Confirmar: SALE el inventario y BAJA el lote, con movimiento purchase_return', async () => {
    await client.post(`/api/purchases/returns/${returnId}/confirm`).expect(200)

    const { rows: st } = await withBypass(() => query(
      `SELECT quantity FROM inventory_stock
        WHERE tenant_id=$1 AND warehouse_id=$2 AND item_id=$3 AND status='available'`,
      [tenantId, warehouseId, rm.id]))
    expect(parseFloat(st[0].quantity)).toBeCloseTo(70, 2)        // 100 − 30

    const { rows: lot } = await withBypass(() => query(
      `SELECT quantity_remaining FROM raw_material_lots WHERE id=$1`, [lotId]))
    expect(parseFloat(lot[0].quantity_remaining)).toBeCloseTo(70, 2)

    const { rows: mov } = await withBypass(() => query(
      `SELECT movement_type, quantity FROM inventory_movements
        WHERE reference_type='supplier_return' AND reference_id=$1`, [returnId]))
    const exit = mov.find(m => m.movement_type === 'purchase_return')
    expect(exit).toBeTruthy()
    expect(parseFloat(exit.quantity)).toBeCloseTo(-30, 2)
  })

  test('No se puede re-confirmar una devolución ya confirmada', async () => {
    const r = await client.post(`/api/purchases/returns/${returnId}/confirm`)
    expect(r.status).toBe(400)
  })

  test('Cancelar una devolución confirmada REVIERTE inventario y lote', async () => {
    await client.post(`/api/purchases/returns/${returnId}/cancel`).expect(200)

    const { rows: st } = await withBypass(() => query(
      `SELECT quantity FROM inventory_stock
        WHERE tenant_id=$1 AND warehouse_id=$2 AND item_id=$3 AND status='available'`,
      [tenantId, warehouseId, rm.id]))
    expect(parseFloat(st[0].quantity)).toBeCloseTo(100, 2)       // restaurado

    const { rows: lot } = await withBypass(() => query(
      `SELECT quantity_remaining, status FROM raw_material_lots WHERE id=$1`, [lotId]))
    expect(parseFloat(lot[0].quantity_remaining)).toBeCloseTo(100, 2)
    expect(lot[0].status).toBe('active')
  })

  test('Guard: no se puede crear una devolución por más de lo disponible en el lote', async () => {
    const res = await client.post('/api/purchases/returns', {
      partnerId,
      lines: [{ itemType: 'raw_material', itemId: rm.id, warehouseId, rawMaterialLotId: lotId, quantity: 999 }],
    })
    expect(res.status).toBe(400)
  })

  test('Crear y agregar un motivo de devolución al catálogo', async () => {
    const created = await client.post('/api/purchases/return-reasons', {
      name: 'Cadena de frío rota',
    }).expect(201)
    expect(created.body.code).toBe('cadena_de_frio_rota')
    const list = await client.get('/api/purchases/return-reasons').expect(200)
    expect(list.body.map(r => r.id)).toContain(created.body.id)
  })
})
