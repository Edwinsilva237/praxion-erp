'use strict'

/**
 * SaaS v2 — Migration 125: tenant_product_kinds
 *
 * Familias de productos del tenant, con attribute_schema (atributos custom del
 * producto) y capture_schema (qué se captura por microlote) ambos como JSONB
 * con wrapper { version: N, fields: [...] }.
 *
 * - is_produced=true (default): el kind se fabrica (tiene receta + captura).
 *   is_produced=false: solo reventa/compra, no requiere base_unit_id ni
 *   schemas (pero los aceptamos por uniformidad — quedan vacíos).
 * - base_unit_id: FK opcional a tenant_units (unidad de inventario por default).
 * - default_quality_grade_id: FK opcional a tenant_quality_grades.
 * - requires_lots: override del flag global tenant_process_config.uses_lots.
 *
 * Política de schema evolution (§2.2.8): por ahora se valida el meta-schema
 * (vía ajv en backend) y se permite cualquier cambio. La política completa de
 * "campo deprecated por confirmación si hay datos históricos" se implementa
 * cuando existan datos reales (products.custom_attributes en migration 126,
 * shift_progress.dynamic_attributes ya existe pero sin product_kind ref).
 *
 * Seed default: tabla vacía. Cada tenant crea sus kinds (palomitas_dulces,
 * pellet_pe, pan_dulce, frituras_papa, etc.).
 *
 * Referencia: §2.2.8.
 */

const up = `
  CREATE TABLE tenant_product_kinds (
    id                          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id                   UUID         NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    code                        VARCHAR(50)  NOT NULL,
    name                        VARCHAR(120) NOT NULL,
    is_produced                 BOOLEAN      NOT NULL DEFAULT true,
    base_unit_id                UUID         NULL REFERENCES tenant_units(id) ON DELETE SET NULL,
    attribute_schema            JSONB        NOT NULL DEFAULT '{"version": 1, "fields": []}'::jsonb,
    capture_schema              JSONB        NOT NULL DEFAULT '{"version": 1, "fields": []}'::jsonb,
    requires_lots               BOOLEAN      NULL,
    default_shelf_life_days     INTEGER      NULL,
    default_quality_grade_id    UUID         NULL REFERENCES tenant_quality_grades(id) ON DELETE SET NULL,
    is_active                   BOOLEAN      NOT NULL DEFAULT true,
    created_at                  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at                  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    created_by_user_id          UUID         NULL REFERENCES users(id) ON DELETE SET NULL,
    updated_by_user_id          UUID         NULL REFERENCES users(id) ON DELETE SET NULL,

    CONSTRAINT tpk_code_per_tenant UNIQUE (tenant_id, code),
    CONSTRAINT tpk_shelf_life_positive CHECK (default_shelf_life_days IS NULL OR default_shelf_life_days > 0),
    CONSTRAINT tpk_attr_schema_is_object CHECK (jsonb_typeof(attribute_schema) = 'object'),
    CONSTRAINT tpk_capture_schema_is_object CHECK (jsonb_typeof(capture_schema) = 'object')
  );

  CREATE INDEX tpk_tenant_active  ON tenant_product_kinds (tenant_id, is_active);
  CREATE INDEX tpk_tenant_produced ON tenant_product_kinds (tenant_id, is_produced);

  COMMENT ON TABLE tenant_product_kinds IS
    'SaaS v2: familias de productos del tenant. Reemplaza la rigidez de products + raw_materials con catálogo configurable por industria.';
  COMMENT ON COLUMN tenant_product_kinds.is_produced IS
    'true: el kind se fabrica (tiene receta + captura). false: solo reventa/compra.';
  COMMENT ON COLUMN tenant_product_kinds.attribute_schema IS
    'JSONB { version, fields[] } — atributos custom del producto (sabor, tamaño, etc.). Validado por ajv en backend.';
  COMMENT ON COLUMN tenant_product_kinds.capture_schema IS
    'JSONB { version, fields[] } — campos que captura el operador por microlote. lot_critical=true divide lotes.';
  COMMENT ON COLUMN tenant_product_kinds.requires_lots IS
    'NULL: hereda de tenant_process_config.uses_lots. true/false: override por kind.';

  CREATE TRIGGER set_updated_at_tenant_product_kinds
    BEFORE UPDATE ON tenant_product_kinds
    FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

  -- La función seed_tenant_process_template_defaults NO se extiende: los
  -- product_kinds son tenant-específicos (palomitas_dulces para uno,
  -- pellet_pe para otro) y no tienen seed default genérico.
`

const down = `
  DROP TRIGGER IF EXISTS set_updated_at_tenant_product_kinds ON tenant_product_kinds;
  DROP TABLE IF EXISTS tenant_product_kinds;
`

module.exports = { up, down }
