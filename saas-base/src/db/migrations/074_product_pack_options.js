'use strict'

/**
 * Presentaciones de venta por producto.
 *
 * Caso: las etiquetas se inventarían por millar pero algunos clientes piden
 * factura por rollo (donde 1 rollo = N millares). Antes la unidad era una
 * etiqueta libre por línea sin multiplicador real. Ahora:
 *
 *   - products.base_unit  → unidad atómica del inventario (ej. 'millar')
 *   - product_pack_options → presentaciones N:1 por producto. Cada una
 *                            tiene su `base_per_pack` (multiplicador a base)
 *                            y `sat_unit_code` para el CFDI.
 *
 * Las líneas (pedido/remisión/factura) reciben:
 *   - pack_option_id      → presentación elegida
 *   - pack_factor         → snapshot del base_per_pack al capturar
 *   - quantity_base       → quantity * pack_factor (lo que mueve inventario)
 *
 * Backfill: cada producto existente recibe una pack_option default con
 * pack_unit = su sale_unit y base_per_pack = 1. Las líneas históricas
 * quedan con pack_factor = 1 y quantity_base = quantity.
 */

const up = `
  -- 1) products.base_unit
  ALTER TABLE products
    ADD COLUMN IF NOT EXISTS base_unit VARCHAR(50) NOT NULL DEFAULT 'pieza';

  COMMENT ON COLUMN products.base_unit IS 'Unidad atómica del inventario (millar, pieza, kg). Independiente de la unidad de venta.';

  -- Heredar base_unit desde sale_unit en productos existentes
  UPDATE products
     SET base_unit = COALESCE(sale_unit, 'pieza')
   WHERE base_unit = 'pieza';

  -- 2) Tabla product_pack_options
  CREATE TABLE product_pack_options (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id       UUID          NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    product_id      UUID          NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    pack_unit       VARCHAR(50)   NOT NULL,
    base_per_pack   DECIMAL(14,4) NOT NULL DEFAULT 1,
    sat_unit_code   VARCHAR(5)    NOT NULL DEFAULT 'H87',
    is_default      BOOLEAN       NOT NULL DEFAULT false,
    notes           TEXT,
    created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

    CONSTRAINT pko_unique_per_product UNIQUE (tenant_id, product_id, pack_unit),
    CONSTRAINT pko_positive CHECK (base_per_pack > 0)
  );

  CREATE INDEX idx_pko_product ON product_pack_options (tenant_id, product_id);

  -- Solo una presentación default por producto
  CREATE UNIQUE INDEX pko_one_default
    ON product_pack_options (tenant_id, product_id)
    WHERE is_default = true;

  COMMENT ON COLUMN product_pack_options.base_per_pack
    IS 'Cuántas unidades base contiene una presentación. Ej: 1 rollo = 5 (millares).';
  COMMENT ON COLUMN product_pack_options.sat_unit_code
    IS 'Clave SAT (c_ClaveUnidad) que se manda en el CFDI para esta presentación.';

  CREATE TRIGGER set_updated_at_product_pack_options
    BEFORE UPDATE ON product_pack_options
    FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

  -- 3) Backfill: una presentación default por cada producto existente
  INSERT INTO product_pack_options
    (tenant_id, product_id, pack_unit, base_per_pack, sat_unit_code, is_default)
  SELECT
    p.tenant_id, p.id,
    COALESCE(p.sale_unit, 'pieza'),
    1,
    COALESCE(p.sat_unit_code, 'H87'),
    true
  FROM products p
  ON CONFLICT (tenant_id, product_id, pack_unit) DO NOTHING;

  -- 4) Columnas en las 3 tablas de líneas
  ALTER TABLE sales_order_lines
    ADD COLUMN IF NOT EXISTS pack_option_id UUID REFERENCES product_pack_options(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS pack_factor    DECIMAL(14,4) NOT NULL DEFAULT 1,
    ADD COLUMN IF NOT EXISTS quantity_base  DECIMAL(14,4);

  ALTER TABLE delivery_note_lines
    ADD COLUMN IF NOT EXISTS pack_option_id UUID REFERENCES product_pack_options(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS pack_factor    DECIMAL(14,4) NOT NULL DEFAULT 1,
    ADD COLUMN IF NOT EXISTS quantity_base  DECIMAL(14,4);

  ALTER TABLE invoice_lines
    ADD COLUMN IF NOT EXISTS pack_option_id UUID REFERENCES product_pack_options(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS pack_factor    DECIMAL(14,4) NOT NULL DEFAULT 1,
    ADD COLUMN IF NOT EXISTS quantity_base  DECIMAL(14,4);

  -- 5) Backfill quantity_base en líneas existentes
  UPDATE sales_order_lines   SET quantity_base = quantity            WHERE quantity_base IS NULL;
  UPDATE delivery_note_lines SET quantity_base = quantity_delivered  WHERE quantity_base IS NULL;
  UPDATE invoice_lines       SET quantity_base = quantity            WHERE quantity_base IS NULL;

  COMMENT ON COLUMN sales_order_lines.quantity_base
    IS 'quantity * pack_factor en unidad base del producto. Sirve para inventario y reportes uniformes.';
`

const down = `
  ALTER TABLE invoice_lines
    DROP COLUMN IF EXISTS pack_option_id,
    DROP COLUMN IF EXISTS pack_factor,
    DROP COLUMN IF EXISTS quantity_base;

  ALTER TABLE delivery_note_lines
    DROP COLUMN IF EXISTS pack_option_id,
    DROP COLUMN IF EXISTS pack_factor,
    DROP COLUMN IF EXISTS quantity_base;

  ALTER TABLE sales_order_lines
    DROP COLUMN IF EXISTS pack_option_id,
    DROP COLUMN IF EXISTS pack_factor,
    DROP COLUMN IF EXISTS quantity_base;

  DROP TABLE IF EXISTS product_pack_options CASCADE;

  ALTER TABLE products DROP COLUMN IF EXISTS base_unit;
`

module.exports = { up, down }
