'use strict'

/**
 * Sincroniza el rol de sistema `super_admin` con TODOS los permisos existentes.
 *
 * Histórico: el seed.js original asignó a super_admin solo los 14 permisos
 * conocidos en su momento (users, roles, settings, billing, audit_logs).
 * A partir de la migración 009 los módulos siguientes (business_partners,
 * production, inventory, sales, financials, etc.) registraron sus permisos
 * en la tabla `permissions` PERO NUNCA los amarraron al super_admin.
 *
 * Localmente esos amarres se hicieron a mano durante el desarrollo. En
 * cualquier BD nueva (Render prod, sandbox limpio, dev nuevo) super_admin
 * queda mutilado: tiene rol pero no permisos.
 *
 * Esta migración hace un sweep idempotente: cada permiso de la tabla
 * `permissions` queda amarrado al super_admin (system, tenant_id IS NULL).
 * Idempotente vía ON CONFLICT DO NOTHING.
 *
 * Futuro: cualquier permiso nuevo que insertes en migraciones posteriores
 * debe amarrarse a super_admin en la misma migración (ver patrón al final
 * de este archivo). Si te olvidas, esta migración no se re-ejecuta — quedará
 * la mutilación hasta correr otro sweep.
 */

const up = `
  INSERT INTO role_permissions (role_id, permission_id)
  SELECT r.id, p.id
    FROM roles r
   CROSS JOIN permissions p
   WHERE r.name = 'super_admin'
     AND r.tenant_id IS NULL
  ON CONFLICT (role_id, permission_id) DO NOTHING;
`

const down = `
  -- No-op: el rollback dejaría super_admin sin permisos, peor que el bug
  -- original. Si necesitas revertir, hazlo a mano.
  SELECT 1;
`

module.exports = { up, down }
