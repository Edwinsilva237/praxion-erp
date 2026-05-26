'use strict'

/**
 * Marca de "super-admin de la plataforma" (dueño de Praxion).
 *
 * Un usuario con is_platform_admin=true puede acceder al panel cross-tenant
 * en /api/platform-admin/* — listar todos los tenants, crearlos, suspenderlos
 * y activar/desactivar módulos. Es ortogonal al sistema de roles per-tenant.
 *
 * Defecto FALSE para no afectar a usuarios existentes. La marca se asigna
 * manualmente con scripts/set-platform-admin.js sobre un usuario ya creado.
 */

const up = `
  ALTER TABLE users
    ADD COLUMN IF NOT EXISTS is_platform_admin BOOLEAN NOT NULL DEFAULT FALSE;

  CREATE INDEX IF NOT EXISTS idx_users_platform_admin
    ON users (is_platform_admin) WHERE is_platform_admin = TRUE;
`

const down = `
  DROP INDEX IF EXISTS idx_users_platform_admin;
  ALTER TABLE users DROP COLUMN IF EXISTS is_platform_admin;
`

module.exports = { up, down }
