'use strict'

/**
 * Agrega el valor 'invoiced' al enum sales_order_status.
 *
 * Motivación: el código de invoicing/invoiceService.createDirect hace
 *
 *   UPDATE sales_orders SET status = 'invoiced' WHERE id = ...
 *
 * cuando se genera una factura directa desde un pedido (sin remisión).
 * Como 'invoiced' nunca había sido agregado al enum, ese path fallaba
 * silenciosamente con "invalid input value for enum sales_order_status".
 *
 * Estados finales del pedido tras esta migración:
 *   - 'delivered': pedido entregado vía remisión (con o sin factura)
 *   - 'invoiced': pedido facturado directo, sin remisión (caso direct_invoice=true)
 *   - 'cancelled': pedido cancelado
 */

const up = `
  ALTER TYPE sales_order_status ADD VALUE IF NOT EXISTS 'invoiced';
`

const down = `
  SELECT 1;
`

module.exports = { up, down }
