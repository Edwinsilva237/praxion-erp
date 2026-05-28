'use strict'

/**
 * Mig 158 — alinea los permisos de Almacenes y de Catálogos del Process Template
 * con los recursos semánticos correctos. Continuación de la mig 157, donde se
 * separaron raw_materials y traceability.
 *
 * Bug raíz (descubierto al auditar la pantalla de Roles):
 *  - `warehouses:read|create|update` existían en BD pero estaban huérfanos:
 *    `warehouseRoutes.js` verificaba `inventory:read|create`. Marcar el
 *    sub-permiso de Almacenes en un rol no hacía nada. Y `warehouses:delete`
 *    no existía como permiso registrable.
 *  - Las pantallas de catálogos del Process Template (Unidades, TiposProducto,
 *    Alergenos, TiposMerma, RolesTurno) miraban `settings:update` para decidir
 *    si mostrar botones, pero el backend verifica `tenant_catalogs:update`.
 *    En la práctica nadie podía editar los catálogos sin tener `settings:update`.
 *
 * Esta migración:
 *  1) Agrega warehouses:delete.
 *  2) Amarra los huérfanos al super_admin global.
 *  3) Backfill por roles existentes:
 *     - inventory:read   → warehouses:read
 *     - inventory:create → warehouses:create + warehouses:update + warehouses:delete
 *       (el backend usaba inventory:create para crear, editar, eliminar y
 *        set-default, así que todos los roles con ese permiso reciben los 4)
 *     - settings:read    → tenant_catalogs:read
 *     - settings:update  → tenant_catalogs:update
 *
 *  Sin el backfill, los routes recableados en esta sesión rechazarían a roles
 *  propios del tenant que hoy operan los catálogos vía settings:update.
 *
 *  Acompañado de cambios en routes/inventory/warehouseRoutes y en las
 *  pantallas Socios, Almacenes, Configuración/procesos/* (ver commits
 *  siguientes).
 */

const up = `
  -- 1. Permisos faltantes
  INSERT INTO permissions (resource, action, description) VALUES
    ('warehouses', 'delete', 'Eliminar almacenes (solo si no tienen stock ni movimientos)')
  ON CONFLICT (resource, action) DO NOTHING;

  -- 2. Amarrar a super_admin global (incluye los que ya existían huérfanos)
  INSERT INTO role_permissions (role_id, permission_id)
  SELECT r.id, p.id
    FROM roles r
    CROSS JOIN permissions p
   WHERE r.name = 'super_admin'
     AND r.tenant_id IS NULL
     AND (
       p.resource = 'warehouses' OR
       (p.resource = 'tenant_catalogs' AND p.action IN ('read','update'))
     )
   ON CONFLICT (role_id, permission_id) DO NOTHING;

  -- 3. Backfill por roles existentes
  WITH pairs(old_resource, old_action, new_resource, new_action) AS (
    VALUES
      ('inventory', 'read',   'warehouses',      'read'),
      ('inventory', 'create', 'warehouses',      'create'),
      ('inventory', 'create', 'warehouses',      'update'),
      ('inventory', 'create', 'warehouses',      'delete'),
      ('settings',  'read',   'tenant_catalogs', 'read'),
      ('settings',  'update', 'tenant_catalogs', 'update')
  )
  INSERT INTO role_permissions (role_id, permission_id)
  SELECT rp.role_id, p_new.id
    FROM pairs
    JOIN permissions p_old
      ON p_old.resource = pairs.old_resource AND p_old.action = pairs.old_action
    JOIN role_permissions rp
      ON rp.permission_id = p_old.id
    JOIN permissions p_new
      ON p_new.resource = pairs.new_resource AND p_new.action = pairs.new_action
   ON CONFLICT (role_id, permission_id) DO NOTHING;
`

const down = `
  -- Borrar amarres específicos de warehouses:delete (el resto preexistía).
  DELETE FROM role_permissions rp
   USING permissions p
   WHERE rp.permission_id = p.id
     AND p.resource = 'warehouses' AND p.action = 'delete';

  DELETE FROM permissions
   WHERE resource = 'warehouses' AND action = 'delete';
`

module.exports = { up, down }
