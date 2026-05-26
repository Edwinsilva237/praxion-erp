'use strict'

/**
 * Agrega la columna `neighborhood` (colonia) a business_partners.
 *
 * Motivación: el formulario de Socios pide la colonia del domicilio fiscal
 * y el parser de CSF la extrae, pero la migración 017 solo agregó esa
 * columna a `delivery_addresses`, no a `business_partners`. Cualquier
 * intento de guardar el campo desde el formulario fallaba con
 * "column \"neighborhood\" does not exist".
 */

const up = `
  ALTER TABLE business_partners
    ADD COLUMN IF NOT EXISTS neighborhood VARCHAR(150);

  COMMENT ON COLUMN business_partners.neighborhood IS 'Colonia del domicilio fiscal — extraída de CSF o capturada manualmente';
`

const down = `
  ALTER TABLE business_partners DROP COLUMN IF EXISTS neighborhood;
`

module.exports = { up, down }
