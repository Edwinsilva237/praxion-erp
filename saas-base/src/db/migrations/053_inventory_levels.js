'use strict'

/**
 * Niveles de stock por (item × almacén).
 *
 *   - min_stock         → bajo esto, alerta crítica 🔴
 *   - max_stock         → arriba de esto, sobrestock 🔵
 *   - reorder_point     → punto donde dispara una OC sugerida 🟡
 *   - safety_stock      → colchón de seguridad
 *   - is_manual_reorder_point → true si el usuario lo capturó manualmente,
 *                                false si lo aceptó del sugeridor automático.
 *   - last_calculated_avg / last_calculated_at → snapshot del consumo diario
 *     promedio que se usó para calcular el reorder_point. Permite avisar al
 *     usuario cuando ha pasado tiempo y el cálculo puede estar desactualizado.
 */
const up = `
  CREATE TABLE inventory_levels (
    id                       UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id                UUID         NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    item_type                VARCHAR(20)  NOT NULL CHECK (item_type IN ('raw_material','product')),
    item_id                  UUID         NOT NULL,
    warehouse_id             UUID         NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
    min_stock                DECIMAL(14,4) NOT NULL DEFAULT 0,
    max_stock                DECIMAL(14,4),
    reorder_point            DECIMAL(14,4) NOT NULL DEFAULT 0,
    safety_stock             DECIMAL(14,4) NOT NULL DEFAULT 0,
    is_manual_reorder_point  BOOLEAN      NOT NULL DEFAULT false,
    last_calculated_avg      DECIMAL(14,4),
    last_calculated_at       TIMESTAMPTZ,
    notes                    TEXT,
    updated_by               UUID         REFERENCES users(id) ON DELETE SET NULL,
    created_at               TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at               TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

    CONSTRAINT il_unique_per_item_warehouse UNIQUE (tenant_id, item_type, item_id, warehouse_id),
    CONSTRAINT il_positive_min      CHECK (min_stock >= 0),
    CONSTRAINT il_positive_safety   CHECK (safety_stock >= 0),
    CONSTRAINT il_max_gte_min       CHECK (max_stock IS NULL OR max_stock >= min_stock),
    CONSTRAINT il_reorder_in_range  CHECK (reorder_point >= 0)
  );

  CREATE INDEX idx_il_tenant       ON inventory_levels (tenant_id);
  CREATE INDEX idx_il_item         ON inventory_levels (tenant_id, item_type, item_id);
  CREATE INDEX idx_il_warehouse    ON inventory_levels (warehouse_id);

  COMMENT ON TABLE  inventory_levels                IS 'Niveles de stock min/max/reorden/seguridad por (item × almacén).';
  COMMENT ON COLUMN inventory_levels.is_manual_reorder_point
    IS 'true = capturado manualmente; false = aceptado del sugeridor automático.';
  COMMENT ON COLUMN inventory_levels.last_calculated_avg
    IS 'Consumo diario promedio que se usó al calcular el reorder_point sugerido.';

  CREATE TRIGGER set_updated_at_inventory_levels
    BEFORE UPDATE ON inventory_levels
    FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();
`

const down = `
  DROP TRIGGER IF EXISTS set_updated_at_inventory_levels ON inventory_levels;
  DROP TABLE IF EXISTS inventory_levels CASCADE;
`

module.exports = { up, down }
