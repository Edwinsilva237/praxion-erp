'use strict'

/**
 * Mig 161 — `scheduled_shift_members`: roles dinámicos del turno en planning.
 *
 * Contexto (sesión 2026-05-29):
 *  La mig 124 creó `tenant_shift_roles` (catálogo configurable) y
 *  `production_shift_members` (runtime), pero ningún code path los usaba —
 *  tanto la programación (scheduled_shifts) como el runtime (production_shifts)
 *  seguían operando con columnas rígidas `operator_id` / `supervisor_id`.
 *
 *  El admin podía configurar roles (capturista, supervisor, calidad,
 *  alimentador, maquinista, o roles custom como "repostero" para pastelería)
 *  pero en la pantalla de Programación solo aparecían los dos campos
 *  hardcoded. Inconsistencia entre lo que el SaaS prometía y lo que entregaba.
 *
 * Esta migración añade la tabla espejo `scheduled_shift_members` (planning) —
 * la del runtime ya existe desde mig 124. El refactor de los services para
 * leer/escribir estas tablas va en el mismo commit junto con el frontend
 * dinámico de la programación.
 *
 * Compatibilidad:
 *  - `scheduled_shifts.operator_id` y `supervisor_id` se mantienen NOT NULL.
 *    El service los DERIVA al insertar — toma como operator el primer miembro
 *    con `can_capture=true` y como supervisor el primero con `can_validate=true`,
 *    en defecto del catálogo. Esto preserva 100% de los flujos legacy de
 *    captura, validación y cierre hasta que el runtime también se refactorice.
 */

const up = `
  CREATE TABLE scheduled_shift_members (
    id                   UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    scheduled_shift_id   UUID         NOT NULL REFERENCES scheduled_shifts(id) ON DELETE CASCADE,
    user_id              UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role_id              UUID         NOT NULL REFERENCES tenant_shift_roles(id) ON DELETE RESTRICT,
    notes                TEXT         NULL,
    created_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW()
  );

  CREATE INDEX ssm_shift_role ON scheduled_shift_members (scheduled_shift_id, role_id);
  CREATE INDEX ssm_user       ON scheduled_shift_members (user_id);

  COMMENT ON TABLE scheduled_shift_members IS
    'SaaS v2: miembros asignados a un turno PROGRAMADO con su rol del catálogo tenant_shift_roles. Análogo a production_shift_members (runtime) pero para planning. Al activar el turno, los miembros se copian a production_shift_members.';
`

const down = `
  DROP TABLE IF EXISTS scheduled_shift_members;
`

module.exports = { up, down }
