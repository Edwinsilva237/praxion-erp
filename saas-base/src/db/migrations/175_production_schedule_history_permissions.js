'use strict'

/**
 * Mig 175 — separa "Programación" (ver todos los turnos) e "Histórico" en
 * permisos propios, distintos del genérico `production:read`.
 *
 * Problema (reportado 2026-05-30):
 *  El menú "Programación" (calendario con TODOS los turnos de la planta) y el
 *  "Histórico" colgaban ambos de `production:read`. Como la pantalla de Captura
 *  TAMBIÉN requiere `production:read` (cola de órdenes), no se podía dar captura
 *  sin exponer la programación de toda la planta y el histórico. El admin no
 *  podía quitarle esos dos al rol de "capturista".
 *
 * Solución:
 *  - production:read           → queda como base: órdenes, cola de captura,
 *                                detalle de turno y la nueva vista "Mis turnos".
 *  - production:read_schedule  → ver la PROGRAMACIÓN de todos los turnos.
 *  - production:read_history   → ver el HISTÓRICO de turnos cerrados/validados.
 *
 * No rompemos a nadie: concedemos los dos permisos nuevos a TODO rol que hoy
 * tenga `production:read` (conservan exactamente su acceso actual). Después, el
 * admin puede DESMARCAR "Programación" e "Histórico" al rol de capturista desde
 * Configuración → Roles. Las plantillas de rol nuevas ya distinguen: supervisor
 * los incluye, capturista no.
 */

const up = `
  -- 1. Permisos nuevos
  INSERT INTO permissions (resource, action, description) VALUES
    ('production', 'read_schedule',
     'Ver la programación de todos los turnos de la planta (calendario de planeación)'),
    ('production', 'read_history',
     'Ver el histórico de turnos cerrados y validados')
  ON CONFLICT (resource, action) DO NOTHING;

  -- 2. Amarrar a super_admin global (línea de defensa)
  INSERT INTO role_permissions (role_id, permission_id)
  SELECT r.id, p.id
    FROM roles r
    CROSS JOIN permissions p
   WHERE r.name = 'super_admin'
     AND r.tenant_id IS NULL
     AND p.resource = 'production'
     AND p.action IN ('read_schedule', 'read_history')
   ON CONFLICT (role_id, permission_id) DO NOTHING;

  -- 3. Preservar acceso actual: todo rol que hoy tiene production:read conserva
  --    Programación + Histórico (antes ambos colgaban de production:read).
  INSERT INTO role_permissions (role_id, permission_id)
  SELECT DISTINCT rp.role_id, np.id
    FROM role_permissions rp
    JOIN permissions rdp ON rdp.id = rp.permission_id
                        AND rdp.resource = 'production' AND rdp.action = 'read'
    JOIN permissions np  ON np.resource = 'production'
                        AND np.action IN ('read_schedule', 'read_history')
   ON CONFLICT (role_id, permission_id) DO NOTHING;
`

const down = `
  DELETE FROM role_permissions
   WHERE permission_id IN (
     SELECT id FROM permissions
      WHERE resource = 'production'
        AND action IN ('read_schedule', 'read_history')
   );
  DELETE FROM permissions
   WHERE resource = 'production'
     AND action IN ('read_schedule', 'read_history');
`

module.exports = { up, down }
