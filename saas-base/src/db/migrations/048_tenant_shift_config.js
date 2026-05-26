'use strict'

const up = `
  CREATE TABLE IF NOT EXISTS tenant_shift_config (
    id                            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id                     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    shift_number                  SMALLINT NOT NULL CHECK (shift_number IN (1,2,3)),
    name                          VARCHAR(60) NOT NULL DEFAULT '',
    start_time                    TIME NOT NULL,
    duration_hours                SMALLINT NOT NULL DEFAULT 8,
    confirmation_tolerance_minutes SMALLINT NOT NULL DEFAULT 15,
    created_at                    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at                    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_tenant_shift UNIQUE (tenant_id, shift_number)
  );

  CREATE INDEX idx_shift_config_tenant ON tenant_shift_config (tenant_id);

  -- Insertar configuración por defecto para tenants existentes
  INSERT INTO tenant_shift_config
    (tenant_id, shift_number, name, start_time, duration_hours, confirmation_tolerance_minutes)
  SELECT
    id,
    s.shift_number,
    s.name,
    s.start_time::TIME,
    8,
    15
  FROM tenants
  CROSS JOIN (VALUES
    (1, 'Turno Matutino',   '06:00'),
    (2, 'Turno Vespertino', '14:00'),
    (3, 'Turno Nocturno',   '22:00')
  ) AS s(shift_number, name, start_time)
  ON CONFLICT (tenant_id, shift_number) DO NOTHING;
`

const down = `
  DROP TABLE IF EXISTS tenant_shift_config;
`

module.exports = { up, down }
