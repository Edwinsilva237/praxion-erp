'use strict'

/**
 * Mig 246 — Vales de salida (consumo interno a áreas).
 *
 * Caso de uso: el almacenista libera material a producción u otras áreas
 * (empaque, mantenimiento, oficinas...) SIN que haya venta de por medio.
 * Antes la única vía era un ajuste de salida genérico; el vale formaliza:
 * quién recibió, a qué área fue, y deja el consumo separado de las
 * correcciones de inventario en el kardex (movement_type='internal_consumption',
 * agregado en mig 245).
 *
 * Diseño espejo de inventory_adjustments (mig 050): la cabecera vive aquí y
 * las LÍNEAS viven en inventory_movements con reference_type='consumption_voucher'.
 * La cancelación genera movimientos contrarios (reference_type=
 * 'consumption_voucher_reversal') igual que los ajustes.
 *
 * Permisos: reusa inventory:read / inventory:adjust — SIN permiso nuevo,
 * nadie necesita re-login.
 */

const up = `
  CREATE TABLE tenant_consumption_areas (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id   UUID         NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name        VARCHAR(100) NOT NULL,
    is_active   BOOLEAN      NOT NULL DEFAULT true,
    sort_order  INTEGER      NOT NULL DEFAULT 0,
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

    CONSTRAINT tca_name_tenant UNIQUE (tenant_id, name)
  );

  CREATE INDEX idx_tca_tenant ON tenant_consumption_areas (tenant_id, is_active, sort_order);

  CREATE TABLE consumption_vouchers (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id           UUID          NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    voucher_number      VARCHAR(20)   NOT NULL,
    voucher_date        DATE          NOT NULL DEFAULT CURRENT_DATE,
    warehouse_id        UUID          NOT NULL REFERENCES warehouses(id),
    area_id             UUID          NOT NULL REFERENCES tenant_consumption_areas(id),
    received_by         VARCHAR(150)  NOT NULL,
    notes               TEXT,
    total_lines         INTEGER       NOT NULL DEFAULT 0,
    total_value         DECIMAL(14,2) NOT NULL DEFAULT 0,
    status              VARCHAR(12)   NOT NULL DEFAULT 'active',
    cancelled_at        TIMESTAMPTZ,
    cancelled_by        UUID          REFERENCES users(id) ON DELETE SET NULL,
    cancellation_reason TEXT,
    created_by          UUID          REFERENCES users(id) ON DELETE SET NULL,
    created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

    CONSTRAINT cv_number_tenant UNIQUE (tenant_id, voucher_number),
    CONSTRAINT cv_status CHECK (status IN ('active', 'cancelled'))
  );

  CREATE INDEX idx_cv_tenant    ON consumption_vouchers (tenant_id);
  CREATE INDEX idx_cv_warehouse ON consumption_vouchers (warehouse_id);
  CREATE INDEX idx_cv_area      ON consumption_vouchers (tenant_id, area_id);
  CREATE INDEX idx_cv_date      ON consumption_vouchers (tenant_id, voucher_date DESC);

  CREATE TRIGGER set_updated_at_consumption_vouchers
    BEFORE UPDATE ON consumption_vouchers
    FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

  ALTER TABLE tenant_consumption_areas ENABLE ROW LEVEL SECURITY;
  ALTER TABLE tenant_consumption_areas FORCE  ROW LEVEL SECURITY;
  CREATE POLICY rls_tenant ON tenant_consumption_areas
    AS PERMISSIVE FOR ALL
    USING (NOT rls_enforce() OR tenant_id = current_tenant_id())
    WITH CHECK (NOT rls_enforce() OR tenant_id = current_tenant_id());

  ALTER TABLE consumption_vouchers ENABLE ROW LEVEL SECURITY;
  ALTER TABLE consumption_vouchers FORCE  ROW LEVEL SECURITY;
  CREATE POLICY rls_tenant ON consumption_vouchers
    AS PERMISSIVE FOR ALL
    USING (NOT rls_enforce() OR tenant_id = current_tenant_id())
    WITH CHECK (NOT rls_enforce() OR tenant_id = current_tenant_id());

  COMMENT ON TABLE tenant_consumption_areas
    IS 'Áreas/destinos de consumo interno por tenant (producción, empaque, mantenimiento...).';
  COMMENT ON TABLE consumption_vouchers
    IS 'Vales de salida a áreas — cabecera. Las líneas viven en inventory_movements con reference_type=consumption_voucher.';
`

const down = `
  DROP POLICY IF EXISTS rls_tenant ON consumption_vouchers;
  DROP POLICY IF EXISTS rls_tenant ON tenant_consumption_areas;
  DROP TABLE IF EXISTS consumption_vouchers;
  DROP TABLE IF EXISTS tenant_consumption_areas;
`

module.exports = { up, down }
