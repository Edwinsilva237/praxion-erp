'use strict'

/**
 * Agrega el valor 'partially_delivered' al enum sales_order_status.
 *
 * Motivación: el flujo de pedido → remisión → entrega tenía solo tres
 * estados post-confirmación: 'in_delivery', 'delivered' o 'cancelled'. Eso
 * dejaba al pedido en 'in_delivery' tanto cuando se acababa de emitir la
 * primera remisión como cuando ya había una entrega parcial registrada,
 * sin forma de distinguirlos. Con este cambio:
 *
 *   - 'in_delivery'          → al menos una remisión emitida, ninguna entrega registrada
 *                              (la etiqueta visual pasa a "Remisionado")
 *   - 'partially_delivered'  → al menos una remisión completamente entregada,
 *                              pero todavía hay saldo del pedido sin remisionar/entregar
 *   - 'delivered'            → todas las líneas del pedido están entregadas al 100%
 *
 * En PostgreSQL 12+, ALTER TYPE ... ADD VALUE puede correr dentro de
 * transacción siempre que el valor no se use en la misma transacción
 * (acá solo se inserta en schema_migrations, así que es seguro).
 */

const up = `
  ALTER TYPE sales_order_status ADD VALUE IF NOT EXISTS 'partially_delivered';
`

// No-op: PostgreSQL no permite quitar valores de un enum sin recrearlo.
// Si necesitas revertir, hazlo a mano (rename type + recreate).
const down = `
  SELECT 1;
`

module.exports = { up, down }
