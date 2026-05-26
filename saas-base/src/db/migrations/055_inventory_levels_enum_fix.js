'use strict'

/**
 * Fix: en la migración 053 creé `inventory_levels.item_type` como VARCHAR(20),
 * pero el resto del esquema usa el enum `inventory_item_type`.
 *
 * Eso provoca el error:
 *   "el operador no existe: inventory_item_type = character varying"
 * al hacer JOINs entre inventory_levels y inventory_stock / inventory_movements.
 *
 * Esta migración:
 *   1. Quita el CHECK constraint que validaba los valores como string.
 *   2. Cambia el tipo de la columna a `inventory_item_type` (el enum existente).
 *
 * No requiere recrear los datos: el cast string→enum es válido siempre que
 * los valores ya guardados estén en {'raw_material', 'product'}.
 */
const up = `
  ALTER TABLE inventory_levels
    DROP CONSTRAINT IF EXISTS inventory_levels_item_type_check;

  ALTER TABLE inventory_levels
    ALTER COLUMN item_type TYPE inventory_item_type
    USING item_type::inventory_item_type;
`

const down = `
  ALTER TABLE inventory_levels
    ALTER COLUMN item_type TYPE VARCHAR(20)
    USING item_type::text;

  ALTER TABLE inventory_levels
    ADD CONSTRAINT inventory_levels_item_type_check
      CHECK (item_type IN ('raw_material','product'));
`

module.exports = { up, down }
