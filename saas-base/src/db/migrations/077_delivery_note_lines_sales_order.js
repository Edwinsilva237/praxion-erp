'use strict'

/**
 * Permite que una remisión consolide líneas de varios pedidos del mismo cliente.
 *
 * `delivery_note_lines.sales_order_id` y `sales_order_line_id` guardan el
 * pedido / línea de pedido origen de cada línea de la remisión. Permite:
 *   - Recalcular `sales_orders.status` por cada pedido distinto cubierto
 *     por una sola remisión (no solo el `delivery_notes.sales_order_id`
 *     "principal").
 *   - Reportar trazabilidad línea → pedido en el detalle de la remisión.
 *
 * `delivery_notes.sales_order_id` se mantiene apuntando al PRIMER pedido
 * de una remisión consolidada (por compat con los `LEFT JOIN sales_orders`
 * existentes en getDeliveryNote/listDeliveryNotes).
 *
 * Backfill: para remisiones single-pedido históricas se copia
 * `delivery_notes.sales_order_id` a todas sus líneas. `sales_order_line_id`
 * queda NULL en históricas (no hay forma confiable de mapear retroactivamente).
 */

const up = `
  ALTER TABLE delivery_note_lines
    ADD COLUMN IF NOT EXISTS sales_order_id      UUID REFERENCES sales_orders(id)      ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS sales_order_line_id UUID REFERENCES sales_order_lines(id) ON DELETE SET NULL;

  UPDATE delivery_note_lines dnl
     SET sales_order_id = dn.sales_order_id
    FROM delivery_notes dn
   WHERE dnl.delivery_note_id = dn.id
     AND dn.sales_order_id IS NOT NULL
     AND dnl.sales_order_id IS NULL;

  CREATE INDEX IF NOT EXISTS idx_dnl_sales_order_id      ON delivery_note_lines (sales_order_id);
  CREATE INDEX IF NOT EXISTS idx_dnl_sales_order_line_id ON delivery_note_lines (sales_order_line_id);

  COMMENT ON COLUMN delivery_note_lines.sales_order_id      IS 'Pedido origen de esta línea (puede diferir del delivery_notes.sales_order_id cuando la remisión es consolidada).';
  COMMENT ON COLUMN delivery_note_lines.sales_order_line_id IS 'Línea exacta del pedido origen. NULL en remisiones históricas previas a la migración 077.';
`

const down = `
  ALTER TABLE delivery_note_lines
    DROP COLUMN IF EXISTS sales_order_line_id,
    DROP COLUMN IF EXISTS sales_order_id;
`

module.exports = { up, down }
