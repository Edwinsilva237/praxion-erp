'use strict'

const up = `
  ALTER TABLE purchase_orders
    ADD COLUMN IF NOT EXISTS order_type VARCHAR(30) DEFAULT 'raw_material';

  -- Poblar el order_type de OC existentes basado en el item_type de sus líneas
  UPDATE purchase_orders po
  SET order_type = CASE
    WHEN EXISTS (
      SELECT 1 FROM purchase_order_lines pol
      WHERE pol.purchase_order_id = po.id AND pol.item_type = 'product'
    ) THEN 'product'
    ELSE 'raw_material'
  END
  WHERE order_type IS NULL OR order_type = 'raw_material';
`

const down = `
  ALTER TABLE purchase_orders DROP COLUMN IF EXISTS order_type;
`

module.exports = { up, down }
