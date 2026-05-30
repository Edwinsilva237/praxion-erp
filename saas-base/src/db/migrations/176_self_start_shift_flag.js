'use strict'

/**
 * Mig 176 — flag `allow_self_start_shift` para micro pymes.
 *
 * Contexto (2026-05-30):
 *  El flujo normal exige que un supervisor PROGRAME el turno antes de que el
 *  capturista pueda capturar (Captura requiere un turno del día). Para una
 *  micro pyme de un solo equipo que "siempre hace lo mismo", eso es ceremonia
 *  innecesaria: no hay planeación, simplemente llegan y producen.
 *
 *  Con este flag (opt-in, apagado por default) el capturista puede INICIAR su
 *  turno directamente desde la pantalla de Captura, sin programación previa.
 *  El sistema crea el production_shift activo con el usuario como operador
 *  (modo "inicia sesión y ejecuta"). Para tenants con planeación real el flag
 *  queda en false y el comportamiento es el de siempre.
 */

const up = `
  ALTER TABLE tenant_process_config
    ADD COLUMN allow_self_start_shift BOOLEAN NOT NULL DEFAULT false;

  COMMENT ON COLUMN tenant_process_config.allow_self_start_shift IS
    'true: el capturista inicia su turno directo desde Captura sin programación previa (micro pyme, "inicia y ejecuta"). false: requiere turno programado por un supervisor.';
`

const down = `
  ALTER TABLE tenant_process_config DROP COLUMN IF EXISTS allow_self_start_shift;
`

module.exports = { up, down }
