'use strict'

/**
 * Vincula líneas de factura con líneas de pedido para soportar
 * "facturación anticipada con entregas parciales".
 *
 * Caso: cliente pide 100 ton, se le factura todo, se le entrega en
 * remisiones parciales. Necesitamos saber qué línea de pedido se facturó
 * para calcular saldo (facturado - entregado).
 *
 * Sin esta columna:
 *   - invoice_lines.delivery_note_line_id apunta a una remisión específica.
 *     Si la factura se generó SIN remisión (createDirect), queda NULL.
 *   - No hay forma de saber a qué pedido pertenece la línea de factura.
 *
 * Con esta columna:
 *   - createDirect setea sales_order_line_id en cada invoice_line.
 *   - Una vista calcula por (sales_order_line):
 *       SUM(invoice_lines.quantity) AS facturado
 *       SUM(delivery_note_lines.quantity_delivered) AS entregado
 *       facturado - entregado = pendiente_entrega
 */

const up = `
  ALTER TABLE invoice_lines
    ADD COLUMN sales_order_line_id UUID
    REFERENCES sales_order_lines(id) ON DELETE SET NULL;

  CREATE INDEX idx_il_sales_order_line ON invoice_lines (sales_order_line_id)
    WHERE sales_order_line_id IS NOT NULL;

  COMMENT ON COLUMN invoice_lines.sales_order_line_id IS
    'Línea de pedido facturada. Usado para calcular saldo pendiente de entrega cuando hay facturación anticipada.';
`

const down = `
  DROP INDEX IF EXISTS idx_il_sales_order_line;
  ALTER TABLE invoice_lines DROP COLUMN IF EXISTS sales_order_line_id;
`

module.exports = { up, down }
