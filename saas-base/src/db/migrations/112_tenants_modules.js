'use strict'

/**
 * Interruptores de módulo por tenant.
 *
 * Lista negativa: missing|true = encendido, false = apagado. Así los tenants
 * existentes (con {} por default) tienen TODO encendido, y solo guardamos
 * las excepciones cuando un módulo se apaga explícitamente.
 *
 * Keys soportadas (espejo de la nav lateral):
 *   invoicing, production, inventory, purchases, quotations, sales,
 *   petty_cash, reports
 *
 * El middleware requireModule(key) lee este JSONB y devuelve 403 cuando el
 * módulo está apagado para ese tenant.
 */

const up = `
  ALTER TABLE tenants
    ADD COLUMN IF NOT EXISTS modules JSONB NOT NULL DEFAULT '{}'::jsonb;
`

const down = `
  ALTER TABLE tenants DROP COLUMN IF EXISTS modules;
`

module.exports = { up, down }
