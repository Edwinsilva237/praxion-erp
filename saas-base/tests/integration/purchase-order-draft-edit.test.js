'use strict'

/**
 * Edición completa de una OC en borrador (botón "Editar" del panel de OC).
 *
 * updateOrder con `lines` = modo completo: actualiza proveedor / IVA / notas y
 * REEMPLAZA todas las líneas recalculando totales. Sin `lines` conserva el
 * comportamiento parcial legacy (COALESCE de fecha/notas/proveedor genérico).
 * Solo aplica a OC en 'draft' — confirmada, el endpoint responde 404.
 */

const { pool, query, withBypass } = require('../../src/db')
const purchaseOrderService = require('../../src/modules/purchases/purchaseOrderService')
const { createTenant, cleanupTestTenants } = require('../helpers/factory')

let tenantId, userId, supplierId, supplier2Id, rmId, rm2Id, warehouseId

// pg devuelve DATE como Date a medianoche local — comparar con getters locales.
function ymd(d) {
  const x = new Date(d)
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`
}

async function makeSupplier(name) {
  const { rows } = await withBypass(() => query(
    `INSERT INTO business_partners (tenant_id, type, name) VALUES ($1,'supplier',$2) RETURNING id`,
    [tenantId, name]
  ))
  return rows[0].id
}
async function makeRawMaterial(name) {
  const { rows } = await withBypass(() => query(
    `INSERT INTO raw_materials (tenant_id, name) VALUES ($1,$2) RETURNING id`,
    [tenantId, name]
  ))
  return rows[0].id
}

beforeAll(async () => {
  const t = await createTenant({ label: 'ocdraftedit', planSlug: 'owner' })
  tenantId = t.tenant.id
  userId   = t.user.id
  supplierId  = await makeSupplier('Proveedor Original')
  supplier2Id = await makeSupplier('Proveedor Nuevo')
  rmId  = await makeRawMaterial('Resina Original')
  rm2Id = await makeRawMaterial('Resina Sustituta')
  const { rows: wh } = await withBypass(() => query(
    `SELECT id FROM warehouses WHERE tenant_id = $1 ORDER BY created_at LIMIT 1`, [tenantId]
  ))
  warehouseId = wh[0].id
})

afterAll(async () => { await cleanupTestTenants(); await pool.end() })

test('edición completa: cambia proveedor, reemplaza líneas y recalcula totales', async () => {
  const oc = await purchaseOrderService.createOrder({
    tenantId, partnerId: supplierId, currency: 'MXN', userId, taxRate: 0.16,
    notes: 'nota original', expectedDate: '2026-08-10',
    lines: [{
      itemType: 'raw_material', itemId: rmId, quantity: 10, unit: 'kg',
      unitPrice: 25, warehouseId, supplierSku: 'ORIG-1',
    }],
  })

  await purchaseOrderService.updateOrder({
    tenantId, orderId: oc.id, userId,
    partnerId: supplier2Id,
    taxRate: 0,
    notes: null,             // limpiar la nota
    expectedDate: '2026-08-20',
    lines: [
      { itemType: 'raw_material', itemId: rm2Id, quantity: 4, unit: 'kg', unitPrice: 50, warehouseId },
      { itemType: 'raw_material', itemId: rmId,  quantity: 2, unit: 'kg', unitPrice: 30, warehouseId, notes: 'línea nueva' },
    ],
  })

  const full = await purchaseOrderService.getOrder({ tenantId, orderId: oc.id })
  expect(full.partner_id).toBe(supplier2Id)
  expect(full.notes).toBeNull()
  expect(ymd(full.expected_date)).toBe('2026-08-20')
  expect(full.lines).toHaveLength(2)
  expect(full.lines[0].item_id).toBe(rm2Id)
  expect(parseFloat(full.lines[0].line_number)).toBe(1)
  expect(full.lines[1].notes).toBe('línea nueva')
  // 4×50 + 2×30 = 260, sin IVA
  expect(parseFloat(full.subtotal_mxn)).toBeCloseTo(260, 2)
  expect(parseFloat(full.tax_mxn)).toBeCloseTo(0, 2)
  expect(parseFloat(full.total_mxn)).toBeCloseTo(260, 2)
  expect(full.status).toBe('draft')
})

test('edición parcial legacy (sin lines) conserva COALESCE y no toca líneas', async () => {
  const oc = await purchaseOrderService.createOrder({
    tenantId, partnerId: supplierId, currency: 'MXN', userId,
    notes: 'nota que se conserva',
    lines: [{ itemType: 'raw_material', itemId: rmId, quantity: 5, unit: 'kg', unitPrice: 20, warehouseId }],
  })

  await purchaseOrderService.updateOrder({
    tenantId, orderId: oc.id, userId, expectedDate: '2026-09-01',
  })

  const full = await purchaseOrderService.getOrder({ tenantId, orderId: oc.id })
  expect(ymd(full.expected_date)).toBe('2026-09-01')
  expect(full.notes).toBe('nota que se conserva')
  expect(full.lines).toHaveLength(1)
})

test('una OC confirmada YA NO se puede editar (404)', async () => {
  const oc = await purchaseOrderService.createOrder({
    tenantId, partnerId: supplierId, currency: 'MXN', userId,
    lines: [{ itemType: 'raw_material', itemId: rmId, quantity: 1, unit: 'kg', unitPrice: 10, warehouseId }],
  })
  await purchaseOrderService.confirmOrder({ tenantId, orderId: oc.id, userId })

  await expect(purchaseOrderService.updateOrder({
    tenantId, orderId: oc.id, userId,
    lines: [{ itemType: 'raw_material', itemId: rmId, quantity: 9, unit: 'kg', unitPrice: 10, warehouseId }],
  })).rejects.toThrow(/borrador/)
})

test('edición completa sin líneas es rechazada (400)', async () => {
  const oc = await purchaseOrderService.createOrder({
    tenantId, partnerId: supplierId, currency: 'MXN', userId,
    lines: [{ itemType: 'raw_material', itemId: rmId, quantity: 1, unit: 'kg', unitPrice: 10, warehouseId }],
  })
  await expect(purchaseOrderService.updateOrder({
    tenantId, orderId: oc.id, userId, lines: [],
  })).rejects.toThrow(/al menos una línea/)
})
