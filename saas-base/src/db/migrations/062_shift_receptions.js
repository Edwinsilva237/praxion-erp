'use strict'

/**
 * Tabla shift_receptions.
 *
 * Registro de recepciones de turno entre operador entrante y saliente.
 * Cuando el operador entrante recibe la línea, declara si acepta sin
 * observaciones o si recibe con observaciones (descripción obligatoria
 * mínimo 20 caracteres).
 *
 * IMPORTANTE: no confundir con la tabla `shift_handovers` (creada en
 * migraciones del módulo de producción inicial), que es el reporte de
 * balance al cierre del turno (MP recibida / PT producido / scrap).
 * Son tablas distintas con propósitos distintos.
 */
const up = `
  CREATE TABLE shift_receptions (
    id                 UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id          UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    outgoing_shift_id  UUID        NOT NULL REFERENCES production_shifts(id),
    incoming_shift_id  UUID        NOT NULL REFERENCES production_shifts(id),
    accepted           BOOLEAN     NOT NULL,
    issue_description  TEXT,
    received_by        UUID        NOT NULL REFERENCES users(id),
    received_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT chk_reception_observations_required
      CHECK (accepted = TRUE OR (issue_description IS NOT NULL AND length(trim(issue_description)) >= 20)),

    CONSTRAINT uq_reception_incoming_shift UNIQUE (incoming_shift_id)
  );

  CREATE INDEX idx_shift_receptions_outgoing ON shift_receptions (outgoing_shift_id);
  CREATE INDEX idx_shift_receptions_tenant   ON shift_receptions (tenant_id, received_at DESC);

  COMMENT ON TABLE  shift_receptions                   IS 'Recepción de turno entre operadores (handover de línea). No confundir con shift_handovers (balance al cierre).';
  COMMENT ON COLUMN shift_receptions.outgoing_shift_id IS 'Turno que se está entregando (saliente)';
  COMMENT ON COLUMN shift_receptions.incoming_shift_id IS 'Turno que recibe la línea (entrante)';
  COMMENT ON COLUMN shift_receptions.accepted          IS 'TRUE = recibido sin observaciones; FALSE = recibido con observaciones';
  COMMENT ON COLUMN shift_receptions.issue_description IS 'Descripción libre de las observaciones (obligatorio si accepted=FALSE, mínimo 20 chars)';
`

const down = `
  DROP TABLE IF EXISTS shift_receptions CASCADE;
`

module.exports = { up, down }
