'use strict'

/**
 * Marca explícita de "el cliente recoge en bodega" para un pedido.
 *
 * Diferenciar:
 *   - driver_id NULL + pickup_in_warehouse FALSE → repartidor sin asignar todavía.
 *   - driver_id NULL + pickup_in_warehouse TRUE  → no requiere repartidor.
 *   - driver_id NOT NULL                          → repartidor asignado.
 *
 * Sin esta columna, un pedido "recoge en bodega" se confundía con uno al que
 * simplemente no se le ha asignado repartidor todavía.
 */

const up = `
  ALTER TABLE sales_orders
    ADD COLUMN pickup_in_warehouse BOOLEAN NOT NULL DEFAULT FALSE;

  COMMENT ON COLUMN sales_orders.pickup_in_warehouse IS
    'Si TRUE, el cliente recoge en bodega y no requiere repartidor asignado.';
`

const down = `
  ALTER TABLE sales_orders DROP COLUMN IF EXISTS pickup_in_warehouse;
`

module.exports = { up, down }
