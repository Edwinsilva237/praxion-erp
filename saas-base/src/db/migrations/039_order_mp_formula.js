'use strict'

const up = `
  -- 1. Tabla de fórmula de mezcla por orden (hasta 4 materias primas)
  CREATE TABLE IF NOT EXISTS order_mp_formula (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    production_order_id UUID          NOT NULL REFERENCES production_orders(id) ON DELETE CASCADE,
    raw_material_id     UUID          NOT NULL REFERENCES raw_materials(id),
    percentage          DECIMAL(5,2)  NOT NULL,
    sort_order          INTEGER       NOT NULL DEFAULT 0,

    CONSTRAINT ompf_pct_positive CHECK (percentage > 0 AND percentage <= 100),
    CONSTRAINT ompf_unique_mp    UNIQUE (production_order_id, raw_material_id)
  );

  CREATE INDEX idx_ompf_order ON order_mp_formula (production_order_id);

  COMMENT ON TABLE order_mp_formula IS
    'Fórmula de mezcla de MP para una orden. Los porcentajes deben sumar 100%.
     Máximo 4 materias primas por orden.';

  -- 2. Hacer raw_material_id opcional en production_orders
  --    (ya no es el único material, la mezcla vive en order_mp_formula)
  ALTER TABLE production_orders
    ALTER COLUMN raw_material_id DROP NOT NULL;

  -- 3. Agregar campo de costo promedio calculado de la mezcla
  ALTER TABLE production_orders
    ADD COLUMN IF NOT EXISTS blended_cost_per_kg DECIMAL(12,6),
    ADD COLUMN IF NOT EXISTS cancelled_at        TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS cancelled_by        UUID REFERENCES users(id);

  COMMENT ON COLUMN production_orders.blended_cost_per_kg IS
    'Costo promedio ponderado de la mezcla: Σ(porcentaje × cost_per_kg) / 100';

  -- 4. Agregar raw_material_id en shift_mp_loads para saber qué MP se cargó realmente
  --    (ya existe, solo verificamos que esté)
  -- shift_mp_loads ya tiene raw_material_id — OK
`

const down = `
  DROP TABLE IF EXISTS order_mp_formula CASCADE;
  ALTER TABLE production_orders
    DROP COLUMN IF EXISTS blended_cost_per_kg,
    DROP COLUMN IF EXISTS cancelled_at,
    DROP COLUMN IF EXISTS cancelled_by;
`

module.exports = { up, down }
