'use strict'

/**
 * Permisos faltantes del recurso "financials".
 *
 * Bug histórico: el backend de bank-accounts y financials usa
 * checkPermission('financials', 'read'|'create'|'update'|'delete')
 * pero esos permisos nunca se insertaron en la tabla `permissions`.
 *
 * Resultado: CxC, CxP, Anticipos, Cuentas bancarias y todas las rutas
 * de pagos solo funcionaban para usuarios con rol super_admin (que tiene
 * comodín "*"). Cualquier rol propio del tenant recibía 403 al intentar
 * usar esas pantallas — aunque el sidebar pareciera mostrarlas, no
 * pasaba nada o el backend devolvía error.
 *
 * Esta migración los crea y los asigna automáticamente al super_admin.
 * Los roles del tenant existentes NO los reciben automáticamente — el
 * admin debe marcarlos manualmente desde el editor de roles. Esto es
 * intencional para no abrir permisos sin que alguien revise.
 */

const up = `
  INSERT INTO permissions (resource, action, description) VALUES
    ('financials', 'read',   'Ver pagos, CxC, CxP, anticipos y cuentas bancarias'),
    ('financials', 'create', 'Registrar pagos, anticipos y crear cuentas bancarias'),
    ('financials', 'update', 'Editar pagos, anticipos y cuentas bancarias'),
    ('financials', 'delete', 'Eliminar o desactivar cuentas bancarias y pagos')
  ON CONFLICT (resource, action) DO NOTHING;

  -- Asignar al super_admin global
  INSERT INTO role_permissions (role_id, permission_id)
  SELECT r.id, p.id
    FROM roles r
    CROSS JOIN permissions p
   WHERE r.name = 'super_admin'
     AND p.resource = 'financials'
     AND NOT EXISTS (
       SELECT 1 FROM role_permissions rp
        WHERE rp.role_id = r.id AND rp.permission_id = p.id
     );
`

const down = `
  DELETE FROM permissions WHERE resource = 'financials';
`

module.exports = { up, down }
