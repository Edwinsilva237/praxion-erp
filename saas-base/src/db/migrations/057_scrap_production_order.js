'use strict'

/**
 * Modelo D — Merma como activo en almacén REGRIND.
 *
 * Para distribuir correctamente la merma capturada entre los materiales de la
 * mezcla y registrarla como entrada al almacén regrind, necesitamos saber a
 * qué orden de producción pertenece. La columna se agrega como NULL porque:
 *
 *   - Las mermas históricas previas a Modelo D no tienen orden asociada.
 *   - Permite seguir capturando merma "genérica" (no vinculada a una orden)
 *     si por alguna razón no hay orden activa al momento.
 *
 * Cuando productionOrderId está presente, el sistema:
 *   1. Inserta el registro en shift_scrap con la orden vinculada.
 *   2. Genera entrada al almacén REGRIND distribuida según la fórmula MP de
 *      la orden, con costo = avg_cost × (1 + reprocessFactor).
 *   3. Al validar el turno, descuenta MP virgen también por la merma capturada.
 */
const up = `
  ALTER TABLE shift_scrap
    ADD COLUMN IF NOT EXISTS production_order_id UUID
      REFERENCES production_orders(id) ON DELETE SET NULL;

  CREATE INDEX IF NOT EXISTS idx_ss_production_order_id
    ON shift_scrap (production_order_id);

  COMMENT ON COLUMN shift_scrap.production_order_id IS
    'Orden a la que pertenecía la captura. Permite distribuir la merma según la fórmula MP de la orden y generar entrada al almacén regrind. NULL para mermas genéricas o históricas.';
`

const down = `
  DROP INDEX IF EXISTS idx_ss_production_order_id;
  ALTER TABLE shift_scrap DROP COLUMN IF EXISTS production_order_id;
`

module.exports = { up, down }
