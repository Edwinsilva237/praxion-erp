'use strict'

const up = `
  CREATE TYPE production_order_status AS ENUM (
    'draft',
    'released',
    'in_progress',
    'completed',
    'cancelled'
  );

  CREATE TYPE shift_number AS ENUM ('1', '2', '3');

  CREATE TYPE shift_status AS ENUM (
    'pending',
    'active',
    'pending_handover',
    'reviewed',
    'pending_management',
    'closed'
  );

  CREATE TYPE progress_status AS ENUM (
    'captured',
    'out_of_range',
    'reviewed'
  );

  -- Órdenes de producción
  CREATE TABLE production_orders (
    id                   UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id            UUID                   NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    order_number         VARCHAR(20)            NOT NULL,
    product_id           UUID                   NOT NULL REFERENCES products(id),
    raw_material_id      UUID                   NOT NULL REFERENCES raw_materials(id),
    quantity_packages    INTEGER                NOT NULL,
    quantity_units       INTEGER                GENERATED ALWAYS AS (quantity_packages * 50) STORED,
    theoretical_mp_kg    DECIMAL(10,4),
    real_mp_kg           DECIMAL(10,4),
    status               production_order_status NOT NULL DEFAULT 'draft',
    notes                TEXT,
    created_by           UUID                   REFERENCES users(id) ON DELETE SET NULL,
    released_by          UUID                   REFERENCES users(id) ON DELETE SET NULL,
    released_at          TIMESTAMPTZ,
    completed_at         TIMESTAMPTZ,
    created_at           TIMESTAMPTZ            NOT NULL DEFAULT NOW(),
    updated_at           TIMESTAMPTZ            NOT NULL DEFAULT NOW(),

    CONSTRAINT po_order_number_tenant UNIQUE (tenant_id, order_number),
    CONSTRAINT po_quantity_positive   CHECK (quantity_packages > 0)
  );

  CREATE INDEX idx_po_tenant_id  ON production_orders (tenant_id);
  CREATE INDEX idx_po_product_id ON production_orders (tenant_id, product_id);
  CREATE INDEX idx_po_status     ON production_orders (tenant_id, status);

  COMMENT ON COLUMN production_orders.quantity_units    IS 'Calculado: packages × 50 — siempre paquetes de 50';
  COMMENT ON COLUMN production_orders.theoretical_mp_kg IS 'Calculado al liberar: g/m × largo_m × piezas / 1000';
  COMMENT ON COLUMN production_orders.real_mp_kg        IS 'Suma de pesos reales al cerrar todos los turnos';

  CREATE TRIGGER set_updated_at_production_orders
    BEFORE UPDATE ON production_orders
    FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

  -- Turnos de producción
  CREATE TABLE production_shifts (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id           UUID         NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    production_order_id UUID         NOT NULL REFERENCES production_orders(id),
    shift_number        shift_number NOT NULL,
    shift_date          DATE         NOT NULL,
    operator_id         UUID         NOT NULL REFERENCES users(id),
    supervisor_id       UUID         NOT NULL REFERENCES users(id),
    mp_reserved_kg      DECIMAL(10,4) NOT NULL DEFAULT 0,
    mp_real_kg          DECIMAL(10,4) NOT NULL DEFAULT 0,
    pt_units_produced   INTEGER      NOT NULL DEFAULT 0,
    scrap_estimated_kg  DECIMAL(10,4) NOT NULL DEFAULT 0,
    process_loss_kg     DECIMAL(10,4),
    process_loss_pct    DECIMAL(5,2),
    status              shift_status NOT NULL DEFAULT 'pending',
    started_at          TIMESTAMPTZ,
    closed_at           TIMESTAMPTZ,
    created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

    CONSTRAINT ps_unique_shift UNIQUE (production_order_id, shift_number, shift_date)
  );

  CREATE INDEX idx_ps_tenant_id   ON production_shifts (tenant_id);
  CREATE INDEX idx_ps_order_id    ON production_shifts (production_order_id);
  CREATE INDEX idx_ps_operator    ON production_shifts (tenant_id, operator_id);
  CREATE INDEX idx_ps_supervisor  ON production_shifts (tenant_id, supervisor_id);
  CREATE INDEX idx_ps_status      ON production_shifts (tenant_id, status);

  CREATE TRIGGER set_updated_at_production_shifts
    BEFORE UPDATE ON production_shifts
    FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

  -- Avances por microlote
  CREATE TABLE shift_progress (
    id                   UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    shift_id             UUID           NOT NULL REFERENCES production_shifts(id) ON DELETE CASCADE,
    microlot_number      INTEGER        NOT NULL,
    quantity_units       INTEGER        NOT NULL,
    real_weight_kg       DECIMAL(10,4)  NOT NULL,
    theoretical_weight_kg DECIMAL(10,4) NOT NULL,
    deviation_pct        DECIMAL(6,2)   GENERATED ALWAYS AS (
      CASE WHEN theoretical_weight_kg > 0
        THEN ROUND(((real_weight_kg - theoretical_weight_kg) / theoretical_weight_kg * 100)::numeric, 2)
        ELSE 0
      END
    ) STORED,
    weight_ok            BOOLEAN        GENERATED ALWAYS AS (
      CASE WHEN theoretical_weight_kg > 0
        THEN ABS((real_weight_kg - theoretical_weight_kg) / theoretical_weight_kg * 100) <= 5
        ELSE false
      END
    ) STORED,
    status               progress_status NOT NULL DEFAULT 'captured',
    notes                TEXT,
    captured_at          TIMESTAMPTZ     NOT NULL DEFAULT NOW(),

    CONSTRAINT sp_microlot_unique UNIQUE (shift_id, microlot_number),
    CONSTRAINT sp_quantity_positive CHECK (quantity_units > 0),
    CONSTRAINT sp_weight_positive   CHECK (real_weight_kg > 0)
  );

  CREATE INDEX idx_sp_shift_id ON shift_progress (shift_id);
  CREATE INDEX idx_sp_status   ON shift_progress (shift_id, status);

  COMMENT ON COLUMN shift_progress.deviation_pct IS 'Calculado: (real - teórico) / teórico × 100';
  COMMENT ON COLUMN shift_progress.weight_ok     IS 'Calculado: desviación dentro del ±5% de la spec vigente';

  -- Entrega de turno
  CREATE TABLE shift_handovers (
    id                   UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    shift_id             UUID          NOT NULL REFERENCES production_shifts(id) UNIQUE,
    mp_received_kg       DECIMAL(10,4) NOT NULL,
    pt_produced_units    INTEGER       NOT NULL,
    scrap_estimated_kg   DECIMAL(10,4) NOT NULL DEFAULT 0,
    process_loss_kg      DECIMAL(10,4),
    process_loss_pct     DECIMAL(5,2),
    balance_ok           BOOLEAN,
    supervisor_notes     TEXT,
    management_notes     TEXT,
    reviewed_by          UUID          REFERENCES users(id) ON DELETE SET NULL,
    reviewed_at          TIMESTAMPTZ,
    submitted_by         UUID          REFERENCES users(id) ON DELETE SET NULL,
    submitted_at         TIMESTAMPTZ   NOT NULL DEFAULT NOW()
  );

  CREATE INDEX idx_handover_shift_id ON shift_handovers (shift_id);
`

const down = `
  DROP TRIGGER IF EXISTS set_updated_at_production_shifts ON production_shifts;
  DROP TRIGGER IF EXISTS set_updated_at_production_orders ON production_orders;
  DROP TABLE IF EXISTS shift_handovers   CASCADE;
  DROP TABLE IF EXISTS shift_progress    CASCADE;
  DROP TABLE IF EXISTS production_shifts CASCADE;
  DROP TABLE IF EXISTS production_orders CASCADE;
  DROP TYPE  IF EXISTS progress_status   CASCADE;
  DROP TYPE  IF EXISTS shift_status      CASCADE;
  DROP TYPE  IF EXISTS shift_number      CASCADE;
  DROP TYPE  IF EXISTS production_order_status CASCADE;
`

module.exports = { up, down }
