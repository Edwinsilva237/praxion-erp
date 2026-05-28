'use strict'

/**
 * Mig 159 — backfill de process_config a roles que ya tenían settings:read|update.
 *
 * Sigue al cambio en frontend `Configuracion/procesos/Flags.jsx` (pantalla de
 * banderas globales del Process Template): pasó de mirar `settings:update`
 * a mirar `process_config:update`, alineado con lo que el backend ya verificaba.
 *
 * Sin este backfill, los roles del tenant que hoy operan los flags vía
 * `settings:update` perderían visibilidad del botón Guardar en esa pantalla.
 *
 * Idempotente vía ON CONFLICT.
 */

const up = `
  WITH pairs(old_resource, old_action, new_resource, new_action) AS (
    VALUES
      ('settings', 'read',   'process_config', 'read'),
      ('settings', 'update', 'process_config', 'update')
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
  -- No-op: el rollback dejaría roles sin process_config:* que ya estaban
  -- operando esa pantalla. Si se requiere revertir, hazlo a mano por rol.
  SELECT 1;
`

module.exports = { up, down }
