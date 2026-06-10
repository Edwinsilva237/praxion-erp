'use strict'

// ─────────────────────────────────────────────────────────────────────────────
// Herramienta admin (one-time) — recálculo de costo de turnos ya validados que
// quedaron con costo por medida en $0 por el bug del 3er fallback de costo/kg
// (fix c232724). Reusa la maquinaria existente: revertValidation → closeShift →
// validateShift. NO reimplementa costeo ni toca inventario a mano.
//
// Seguridad:
//   - SOLO salta la ventana de 72h (bypassWindow). TODOS los demás frenos de
//     getRevertContext quedan intactos: PT ya vendido (PT_INSUFFICIENT_STOCK),
//     orden fulfilled/completed/cancelled, período contable cerrado, etc.
//   - Re-entrante: si un turno quedó a medias (active/pending_handover por un
//     fallo previo), retoma desde donde está en vez de duplicar pasos.
//   - El endpoint que la expone va gated por production:revert_validation.
// ─────────────────────────────────────────────────────────────────────────────

const { query } = require('../../db')
const svc = require('./productionService')

const DEFAULT_REASON =
  'Recalculo de costo por medida: validateShift no aplicaba el fallback de order_mp_formula (fix 2026-06-09).'

// Estado de costo de un turno: promedio + filas por medida (cuántas y cuántas >0).
async function shiftCostState(tenantId, shiftId) {
  const { rows: ps } = await query(
    `SELECT status, cost_per_unit FROM production_shifts WHERE id = $1 AND tenant_id = $2`,
    [shiftId, tenantId]
  )
  const { rows: pc } = await query(
    `SELECT COUNT(*)::int AS n,
            COALESCE(SUM(CASE WHEN cost_per_unit > 0 THEN 1 ELSE 0 END), 0)::int AS n_nonzero
       FROM shift_product_costs WHERE shift_id = $1`,
    [shiftId]
  )
  return {
    status:                    ps[0]?.status || null,
    cost_per_unit:             parseFloat(ps[0]?.cost_per_unit || 0),
    product_cost_rows:         pc[0]?.n || 0,
    product_cost_rows_nonzero: pc[0]?.n_nonzero || 0,
  }
}

// ─── Fase 1 — PREVIEW (solo lectura) ─────────────────────────────────────────
// Lista turnos 'reviewed' en [from, to] con su costo y el contexto de reversión
// (con la ventana de 72h ya saltada, para ver el alcance real). Cero cambios.
async function previewZeroCostShifts({ tenantId, from, to }) {
  if (!from || !to) {
    const e = new Error('from y to (YYYY-MM-DD) son requeridos.'); e.status = 400; throw e
  }
  const { rows: shifts } = await query(
    `SELECT ps.id, ps.shift_number, ps.shift_date, ps.cost_per_unit,
            u.full_name AS operator_name
       FROM production_shifts ps
       LEFT JOIN users u ON u.id = ps.operator_id
      WHERE ps.tenant_id = $1
        AND ps.status = 'reviewed'
        AND ps.shift_date >= $2 AND ps.shift_date <= $3
      ORDER BY ps.shift_date, ps.shift_number`,
    [tenantId, from, to]
  )

  const out = []
  for (const s of shifts) {
    const cost = await shiftCostState(tenantId, s.id)
    let ctx
    try {
      ctx = await svc.getRevertContext({ tenantId, shiftId: s.id, bypassWindow: true })
    } catch (e) {
      ctx = { allowed: false, blockers: [{ code: 'ERROR', message: e.message }], requires_dual_approval: false }
    }
    const cpu = parseFloat(s.cost_per_unit || 0)
    out.push({
      shift_id:                  s.id,
      shift_number:              s.shift_number,
      shift_date:                s.shift_date,
      operator_name:             s.operator_name,
      cost_per_unit:             cpu,
      product_cost_rows:         cost.product_cost_rows,
      product_cost_rows_nonzero: cost.product_cost_rows_nonzero,
      // Sospechoso de $0: promedio en 0, o hay filas por medida pero TODAS en 0.
      looks_zero:                cpu === 0 || (cost.product_cost_rows > 0 && cost.product_cost_rows_nonzero === 0),
      revertible:                ctx.allowed,                 // con ventana de 72h ya saltada
      blockers:                  ctx.blockers || [],          // frenos duros que SÍ aplican
      requires_dual_approval:    !!ctx.requires_dual_approval,
    })
  }
  return { from, to, count: out.length, candidates: out.filter(s => s.looks_zero).length, shifts: out }
}

// ─── Recálculo de UN turno (re-entrante) ─────────────────────────────────────
async function recomputeOneShift({ tenantId, shiftId, reason, secondaryApproverId, userId, ipAddress, userAgent }) {
  const r = (reason && String(reason).trim().length >= 20) ? String(reason).trim() : DEFAULT_REASON
  const before = await shiftCostState(tenantId, shiftId)
  if (!before.status) { const e = new Error('Turno no encontrado.'); e.status = 404; throw e }

  let status = before.status

  // 1) reviewed → revertir (salta SOLO la ventana; demás frenos intactos).
  if (status === 'reviewed') {
    await svc.revertValidation({
      tenantId, shiftId, reason: r,
      secondaryApproverId: secondaryApproverId || null,
      userId, ipAddress, userAgent, bypassWindow: true,
    })
    status = 'active'
  }
  // 2) active → re-cerrar (admin, skipAuth).
  if (status === 'active') {
    await svc.closeShift({ tenantId, shiftId, userId, ipAddress, userAgent, skipAuth: true })
    status = 'pending_handover'
  }
  // 3) pending_handover → re-validar (con el fix recomputa costo + reentra PT).
  if (status === 'pending_handover') {
    await svc.validateShift({
      tenantId, shiftId, approved: true,
      supervisorNotes: 'Revalidado por recalculo de costo (admin).',
      userId, ipAddress, userAgent,
    })
  } else {
    const e = new Error(`Estado inesperado tras los pasos: ${status}`); e.status = 409; throw e
  }

  const after = await shiftCostState(tenantId, shiftId)
  return {
    shift_id:                   shiftId,
    before_cost_per_unit:       before.cost_per_unit,
    after_cost_per_unit:        after.cost_per_unit,
    after_product_rows_nonzero: after.product_cost_rows_nonzero,
    final_status:               after.status,
    fixed:                      after.cost_per_unit > 0,
  }
}

// ─── Fase 2 — EJECUTAR sobre una lista EXPLÍCITA de shiftIds ──────────────────
async function executeZeroCostRecompute({ tenantId, shiftIds, reason, secondaryApproverId, userId, ipAddress, userAgent }) {
  if (!Array.isArray(shiftIds) || shiftIds.length === 0) {
    const e = new Error('shiftIds (lista no vacía) es requerido.'); e.status = 400; throw e
  }
  if (shiftIds.length > 50) {
    const e = new Error('Máximo 50 turnos por ejecución (límite de seguridad).'); e.status = 400; throw e
  }

  const results = []
  for (const shiftId of shiftIds) {
    try {
      const r = await recomputeOneShift({ tenantId, shiftId, reason, secondaryApproverId, userId, ipAddress, userAgent })
      results.push({ ok: true, ...r })
    } catch (e) {
      results.push({ ok: false, shift_id: shiftId, error: e.message, code: e.code || null, blockers: e.blockers || null })
    }
  }

  return {
    requested: shiftIds.length,
    fixed:     results.filter(r => r.ok && r.fixed).length,
    no_change: results.filter(r => r.ok && !r.fixed).length,
    failed:    results.filter(r => !r.ok).length,
    results,
  }
}

module.exports = { previewZeroCostShifts, executeZeroCostRecompute }
