'use strict'

/**
 * Cerrar MANUALMENTE un pedido parcialmente entregado (espejo del "Dar por
 * completa" de compras, mig 239).
 *
 * Caso real: el cliente recibe una parte del pedido y decide NO llevarse el
 * resto → el pedido quedaría en 'partially_delivered' ("vivo" en la ventana
 * de pendientes) para siempre. `closeOrder` lo pasa a 'closed' sin tocar
 * inventario ni las remisiones/facturas/CxC ya generadas.
 *
 * Cubre: (1) cierre feliz desde partially_delivered con bitácora; (2) el
 * recálculo automático de status NO revive un pedido cerrado; (3) no se puede
 * cerrar un pedido que no está en entrega parcial.
 */

const { pool, query, withBypass } = require('../../src/db')
const orderService = require('../../src/modules/sales/orderService')
const { createTenant, cleanupTestTenants } = require('../helpers/factory')

let tenantId, userId, partnerId
let seq = 0
const uniq = () => `${Date.now()}-${++seq}`

beforeAll(async () => {
  const t = await createTenant({ label: 'soclose', planSlug: 'owner' })
  tenantId = t.tenant.id
  userId   = t.user.id
  const { rows: bp } = await withBypass(() => query(
    `INSERT INTO business_partners (tenant_id, type, name) VALUES ($1,'customer','Cliente Parcial') RETURNING id`,
    [tenantId]
  ))
  partnerId = bp[0].id
})

afterAll(async () => { await cleanupTestTenants(); await pool.end() })

/** Inserta un pedido directo en el status dado (el flujo remisión→entrega
 *  parcial ya está cubierto por delivery-note-partial-rejection.test.js). */
async function makeOrder(status) {
  const { rows } = await withBypass(() => query(
    `INSERT INTO sales_orders (tenant_id, order_number, partner_id, status, subtotal_mxn, total_mxn)
     VALUES ($1, $2, $3, $4, 1000, 1160) RETURNING id, order_number`,
    [tenantId, `PED-${uniq()}`, partnerId, status]
  ))
  return rows[0]
}

test('cierra un pedido en entrega parcial → closed, con motivo en bitácora', async () => {
  const order = await makeOrder('partially_delivered')
  const res = await orderService.closeOrder({
    tenantId, orderId: order.id, reason: 'El cliente ya no quiso el resto', userId,
  })
  expect(res.status).toBe('closed')

  const full = await orderService.getOrder({ tenantId, orderId: order.id })
  expect(full.status).toBe('closed')

  const { rows } = await withBypass(() => query(
    `SELECT from_status, to_status, notes FROM document_status_log
      WHERE tenant_id=$1 AND entity_type='sales_order' AND entity_id=$2 AND to_status='closed'`,
    [tenantId, order.id]
  ))
  expect(rows).toHaveLength(1)
  expect(rows[0].from_status).toBe('partially_delivered')
  expect(rows[0].notes).toBe('El cliente ya no quiso el resto')
})

test('el recálculo automático de status NO revive un pedido cerrado', async () => {
  const order = await makeOrder('partially_delivered')
  await orderService.closeOrder({ tenantId, orderId: order.id, userId })

  // Simula el recálculo que dispara cualquier cambio en remisiones (cancelar
  // o entregar una rezagada): debe respetar el cierre manual.
  const after = await orderService.recalcOrderStatus({ tenantId, orderId: order.id })
  expect(after).toBe('closed')

  const full = await orderService.getOrder({ tenantId, orderId: order.id })
  expect(full.status).toBe('closed')
})

test('no se puede cerrar un pedido que no está en entrega parcial (404)', async () => {
  const order = await makeOrder('confirmed')
  await expect(
    orderService.closeOrder({ tenantId, orderId: order.id, userId })
  ).rejects.toMatchObject({ status: 404 })
})
