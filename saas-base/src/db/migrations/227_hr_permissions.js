'use strict'

/**
 * Mig 227 — permisos del módulo de RH (`hr`).
 *
 *   hr:read   — ver empleados, periodos vacacionales y saldos.
 *   hr:manage — alta/edición de empleados, generar periodos, registrar días
 *               tomados/ajustes y editar la tabla de días por antigüedad.
 *
 * Se otorgan a los roles que administran el tenant (owner, admin) + super_admin
 * global. NO se dan a roles operativos: RH es información sensible (salarios).
 * Patrón de la mig 218.
 */

const up = `
  INSERT INTO permissions (resource, action, description) VALUES
    ('hr', 'read',   'Ver empleados y vacaciones (RH)'),
    ('hr', 'manage', 'Administrar empleados y periodos vacacionales (RH)')
  ON CONFLICT (resource, action) DO NOTHING;

  -- Otorgar a roles que administran el tenant: los que ya tienen users:create
  -- (owner/admin). Cubre el rol dueño de cada tenant sin nombrarlo por nombre.
  INSERT INTO role_permissions (role_id, permission_id)
  SELECT DISTINCT rp.role_id, pnew.id
    FROM role_permissions rp
    JOIN permissions padmin ON padmin.id = rp.permission_id
                           AND padmin.resource = 'users' AND padmin.action = 'create'
    CROSS JOIN permissions pnew
   WHERE pnew.resource = 'hr'
     AND NOT EXISTS (
       SELECT 1 FROM role_permissions rp2
        WHERE rp2.role_id = rp.role_id AND rp2.permission_id = pnew.id
     );

  -- Asegurar el super_admin global.
  INSERT INTO role_permissions (role_id, permission_id)
  SELECT r.id, p.id
    FROM roles r CROSS JOIN permissions p
   WHERE r.name = 'super_admin' AND p.resource = 'hr'
     AND NOT EXISTS (
       SELECT 1 FROM role_permissions rp WHERE rp.role_id = r.id AND rp.permission_id = p.id
     );
`

const down = `
  DELETE FROM role_permissions
   WHERE permission_id IN (SELECT id FROM permissions WHERE resource = 'hr');
  DELETE FROM permissions WHERE resource = 'hr';
`

module.exports = { up, down }
