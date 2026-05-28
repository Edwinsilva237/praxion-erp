'use strict'

/**
 * Mig 157 — separa los permisos de Materias Primas y de Trazabilidad de los
 * de Productos / Producción donde estaban cableados por inercia histórica.
 *
 * Contexto (sesión 2026-05-28):
 *  - `raw_materials:read|create|update` existían en BD pero estaban huérfanos
 *    porque los routes verificaban `products:*`. Marcar el sub-permiso de MP
 *    en un rol no hacía nada — el botón "Crear MP" se prendía con products:create.
 *  - `raw_materials:delete` no existía en BD.
 *  - `traceability:*` no existía en BD; los endpoints de trazabilidad y de lotes
 *    verificaban `production:read|update`, así que la única forma de dar acceso
 *    a Trazabilidad era abrir todo Producción.
 *
 * Esta migración:
 *  1) Inserta los permisos faltantes (raw_materials:delete + traceability:*).
 *  2) Amarra al super_admin global.
 *  3) Backfill por roles existentes: cualquier rol que hoy tenga
 *     - products:create → recibe raw_materials:create
 *     - products:update → recibe raw_materials:update
 *     - products:delete → recibe raw_materials:delete (nuevo)
 *     - products:read   → recibe raw_materials:read
 *     - production:read   → recibe traceability:read
 *     - production:update → recibe traceability:update
 *
 *  Sin el backfill, los roles propios del tenant perderían en silencio la
 *  capacidad de crear/editar MP y de consultar trazabilidad en el siguiente
 *  redeploy (porque routes ahora exigen los permisos nuevos).
 *
 * Acompañado de cambios en routes/raw-materials, routes/traceability y
 * routes/lots — ver commits siguientes en la misma sesión.
 */

const up = `
  -- 1. Permisos faltantes
  INSERT INTO permissions (resource, action, description) VALUES
    ('raw_materials', 'delete',  'Eliminar materias primas'),
    ('traceability',  'read',    'Consultar trazabilidad de lotes (búsqueda, expirations, recall)'),
    ('traceability',  'update',  'Ejecutar acciones de trazabilidad (correr chequeo de expiración, marcar lotes vencidos)')
  ON CONFLICT (resource, action) DO NOTHING;

  -- 2. Amarrar a super_admin global
  INSERT INTO role_permissions (role_id, permission_id)
  SELECT r.id, p.id
    FROM roles r
    CROSS JOIN permissions p
   WHERE r.name = 'super_admin'
     AND r.tenant_id IS NULL
     AND (
       (p.resource = 'raw_materials' AND p.action = 'delete') OR
       (p.resource = 'traceability'  AND p.action IN ('read','update'))
     )
   ON CONFLICT (role_id, permission_id) DO NOTHING;

  -- 3. Backfill por roles existentes (sistema + propios del tenant)
  --    Cada par viejo→nuevo se propaga para todos los roles que ya tenían el viejo.
  WITH pairs(old_resource, old_action, new_resource, new_action) AS (
    VALUES
      ('products',   'read',   'raw_materials', 'read'),
      ('products',   'create', 'raw_materials', 'create'),
      ('products',   'update', 'raw_materials', 'update'),
      ('products',   'delete', 'raw_materials', 'delete'),
      ('production', 'read',   'traceability',  'read'),
      ('production', 'update', 'traceability',  'update')
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
  -- Borrar amarres específicos (no toca super_admin si fue otorgado por mig 146 sweep posterior)
  DELETE FROM role_permissions rp
   USING permissions p
   WHERE rp.permission_id = p.id
     AND (
       (p.resource = 'raw_materials' AND p.action = 'delete') OR
       (p.resource = 'traceability'  AND p.action IN ('read','update'))
     );

  DELETE FROM permissions
   WHERE (resource = 'raw_materials' AND action = 'delete')
      OR (resource = 'traceability'  AND action IN ('read','update'));
`

module.exports = { up, down }
