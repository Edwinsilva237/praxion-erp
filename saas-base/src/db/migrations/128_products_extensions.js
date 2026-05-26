'use strict'

/**
 * SaaS v2 — Migration 128: extensión aditiva a products + trigger de sync
 * para default_recipe_id.
 *
 * Aditiva pura sobre products (igual que la 126 sobre raw_materials):
 *  - 8 columnas nuevas, todas NULL-able o con DEFAULT.
 *  - El productsService viejo sigue intacto; no se sobreescribe.
 *
 * Columnas (§2.3.2):
 *  - product_kind_id          FK tenant_product_kinds (NULL = no clasificado)
 *  - is_produced              BOOLEAN DEFAULT false (explícito, no derivado)
 *  - custom_attributes        JSONB objeto (valores según attribute_schema del kind)
 *  - default_recipe_id        FK recipes (SE MANTIENE SINCRONIZADA via trigger
 *                             con la única receta vigente del producto)
 *  - shelf_life_days          INTEGER override del default del kind
 *  - default_quality_grade_id FK tenant_quality_grades
 *  - expected_sale_price      NUMERIC(18,2) NRV para multi-calidad (§3.4)
 *  - lot_number_pattern       VARCHAR(80) override del patrón del tenant
 *
 * Trigger sync_products_default_recipe_id:
 *  - AFTER INSERT/UPDATE/DELETE ON recipes
 *  - Recalcula products.default_recipe_id como la receta del producto con
 *    valid_until IS NULL (o NULL si no hay).
 *  - Garantiza consistencia incluso si alguien hace SQL directo en recipes.
 *
 * Referencia: §2.3.2 + §2.2.9.
 */

const up = `
  ALTER TABLE products
    ADD COLUMN IF NOT EXISTS product_kind_id          UUID          NULL REFERENCES tenant_product_kinds(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS is_produced              BOOLEAN       NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS custom_attributes        JSONB         NULL,
    ADD COLUMN IF NOT EXISTS default_recipe_id        UUID          NULL REFERENCES recipes(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS shelf_life_days          INTEGER       NULL,
    ADD COLUMN IF NOT EXISTS default_quality_grade_id UUID          NULL REFERENCES tenant_quality_grades(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS expected_sale_price      NUMERIC(18,2) NULL,
    ADD COLUMN IF NOT EXISTS lot_number_pattern       VARCHAR(80)   NULL;

  ALTER TABLE products
    ADD CONSTRAINT products_custom_attributes_is_object
      CHECK (custom_attributes IS NULL OR jsonb_typeof(custom_attributes) = 'object'),
    ADD CONSTRAINT products_shelf_life_positive
      CHECK (shelf_life_days IS NULL OR shelf_life_days > 0),
    ADD CONSTRAINT products_expected_sale_price_nonneg
      CHECK (expected_sale_price IS NULL OR expected_sale_price >= 0);

  CREATE INDEX IF NOT EXISTS idx_products_product_kind_id  ON products (product_kind_id);
  CREATE INDEX IF NOT EXISTS idx_products_is_produced      ON products (tenant_id, is_produced);
  CREATE INDEX IF NOT EXISTS idx_products_default_recipe   ON products (default_recipe_id);

  COMMENT ON COLUMN products.product_kind_id IS
    'SaaS v2: FK a tenant_product_kinds. NULL = producto no clasificado (default para reventa).';
  COMMENT ON COLUMN products.is_produced IS
    'SaaS v2: TRUE si se fabrica via módulo producción. Columna explícita (no derivada) — el admin la setea según el negocio. Tener una receta vigente NO implica is_produced=true automáticamente.';
  COMMENT ON COLUMN products.default_recipe_id IS
    'SaaS v2: FK a recipes vigente del producto. Mantenida automáticamente por trigger sync_products_default_recipe_id_trg (NO setear manualmente).';
  COMMENT ON COLUMN products.lot_number_pattern IS
    'SaaS v2: override del patrón de tenant_process_config.lot_number_pattern. NULL = hereda del tenant.';

  -- ─── Trigger: mantener default_recipe_id sincronizado ─────────────────
  CREATE OR REPLACE FUNCTION sync_products_default_recipe_id()
  RETURNS TRIGGER
  LANGUAGE plpgsql
  AS $$
  DECLARE
    affected_product_id UUID;
    new_recipe_id       UUID;
  BEGIN
    -- En DELETE: usar OLD; en INSERT/UPDATE: usar NEW. En UPDATE con cambio
    -- de product_id (raro), debemos actualizar ambos productos.
    IF (TG_OP = 'DELETE') THEN
      affected_product_id := OLD.product_id;
    ELSE
      affected_product_id := NEW.product_id;

      -- Si UPDATE cambió product_id, actualizar también el viejo producto.
      IF (TG_OP = 'UPDATE' AND OLD.product_id IS DISTINCT FROM NEW.product_id) THEN
        SELECT id INTO new_recipe_id
        FROM recipes
        WHERE product_id = OLD.product_id AND valid_until IS NULL
        LIMIT 1;
        UPDATE products SET default_recipe_id = new_recipe_id WHERE id = OLD.product_id;
      END IF;
    END IF;

    -- Recalcular default_recipe_id del producto afectado.
    SELECT id INTO new_recipe_id
    FROM recipes
    WHERE product_id = affected_product_id AND valid_until IS NULL
    LIMIT 1;

    UPDATE products SET default_recipe_id = new_recipe_id WHERE id = affected_product_id;

    RETURN COALESCE(NEW, OLD);
  END;
  $$;

  CREATE TRIGGER sync_products_default_recipe_id_trg
    AFTER INSERT OR UPDATE OR DELETE ON recipes
    FOR EACH ROW
    EXECUTE FUNCTION sync_products_default_recipe_id();

  COMMENT ON FUNCTION sync_products_default_recipe_id IS
    'SaaS v2: mantiene products.default_recipe_id apuntando a la única receta con valid_until IS NULL del producto, o NULL si no hay.';

  -- Backfill inicial para productos que ya tengan recetas vigentes
  -- (en producción la tabla recipes está vacía, pero en sandbox de tests puede no).
  UPDATE products p
  SET default_recipe_id = (
    SELECT r.id FROM recipes r
    WHERE r.product_id = p.id AND r.valid_until IS NULL
    LIMIT 1
  );
`

const down = `
  DROP TRIGGER IF EXISTS sync_products_default_recipe_id_trg ON recipes;
  DROP FUNCTION IF EXISTS sync_products_default_recipe_id();

  DROP INDEX IF EXISTS idx_products_default_recipe;
  DROP INDEX IF EXISTS idx_products_is_produced;
  DROP INDEX IF EXISTS idx_products_product_kind_id;

  ALTER TABLE products
    DROP CONSTRAINT IF EXISTS products_expected_sale_price_nonneg,
    DROP CONSTRAINT IF EXISTS products_shelf_life_positive,
    DROP CONSTRAINT IF EXISTS products_custom_attributes_is_object;

  ALTER TABLE products
    DROP COLUMN IF EXISTS lot_number_pattern,
    DROP COLUMN IF EXISTS expected_sale_price,
    DROP COLUMN IF EXISTS default_quality_grade_id,
    DROP COLUMN IF EXISTS shelf_life_days,
    DROP COLUMN IF EXISTS default_recipe_id,
    DROP COLUMN IF EXISTS custom_attributes,
    DROP COLUMN IF EXISTS is_produced,
    DROP COLUMN IF EXISTS product_kind_id;
`

module.exports = { up, down }
