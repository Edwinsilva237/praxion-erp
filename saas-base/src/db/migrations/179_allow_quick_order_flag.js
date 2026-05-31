'use strict'

/**
 * Mig 179 — sub-flag `allow_quick_order` para micro pyme.
 *
 * Contexto (2026-05-30):
 *  `allow_self_start_shift` (mig 176) deja al operador iniciar su turno sin
 *  programación. Por default eso es CON ÓRDENES FORZOSAS: el operador debe
 *  elegir una orden ya creada de la cola (el dueño mantiene el control de qué
 *  se produce).
 *
 *  Este sub-flag (opt-in, default false; solo aplica si allow_self_start_shift
 *  está activo) habilita además el "inicio rápido": el operador puede crear la
 *  orden al vuelo (producto + cantidad) sin que el dueño la prepare antes. Útil
 *  para el micro-pyme unipersonal; se deja apagado cuando el dueño quiere que
 *  solo se produzcan órdenes que él autorizó.
 */

const up = `
  ALTER TABLE tenant_process_config
    ADD COLUMN allow_quick_order BOOLEAN NOT NULL DEFAULT false;

  COMMENT ON COLUMN tenant_process_config.allow_quick_order IS
    'Sub-opción de micro pyme (requiere allow_self_start_shift). true: el operador puede crear la orden al iniciar el turno (inicio rápido). false: debe elegir una orden ya creada.';
`

const down = `
  ALTER TABLE tenant_process_config DROP COLUMN IF EXISTS allow_quick_order;
`

module.exports = { up, down }
