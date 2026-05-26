'use strict'

/**
 * SaaS v2 — Migration 129: extensión aditiva a production_orders.
 *
 * Aditivo puro (mismo patrón que 126 raw_materials y 128 products):
 *  - Columnas nuevas NULL-able o con DEFAULT.
 *  - Las columnas viejas (raw_material_id, length_mm, mp_formula) se mantienen
 *    y se ignoran cuando recipe_id está set (decisión §2.3.4).
 *  - productionService viejo intacto.
 *
 * Columnas (§2.3.4):
 *  - recipe_id                              FK recipes
 *  - recipe_version_at_creation             INTEGER (snapshot, popula via trigger)
 *  - accept_second_quality_for_fulfillment  BOOLEAN (override del flag tenant)
 *  - expected_scrap_pct                     NUMERIC(5,2) (override del de la receta)
 *  - custom_attributes                      JSONB objeto (personalización por orden)
 *  - additional_costs                       NUMERIC(18,2) (extras no contemplados en receta)
 *  - additional_costs_notes                 TEXT
 *
 * Trigger sync_production_order_recipe_version:
 *  - BEFORE INSERT/UPDATE en production_orders
 *  - Si recipe_id se setea o cambia, popula recipe_version_at_creation desde
 *    recipes.version. Evita inconsistencias (alguien setea recipe_id pero
 *    olvida la versión, o pone versión que no coincide).
 *  - Si recipe_id se nulifica, recipe_version_at_creation también queda NULL.
 *
 * Referencia: §2.3.4.
 */

const up = `
  ALTER TABLE production_orders
    ADD COLUMN IF NOT EXISTS recipe_id                            UUID          NULL REFERENCES recipes(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS recipe_version_at_creation           INTEGER       NULL,
    ADD COLUMN IF NOT EXISTS accept_second_quality_for_fulfillment BOOLEAN      NULL,
    ADD COLUMN IF NOT EXISTS expected_scrap_pct                   NUMERIC(5,2)  NULL,
    ADD COLUMN IF NOT EXISTS custom_attributes                    JSONB         NULL,
    ADD COLUMN IF NOT EXISTS additional_costs                     NUMERIC(18,2) NULL,
    ADD COLUMN IF NOT EXISTS additional_costs_notes               TEXT          NULL;

  ALTER TABLE production_orders
    ADD CONSTRAINT po_custom_attributes_is_object
      CHECK (custom_attributes IS NULL OR jsonb_typeof(custom_attributes) = 'object'),
    ADD CONSTRAINT po_expected_scrap_pct_range
      CHECK (expected_scrap_pct IS NULL OR (expected_scrap_pct >= 0 AND expected_scrap_pct <= 100)),
    ADD CONSTRAINT po_additional_costs_nonneg
      CHECK (additional_costs IS NULL OR additional_costs >= 0),
    ADD CONSTRAINT po_recipe_version_implies_recipe
      CHECK (recipe_version_at_creation IS NULL OR recipe_id IS NOT NULL);

  CREATE INDEX IF NOT EXISTS idx_po_recipe_id ON production_orders (recipe_id);

  COMMENT ON COLUMN production_orders.recipe_id IS
    'SaaS v2: receta seleccionada al crear la orden. Si está set, raw_material_id/length_mm/mp_formula se ignoran.';
  COMMENT ON COLUMN production_orders.recipe_version_at_creation IS
    'SaaS v2: snapshot de recipes.version cuando se creó/actualizó la orden. Popula automáticamente vía trigger.';
  COMMENT ON COLUMN production_orders.accept_second_quality_for_fulfillment IS
    'SaaS v2: NULL = hereda del flag tenant; true/false = override por orden.';
  COMMENT ON COLUMN production_orders.expected_scrap_pct IS
    'SaaS v2: override del % esperado en la receta. Si NULL, usa recipes.expected_scrap_pct.';
  COMMENT ON COLUMN production_orders.custom_attributes IS
    'SaaS v2: atributos específicos de la orden (personalización pasteles, etc.). Objeto JSONB.';
  COMMENT ON COLUMN production_orders.additional_costs IS
    'SaaS v2: costos directos extras (mano de obra especial, materiales fuera de receta). Suman al costo final.';

  -- ─── Trigger: popula recipe_version_at_creation desde recipes ─────────
  CREATE OR REPLACE FUNCTION sync_production_order_recipe_version()
  RETURNS TRIGGER
  LANGUAGE plpgsql
  AS $$
  DECLARE
    v INTEGER;
  BEGIN
    IF NEW.recipe_id IS NULL THEN
      NEW.recipe_version_at_creation := NULL;
    ELSIF (TG_OP = 'INSERT')
       OR (TG_OP = 'UPDATE' AND OLD.recipe_id IS DISTINCT FROM NEW.recipe_id) THEN
      SELECT version INTO v FROM recipes WHERE id = NEW.recipe_id;
      NEW.recipe_version_at_creation := v;
    END IF;
    RETURN NEW;
  END;
  $$;

  CREATE TRIGGER sync_production_order_recipe_version_trg
    BEFORE INSERT OR UPDATE ON production_orders
    FOR EACH ROW
    EXECUTE FUNCTION sync_production_order_recipe_version();

  COMMENT ON FUNCTION sync_production_order_recipe_version IS
    'SaaS v2: popula production_orders.recipe_version_at_creation desde recipes.version cuando recipe_id se setea/cambia.';
`

const down = `
  DROP TRIGGER IF EXISTS sync_production_order_recipe_version_trg ON production_orders;
  DROP FUNCTION IF EXISTS sync_production_order_recipe_version();

  DROP INDEX IF EXISTS idx_po_recipe_id;

  ALTER TABLE production_orders
    DROP CONSTRAINT IF EXISTS po_recipe_version_implies_recipe,
    DROP CONSTRAINT IF EXISTS po_additional_costs_nonneg,
    DROP CONSTRAINT IF EXISTS po_expected_scrap_pct_range,
    DROP CONSTRAINT IF EXISTS po_custom_attributes_is_object;

  ALTER TABLE production_orders
    DROP COLUMN IF EXISTS additional_costs_notes,
    DROP COLUMN IF EXISTS additional_costs,
    DROP COLUMN IF EXISTS custom_attributes,
    DROP COLUMN IF EXISTS expected_scrap_pct,
    DROP COLUMN IF EXISTS accept_second_quality_for_fulfillment,
    DROP COLUMN IF EXISTS recipe_version_at_creation,
    DROP COLUMN IF EXISTS recipe_id;
`

module.exports = { up, down }
