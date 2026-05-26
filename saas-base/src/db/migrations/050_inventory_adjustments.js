'use strict'

/**
 * Documentos de ajuste de inventario.
 *
 * Cabecera = inventory_adjustments
 * Líneas   = inventory_movements (con reference_type='inventory_adjustment'
 *                                 y reference_id apuntando a la cabecera)
 *
 * Permite agrupar varios movimientos (entradas y salidas) en un solo
 * documento con folio único, motivo y trazabilidad por usuario.
 */
const up = `
  CREATE TABLE inventory_adjustments (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id           UUID          NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    adjustment_number   VARCHAR(20)   NOT NULL,
    adjustment_date     DATE          NOT NULL DEFAULT CURRENT_DATE,
    warehouse_id        UUID          NOT NULL REFERENCES warehouses(id),
    reason              VARCHAR(200)  NOT NULL,
    notes               TEXT,
    total_lines         INTEGER       NOT NULL DEFAULT 0,
    total_in_value      DECIMAL(14,2) NOT NULL DEFAULT 0,
    total_out_value     DECIMAL(14,2) NOT NULL DEFAULT 0,
    net_value           DECIMAL(14,2) GENERATED ALWAYS AS
                        (total_in_value - total_out_value) STORED,
    created_by          UUID          REFERENCES users(id) ON DELETE SET NULL,
    created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

    CONSTRAINT ia_number_tenant UNIQUE (tenant_id, adjustment_number)
  );

  CREATE INDEX idx_ia_tenant_id    ON inventory_adjustments (tenant_id);
  CREATE INDEX idx_ia_warehouse_id ON inventory_adjustments (warehouse_id);
  CREATE INDEX idx_ia_date         ON inventory_adjustments (tenant_id, adjustment_date DESC);

  CREATE TRIGGER set_updated_at_inventory_adjustments
    BEFORE UPDATE ON inventory_adjustments
    FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

  COMMENT ON TABLE  inventory_adjustments
    IS 'Documentos de ajuste de inventario — cabecera. Las líneas se almacenan en inventory_movements con reference_type=inventory_adjustment.';
  COMMENT ON COLUMN inventory_adjustments.adjustment_number
    IS 'Folio AJ-YYYYMM-XXXX, único por tenant.';
  COMMENT ON COLUMN inventory_adjustments.net_value
    IS 'Calculado: total_in_value - total_out_value. Positivo = aumento neto, negativo = disminución neta.';
`

const down = `
  DROP TRIGGER IF EXISTS set_updated_at_inventory_adjustments ON inventory_adjustments;
  DROP TABLE IF EXISTS inventory_adjustments CASCADE;
`

module.exports = { up, down }
