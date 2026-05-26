'use strict'

/**
 * SaaS v2 — Migration 119: permisos genéricos tenant_catalogs:*
 *
 * Crea un par de permisos que cubren TODOS los catálogos del tenant del
 * Process Template:
 *   - tenant_units, tenant_unit_conversions
 *   - tenant_warehouse_types (próx)
 *   - tenant_scrap_types (próx)
 *   - tenant_quality_grades (próx)
 *   - tenant_shift_roles (próx)
 *   - tenant_product_kinds (próx)
 *
 * Decisión: un par único de permisos (read/update) para todos los catálogos
 * en lugar de uno por catálogo (units:read, scrap_types:read, etc.). Razón:
 *  - Quien configura el tenant suele tener acceso a TODOS los catálogos.
 *  - Granularidad por catálogo agrega complejidad sin valor en MVP.
 *  - Si en el futuro se necesita finura, se puede agregar permisos
 *    específicos para casos puntuales sin romper este patrón.
 */

const up = `
  INSERT INTO permissions (resource, action, description) VALUES
    ('tenant_catalogs', 'read',   'Ver catálogos del tenant (unidades, almacenes, mermas, calidades, etc.) del Process Template'),
    ('tenant_catalogs', 'update', 'Crear/editar/desactivar catálogos del tenant (unidades, almacenes, mermas, etc.)')
  ON CONFLICT (resource, action) DO NOTHING;

  -- Asignar a super_admin global
  INSERT INTO role_permissions (role_id, permission_id)
  SELECT r.id, p.id
    FROM roles r
    CROSS JOIN permissions p
   WHERE r.name = 'super_admin'
     AND p.resource = 'tenant_catalogs'
     AND NOT EXISTS (
       SELECT 1 FROM role_permissions rp
        WHERE rp.role_id = r.id AND rp.permission_id = p.id
     );

  -- Asignar a roles que ya tienen tenants:read (proxy para "admin del tenant")
  INSERT INTO role_permissions (role_id, permission_id)
  SELECT DISTINCT r.id, p.id
    FROM roles r
    JOIN role_permissions rp_existing ON rp_existing.role_id = r.id
    JOIN permissions p_existing ON p_existing.id = rp_existing.permission_id
                              AND p_existing.resource = 'tenants'
                              AND p_existing.action = 'read'
    CROSS JOIN permissions p
   WHERE p.resource = 'tenant_catalogs'
     AND NOT EXISTS (
       SELECT 1 FROM role_permissions rp
        WHERE rp.role_id = r.id AND rp.permission_id = p.id
     );
`

const down = `
  DELETE FROM permissions WHERE resource = 'tenant_catalogs';
`

module.exports = { up, down }
