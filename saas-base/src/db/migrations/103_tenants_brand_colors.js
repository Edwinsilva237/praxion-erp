'use strict'

/**
 * Colores corporativos del tenant. Se usan para:
 *   - Personalizar el PDF del CFDI vía sync con Facturapi (organization.colors).
 *   - Vista previa en el dashboard.
 *
 * Formato: hex string con prefijo '#', ej. '#5E9F32'.
 */

const up = `
  ALTER TABLE tenants
    ADD COLUMN IF NOT EXISTS brand_color_primary   VARCHAR(7),
    ADD COLUMN IF NOT EXISTS brand_color_secondary VARCHAR(7);
`

const down = `
  ALTER TABLE tenants
    DROP COLUMN IF EXISTS brand_color_primary,
    DROP COLUMN IF EXISTS brand_color_secondary;
`

module.exports = { up, down }
