'use strict'

/**
 * Branding por tenant.
 *
 * Cada cliente puede subir su propio logo y definir el nombre comercial que
 * verá en su panel (sidebar, topbar, recibos, etc.). La marca Praxion
 * Systems sigue siendo del producto (Login, favicon, emails del sistema).
 *
 *   - display_name        — nombre comercial que mostrar dentro del panel.
 *                           Si NULL, frontend usa `name`.
 *   - logo_storage_path   — key opaco que apunta al storage (R2 o disco)
 *                           del archivo de logo subido. NULL = sin logo
 *                           (frontend muestra fallback Praxion).
 */

const up = `
  ALTER TABLE tenants
    ADD COLUMN IF NOT EXISTS display_name      VARCHAR(120),
    ADD COLUMN IF NOT EXISTS logo_storage_path VARCHAR(500);
`

const down = `
  ALTER TABLE tenants
    DROP COLUMN IF EXISTS display_name,
    DROP COLUMN IF EXISTS logo_storage_path;
`

module.exports = { up, down }
