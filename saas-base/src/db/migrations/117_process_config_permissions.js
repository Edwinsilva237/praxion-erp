'use strict'

/**
 * SaaS v2 — Migration 117: permisos para process_config
 *
 * Crea los permisos process_config:read y process_config:update y los asigna
 * al super_admin global y a los roles existentes que ya tengan permisos de
 * 'tenants:read' (proxy para "rol de admin del tenant").
 *
 * Esto permite que el admin del tenant pueda leer y modificar su config
 * sin que el platform admin tenga que asignarlo manualmente a cada tenant.
 *
 * Decisión: asignamos solo a roles que ya tienen tenants:read (típicamente
 * owner/admin). Otros roles deben pedir el permiso explícitamente desde el
 * editor de roles — esto evita abrir un permiso sensible por accidente.
 */

const up = `
  -- 1. Crear los permisos
  INSERT INTO permissions (resource, action, description) VALUES
    ('process_config', 'read',   'Ver la configuración del Process Template del tenant (flags globales)'),
    ('process_config', 'update', 'Modificar la configuración del Process Template del tenant')
  ON CONFLICT (resource, action) DO NOTHING;

  -- 2. Asignar al super_admin global
  INSERT INTO role_permissions (role_id, permission_id)
  SELECT r.id, p.id
    FROM roles r
    CROSS JOIN permissions p
   WHERE r.name = 'super_admin'
     AND p.resource = 'process_config'
     AND NOT EXISTS (
       SELECT 1 FROM role_permissions rp
        WHERE rp.role_id = r.id AND rp.permission_id = p.id
     );

  -- 3. Asignar a roles del tenant que ya tienen tenants:read
  --    (proxy para "rol de admin del tenant")
  INSERT INTO role_permissions (role_id, permission_id)
  SELECT DISTINCT r.id, p.id
    FROM roles r
    JOIN role_permissions rp_existing ON rp_existing.role_id = r.id
    JOIN permissions p_existing ON p_existing.id = rp_existing.permission_id
                              AND p_existing.resource = 'tenants'
                              AND p_existing.action = 'read'
    CROSS JOIN permissions p
   WHERE p.resource = 'process_config'
     AND NOT EXISTS (
       SELECT 1 FROM role_permissions rp
        WHERE rp.role_id = r.id AND rp.permission_id = p.id
     );
`

const down = `
  DELETE FROM permissions WHERE resource = 'process_config';
`

module.exports = { up, down }
