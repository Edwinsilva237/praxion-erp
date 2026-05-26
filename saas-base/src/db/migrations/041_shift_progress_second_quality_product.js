'use strict'

const up = `
  ALTER TABLE shift_progress
    ADD COLUMN IF NOT EXISTS second_quality_product_id UUID REFERENCES products(id) ON DELETE SET NULL;

  COMMENT ON COLUMN shift_progress.second_quality_product_id IS
    'Producto de segunda calidad al que se asigna este paquete. Solo aplica cuando is_second_quality=true.';

  CREATE INDEX IF NOT EXISTS idx_sp_second_quality_product
    ON shift_progress (second_quality_product_id)
    WHERE second_quality_product_id IS NOT NULL;
`

const down = `
  DROP INDEX IF EXISTS idx_sp_second_quality_product;
  ALTER TABLE shift_progress DROP COLUMN IF EXISTS second_quality_product_id;
`

module.exports = { up, down }
