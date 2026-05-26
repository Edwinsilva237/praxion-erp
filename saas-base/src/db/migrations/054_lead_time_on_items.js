'use strict'

/**
 * Lead time (tiempo de entrega esperado en días) a nivel ítem.
 *
 * Se usa para calcular el reorder_point sugerido:
 *   reorder_point = (consumo_diario_promedio × lead_time_days) + safety_stock
 *
 * Para esta iteración el lead_time va a nivel ítem. Cuando pulamos Compras,
 * se podrá refinar a nivel proveedor-material en supplier_materials.
 */
const up = `
  ALTER TABLE raw_materials
    ADD COLUMN lead_time_days INTEGER NOT NULL DEFAULT 7
      CHECK (lead_time_days >= 0 AND lead_time_days <= 365);

  ALTER TABLE products
    ADD COLUMN lead_time_days INTEGER NOT NULL DEFAULT 7
      CHECK (lead_time_days >= 0 AND lead_time_days <= 365);

  COMMENT ON COLUMN raw_materials.lead_time_days
    IS 'Tiempo de entrega esperado en días — usado para calcular reorder_point.';
  COMMENT ON COLUMN products.lead_time_days
    IS 'Tiempo de entrega esperado en días — usado para calcular reorder_point.';
`

const down = `
  ALTER TABLE raw_materials DROP COLUMN IF EXISTS lead_time_days;
  ALTER TABLE products      DROP COLUMN IF EXISTS lead_time_days;
`

module.exports = { up, down }
