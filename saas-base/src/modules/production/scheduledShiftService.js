'use strict'

const { query, withTransaction } = require('../../db')
const { audit } = require('../../utils/audit')

// ─── Crear turno programado ───────────────────────────────────────────────────
async function scheduleShift({
  tenantId, productionOrderId, shiftNumber, scheduledDate,
  scheduledStart, operatorId, supervisorId, lineId, notes,
  userId, ipAddress, userAgent,
}) {
  // Regla de negocio: aunque la orden NO sea obligatoria en el turno,
  // sí debe existir AL MENOS UNA orden asignable en el tenant (released
  // o in_progress). Si no hay ninguna, no tiene sentido programar turnos
  // porque no habrá nada que producir.
  const { rows: anyOrder } = await query(
    `SELECT 1 FROM production_orders
     WHERE tenant_id = $1 AND status IN ('released','in_progress')
     LIMIT 1`,
    [tenantId]
  )
  if (anyOrder.length === 0) {
    throw createError(400,
      'No puedes programar turnos sin tener al menos una orden de producción liberada o en proceso. Crea o libera una orden primero.')
  }

  // La orden es OPCIONAL: el operador la elige de la cola al iniciar el turno.
  // Solo validamos si fue proporcionada.
  if (productionOrderId) {
    const { rows: order } = await query(
      `SELECT id, status FROM production_orders WHERE id = $1 AND tenant_id = $2`,
      [productionOrderId, tenantId]
    )
    if (!order[0]) throw createError(404, 'Orden de producción no encontrada.')
    if (!['released', 'in_progress'].includes(order[0].status)) {
      throw createError(400, 'La orden debe estar liberada para programar turnos.')
    }
  }

  const { rows } = await query(
    `INSERT INTO scheduled_shifts
       (tenant_id, production_order_id, shift_number, scheduled_date,
        scheduled_start, operator_id, supervisor_id, line_id, notes, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     RETURNING *`,
    [tenantId, productionOrderId || null, shiftNumber, scheduledDate,
     scheduledStart, operatorId, supervisorId, lineId || 1, notes || null, userId]
  )

  await audit({
    tenantId, userId, action: 'scheduled_shift.created', resource: 'scheduled_shifts',
    resourceId: rows[0].id,
    payload: { scheduledDate, shiftNumber, scheduledStart, hasOrder: !!productionOrderId },
    ipAddress, userAgent,
  })

  return rows[0]
}

// ─── Listar turnos programados ────────────────────────────────────────────────
async function listScheduledShifts({ tenantId, operatorId, dateFrom, dateTo, status }) {
  const params = [tenantId]
  const filters = []

  if (operatorId) { params.push(operatorId); filters.push(`ss.operator_id = $${params.length}`) }
  if (status)     { params.push(status);     filters.push(`ss.status = $${params.length}`) }
  if (dateFrom)   { params.push(dateFrom);   filters.push(`ss.scheduled_date >= $${params.length}`) }
  if (dateTo)     { params.push(dateTo);     filters.push(`ss.scheduled_date <= $${params.length}`) }

  const where = filters.length ? `AND ${filters.join(' AND ')}` : ''

  const { rows } = await query(
    `SELECT ss.*,
            po.order_number, po.length_mm, po.quantity_packages,
            p.name  AS product_name, p.sku,
            r.resin_type,
            op.full_name AS operator_name, op.email AS operator_email,
            sv.full_name AS supervisor_name
     FROM scheduled_shifts ss
     LEFT JOIN production_orders po ON po.id = ss.production_order_id
     LEFT JOIN products p           ON p.id  = po.product_id
     LEFT JOIN raw_materials r      ON r.id  = po.raw_material_id
     JOIN users op             ON op.id = ss.operator_id
     JOIN users sv             ON sv.id = ss.supervisor_id
     WHERE ss.tenant_id = $1 ${where}
     ORDER BY ss.scheduled_date, ss.scheduled_start`,
    params
  )
  return rows
}

// ─── Turno del operador para hoy ─────────────────────────────────────────────
// IMPORTANTE: usamos CURRENT_DATE de PostgreSQL (configurado con la timezone
// del servidor, típicamente la del tenant), no `new Date().toISOString()` de
// Node que siempre devuelve UTC. Esto evita que "hoy" cambie a la medianoche
// UTC en lugar de la medianoche local del usuario.
async function getTodayShiftsForOperator({ tenantId, operatorId }) {
  const { rows: dateRow } = await query(`SELECT CURRENT_DATE::text AS today`)
  const today = dateRow[0].today
  return listScheduledShifts({
    tenantId,
    operatorId,
    dateFrom: today,
    dateTo: today,
  })
}

// ─── Cancelar / modificar turno programado ───────────────────────────────────
async function updateScheduledShift({
  tenantId, id, scheduledDate, scheduledStart,
  operatorId, notes, status,
  isOvertime, absenceRegistered, replacementOperatorId,
  userId, ipAddress, userAgent,
}) {
  const { rows } = await query(
    `UPDATE scheduled_shifts SET
       scheduled_date        = COALESCE($1, scheduled_date),
       scheduled_start       = COALESCE($2, scheduled_start),
       operator_id           = COALESCE($3, operator_id),
       notes                 = COALESCE($4, notes),
       status                = COALESCE($5, status),
       is_overtime           = COALESCE($6, is_overtime),
       absence_registered    = COALESCE($7, absence_registered),
       replacement_operator_id = COALESCE($8, replacement_operator_id)
     WHERE id = $9 AND tenant_id = $10 AND status = 'scheduled'
     RETURNING *`,
    [scheduledDate || null, scheduledStart || null, operatorId || null,
     notes ?? null, status || null,
     isOvertime ?? null, absenceRegistered ?? null, replacementOperatorId || null,
     id, tenantId]
  )
  if (!rows[0]) throw createError(400, 'El turno no existe o ya no se puede modificar.')

  await audit({
    tenantId, userId, action: 'scheduled_shift.updated', resource: 'scheduled_shifts',
    resourceId: id, payload: { status }, ipAddress, userAgent,
  })
  return rows[0]
}

// ─── Operador confirma presencia ──────────────────────────────────────────────
async function confirmPresence({ tenantId, id, userId, ipAddress, userAgent }) {
  return withTransaction(async (client) => {
    const { rows: ss } = await client.query(
      `SELECT ss.*
       FROM scheduled_shifts ss
       LEFT JOIN production_orders po ON po.id = ss.production_order_id
       WHERE ss.id = $1 AND ss.tenant_id = $2 AND ss.status = 'scheduled'`,
      [id, tenantId]
    )
    if (!ss[0]) throw createError(400, 'Turno no encontrado o ya no está programado.')

    const shift = ss[0]

    // ── CANDADO: verificar si hay turno activo del turno anterior ─────────────
    const { rows: activeShifts } = await client.query(
      `SELECT ps.id, ps.operator_id, u.full_name AS operator_name
       FROM production_shifts ps
       JOIN users u ON u.id = ps.operator_id
       WHERE ps.tenant_id = $1
         AND ps.status = 'active'
       ORDER BY ps.started_at DESC
       LIMIT 1`,
      [tenantId]
    )

    const prevActiveShift = activeShifts[0] || null

    // Determinar el status del nuevo turno
    const newStatus = prevActiveShift ? 'pending_handover' : 'active'
    const startedAt = prevActiveShift ? null : 'NOW()'

    // Crear el turno real en production_shifts
    const { rows: newShift } = await client.query(
      `INSERT INTO production_shifts
         (tenant_id, production_order_id, shift_number, shift_date,
          operator_id, supervisor_id, status, started_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,${prevActiveShift ? 'NULL' : 'NOW()'})
       RETURNING *`,
      [tenantId, shift.production_order_id, shift.shift_number,
       shift.scheduled_date, shift.operator_id, shift.supervisor_id, newStatus]
    )

    // Marcar orden como en proceso
    await client.query(
      `UPDATE production_orders SET status = 'in_progress'
       WHERE id = $1 AND status = 'released'`,
      [shift.production_order_id]
    )

    // Actualizar turno programado
    const { rows: updated } = await client.query(
      `UPDATE scheduled_shifts SET
         status       = 'active',
         confirmed_at = NOW(),
         confirmed_by = $1,
         shift_id     = $2
       WHERE id = $3 RETURNING *`,
      [userId, newShift[0].id, id]
    )

    await audit({
      tenantId, userId, action: 'scheduled_shift.confirmed', resource: 'scheduled_shifts',
      resourceId: id, payload: { shiftId: newShift[0].id },
      ipAddress, userAgent,
    })

    // Si hay turno anterior activo, marcar que está esperando handover
    if (prevActiveShift) {
      await client.query(
        `UPDATE production_shifts
         SET handover_requested_at = NOW(),
             handover_waiting_shift_id = $1
         WHERE id = $2`,
        [newShift[0].id, prevActiveShift.id]
      )
    }

    // Detectar orden activa del turno anterior para precargar en el operador nuevo
    const { rows: prevActiveOrder } = await client.query(
      `SELECT sp.production_order_id AS previous_active_order_id
       FROM shift_progress sp
       JOIN production_shifts ps ON ps.id = sp.shift_id
       WHERE ps.status IN ('active','pending_handover')
         AND ps.tenant_id = $1
         AND ps.id != $2
       ORDER BY sp.microlot_number DESC
       LIMIT 1`,
      [tenantId, newShift[0].id]
    )

    return {
      scheduledShift: updated[0],
      shift: newShift[0],
      waiting_for_handover: !!prevActiveShift,
      previous_operator:    prevActiveShift ? {
        id:   prevActiveShift.id,
        name: prevActiveShift.operator_name,
      } : null,
      previous_active_order_id: prevActiveOrder[0]?.previous_active_order_id || null,
    }
  })
}

// ─── Job: auto-activar turnos cuya hora ya pasó ──────────────────────────────
// Se llama cada minuto desde un setInterval en app.js
async function autoActivatePendingShifts() {
  const now = new Date()
  const today = now.toISOString().split('T')[0]
  const currentTime = now.toTimeString().slice(0, 5) // HH:MM
  // Ventana: activar turnos que debieron empezar hace 0-15 minutos
  const cutoff = new Date(now.getTime() - 15 * 60 * 1000)
  const cutoffTime = cutoff.toTimeString().slice(0, 5)

  const { rows: pending } = await query(
    `SELECT ss.*
     FROM scheduled_shifts ss
     LEFT JOIN production_orders po ON po.id = ss.production_order_id
     WHERE ss.status = 'scheduled'
       AND ss.scheduled_date = $1
       AND ss.scheduled_start <= $2
       AND ss.scheduled_start >= $3`,
    [today, currentTime, cutoffTime]
  )

  for (const shift of pending) {
    try {
      await withTransaction(async (client) => {
        // Crear turno real
        const { rows: newShift } = await client.query(
          `INSERT INTO production_shifts
             (tenant_id, production_order_id, shift_number, shift_date,
              operator_id, supervisor_id, status, started_at)
           VALUES ($1,$2,$3,$4,$5,$6,'active',NOW())
           ON CONFLICT (production_order_id, shift_number, shift_date) DO NOTHING
           RETURNING *`,
          [shift.tenant_id, shift.production_order_id, shift.shift_number,
           shift.scheduled_date, shift.operator_id, shift.supervisor_id]
        )

        if (newShift[0]) {
          await client.query(
            `UPDATE production_orders SET status = 'in_progress'
             WHERE id = $1 AND status = 'released'`,
            [shift.production_order_id]
          )

          await client.query(
            `UPDATE scheduled_shifts SET
               status   = 'active',
               shift_id = $1
             WHERE id = $2`,
            [newShift[0].id, shift.id]
          )
        }
      })
    } catch (err) {
      console.error(`Auto-activación fallida para turno programado ${shift.id}:`, err.message)
    }
  }

  return pending.length
}

function createError(status, message) {
  const err = new Error(message)
  err.status = status
  return err
}

module.exports = {
  scheduleShift,
  listScheduledShifts,
  getTodayShiftsForOperator,
  updateScheduledShift,
  confirmPresence,
  autoActivatePendingShifts,
}
