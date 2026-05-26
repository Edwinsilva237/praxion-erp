'use strict'

/**
 * Tabla de bitácora para correcciones del supervisor.
 *
 * Cuando el supervisor (o admin) corrige un registro durante la fase de
 * pending_handover (post-cierre del operador, pre-validación), se guarda
 * un snapshot completo del registro original y de los nuevos valores.
 *
 * Esto permite:
 *   - Trazabilidad total: quién corrigió qué, cuándo, por qué
 *   - KPIs: % turnos con correcciones, operadores con más correcciones
 *   - Recuperación: si fue error, el snapshot tiene todo el JSON
 *
 * Cuándo se inserta una fila:
 *   - action='update': el supervisor edita un paquete/merma/incidencia
 *     existente. original_value y new_value tienen JSONB.
 *   - action='delete': el supervisor elimina un registro. original_value
 *     tiene JSONB con el snapshot, new_value es NULL.
 *   - action='create': el supervisor agrega un paquete/merma/incidencia
 *     que faltó. original_value es NULL, new_value tiene JSONB.
 */
const up = `
  CREATE TABLE shift_corrections (
    id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id         UUID         NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    shift_id          UUID         NOT NULL REFERENCES production_shifts(id) ON DELETE CASCADE,
    target_type       VARCHAR(30)  NOT NULL CHECK (target_type IN ('shift_progress','shift_scrap','shift_incidents')),
    target_id         UUID,
    action            VARCHAR(20)  NOT NULL CHECK (action IN ('update','delete','create')),
    original_value    JSONB,
    new_value         JSONB,
    correction_reason TEXT         NOT NULL,
    corrected_by      UUID         REFERENCES users(id) ON DELETE SET NULL,
    corrected_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
  );

  CREATE INDEX idx_shift_corrections_shift   ON shift_corrections (shift_id);
  CREATE INDEX idx_shift_corrections_tenant  ON shift_corrections (tenant_id);
  CREATE INDEX idx_shift_corrections_target  ON shift_corrections (target_type, target_id);
  CREATE INDEX idx_shift_corrections_user    ON shift_corrections (corrected_by);

  COMMENT ON TABLE  shift_corrections IS
    'Bitácora de correcciones del supervisor en turnos pending_handover. Para auditoría y KPIs.';
  COMMENT ON COLUMN shift_corrections.action IS
    'update | delete | create — qué tipo de corrección hizo el supervisor';
  COMMENT ON COLUMN shift_corrections.original_value IS
    'Snapshot del registro antes del cambio. NULL si action=create.';
  COMMENT ON COLUMN shift_corrections.new_value IS
    'Snapshot del registro después del cambio. NULL si action=delete.';
`

const down = `
  DROP TABLE IF EXISTS shift_corrections CASCADE;
`

module.exports = { up, down }
