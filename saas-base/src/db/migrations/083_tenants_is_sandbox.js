'use strict'

/**
 * Marca un tenant como ambiente de pruebas (sandbox). Cuando is_sandbox=true:
 *   - El timbrado a Facturapi usa la API key de prueba (FACTURAPI_KEY_TEST),
 *     no consume créditos reales ni genera CFDIs con validez fiscal.
 *   - El frontend muestra un banner permanente "MODO SANDBOX".
 *   - El script `npm run reset:sandbox` borra todos los movimientos
 *     transaccionales del tenant preservando catálogos.
 *
 * El flag es por-tenant para permitir tener prod y sandbox coexistiendo
 * en la misma base de datos.
 */

const up = `
  ALTER TABLE tenants
    ADD COLUMN IF NOT EXISTS is_sandbox BOOLEAN NOT NULL DEFAULT FALSE;

  COMMENT ON COLUMN tenants.is_sandbox IS
    'Si TRUE, el tenant opera en modo pruebas: Facturapi usa key de test, UI muestra banner, datos son reseteables.';

  CREATE INDEX idx_tenants_sandbox ON tenants (is_sandbox) WHERE is_sandbox = TRUE;
`

const down = `
  DROP INDEX IF EXISTS idx_tenants_sandbox;
  ALTER TABLE tenants DROP COLUMN IF EXISTS is_sandbox;
`

module.exports = { up, down }
