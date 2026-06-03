'use strict'

/**
 * Mig 189 — separa "Órdenes de producción" y "Mis turnos" en permisos propios,
 * distintos del genérico `production:read`.
 *
 * Problema: el menú "Órdenes de producción" (planeación: la LISTA de órdenes) y
 * "Mis turnos" (los turnos del propio usuario) colgaban ambos de `production:read`.
 * Como la pantalla de Captura TAMBIÉN usa `production:read` (cola + detalle de
 * orden/turno), no se podía dar captura + mis-turnos a un operador SIN exponerle
 * la lista de planeación, ni dar órdenes a un planeador sin "Mis turnos".
 *
 * Solución (mismo patrón que mig 175 con read_schedule/read_history):
 *  - production:read            → base: cola de captura, detalle de orden/turno,
 *                                 validación, etc.
 *  - production:read_orders     → ver la LISTA de Órdenes de producción (planeación).
 *  - production:read_own_shifts → ver "Mis turnos" (los turnos del propio usuario).
 *
 * No rompemos a nadie: concedemos ambos a TODO rol que hoy tenga `production:read`
 * (conservan exactamente su acceso actual). Después el admin puede DESMARCAR uno
 * desde Configuración → Roles (p.ej. quitarle "Órdenes de producción" al capturista,
 * o "Mis turnos" a un planeador). super_admin los tiene por amarre global.
 */

const up = `
  -- 1. Permisos nuevos
  INSERT INTO permissions (resource, action, description) VALUES
    ('production', 'read_orders',
     'Ver la lista de Órdenes de producción (planeación)'),
    ('production', 'read_own_shifts',
     'Ver "Mis turnos": los turnos donde el usuario participa')
  ON CONFLICT (resource, action) DO NOTHING;

  -- 2. Amarrar a super_admin global (línea de defensa)
  INSERT INTO role_permissions (role_id, permission_id)
  SELECT r.id, p.id
    FROM roles r
    CROSS JOIN permissions p
   WHERE r.name = 'super_admin'
     AND r.tenant_id IS NULL
     AND p.resource = 'production'
     AND p.action IN ('read_orders', 'read_own_shifts')
   ON CONFLICT (role_id, permission_id) DO NOTHING;

  -- 3. Preservar acceso actual: todo rol que hoy tiene production:read conserva
  --    Órdenes + Mis turnos (antes ambas colgaban de production:read).
  INSERT INTO role_permissions (role_id, permission_id)
  SELECT DISTINCT rp.role_id, np.id
    FROM role_permissions rp
    JOIN permissions rdp ON rdp.id = rp.permission_id
                        AND rdp.resource = 'production' AND rdp.action = 'read'
    JOIN permissions np  ON np.resource = 'production'
                        AND np.action IN ('read_orders', 'read_own_shifts')
   ON CONFLICT (role_id, permission_id) DO NOTHING;
`

const down = `
  DELETE FROM role_permissions
   WHERE permission_id IN (
     SELECT id FROM permissions
      WHERE resource = 'production'
        AND action IN ('read_orders', 'read_own_shifts')
   );
  DELETE FROM permissions
   WHERE resource = 'production'
     AND action IN ('read_orders', 'read_own_shifts');
`

module.exports = { up, down }
