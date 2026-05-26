'use strict'

// ─────────────────────────────────────────────────────────────────────────────
// 061_production_granular_permissions.js
// Crea 2 permisos granulares para el módulo de producción y los asigna al
// rol `member` (operadores) y `admin`.
//
// Motivación: el operador necesita poder hacer 2 acciones específicas que
// antes requerían `production:update` (un permiso muy amplio que también
// permite liberar/editar/cancelar órdenes y validar turnos de otros).
//
//   - change_formula:   cambiar la mezcla de MP cuando se queda sin un
//                       material durante la captura.
//   - close_own_shift:  cerrar SU PROPIO turno para iniciar handover.
//                       (El service ya valida que operator_id = userId, así
//                       que el alcance real está acotado al propio turno).
//
// Los endpoints correspondientes pasan a usar estos permisos granulares en
// lugar de production:update.
// ─────────────────────────────────────────────────────────────────────────────

const up = `
  -- 1. Crear los nuevos permisos granulares
  INSERT INTO permissions (resource, action, description) VALUES
    ('production', 'change_formula',  'Cambiar la fórmula de mezcla de MP en una orden en curso'),
    ('production', 'close_own_shift', 'Cerrar el propio turno de producción (handover)')
  ON CONFLICT (resource, action) DO NOTHING;

  -- 2. Asignarlos a los roles member y admin
  --    (super_admin hace bypass por rol, no necesita asignación explícita)
  INSERT INTO role_permissions (role_id, permission_id)
  SELECT r.id, p.id
  FROM roles r
  CROSS JOIN permissions p
  WHERE r.name IN ('member', 'admin')
    AND p.resource = 'production'
    AND p.action IN ('change_formula', 'close_own_shift')
  ON CONFLICT DO NOTHING;
`

const down = `
  -- Eliminar asignaciones de los permisos granulares
  DELETE FROM role_permissions
  WHERE permission_id IN (
    SELECT id FROM permissions
    WHERE resource = 'production'
      AND action IN ('change_formula', 'close_own_shift')
  );

  -- Eliminar los permisos
  DELETE FROM permissions
  WHERE resource = 'production'
    AND action IN ('change_formula', 'close_own_shift');
`

module.exports = { up, down }
