'use strict'

const up = `
  CREATE TYPE product_type AS ENUM ('corner_protector', 'resale');

  CREATE TABLE products (
    id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id        UUID          NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    sku              VARCHAR(50)   NOT NULL,
    name             VARCHAR(200)  NOT NULL,
    type             product_type  NOT NULL,
    resin_type       resin_type,
    length_mm        DECIMAL(8,2),
    width_mm         DECIMAL(8,2),
    thickness_mm     DECIMAL(8,2),
    units_per_package INTEGER      NOT NULL DEFAULT 50,
    sale_unit        VARCHAR(20)   NOT NULL DEFAULT 'paquete',
    description      TEXT,
    is_active        BOOLEAN       NOT NULL DEFAULT true,
    created_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

    CONSTRAINT products_sku_tenant_unique UNIQUE (tenant_id, sku),
    CONSTRAINT products_resin_required CHECK (
      (type = 'corner_protector' AND resin_type IS NOT NULL) OR
      (type = 'resale')
    ),
    CONSTRAINT products_dimensions_required CHECK (
      (type = 'corner_protector' AND length_mm IS NOT NULL AND width_mm IS NOT NULL AND thickness_mm IS NOT NULL) OR
      (type = 'resale')
    )
  );

  CREATE INDEX idx_products_tenant_id  ON products (tenant_id);
  CREATE INDEX idx_products_type       ON products (tenant_id, type);
  CREATE INDEX idx_products_resin_type ON products (tenant_id, resin_type);

  COMMENT ON COLUMN products.length_mm   IS 'Largo del esquinero en mm — solo para corner_protector';
  COMMENT ON COLUMN products.width_mm    IS 'Ancho del ala en mm';
  COMMENT ON COLUMN products.thickness_mm IS 'Grueso en mm';
  COMMENT ON COLUMN products.sale_unit   IS 'Unidad de venta: paquete (default), pieza, caja';

  CREATE TRIGGER set_updated_at_products
    BEFORE UPDATE ON products
    FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

  -- Fichas de calidad por producto con historial
  CREATE TABLE product_quality_specs (
    id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    product_id            UUID         NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    grams_per_linear_meter DECIMAL(8,2) NOT NULL DEFAULT 180.00,
    tolerance_pct         DECIMAL(5,2) NOT NULL DEFAULT 5.00,
    units_per_package     INTEGER      NOT NULL DEFAULT 50,
    valid_from            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    valid_until           TIMESTAMPTZ,
    notes                 TEXT,
    created_by            UUID         REFERENCES users(id) ON DELETE SET NULL,
    created_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

    CONSTRAINT pqs_tolerance_range CHECK (tolerance_pct BETWEEN 0 AND 50),
    CONSTRAINT pqs_grams_positive  CHECK (grams_per_linear_meter > 0)
  );

  CREATE INDEX idx_pqs_product_id  ON product_quality_specs (product_id);
  CREATE INDEX idx_pqs_valid_from  ON product_quality_specs (product_id, valid_from DESC);

  COMMENT ON TABLE  product_quality_specs IS 'Historial de especificaciones de calidad por producto — nunca se eliminan';
  COMMENT ON COLUMN product_quality_specs.valid_until IS 'NULL = spec vigente actualmente';

  -- Vista para obtener siempre la spec vigente de cada producto
  CREATE OR REPLACE VIEW current_quality_specs AS
    SELECT DISTINCT ON (product_id)
      id, product_id, grams_per_linear_meter, tolerance_pct, units_per_package,
      valid_from, valid_until, notes
    FROM product_quality_specs
    WHERE valid_from <= NOW()
      AND (valid_until IS NULL OR valid_until > NOW())
    ORDER BY product_id, valid_from DESC;

  COMMENT ON VIEW current_quality_specs IS 'Spec de calidad vigente por producto — usar esta view en validaciones de producción';
`

const down = `
  DROP VIEW  IF EXISTS current_quality_specs   CASCADE;
  DROP TRIGGER IF EXISTS set_updated_at_products ON products;
  DROP TABLE IF EXISTS product_quality_specs CASCADE;
  DROP TABLE IF EXISTS products              CASCADE;
  DROP TYPE  IF EXISTS product_type          CASCADE;
`

module.exports = { up, down }
