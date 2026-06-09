'use strict'

/**
 * Mig 200 — permiso `production:force_close` para que el rol `admin` pueda
 * forzar el cierre / finalización de un turno de producción AUNQUE no sea el
 * supervisor de ese turno.
 *
 * Problema operativo (reportado 2026-06-09): un operador termina su turno
 * ("Finalizar mi turno" → closeShift), el turno pasa a `pending_handover`
 * (cerrado, esperando validación) pero SIGUE apareciendo como "activo" en el
 * tablero (getActiveShifts incluye pending_handover). El siguiente operador
 * aterriza sobre ese turno y al capturar recibe "El turno no está activo".
 * La línea queda trabada hasta que un supervisor lo valida.
 *
 * El rol `admin` por defecto (ver db/seed.js) NO tiene `production:update`
 * —solo `change_formula` + `close_own_shift` de mig 061— así que NO podía
 * forzar el cierre ni validar (ambos endpoints piden `production:update`).
 *
 * Solución: permiso granular dedicado en vez de abrir el amplio
 * `production:update`. El endpoint POST /shifts/:id/force-close pasa a aceptar
 * `production:update` O `production:force_close` (checkAnyPermission), y
 * forceCloseShift finaliza el turno atorado para liberar la línea.
 *
 * Mismo patrón que mig 189: crear el permiso, amarrarlo a super_admin global y
 * concederlo a los roles `admin` (sistema + por-tenant). NO se concede a
 * `member` (los operadores no fuerzan cierres de otros).
 *
 * ⚠️ Los usuarios admin ya logueados deben RE-LOGUEAR (o refrescar /auth/me)
 * para que el nuevo permiso aparezca en su sesión.
 */

const up = `
  -- 1. Permiso nuevo
  INSERT INTO permissions (resource, action, description) VALUES
    ('production', 'force_close',
     'Forzar el cierre y finalización de un turno de producción atorado, sin ser su supervisor')
  ON CONFLICT (resource, action) DO NOTHING;

  -- 2. Amarrar a super_admin global (línea de defensa)
  INSERT INTO role_permissions (role_id, permission_id)
  SELECT r.id, p.id
    FROM roles r
    CROSS JOIN permissions p
   WHERE r.name = 'super_admin'
     AND r.tenant_id IS NULL
     AND p.resource = 'production'
     AND p.action = 'force_close'
   ON CONFLICT (role_id, permission_id) DO NOTHING;

  -- 3. Conceder a todos los roles 'admin' (sistema + por-tenant).
  INSERT INTO role_permissions (role_id, permission_id)
  SELECT r.id, p.id
    FROM roles r
    CROSS JOIN permissions p
   WHERE r.name = 'admin'
     AND p.resource = 'production'
     AND p.action = 'force_close'
   ON CONFLICT (role_id, permission_id) DO NOTHING;
`

const down = `
  DELETE FROM role_permissions
   WHERE permission_id IN (
     SELECT id FROM permissions
      WHERE resource = 'production' AND action = 'force_close'
   );
  DELETE FROM permissions
   WHERE resource = 'production' AND action = 'force_close';
`

module.exports = { up, down }
