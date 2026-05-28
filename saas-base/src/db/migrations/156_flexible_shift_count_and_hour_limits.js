'use strict'

/**
 * SaaS v2 — soporte para 1–N turnos por tenant + límites de horas para
 * detectar y registrar tiempo extra al programar turnos.
 *
 * Motivación (sesión 2026-05-28):
 *   El modelo previo asumía exactamente 3 turnos numerados 1, 2, 3. Eso choca
 *   con verticales reales: panaderías con un solo turno matutino, pastelería
 *   con turno partido (modelado como 2 turnos al mismo operador), industria
 *   continua con 4 turnos rotativos.
 *
 *   El ENUM `shift_number` se extiende a '4', '5', '6' — margen pragmático.
 *   El CHECK estático en `tenant_shift_config` se elimina para permitir 1 ó N
 *   filas por tenant.
 *
 *   Se agregan max_hours_per_day y max_hours_per_week a tenant_process_config.
 *   Defaults: 9 y 48 (LFT 61). Validación de exceso vive en la app
 *   (scheduledShiftService) — el contrato de BD permite cualquier número de
 *   turnos al mismo operador; la decisión "es tiempo extra" la toma el
 *   supervisor en la UI y queda registrada en audit_logs.
 */

const up = `
  -- 1. Extender el ENUM shift_number para aceptar hasta 6 turnos.
  --    Las tablas production_shifts y scheduled_shifts usan este tipo.
  ALTER TYPE shift_number ADD VALUE IF NOT EXISTS '4';
  ALTER TYPE shift_number ADD VALUE IF NOT EXISTS '5';
  ALTER TYPE shift_number ADD VALUE IF NOT EXISTS '6';

  -- 2. Quitar el CHECK shift_number IN (1,2,3) de tenant_shift_config.
  --    El nombre del constraint lo asigna Postgres automáticamente; lo
  --    referenciamos por convención (<tabla>_<columna>_check).
  ALTER TABLE tenant_shift_config
    DROP CONSTRAINT IF EXISTS tenant_shift_config_shift_number_check;

  --    Sustituirlo por uno más permisivo (1..99) que sigue protegiendo
  --    contra valores nulos/negativos sin limitar la cantidad razonable.
  ALTER TABLE tenant_shift_config
    ADD CONSTRAINT tenant_shift_config_shift_number_check
    CHECK (shift_number BETWEEN 1 AND 99);

  -- 3. Límites de horas por operador en tenant_process_config.
  ALTER TABLE tenant_process_config
    ADD COLUMN IF NOT EXISTS max_hours_per_day  SMALLINT NOT NULL DEFAULT 9
      CHECK (max_hours_per_day BETWEEN 1 AND 24);

  ALTER TABLE tenant_process_config
    ADD COLUMN IF NOT EXISTS max_hours_per_week SMALLINT NOT NULL DEFAULT 48
      CHECK (max_hours_per_week BETWEEN 1 AND 168);

  COMMENT ON COLUMN tenant_process_config.max_hours_per_day IS
    'Horas máximas que un operador puede tener programadas en un mismo día. Default 9 (LFT 61). Excederlo marca el turno como tiempo extra en audit_logs.';
  COMMENT ON COLUMN tenant_process_config.max_hours_per_week IS
    'Horas máximas semanales por operador. Default 48 (LFT 61). Solo se reporta en audit_logs; no bloquea.';
`

const down = `
  ALTER TABLE tenant_process_config DROP COLUMN IF EXISTS max_hours_per_week;
  ALTER TABLE tenant_process_config DROP COLUMN IF EXISTS max_hours_per_day;

  ALTER TABLE tenant_shift_config
    DROP CONSTRAINT IF EXISTS tenant_shift_config_shift_number_check;

  -- Backfill: si hay turnos > 3 al hacer rollback, los bajamos a NULL/1 para
  -- que el CHECK viejo no truene. El operador que hace rollback acepta perder
  -- esos turnos extra (no hay forma de meter '4' en un ENUM que solo aceptaba 3).
  DELETE FROM tenant_shift_config WHERE shift_number NOT IN (1, 2, 3);

  ALTER TABLE tenant_shift_config
    ADD CONSTRAINT tenant_shift_config_shift_number_check
    CHECK (shift_number IN (1, 2, 3));

  -- Nota: ALTER TYPE shift_number DROP VALUE no existe en Postgres. Los valores
  -- '4', '5', '6' quedan en el ENUM aunque ya no se usen — es inofensivo.
`

module.exports = { up, down }
