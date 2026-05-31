'use strict'

/**
 * SaaS v2 §Fase3 — Servicio de aplicación de overhead a turnos.
 *
 * Se llama al cerrar un turno (desde productionService.closeShift).
 * Distribuye el overhead estimado de los períodos activos al turno recién cerrado.
 *
 * NUNCA bloquea el cierre del turno: el caller lo envuelve en try/catch.
 */

const { query, withBypass } = require('../../db')

/**
 * Calcula el valor de la base de imputación (basis_value) para un turno
 * según el allocation_base del ítem.
 *
 * @param {string} allocationBase  shifts | hours | units | weight | equal
 * @param {{ startedAt, endedAt, totalKgProduced, totalUnitsProduced }} shiftData
 * @returns {number}
 */
function computeBasisValue(allocationBase, shiftData) {
  const { startedAt, endedAt, totalKgProduced, totalUnitsProduced } = shiftData

  switch (allocationBase) {
    case 'shifts':
    case 'equal':
      return 1

    case 'hours': {
      const start = startedAt instanceof Date ? startedAt : new Date(startedAt)
      const end   = endedAt   instanceof Date ? endedAt   : new Date(endedAt)
      const diffMs = end.getTime() - start.getTime()
      return Math.max(0, diffMs / (1000 * 60 * 60))
    }

    case 'units':
      return Math.max(0, parseFloat(totalUnitsProduced) || 0)

    case 'weight':
      return Math.max(0, parseFloat(totalKgProduced) || 0)

    default:
      return 1
  }
}

/**
 * Aplica el overhead estimado al turno recién cerrado.
 *
 * 1. Busca períodos activos (no finalizados) cuyo rango de fechas abarca
 *    la fecha de inicio del turno.
 * 2. Por cada período × ítem calcula:
 *    - basis_value según allocation_base del ítem.
 *    - estimated_amount = (period.estimated_amount / expected_basis_divisor) * basis_value.
 *      Si no hay expected_basis_divisor, usa el estimated_amount completo por si
 *      es el único turno del período (se recalcula en el re-costeo mensual).
 * 3. Upsert en shift_overhead_application.
 * 4. Actualiza production_shifts.estimated_overhead_total.
 *
 * @param {string} shiftId
 * @param {string} tenantId
 * @param {{ startedAt, endedAt, totalKgProduced, totalUnitsProduced }} shiftData
 * @returns {{ totalEstimatedOverhead: number, applicationCount: number }}
 */
async function applyOverheadToShift(shiftId, tenantId, shiftData) {
  const { startedAt } = shiftData
  const shiftDate = startedAt instanceof Date ? startedAt : new Date(startedAt)
  const shiftDateStr = shiftDate.toISOString().slice(0, 10)

  // Fix (2026-05-30): auto-generar el presupuesto estimado del mes del turno si
  // no existe, para que el overhead aplique SIN pasos manuales. Antes el operador
  // tenía que abrir "Períodos del mes" para que se crearan los renglones; si no,
  // applyOverheadToShift no encontraba períodos y el turno salía con overhead $0.
  // ensurePeriodsForMonth es idempotente (salta los que ya existen) y copia el
  // default_estimated_amount + default_expected_basis_divisor de cada ítem activo.
  try {
    const [yStr, mStr] = shiftDateStr.split('-')
    const { ensurePeriodsForMonth } = require('./overheadPeriodsService')
    await ensurePeriodsForMonth(tenantId, parseInt(yStr, 10), parseInt(mStr, 10))
  } catch (e) {
    console.warn('[overhead] ensurePeriodsForMonth (auto) falló, no bloquea:', e.message)
  }

  // 1. Obtener períodos activos que solapan con la fecha del turno
  const { rows: periods } = await withBypass(() =>
    query(
      `SELECT top.*,
              toi.allocation_base,
              toi.is_active AS item_is_active
       FROM tenant_overhead_periods top
       JOIN tenant_overhead_items toi ON toi.id = top.overhead_item_id
       WHERE top.tenant_id = $1
         AND top.is_finalized = false
         AND toi.is_active = true
         AND $2::date BETWEEN top.period_start AND top.period_end`,
      [tenantId, shiftDateStr]
    )
  )

  if (periods.length === 0) {
    return { totalEstimatedOverhead: 0, applicationCount: 0 }
  }

  let totalEstimatedOverhead = 0
  let applicationCount = 0

  for (const period of periods) {
    const basisValue = computeBasisValue(period.allocation_base, shiftData)
    const estimatedAmount = period.estimated_amount || 0
    const divisor = parseFloat(period.expected_basis_divisor) || 0

    // Si hay divisor estimado, dividimos el total; si no, imputamos el total completo
    // (conservative: el re-costeo mensual ajustará el real_amount correctamente).
    let shiftEstimated
    if (divisor > 0) {
      shiftEstimated = (parseFloat(estimatedAmount) / divisor) * basisValue
    } else {
      // Sin divisor: como no sabemos cuántos turnos habrá, usamos el importe
      // completo como estimación temporal (se corregirá en re-costeo).
      shiftEstimated = parseFloat(estimatedAmount) * basisValue
    }

    // Upsert: si ya existe la fila (re-aplicación), actualizamos
    await withBypass(() =>
      query(
        `INSERT INTO shift_overhead_application
           (shift_id, overhead_item_id, period_id, basis_value, estimated_amount)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (shift_id, overhead_item_id)
         DO UPDATE SET
           period_id        = EXCLUDED.period_id,
           basis_value      = EXCLUDED.basis_value,
           estimated_amount = EXCLUDED.estimated_amount,
           is_recosted      = false,
           updated_at       = NOW()`,
        [shiftId, period.overhead_item_id, period.id, basisValue, shiftEstimated]
      )
    )

    totalEstimatedOverhead += shiftEstimated
    applicationCount++
  }

  // 3. Actualizar estimated_overhead_total en el turno
  await withBypass(() =>
    query(
      `UPDATE production_shifts
       SET estimated_overhead_total = $1
       WHERE id = $2`,
      [totalEstimatedOverhead, shiftId]
    )
  )

  return { totalEstimatedOverhead, applicationCount }
}

/**
 * Devuelve los totales de overhead (estimado y real) de un turno.
 */
async function getShiftOverheadTotal(shiftId) {
  const { rows } = await withBypass(() =>
    query(
      `SELECT estimated_overhead_total, real_overhead_total
       FROM production_shifts
       WHERE id = $1`,
      [shiftId]
    )
  )
  if (!rows[0]) return { estimated_overhead_total: null, real_overhead_total: null }
  return {
    estimated_overhead_total: rows[0].estimated_overhead_total,
    real_overhead_total:      rows[0].real_overhead_total,
  }
}

module.exports = { applyOverheadToShift, getShiftOverheadTotal, computeBasisValue }
