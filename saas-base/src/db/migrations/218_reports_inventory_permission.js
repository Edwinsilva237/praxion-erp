'use strict'

/**
 * Mig 218 — permiso `reports:inventory` para el nuevo reporte de Inventario
 * (valor y existencias, Excel + PDF).
 *
 * Se otorga automáticamente a TODO rol que ya tenga algún permiso de `reports`
 * (owner, admin, comercial, super_admin, etc.) para que quien ya ve reportes
 * obtenga también el de inventario sin reconfigurar.
 */

const up = `
  INSERT INTO permissions (resource, action, description) VALUES
    ('reports', 'inventory', 'Ver reporte de Inventario')
  ON CONFLICT (resource, action) DO NOTHING;

  -- Otorgar a roles que YA tengan cualquier permiso de reports.
  INSERT INTO role_permissions (role_id, permission_id)
  SELECT DISTINCT rp.role_id, pnew.id
    FROM role_permissions rp
    JOIN permissions pexist ON pexist.id = rp.permission_id AND pexist.resource = 'reports'
    CROSS JOIN permissions pnew
   WHERE pnew.resource = 'reports' AND pnew.action = 'inventory'
     AND NOT EXISTS (
       SELECT 1 FROM role_permissions rp2
        WHERE rp2.role_id = rp.role_id AND rp2.permission_id = pnew.id
     );

  -- Asegurar el super_admin global.
  INSERT INTO role_permissions (role_id, permission_id)
  SELECT r.id, p.id
    FROM roles r CROSS JOIN permissions p
   WHERE r.name = 'super_admin' AND p.resource = 'reports' AND p.action = 'inventory'
     AND NOT EXISTS (
       SELECT 1 FROM role_permissions rp WHERE rp.role_id = r.id AND rp.permission_id = p.id
     );
`

const down = `
  DELETE FROM role_permissions
   WHERE permission_id IN (SELECT id FROM permissions WHERE resource = 'reports' AND action = 'inventory');
  DELETE FROM permissions WHERE resource = 'reports' AND action = 'inventory';
`

module.exports = { up, down }
