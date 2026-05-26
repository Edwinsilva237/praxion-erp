'use strict'

/**
 * SaaS v2 §Fase3 — Servicio de re-costeo mensual de overhead.
 *
 * Flujo:
 *  1. Recibe los importes reales de cada período del mes.
 *  2. Finaliza los períodos (is_finalized = true, real_amount capturado).
 *  3. Calcula actual_basis_divisor para cada período = SUM(basis_value) de todos
 *     los turnos del período.
 *  4. Recalcula real_amount por turno:
 *       real_amount = period.real_amount * (shift_basis_value / actual_basis_divisor)
 *  5. Actualiza production_shifts.real_overhead_total y campos de re-costeo.
 *  6. Genera order_cost_snapshots con snapshot_type='recosted'.
 */

const { query, withTransaction, withBypass } = require('../../db')

/**
 * Finaliza todos los períodos del mes para el tenant y recostea los turnos.
 *
 * @param {string}   tenantId
 * @param {number}   year
 * @param {number}   month   1-12
 * @param {Array<{ periodId: string, realAmount: number }>} capturedReals
 * @param {string}   userId
 * @returns {{ shiftsRecosted: number, ordersRecosted: number }}
 */
async function finalizeAndRecoste(tenantId, year, month, capturedReals, userId) {
  const y = parseInt(year)
  const m = parseInt(month)
  if (!y || !m || m < 1 || m > 12) {
    const err = new Error('year y month deben ser números válidos (month: 1-12).')
    err.status = 400; throw err
  }
  if (!Array.isArray(capturedReals) || capturedReals.length === 0) {
    const err = new Error('capturedReals debe ser un array no vacío con { periodId, realAmount }.')
    err.status = 400; throw err
  }

  // Construir mapa periodId → realAmount
  const realMap = {}
  for (const item of capturedReals) {
    if (!item.periodId) {
      const err = new Error('Cada entrada de capturedReals debe tener periodId.')
      err.status = 400; throw err
    }
    const val = parseFloat(item.realAmount)
    if (isNaN(val) || val < 0) {
      const err = new Error(`realAmount de período ${item.periodId} debe ser un número >= 0.`)
      err.status = 400; throw err
    }
    realMap[item.periodId] = val
  }

  // Obtener todos los períodos del mes que no están finalizados
  const { rows: periods } = await withBypass(() =>
    query(
      `SELECT top.*
       FROM tenant_overhead_periods top
       WHERE top.tenant_id = $1
         AND EXTRACT(YEAR  FROM top.period_start) = $2
         AND EXTRACT(MONTH FROM top.period_start) = $3
         AND top.is_finalized = false`,
      [tenantId, y, m]
    )
  )

  if (periods.length === 0) {
    const err = new Error('No hay períodos pendientes de finalización para el mes indicado. Verifica que existan períodos creados con ensurePeriodsForMonth.')
    err.status = 404; throw err
  }

  // Validar que todos los períodos tienen real_amount provisto
  const missingReals = periods.filter(p => realMap[p.id] === undefined)
  if (missingReals.length > 0) {
    const names = missingReals.map(p => p.id).join(', ')
    const err = new Error(`Faltan importes reales para los períodos: ${names}`)
    err.status = 400; throw err
  }

  let shiftsRecosted = 0
  const recostedOrderIds = new Set()

  // Todo en una transacción para consistencia
  await withTransaction(async (client) => {
    for (const period of periods) {
      const realAmount = realMap[period.id]

      // 1. Calcular actual_basis_divisor = SUM(basis_value) de todos los turnos del período
      const { rows: divisorRows } = await client.query(
        `SELECT COALESCE(SUM(basis_value), 0) AS total_basis
         FROM shift_overhead_application
         WHERE period_id = $1`,
        [period.id]
      )
      const actualBasisDivisor = parseFloat(divisorRows[0].total_basis)

      // 2. Finalizar el período
      await client.query(
        `UPDATE tenant_overhead_periods
         SET real_amount            = $1,
             actual_basis_divisor   = $2,
             is_finalized           = true,
             finalized_at           = NOW(),
             finalized_by_user_id   = $3,
             updated_at             = NOW()
         WHERE id = $4`,
        [realAmount, actualBasisDivisor > 0 ? actualBasisDivisor : null, userId, period.id]
      )

      // 3. Obtener todos los registros de aplicación de este período
      const { rows: applications } = await client.query(
        `SELECT soa.*, ps.tenant_id AS shift_tenant_id
         FROM shift_overhead_application soa
         JOIN production_shifts ps ON ps.id = soa.shift_id
         WHERE soa.period_id = $1`,
        [period.id]
      )

      if (applications.length === 0) continue

      for (const app of applications) {
        // 4. Calcular real_amount por turno
        let shiftReal
        if (actualBasisDivisor > 0) {
          shiftReal = realAmount * (parseFloat(app.basis_value) / actualBasisDivisor)
        } else {
          shiftReal = 0
        }

        // 5. Actualizar la aplicación
        await client.query(
          `UPDATE shift_overhead_application
           SET real_amount  = $1,
               is_recosted  = true,
               updated_at   = NOW()
           WHERE id = $2`,
          [shiftReal, app.id]
        )
      }

      // 6. Actualizar real_overhead_total por turno (suma de todos sus real_amounts del período)
      const affectedShiftIds = [...new Set(applications.map(a => a.shift_id))]
      for (const shiftId of affectedShiftIds) {
        const { rows: totRows } = await client.query(
          `SELECT COALESCE(SUM(real_amount), 0) AS total_real
           FROM shift_overhead_application
           WHERE shift_id = $1 AND is_recosted = true`,
          [shiftId]
        )
        const totalReal = parseFloat(totRows[0].total_real)

        await client.query(
          `UPDATE production_shifts
           SET real_overhead_total     = $1,
               recosted_at             = NOW(),
               recosted_by_user_id     = $2,
               updated_at              = NOW()
           WHERE id = $3`,
          [totalReal, userId, shiftId]
        )
        shiftsRecosted++

        // Recolectar órdenes de los turnos re-costeados
        const { rows: orderRows } = await client.query(
          `SELECT DISTINCT production_order_id
           FROM shift_progress
           WHERE shift_id = $1 AND production_order_id IS NOT NULL`,
          [shiftId]
        )
        for (const or of orderRows) {
          recostedOrderIds.add(or.production_order_id)
        }
      }
    }

    // 7. Generar snapshots de costo por orden (snapshot_type='recosted')
    for (const orderId of recostedOrderIds) {
      // Agregar costos del turno para la orden (legacy: cost_per_unit × units)
      const { rows: orderRows } = await client.query(
        `SELECT po.*,
                COALESCE(SUM(sp.real_weight_kg), 0)     AS total_kg,
                COALESCE(SUM(sp.quantity_units), 0)     AS total_units
         FROM production_orders po
         LEFT JOIN shift_progress sp ON sp.production_order_id = po.id
           AND sp.is_second_quality = false
         WHERE po.id = $1
         GROUP BY po.id`,
        [orderId]
      )
      if (!orderRows[0]) continue
      const order = orderRows[0]

      // Overhead total real para la orden = suma real_overhead_total de turnos con progreso de esta orden
      const { rows: ohRows } = await client.query(
        `SELECT COALESCE(SUM(soa.real_amount), 0) AS total_oh
         FROM shift_overhead_application soa
         JOIN shift_progress sp ON sp.shift_id = soa.shift_id
         WHERE sp.production_order_id = $1
           AND soa.is_recosted = true`,
        [orderId]
      )
      const overheadCost = parseFloat(ohRows[0].total_oh)

      // Costo MP de la orden (suma de costos de progreso)
      const { rows: mpRows } = await client.query(
        `SELECT COALESCE(SUM(sp.real_weight_kg * COALESCE(r.cost_per_kg, 0)), 0) AS mp_cost
         FROM shift_progress sp
         JOIN production_orders po ON po.id = sp.production_order_id
         LEFT JOIN raw_materials r ON r.id = po.raw_material_id
         WHERE sp.production_order_id = $1`,
        [orderId]
      )
      const mpCost = parseFloat(mpRows[0].mp_cost)

      const totalUnits = parseFloat(order.total_units) || 0
      const totalCost  = mpCost + overheadCost
      const unitCost   = totalUnits > 0 ? totalCost / totalUnits : 0

      await client.query(
        `INSERT INTO order_cost_snapshots
           (order_id, snapshot_type, mp_cost, overhead_cost,
            total_cost_to_grade_1, units_grade_1, unit_cost_grade_1)
         VALUES ($1, 'recosted', $2, $3, $4, $5, $6)
         ON CONFLICT (order_id, snapshot_type)
         DO UPDATE SET
           mp_cost               = EXCLUDED.mp_cost,
           overhead_cost         = EXCLUDED.overhead_cost,
           total_cost_to_grade_1 = EXCLUDED.total_cost_to_grade_1,
           units_grade_1         = EXCLUDED.units_grade_1,
           unit_cost_grade_1     = EXCLUDED.unit_cost_grade_1,
           created_at            = NOW()`,
        [orderId, mpCost, overheadCost, totalCost, totalUnits, unitCost]
      )
    }
  })

  return {
    shiftsRecosted,
    ordersRecosted: recostedOrderIds.size,
  }
}

module.exports = { finalizeAndRecoste }
