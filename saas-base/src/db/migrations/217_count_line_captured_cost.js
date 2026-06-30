'use strict'

/**
 * Mig 217 — costo unitario capturable en líneas de conteo SIN costo de sistema.
 *
 * Para artículos que nunca tuvieron compra/producción con costo (system_avg_cost
 * = 0), el ajuste de cierre se valuaba en $0 → el inventario quedaba con la
 * cantidad correcta pero valor cero (subvalúa activos). Esta columna permite
 * capturar el costo de adquisición/reposición SOLO en esas líneas (candado en
 * captureLine: prohibido sobre artículos que ya tienen costo promedio válido),
 * y se usa como costo del movimiento de ajuste al aplicar el conteo.
 *
 * NULL = usar system_avg_cost (comportamiento previo, sin cambios).
 */

const up = `
  ALTER TABLE inventory_count_lines
    ADD COLUMN captured_unit_cost DECIMAL(14,6);

  COMMENT ON COLUMN inventory_count_lines.captured_unit_cost
    IS 'Costo unitario capturado a mano SOLO para artículos sin costo de sistema (system_avg_cost=0); valúa el ajuste de cierre. NULL = usar system_avg_cost.';
`

const down = `
  ALTER TABLE inventory_count_lines DROP COLUMN IF EXISTS captured_unit_cost;
`

module.exports = { up, down }
