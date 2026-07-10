'use strict'

// Candado 1 (2026-07-10): ventana de inicio anticipado de turno.
// Cuántos minutos ANTES de la hora programada se permite iniciar un turno.
// Por defecto 30. Fuera de esa ventana, confirmPresence bloquea el inicio
// (salvo supervisores con production:manage). Evita que un operador confirme
// un turno horas antes de su hora y capture en el slot equivocado.

const up = `
  ALTER TABLE tenant_shift_config
    ADD COLUMN IF NOT EXISTS early_start_window_minutes SMALLINT NOT NULL DEFAULT 30;

  COMMENT ON COLUMN tenant_shift_config.early_start_window_minutes IS
    'Minutos antes de start_time en que se permite iniciar el turno. Fuera de la ventana, confirmPresence bloquea (salvo production:manage).';
`

const down = `
  ALTER TABLE tenant_shift_config DROP COLUMN IF EXISTS early_start_window_minutes;
`

module.exports = { up, down }
