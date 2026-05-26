'use strict'

const up = `
  ALTER TABLE sales_order_lines
    ADD COLUMN IF NOT EXISTS length_mm DECIMAL(8,2);

  ALTER TABLE delivery_note_lines
    ADD COLUMN IF NOT EXISTS length_mm DECIMAL(8,2);

  COMMENT ON COLUMN sales_order_lines.length_mm   IS 'Longitud en mm — solo para esquineros. Permite reportes por metro lineal.';
  COMMENT ON COLUMN delivery_note_lines.length_mm IS 'Longitud en mm — solo para esquineros. Permite reportes por metro lineal.';
`

const down = `
  ALTER TABLE sales_order_lines   DROP COLUMN IF EXISTS length_mm;
  ALTER TABLE delivery_note_lines DROP COLUMN IF EXISTS length_mm;
`

module.exports = { up, down }
