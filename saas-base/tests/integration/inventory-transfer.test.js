'use strict'

/**
 * Traspaso entre almacenes (2026-08-01).
 *
 * Mueve stock 'available' de un almacén a otro con un par de movimientos
 * ligados (transfer_out + transfer_in, mismo reference_id) al costo promedio
 * del origen. Con lotIds mueve lotes COMPLETOS y reubica el lote
 * (warehouse_id) para que FEFO/trazabilidad lo encuentren en el destino.
 */

const { pool, query, withBypass } = require('../../src/db')
const inventoryService = require('../../src/modules/inventory/inventoryService')
const { createTenant, cleanupTestTenants } = require('../helpers/factory')

let tenantId, userId, rmId, whA, whB, whWip

beforeAll(async () => {
  const t = await createTenant({ label: 'traspaso', planSlug: 'owner' })
  tenantId = t.tenant.id
  userId   = t.user.id
  const { rows: rm } = await withBypass(() => query(
    `INSERT INTO raw_materials (tenant_id, name) VALUES ($1,'Resina Traspaso') RETURNING id`,
    [tenantId]
  ))
  rmId = rm[0].id
  const { rows: wh } = await withBypass(() => query(
    `SELECT id, type FROM warehouses WHERE tenant_id = $1 ORDER BY created_at`, [tenantId]
  ))
  whA = wh[0].id
  whWip = wh.find(w => w.type === 'wip')?.id || null
  const { rows: wh2 } = await withBypass(() => query(
    `INSERT INTO warehouses (tenant_id, name, type)
     SELECT tenant_id, 'Almacén Destino', type FROM warehouses WHERE id = $1
     RETURNING id`, [whA]
  ))
  whB = wh2[0].id

  // Saldo inicial: 100 kg a $10 en el almacén A (vía ajuste formal).
  await inventoryService.createAdjustmentDocument({
    tenantId, warehouseId: whA, reason: 'inventario_inicial',
    notes: 'seed para pruebas de traspaso', userId,
    lines: [{ itemType: 'raw_material', itemId: rmId, direction: 'in',
              quantity: 100, unitCost: 10, unit: 'kg', notes: 'seed' }],
  })
})

afterAll(async () => { await cleanupTestTenants(); await pool.end() })

async function getStockQty(warehouseId) {
  const { rows } = await withBypass(() => query(
    `SELECT quantity::numeric AS q, avg_cost::numeric AS c FROM inventory_stock
      WHERE tenant_id=$1 AND item_type='raw_material' AND item_id=$2
        AND warehouse_id=$3 AND status='available'`,
    [tenantId, rmId, warehouseId]
  ))
  return rows[0] ? { qty: parseFloat(rows[0].q), cost: parseFloat(rows[0].c) } : { qty: 0, cost: 0 }
}

test('traspasa cantidad suelta: saldo se mueve, costo viaja intacto, kardex ligado', async () => {
  const res = await inventoryService.transferStock({
    tenantId, itemType: 'raw_material', itemId: rmId,
    fromWarehouseId: whA, toWarehouseId: whB,
    quantity: 40, note: 'se recibió en el almacén equivocado', userId,
  })
  expect(res.quantity).toBe(40)
  expect(res.unitCost).toBe(10)

  const a = await getStockQty(whA)
  const b = await getStockQty(whB)
  expect(a.qty).toBe(60)
  expect(b.qty).toBe(40)
  expect(b.cost).toBe(10)

  // Kardex: par transfer_out/transfer_in con el MISMO reference_id.
  const { rows: movs } = await withBypass(() => query(
    `SELECT movement_type, warehouse_id, quantity::numeric AS q, reference_type, reference_id
       FROM inventory_movements
      WHERE tenant_id=$1 AND reference_type='warehouse_transfer' AND reference_id=$2
      ORDER BY movement_type`,
    [tenantId, res.transferId]
  ))
  expect(movs).toHaveLength(2)
  const out = movs.find(m => m.movement_type === 'transfer_out')
  const inn = movs.find(m => m.movement_type === 'transfer_in')
  expect(out.warehouse_id).toBe(whA)
  expect(parseFloat(out.q)).toBe(-40)
  expect(inn.warehouse_id).toBe(whB)
  expect(parseFloat(inn.q)).toBe(40)
})

test('no deja traspasar más de lo disponible → 400', async () => {
  await expect(inventoryService.transferStock({
    tenantId, itemType: 'raw_material', itemId: rmId,
    fromWarehouseId: whA, toWarehouseId: whB,
    quantity: 9999, note: 'demasiado', userId,
  })).rejects.toMatchObject({ status: 400 })
})

test('validaciones: mismo almacén, sin motivo, almacén WIP', async () => {
  await expect(inventoryService.transferStock({
    tenantId, itemType: 'raw_material', itemId: rmId,
    fromWarehouseId: whA, toWarehouseId: whA,
    quantity: 1, note: 'x', userId,
  })).rejects.toMatchObject({ status: 400 })

  await expect(inventoryService.transferStock({
    tenantId, itemType: 'raw_material', itemId: rmId,
    fromWarehouseId: whA, toWarehouseId: whB,
    quantity: 1, note: '   ', userId,
  })).rejects.toMatchObject({ status: 400 })

  if (whWip) {
    await expect(inventoryService.transferStock({
      tenantId, itemType: 'raw_material', itemId: rmId,
      fromWarehouseId: whA, toWarehouseId: whWip,
      quantity: 1, note: 'a wip', userId,
    })).rejects.toMatchObject({ status: 409 })
  }
})

test('traspaso POR LOTES: mueve el lote completo y lo reubica al destino', async () => {
  // Lote de 25 kg ligado al saldo del almacén A.
  const { rows: lot } = await withBypass(() => query(
    `INSERT INTO raw_material_lots
       (tenant_id, raw_material_id, lot_number, received_at, warehouse_id,
        quantity_received, quantity_remaining, unit_cost, total_cost)
     VALUES ($1,$2,'LOTE-TRASP-1',NOW(),$3, 25, 25, 10, 250)
     RETURNING id`,
    [tenantId, rmId, whA]
  ))
  const lotId = lot[0].id

  // El endpoint de lotes elegibles lo lista en el origen.
  const lots = await inventoryService.listTransferableLots({
    tenantId, itemType: 'raw_material', itemId: rmId, warehouseId: whA,
  })
  expect(lots.map(l => l.id)).toContain(lotId)

  const before = await getStockQty(whA)
  const res = await inventoryService.transferStock({
    tenantId, itemType: 'raw_material', itemId: rmId,
    fromWarehouseId: whA, toWarehouseId: whB,
    lotIds: [lotId], note: 'reacomodo del lote', userId,
  })
  expect(res.quantity).toBe(25)
  expect(res.lotsMoved).toBe(1)

  // El lote quedó REUBICADO en el destino (FEFO lo encontrará allá).
  const { rows: moved } = await withBypass(() => query(
    `SELECT warehouse_id FROM raw_material_lots WHERE id = $1`, [lotId]
  ))
  expect(moved[0].warehouse_id).toBe(whB)

  const after = await getStockQty(whA)
  expect(after.qty).toBe(before.qty - 25)

  // Un lote ya movido no se puede volver a mover desde el origen → 409.
  await expect(inventoryService.transferStock({
    tenantId, itemType: 'raw_material', itemId: rmId,
    fromWarehouseId: whA, toWarehouseId: whB,
    lotIds: [lotId], note: 'doble movimiento', userId,
  })).rejects.toMatchObject({ status: 409 })
})
