'use strict'

/**
 * Re-cálculo de `sales_orders.status` basado en remisiones consolidadas.
 *
 * Migración de corrección de datos. Después de la 077, `delivery_note_lines`
 * sabe a qué pedido pertenece cada línea (vía `sales_order_id`). Hay pedidos
 * que quedaron "atascados" en `in_delivery` o `partially_delivered` porque la
 * lógica anterior buscaba remisiones por `delivery_notes.sales_order_id`,
 * que en consolidadas apunta solo al pedido principal.
 *
 * Esta migración es idempotente: actualiza el status al valor correcto según
 * las líneas remisionadas y el saldo pendiente real.
 *
 * Reglas:
 *   - delivered:           todas las líneas cubiertas + ≥1 remisión 'delivered'.
 *   - partially_delivered: ≥1 remisión 'delivered' pero quedan líneas sin cubrir.
 *   - in_delivery:         ≥1 remisión activa (no cancelada), ninguna 'delivered'.
 *   - confirmed:           sin remisiones activas (queda como estaba si ya era 'confirmed').
 */

const up = `
  WITH coverage AS (
    SELECT
      sol.sales_order_id,
      bool_and(
        sol.quantity <= COALESCE((
          SELECT SUM(dnl.quantity_delivered)
            FROM delivery_note_lines dnl
            JOIN delivery_notes      dn ON dn.id = dnl.delivery_note_id
           WHERE dnl.sales_order_id = sol.sales_order_id
             AND dn.status <> 'cancelled'
             AND (dnl.sales_order_line_id = sol.id
                  OR (dnl.sales_order_line_id IS NULL
                      AND dnl.product_id = sol.product_id))
        ), 0)
      ) AS fully_covered
    FROM sales_order_lines sol
    GROUP BY sol.sales_order_id
  ),
  flags AS (
    SELECT so.id AS order_id,
           so.tenant_id,
           so.status AS current_status,
           COALESCE(c.fully_covered, false) AS fully_covered,
           EXISTS(
             SELECT 1
               FROM delivery_notes dn
               JOIN delivery_note_lines dnl ON dnl.delivery_note_id = dn.id
              WHERE dnl.sales_order_id = so.id AND dn.tenant_id = so.tenant_id
                AND dn.status = 'delivered'
           ) AS has_delivered,
           EXISTS(
             SELECT 1
               FROM delivery_notes dn
               JOIN delivery_note_lines dnl ON dnl.delivery_note_id = dn.id
              WHERE dnl.sales_order_id = so.id AND dn.tenant_id = so.tenant_id
                AND dn.status <> 'cancelled'
           ) AS has_active
      FROM sales_orders so
      LEFT JOIN coverage c ON c.sales_order_id = so.id
     WHERE so.status IN ('confirmed', 'in_delivery', 'partially_delivered', 'delivered')
  )
  UPDATE sales_orders so
     SET status = (CASE
       WHEN f.fully_covered AND f.has_delivered THEN 'delivered'
       WHEN f.has_delivered                     THEN 'partially_delivered'
       WHEN f.has_active                        THEN 'in_delivery'
       ELSE 'confirmed'
     END)::sales_order_status
    FROM flags f
   WHERE f.order_id = so.id
     AND (CASE
       WHEN f.fully_covered AND f.has_delivered THEN 'delivered'
       WHEN f.has_delivered                     THEN 'partially_delivered'
       WHEN f.has_active                        THEN 'in_delivery'
       ELSE 'confirmed'
     END)::sales_order_status <> so.status;
`

// No tiene down — es una corrección de datos. Re-aplicarla no hace daño.
const down = `SELECT 1;`

module.exports = { up, down }
