'use strict'

const up = `
  -- 1. Agregar stock mínimo para alertas de reabastecimiento
  ALTER TABLE products
    ADD COLUMN IF NOT EXISTS min_stock INTEGER NOT NULL DEFAULT 0;

  COMMENT ON COLUMN products.min_stock IS 'Stock mínimo para alerta de reabastecimiento. 0 = sin alerta.';

  -- 2. Relajar constraint de dimensiones en esquineros
  --    (las dimensiones se capturan en producción, no en el catálogo)
  ALTER TABLE products
    DROP CONSTRAINT IF EXISTS products_dimensions_required;

  ALTER TABLE products
    DROP CONSTRAINT IF EXISTS products_resin_required;

  -- Hacemos resin_type opcional para todos los tipos
  -- Las dimensiones y resina se manejan en el módulo de producción

  -- 3. Agregar length_mm a líneas de venta y remisión
  ALTER TABLE sales_order_lines
    ADD COLUMN IF NOT EXISTS length_mm DECIMAL(8,2);

  ALTER TABLE delivery_note_lines
    ADD COLUMN IF NOT EXISTS length_mm DECIMAL(8,2);

  COMMENT ON COLUMN sales_order_lines.length_mm   IS 'Longitud en mm — esquineros. Permite reportes por metro lineal.';
  COMMENT ON COLUMN delivery_note_lines.length_mm IS 'Longitud en mm — esquineros. Permite reportes por metro lineal.';
`

const down = `
  ALTER TABLE products DROP COLUMN IF EXISTS min_stock;

  ALTER TABLE sales_order_lines   DROP COLUMN IF EXISTS length_mm;
  ALTER TABLE delivery_note_lines DROP COLUMN IF EXISTS length_mm;

  -- Restaurar constraints (opcional — comentar si causa problemas con datos existentes)
  -- ALTER TABLE products ADD CONSTRAINT products_resin_required CHECK (
  --   (type = 'corner_protector' AND resin_type IS NOT NULL) OR (type = 'resale')
  -- );
`

module.exports = { up, down }
