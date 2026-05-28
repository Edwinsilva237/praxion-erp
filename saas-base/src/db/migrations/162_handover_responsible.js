'use strict'

/**
 * Mig 162 — Responsable del handover por turno.
 *
 * Contexto (sesión 2026-05-29, continuación del refactor de roles dinámicos):
 *  El admin del tenant puede designar al programar el turno qué miembro
 *  específico es el responsable de la entrega/recepción del handover. La
 *  designación es opcional — si nadie está marcado, cualquier miembro con
 *  `can_handover=true` puede ejecutar, como hoy.
 *
 *  La designación se puede asignar a cualquier miembro del turno (no se filtra
 *  por can_handover del catálogo). Esto da libertad operativa: si un supervisor
 *  que no es de rol "handover" por default necesita firmar la entrega, el admin
 *  lo designa al momento de programar (o durante el turno si algo cambia).
 *
 *  Aplica a ambos lados del handover (un solo flag cubre los dos):
 *   - Cuando el turno X cierra, su responsable firma la entrega.
 *   - Cuando el turno X arranca recibiendo del anterior, su responsable firma
 *     la recepción.
 *
 *  Editable durante el turno activo: si ocurre algo a media corrida (relevo,
 *  ausencia del designado), el supervisor reasigna el responsable via
 *  POST /api/production/shifts/:id/set-handover-responsible.
 *
 * Constraint: máximo 1 miembro con is_handover_responsible=true por turno.
 *  El UNIQUE partial index lo garantiza a nivel de BD. El service también
 *  desmarca al anterior al asignar uno nuevo para evitar conflict 409.
 */

const up = `
  -- Planning
  ALTER TABLE scheduled_shift_members
    ADD COLUMN is_handover_responsible BOOLEAN NOT NULL DEFAULT false;

  CREATE UNIQUE INDEX ssm_one_handover_responsible_per_shift
    ON scheduled_shift_members (scheduled_shift_id)
    WHERE is_handover_responsible = true;

  -- Runtime
  ALTER TABLE production_shift_members
    ADD COLUMN is_handover_responsible BOOLEAN NOT NULL DEFAULT false;

  CREATE UNIQUE INDEX psm_one_handover_responsible_per_shift
    ON production_shift_members (shift_id)
    WHERE is_handover_responsible = true AND left_at IS NULL;

  COMMENT ON COLUMN scheduled_shift_members.is_handover_responsible IS
    'true: este miembro firma la entrega cuando el turno cierra y la recepción cuando arranca. Máx 1 por turno (índice UNIQUE parcial).';
  COMMENT ON COLUMN production_shift_members.is_handover_responsible IS
    'true: este miembro firma la entrega/recepción del turno. Editable en runtime via /shifts/:id/set-handover-responsible.';
`

const down = `
  DROP INDEX IF EXISTS psm_one_handover_responsible_per_shift;
  ALTER TABLE production_shift_members DROP COLUMN IF EXISTS is_handover_responsible;
  DROP INDEX IF EXISTS ssm_one_handover_responsible_per_shift;
  ALTER TABLE scheduled_shift_members  DROP COLUMN IF EXISTS is_handover_responsible;
`

module.exports = { up, down }
