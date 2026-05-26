'use strict'

const up = `
  DO $$ BEGIN
    CREATE TYPE scheduled_shift_status AS ENUM (
      'scheduled',
      'active',
      'completed',
      'cancelled'
    );
  EXCEPTION WHEN duplicate_object THEN null; END $$;

  CREATE TABLE IF NOT EXISTS scheduled_shifts (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id           UUID          NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    production_order_id UUID          NOT NULL REFERENCES production_orders(id) ON DELETE CASCADE,
    shift_number        shift_number  NOT NULL,
    scheduled_date      DATE          NOT NULL,
    scheduled_start     TIME          NOT NULL,
    operator_id         UUID          NOT NULL REFERENCES users(id),
    supervisor_id       UUID          NOT NULL REFERENCES users(id),
    line_id             INTEGER       NOT NULL DEFAULT 1,
    status              scheduled_shift_status NOT NULL DEFAULT 'scheduled',
    notes               TEXT,

    -- Confirmación del operador
    confirmed_at        TIMESTAMPTZ,
    confirmed_by        UUID          REFERENCES users(id),

    -- Auto-activación
    auto_activated_at   TIMESTAMPTZ,

    -- Turno real creado al activar
    shift_id            UUID          REFERENCES production_shifts(id),

    created_by          UUID          REFERENCES users(id),
    created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

    CONSTRAINT ss_unique_slot UNIQUE (tenant_id, production_order_id, shift_number, scheduled_date)
  );

  CREATE INDEX idx_sched_shifts_tenant     ON scheduled_shifts (tenant_id, status, scheduled_date);
  CREATE INDEX idx_sched_shifts_operator   ON scheduled_shifts (operator_id, scheduled_date);
  CREATE INDEX idx_sched_shifts_activation ON scheduled_shifts (status, scheduled_date, scheduled_start)
    WHERE status = 'scheduled';

  COMMENT ON TABLE scheduled_shifts IS
    'Turnos programados con anticipación. El sistema los activa automáticamente a la hora de inicio.
     El operador confirma presencia; si no confirma en 15 min se activa solo.';

  CREATE TRIGGER set_updated_at_sched_shifts
    BEFORE UPDATE ON scheduled_shifts
    FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();
`

const down = `
  DROP TABLE IF EXISTS scheduled_shifts CASCADE;
  DROP TYPE  IF EXISTS scheduled_shift_status CASCADE;
`

module.exports = { up, down }
