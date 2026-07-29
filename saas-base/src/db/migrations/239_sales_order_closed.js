'use strict'

/**
 * Agrega el valor 'closed' al enum sales_order_status.
 *
 * Motivación: un pedido parcialmente entregado ('partially_delivered') se queda
 * "vivo" para siempre si el cliente decide NO llevarse el resto — no hay forma
 * de concluirlo sin cancelarlo (lo que borraría el rastro de que SÍ hubo
 * entregas). 'closed' = cierre MANUAL con entrega parcial: ya no se entregará
 * más contra este pedido, pero lo entregado (remisiones, CxC, facturas) queda
 * intacto. Espejo del 'closed' de purchase_orders ("Dar por completa").
 *
 * Estados finales del pedido tras esta migración:
 *   - 'delivered': entregado al 100%
 *   - 'invoiced':  entregado y facturado (o factura directa)
 *   - 'closed':    cerrado manualmente con entrega parcial
 *   - 'cancelled': cancelado (sin entregas)
 */

const up = `
  ALTER TYPE sales_order_status ADD VALUE IF NOT EXISTS 'closed';
`

const down = `
  SELECT 1;
`

module.exports = { up, down }
