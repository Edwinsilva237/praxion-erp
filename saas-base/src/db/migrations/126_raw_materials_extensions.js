'use strict'

/**
 * SaaS v2 — Migration 126: extensión aditiva a raw_materials.
 *
 * Última migration del Foundation. Esta tabla pasa a ser el catálogo unificado
 * de MP + Embalaje + Aditivos (vía item_kind). Aditivo puro:
 *  - Todas las columnas nuevas son NULL-able o tienen DEFAULT.
 *  - La columna `unit` string se mantiene; el código viejo de producción y
 *    compras sigue funcionando. unit_id se popula cuando el tenant configure
 *    SaaS v2 explícitamente.
 *  - rawMaterialService.js (módulo viejo) NO se modifica. El service v2 que
 *    expone item_kind/unit_id/custom_attributes/etc. vendrá durante el refactor
 *    de productionService con golden masters como red de seguridad.
 *
 * Columnas nuevas (§2.3.1):
 *  - item_kind                 'raw_material' | 'packaging' | 'additive'
 *  - unit_id                   FK tenant_units
 *  - custom_attributes         JSONB (valores según tenant_product_kinds.attribute_schema del kind)
 *  - default_warehouse_id      FK warehouses
 *  - expected_yield_pct        % rendimiento esperado (alertas de consumo anómalo)
 *  - requires_lot_tracking     captura obligatoria de lote en recepción
 *  - requires_coa              requiere Certificado de Análisis para activar lote
 *  - default_shelf_life_days   vida útil default si proveedor no informa
 *  - standard_cost             costo estándar (cost_method='standard', post-MVP)
 *
 * Referencia: §2.3.1.
 */

const up = `
  ALTER TABLE raw_materials
    ADD COLUMN IF NOT EXISTS item_kind                VARCHAR(20)    NOT NULL DEFAULT 'raw_material',
    ADD COLUMN IF NOT EXISTS unit_id                  UUID           NULL REFERENCES tenant_units(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS custom_attributes        JSONB          NULL,
    ADD COLUMN IF NOT EXISTS default_warehouse_id     UUID           NULL REFERENCES warehouses(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS expected_yield_pct       NUMERIC(5,2)   NULL,
    ADD COLUMN IF NOT EXISTS requires_lot_tracking    BOOLEAN        NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS requires_coa             BOOLEAN        NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS default_shelf_life_days  INTEGER        NULL,
    ADD COLUMN IF NOT EXISTS standard_cost            NUMERIC(18,6)  NULL;

  ALTER TABLE raw_materials
    ADD CONSTRAINT rm_item_kind_check
      CHECK (item_kind IN ('raw_material', 'packaging', 'additive')),
    ADD CONSTRAINT rm_expected_yield_pct_range
      CHECK (expected_yield_pct IS NULL OR (expected_yield_pct >= 0 AND expected_yield_pct <= 100)),
    ADD CONSTRAINT rm_default_shelf_life_positive
      CHECK (default_shelf_life_days IS NULL OR default_shelf_life_days > 0),
    ADD CONSTRAINT rm_standard_cost_nonneg
      CHECK (standard_cost IS NULL OR standard_cost >= 0),
    ADD CONSTRAINT rm_custom_attributes_is_object
      CHECK (custom_attributes IS NULL OR jsonb_typeof(custom_attributes) = 'object');

  CREATE INDEX IF NOT EXISTS idx_raw_materials_item_kind     ON raw_materials (tenant_id, item_kind);
  CREATE INDEX IF NOT EXISTS idx_raw_materials_unit_id       ON raw_materials (unit_id);
  CREATE INDEX IF NOT EXISTS idx_raw_materials_default_wh    ON raw_materials (default_warehouse_id);
  CREATE INDEX IF NOT EXISTS idx_raw_materials_requires_lot  ON raw_materials (tenant_id, requires_lot_tracking)
    WHERE requires_lot_tracking = true;

  COMMENT ON COLUMN raw_materials.item_kind IS
    'SaaS v2: tipo de item. raw_material (default, MP tradicional), packaging (embalajes), additive (saborizantes, aditivos). Permite usar raw_materials como catálogo unificado.';
  COMMENT ON COLUMN raw_materials.unit_id IS
    'SaaS v2: FK al catálogo tenant_units. La columna "unit" string se mantiene por backward compat con código viejo de producción/compras; eventualmente se elimina en cleanup migrations.';
  COMMENT ON COLUMN raw_materials.custom_attributes IS
    'SaaS v2: valores de atributos custom definidos en el product_kind asociado (vía recipes o por convención de tenant). JSONB objeto.';
  COMMENT ON COLUMN raw_materials.requires_lot_tracking IS
    'SaaS v2: si true, recepción obliga a capturar lote. Para MPs alimentarias críticas (NOM-251).';
  COMMENT ON COLUMN raw_materials.requires_coa IS
    'SaaS v2: si true, el lote no entra en estado active hasta que se adjunta el Certificado de Análisis.';
`

const down = `
  DROP INDEX IF EXISTS idx_raw_materials_requires_lot;
  DROP INDEX IF EXISTS idx_raw_materials_default_wh;
  DROP INDEX IF EXISTS idx_raw_materials_unit_id;
  DROP INDEX IF EXISTS idx_raw_materials_item_kind;

  ALTER TABLE raw_materials
    DROP CONSTRAINT IF EXISTS rm_custom_attributes_is_object,
    DROP CONSTRAINT IF EXISTS rm_standard_cost_nonneg,
    DROP CONSTRAINT IF EXISTS rm_default_shelf_life_positive,
    DROP CONSTRAINT IF EXISTS rm_expected_yield_pct_range,
    DROP CONSTRAINT IF EXISTS rm_item_kind_check;

  ALTER TABLE raw_materials
    DROP COLUMN IF EXISTS standard_cost,
    DROP COLUMN IF EXISTS default_shelf_life_days,
    DROP COLUMN IF EXISTS requires_coa,
    DROP COLUMN IF EXISTS requires_lot_tracking,
    DROP COLUMN IF EXISTS expected_yield_pct,
    DROP COLUMN IF EXISTS default_warehouse_id,
    DROP COLUMN IF EXISTS custom_attributes,
    DROP COLUMN IF EXISTS unit_id,
    DROP COLUMN IF EXISTS item_kind;
`

module.exports = { up, down }
