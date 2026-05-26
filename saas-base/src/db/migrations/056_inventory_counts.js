'use strict'

/**
 * Conteos físicos de inventario.
 *
 * Cabecera = inventory_counts
 * Líneas   = inventory_count_lines (snapshot del sistema + cantidad física)
 *
 * Al aplicar un conteo se genera AUTOMÁTICAMENTE un inventory_adjustment
 * con todas las líneas que tienen diferencia. La FK adjustment_id en la
 * cabecera permite trazabilidad bidireccional.
 *
 * Snapshot inmutable: las cantidades del sistema se congelan al iniciar
 * el conteo (system_qty, system_avg_cost). Movimientos posteriores NO
 * se reconcilian al snapshot — ya están reflejados en el sistema.
 */
const up = `
  CREATE TABLE inventory_counts (
    id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id             UUID         NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    count_number          VARCHAR(20)  NOT NULL,
    count_type            VARCHAR(20)  NOT NULL CHECK (count_type IN ('cyclic', 'month_close')),
    warehouse_id          UUID         REFERENCES warehouses(id),
    scope                 VARCHAR(30)  NOT NULL DEFAULT 'all'
                          CHECK (scope IN ('all','selected','with_stock','below_min')),
    count_date            DATE         NOT NULL DEFAULT CURRENT_DATE,
    notes                 TEXT,

    -- Estado del proceso
    status                VARCHAR(20)  NOT NULL DEFAULT 'in_capture'
                          CHECK (status IN ('in_capture','reconciling','applied','cancelled')),

    -- Auditoría
    started_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    started_by            UUID         REFERENCES users(id) ON DELETE SET NULL,
    applied_at            TIMESTAMPTZ,
    applied_by            UUID         REFERENCES users(id) ON DELETE SET NULL,
    cancelled_at          TIMESTAMPTZ,
    cancelled_by          UUID         REFERENCES users(id) ON DELETE SET NULL,
    cancellation_reason   TEXT,
    closing_notes         TEXT,                       -- notas obligatorias al aplicar

    -- Trazabilidad con el ajuste contable
    adjustment_id         UUID         REFERENCES inventory_adjustments(id) ON DELETE SET NULL,

    -- Totales (calculados al aplicar)
    total_lines           INTEGER      NOT NULL DEFAULT 0,
    captured_lines        INTEGER      NOT NULL DEFAULT 0,
    diff_lines            INTEGER      NOT NULL DEFAULT 0,
    total_diff_value      DECIMAL(14,2) NOT NULL DEFAULT 0,

    created_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

    CONSTRAINT ic_number_tenant UNIQUE (tenant_id, count_number)
  );

  CREATE INDEX idx_ic_tenant_id    ON inventory_counts (tenant_id);
  CREATE INDEX idx_ic_warehouse_id ON inventory_counts (warehouse_id);
  CREATE INDEX idx_ic_status       ON inventory_counts (tenant_id, status);
  CREATE INDEX idx_ic_date         ON inventory_counts (tenant_id, count_date DESC);

  CREATE TRIGGER set_updated_at_inventory_counts
    BEFORE UPDATE ON inventory_counts
    FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

  -- Líneas con snapshot del sistema y captura física
  CREATE TABLE inventory_count_lines (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    count_id            UUID         NOT NULL REFERENCES inventory_counts(id) ON DELETE CASCADE,
    item_type           inventory_item_type NOT NULL,
    item_id             UUID         NOT NULL,
    warehouse_id        UUID         NOT NULL REFERENCES warehouses(id),

    -- Snapshot inmutable del sistema al iniciar
    system_qty          DECIMAL(14,4) NOT NULL,
    system_avg_cost     DECIMAL(14,4) NOT NULL DEFAULT 0,
    unit                VARCHAR(10)   NOT NULL,

    -- Captura física
    physical_qty        DECIMAL(14,4),               -- NULL = pendiente de capturar
    notes               TEXT,                         -- notas opcionales por línea
    captured_at         TIMESTAMPTZ,
    captured_by         UUID         REFERENCES users(id) ON DELETE SET NULL,

    -- Estado
    status              VARCHAR(20)  NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','captured','applied','skipped')),

    created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

    CONSTRAINT icl_unique_per_count UNIQUE (count_id, item_type, item_id, warehouse_id)
  );

  CREATE INDEX idx_icl_count_id     ON inventory_count_lines (count_id);
  CREATE INDEX idx_icl_status       ON inventory_count_lines (count_id, status);
  CREATE INDEX idx_icl_item         ON inventory_count_lines (item_type, item_id);

  CREATE TRIGGER set_updated_at_inventory_count_lines
    BEFORE UPDATE ON inventory_count_lines
    FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

  COMMENT ON TABLE  inventory_counts
    IS 'Conteos físicos cíclicos y de cierre de mes — cabecera.';
  COMMENT ON COLUMN inventory_counts.count_number
    IS 'Folio CONT-YYYYMM-XX (cíclico) o CONT-YYYYMM-CM (cierre de mes).';
  COMMENT ON COLUMN inventory_counts.count_type
    IS 'cyclic = parcial cualquier momento; month_close = cierre completo de mes.';
  COMMENT ON COLUMN inventory_counts.scope
    IS 'all=todo el almacén, selected=selección manual, with_stock=solo con stock>0, below_min=solo bajo mínimo.';
  COMMENT ON COLUMN inventory_counts.adjustment_id
    IS 'FK al inventory_adjustment que se generó al aplicar el conteo.';
  COMMENT ON TABLE  inventory_count_lines
    IS 'Líneas del conteo físico: snapshot del sistema (inmutable) + captura física.';
  COMMENT ON COLUMN inventory_count_lines.system_qty
    IS 'Cantidad que mostraba el sistema al iniciar el conteo (snapshot).';
  COMMENT ON COLUMN inventory_count_lines.physical_qty
    IS 'Cantidad física capturada por el operador. NULL = pendiente.';
`

const down = `
  DROP TRIGGER IF EXISTS set_updated_at_inventory_count_lines ON inventory_count_lines;
  DROP TABLE IF EXISTS inventory_count_lines CASCADE;
  DROP TRIGGER IF EXISTS set_updated_at_inventory_counts ON inventory_counts;
  DROP TABLE IF EXISTS inventory_counts CASCADE;
`

module.exports = { up, down }
