'use strict'

/**
 * Mig 201 — reparación de datos: scheduled_shifts atorados en 'active'.
 *
 * Bug (reportado 2026-06-09): `scheduled_shifts.status` pasa a 'active' al
 * confirmar presencia, pero NUNCA tenía transición a estado terminal cuando el
 * turno real (`production_shifts`) se valida. Resultado: en la cuadrícula de
 * Programación los turnos ya validados se ven "activos" para siempre, mientras
 * que Captura (que lee production_shifts) correctamente dice "no hay turno
 * activo". Desincronización entre el PLAN (scheduled_shifts) y la OPERACIÓN
 * (production_shifts).
 *
 * La corrección hacia adelante vive en productionService.validateShift (al
 * validar, marca el scheduled_shift ligado como 'completed'). Esta migración
 * repara los registros YA atorados: scheduled_shifts en 'active' cuyo turno real
 * ligado ya está en un estado terminal → 'completed'.
 *
 * El ENUM scheduled_shift_status ya incluía 'completed' (mig 037), solo no se
 * usaba. Idempotente: re-correr afecta 0 filas.
 */

const up = `
  UPDATE scheduled_shifts ss
     SET status = 'completed'
    FROM production_shifts ps
   WHERE ps.id = ss.shift_id
     AND ss.status = 'active'
     AND ps.status IN ('reviewed', 'pending_management', 'closed');
`

// Sin down reversible: no podemos saber con certeza cuáles eran 'active' antes
// del backfill (la corrección hacia adelante ya impide que se vuelvan a atorar),
// y revertir a 'active' reintroduciría el bug visual. No-op seguro.
const down = `
  -- No-op: el backfill no es reversible de forma segura (ver nota arriba).
`

module.exports = { up, down }
