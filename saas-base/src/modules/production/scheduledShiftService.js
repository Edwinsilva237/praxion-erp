'use strict'

const { query, withTransaction } = require('../../db')
const { audit } = require('../../utils/audit')
const pushEvents = require('../push/pushEvents')

// ─── Helper: validar members[] contra catálogo y derivar legacy fields ───────
//
// SaaS v2 (sesión 2026-05-29):
//  La programación de turnos acepta dos shapes en el body:
//
//   A) Legacy: { operatorId, supervisorId } — dos campos rígidos.
//   B) Dinámico: { members: [{ userId, shiftRoleId }, ...] } — N miembros por
//      rol del catálogo `tenant_shift_roles`.
//
//  Este helper acepta cualquiera de los dos, valida is_required y
//  is_unique_per_shift contra el catálogo, y devuelve la lista normalizada
//  más operator_id / supervisor_id derivados para mantener las columnas legacy
//  `scheduled_shifts.operator_id|supervisor_id` siempre pobladas.
//
//  Reglas para derivar legacy fields:
//   - operator_id   = primer miembro cuyo rol tiene can_capture=true
//                     (típicamente el capturista). Fallback: primer miembro.
//   - supervisor_id = primer miembro cuyo rol tiene can_validate=true
//                     (típicamente el supervisor). Fallback: operator_id.
//
async function normalizeMembers(client, tenantId, {
  members, operatorIdLegacy, supervisorIdLegacy,
}) {
  // 1) Catálogo activo del tenant
  const { rows: catalog } = await client.query(
    `SELECT id, code, name, is_required, is_unique_per_shift,
            can_capture, can_validate, can_handover
     FROM tenant_shift_roles
     WHERE tenant_id = $1 AND is_active = true`,
    [tenantId]
  )
  const roleById   = Object.fromEntries(catalog.map(r => [r.id,   r]))
  const roleByCode = Object.fromEntries(catalog.map(r => [r.code, r]))

  // 2) Si no llegan members, sintetizamos desde el shape legacy. Esto preserva
  //    el flujo del frontend antiguo y los tests existentes que arman el body
  //    con operator+supervisor directos.
  if (!Array.isArray(members) || members.length === 0) {
    if (!operatorIdLegacy) {
      throw createError(400, 'Asigna al menos un miembro al turno.')
    }
    const synthesized = []
    if (roleByCode.capturista) {
      synthesized.push({ userId: operatorIdLegacy, shiftRoleId: roleByCode.capturista.id })
    }
    if (supervisorIdLegacy
        && supervisorIdLegacy !== operatorIdLegacy
        && roleByCode.supervisor) {
      synthesized.push({ userId: supervisorIdLegacy, shiftRoleId: roleByCode.supervisor.id })
    }
    members = synthesized
  }

  if (members.length === 0) {
    throw createError(400, 'Asigna al menos un miembro al turno.')
  }

  // 3) Cada role_id debe existir en el catálogo del tenant.
  for (const m of members) {
    if (!m.shiftRoleId || !m.userId) {
      throw createError(400, 'Cada miembro requiere userId y shiftRoleId.')
    }
    if (!roleById[m.shiftRoleId]) {
      throw createError(400, `Rol ${m.shiftRoleId} no existe en el catálogo del tenant o está inactivo.`)
    }
  }

  // 3b) Máximo 1 miembro designado como responsable del handover por turno.
  //     La designación es independiente de can_handover del catálogo — cualquier
  //     miembro puede ser designado (lo decide quien programa el turno).
  const handoverCount = members.filter(m => m.isHandoverResponsible).length
  if (handoverCount > 1) {
    throw createError(400, 'Solo un miembro puede ser responsable del handover por turno.')
  }

  // 4) is_required: cada rol marcado como requerido debe tener al menos 1 miembro.
  const countByRole = {}
  for (const m of members) {
    countByRole[m.shiftRoleId] = (countByRole[m.shiftRoleId] || 0) + 1
  }
  for (const r of catalog) {
    if (r.is_required && !countByRole[r.id]) {
      throw createError(400, `Falta asignar el rol "${r.name}" (requerido).`)
    }
  }

  // 5) is_unique_per_shift: si está marcado, solo puede haber un miembro con ese rol.
  for (const r of catalog) {
    if (r.is_unique_per_shift && (countByRole[r.id] || 0) > 1) {
      throw createError(400, `Solo puede haber un miembro con el rol "${r.name}" por turno.`)
    }
  }

  // 6) Derivar operator_id (can_capture) y supervisor_id (can_validate) para
  //    mantener compat con los flujos que siguen usando estos campos en el
  //    runtime mientras se completa el refactor (la mig 124 los mantiene NOT NULL).
  const captureMember = members.find(m => roleById[m.shiftRoleId].can_capture)
  const validateMember = members.find(m => roleById[m.shiftRoleId].can_validate)
  const derivedOperatorId   = captureMember?.userId   || members[0].userId
  const derivedSupervisorId = validateMember?.userId  || derivedOperatorId

  return {
    members,
    derivedOperatorId,
    derivedSupervisorId,
    catalog,
    roleById,
  }
}

// ─── Helper: lee members de un turno (programado o de runtime) ───────────────
//
// Devuelve los miembros del turno con info del rol embebida.
//   table: 'scheduled_shift_members' | 'production_shift_members'
//   fkColumn: 'scheduled_shift_id'   | 'shift_id'
async function readMembers(client, { table, fkColumn, shiftId }) {
  const { rows } = await client.query(
    `SELECT m.id, m.user_id, m.role_id, m.is_handover_responsible,
            u.full_name AS user_name, u.email AS user_email,
            r.code AS role_code, r.name AS role_name,
            r.is_required, r.is_unique_per_shift,
            r.can_capture, r.can_validate, r.can_handover,
            r.sort_order
       FROM ${table} m
       JOIN users u                ON u.id = m.user_id
       JOIN tenant_shift_roles r   ON r.id = m.role_id
      WHERE m.${fkColumn} = $1
      ORDER BY r.sort_order, u.full_name`,
    [shiftId]
  )
  return rows
}

// ─── Crear turno programado ───────────────────────────────────────────────────
async function scheduleShift({
  tenantId, productionOrderId, shiftNumber, scheduledDate,
  scheduledStart, operatorId, supervisorId, lineId, notes,
  members,
  isOvertimeAcknowledged, overtimeContext,
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

  const shift = await withTransaction(async (client) => {
    const normalized = await normalizeMembers(client, tenantId, {
      members, operatorIdLegacy: operatorId, supervisorIdLegacy: supervisorId,
    })

    const { rows } = await client.query(
      `INSERT INTO scheduled_shifts
         (tenant_id, production_order_id, shift_number, scheduled_date,
          scheduled_start, operator_id, supervisor_id, line_id, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING *`,
      [tenantId, productionOrderId || null, shiftNumber, scheduledDate,
       scheduledStart,
       normalized.derivedOperatorId, normalized.derivedSupervisorId,
       lineId || 1, notes || null, userId]
    )
    const created = rows[0]

    for (const m of normalized.members) {
      await client.query(
        `INSERT INTO scheduled_shift_members
           (scheduled_shift_id, user_id, role_id, is_handover_responsible, notes)
         VALUES ($1, $2, $3, $4, $5)`,
        [created.id, m.userId, m.shiftRoleId, !!m.isHandoverResponsible, m.notes || null]
      )
    }

    await audit({
      tenantId, userId, action: 'scheduled_shift.created', resource: 'scheduled_shifts',
      resourceId: created.id,
      payload: {
        scheduledDate, shiftNumber, scheduledStart,
        hasOrder: !!productionOrderId,
        memberCount: normalized.members.length,
      },
      ipAddress, userAgent,
    })

    // Registro de tiempo extra: el supervisor confirmó "Sí, programar aunque
    // exceda el límite". overtimeContext trae los detalles que la UI mostró.
    if (isOvertimeAcknowledged) {
      await audit({
        tenantId, userId, action: 'scheduled_shift.overtime_acknowledged',
        resource: 'scheduled_shifts', resourceId: created.id,
        payload: {
          scheduledDate, shiftNumber, operatorId: normalized.derivedOperatorId,
          ...(overtimeContext && typeof overtimeContext === 'object' ? overtimeContext : {}),
        },
        ipAddress, userAgent,
      })
    }

    const memberRows = await readMembers(client, {
      table: 'scheduled_shift_members',
      fkColumn: 'scheduled_shift_id',
      shiftId: created.id,
    })

    return { ...created, members: memberRows }
  })

  // Push best-effort (post-commit): avisa a los miembros asignados (menos quien
  // programó el turno) que tienen un turno nuevo.
  const recipientIds = (shift.members || [])
    .map((m) => m.user_id)
    .filter((id) => id && id !== userId)
  pushEvents.shiftAssigned(tenantId, {
    userIds: recipientIds,
    shiftNumber: shift.shift_number,
    scheduledDate: shift.scheduled_date,
    shiftId: shift.id,
  })

  return shift
}

// ─── Horas programadas del operador (día y semana) ───────────────────────────
// Suma `duration_hours` del tenant_shift_config por cada turno NO cancelado del
// operador en el día y en la semana del lunes-domingo que contiene la fecha.
// Retorna { day, week, dayMax, weekMax } — los maxes vienen del tenant_process_config.
async function getOperatorHoursForDate({ tenantId, operatorId, date }) {
  if (!operatorId || !date) {
    return { day: 0, week: 0, dayMax: 9, weekMax: 48 }
  }
  const { rows: cfgRows } = await query(
    `SELECT max_hours_per_day, max_hours_per_week
     FROM tenant_process_config WHERE tenant_id = $1`,
    [tenantId]
  )
  const dayMax  = cfgRows[0]?.max_hours_per_day  ?? 9
  const weekMax = cfgRows[0]?.max_hours_per_week ?? 48

  // Sumamos turnos donde el usuario aparezca como miembro O como operator_id
  // legacy. El join contra scheduled_shift_members captura todos los roles del
  // catálogo dinámico; el OR a operator_id mantiene compat con turnos viejos
  // que se programaron antes del refactor.
  const baseSelect = `
    SELECT COALESCE(SUM(COALESCE(sc.duration_hours, 8)), 0)::INT AS hours
      FROM scheduled_shifts ss
      LEFT JOIN tenant_shift_config sc
        ON sc.tenant_id = ss.tenant_id
        AND sc.shift_number::TEXT = ss.shift_number::TEXT
     WHERE ss.tenant_id = $1
       AND ss.status <> 'cancelled'
       AND (
         ss.operator_id = $2
         OR EXISTS (
           SELECT 1 FROM scheduled_shift_members ssm
            WHERE ssm.scheduled_shift_id = ss.id AND ssm.user_id = $2
         )
       )
  `

  const { rows: dayRows } = await query(
    `${baseSelect} AND ss.scheduled_date = $3`,
    [tenantId, operatorId, date]
  )

  // Semana: lunes-domingo que contiene `date` (PostgreSQL ISO: lunes=1).
  const { rows: weekRows } = await query(
    `${baseSelect}
       AND ss.scheduled_date >= date_trunc('week', $3::date)::date
       AND ss.scheduled_date <  date_trunc('week', $3::date)::date + INTERVAL '7 days'`,
    [tenantId, operatorId, date]
  )

  return {
    day:     dayRows[0]?.hours  ?? 0,
    week:    weekRows[0]?.hours ?? 0,
    dayMax,
    weekMax,
  }
}

// ─── Listar turnos programados ────────────────────────────────────────────────
async function listScheduledShifts({ tenantId, operatorId, dateFrom, dateTo, status }) {
  const params = [tenantId]
  const filters = []

  // Filtrar por user_id: aparece como operator legacy O como miembro del turno
  // bajo cualquier rol del catálogo. Esto cubre las dos shapes mientras coexisten.
  if (operatorId) {
    params.push(operatorId)
    filters.push(`(
      ss.operator_id = $${params.length}
      OR EXISTS (
        SELECT 1 FROM scheduled_shift_members ssm
         WHERE ssm.scheduled_shift_id = ss.id AND ssm.user_id = $${params.length}
      )
    )`)
  }
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

  if (rows.length === 0) return rows

  // Adjuntar miembros con una sola query batch — agrupado por scheduled_shift_id.
  const ids = rows.map(r => r.id)
  const { rows: memberRows } = await query(
    `SELECT ssm.scheduled_shift_id, ssm.id, ssm.user_id, ssm.role_id,
            ssm.is_handover_responsible,
            u.full_name AS user_name, u.email AS user_email,
            r.code AS role_code, r.name AS role_name,
            r.is_required, r.is_unique_per_shift,
            r.can_capture, r.can_validate, r.can_handover,
            r.sort_order
       FROM scheduled_shift_members ssm
       JOIN users u              ON u.id = ssm.user_id
       JOIN tenant_shift_roles r ON r.id = ssm.role_id
      WHERE ssm.scheduled_shift_id = ANY($1::uuid[])
      ORDER BY r.sort_order, u.full_name`,
    [ids]
  )
  const membersByShift = {}
  for (const m of memberRows) {
    if (!membersByShift[m.scheduled_shift_id]) membersByShift[m.scheduled_shift_id] = []
    membersByShift[m.scheduled_shift_id].push(m)
  }
  return rows.map(r => ({ ...r, members: membersByShift[r.id] || [] }))
}

// ─── Turno del operador para hoy ─────────────────────────────────────────────
// "Hoy" debe ser el día LOCAL de operación, no el del servidor. En producción
// Postgres corre en UTC (Render no fija timezone), así que CURRENT_DATE salta a
// "mañana" a partir de las 18:00 de México (medianoche UTC) y ocultaba los
// turnos del día — el operador no podía confirmar su presencia por la tarde.
// Convertimos NOW() a la zona de operación y tomamos esa fecha.
// TODO: cuando exista timezone por tenant, reemplazar la constante.
const OPS_TIMEZONE = 'America/Mexico_City'
async function getTodayShiftsForOperator({ tenantId, operatorId }) {
  const { rows: dateRow } = await query(
    `SELECT (NOW() AT TIME ZONE $1)::date::text AS today`, [OPS_TIMEZONE]
  )
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
  members,
  userId, ipAddress, userAgent,
}) {
  return withTransaction(async (client) => {
    // Si llega members[], re-validamos y re-derivamos operator/supervisor.
    let derivedOperatorId   = operatorId || null
    let derivedSupervisorId = null
    if (Array.isArray(members)) {
      const normalized = await normalizeMembers(client, tenantId, {
        members, operatorIdLegacy: operatorId, supervisorIdLegacy: null,
      })
      derivedOperatorId   = normalized.derivedOperatorId
      derivedSupervisorId = normalized.derivedSupervisorId

      // Reemplazar miembros existentes (estrategia simple: delete + insert).
      await client.query(
        `DELETE FROM scheduled_shift_members WHERE scheduled_shift_id = $1`,
        [id]
      )
      for (const m of normalized.members) {
        await client.query(
          `INSERT INTO scheduled_shift_members
             (scheduled_shift_id, user_id, role_id, is_handover_responsible, notes)
           VALUES ($1, $2, $3, $4, $5)`,
          [id, m.userId, m.shiftRoleId, !!m.isHandoverResponsible, m.notes || null]
        )
      }
    }

    const { rows } = await client.query(
      `UPDATE scheduled_shifts SET
         scheduled_date        = COALESCE($1, scheduled_date),
         scheduled_start       = COALESCE($2, scheduled_start),
         operator_id           = COALESCE($3, operator_id),
         supervisor_id         = COALESCE($4, supervisor_id),
         notes                 = COALESCE($5, notes),
         status                = COALESCE($6, status),
         is_overtime           = COALESCE($7, is_overtime),
         absence_registered    = COALESCE($8, absence_registered),
         replacement_operator_id = COALESCE($9, replacement_operator_id)
       WHERE id = $10 AND tenant_id = $11 AND status = 'scheduled'
       RETURNING *`,
      [scheduledDate || null, scheduledStart || null,
       derivedOperatorId, derivedSupervisorId,
       notes ?? null, status || null,
       isOvertime ?? null, absenceRegistered ?? null, replacementOperatorId || null,
       id, tenantId]
    )
    if (!rows[0]) throw createError(400, 'El turno no existe o ya no se puede modificar.')

    await audit({
      tenantId, userId, action: 'scheduled_shift.updated', resource: 'scheduled_shifts',
      resourceId: id, payload: { status }, ipAddress, userAgent,
    })

    const memberRows = await readMembers(client, {
      table: 'scheduled_shift_members',
      fkColumn: 'scheduled_shift_id',
      shiftId: id,
    })
    return { ...rows[0], members: memberRows }
  })
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

    // Copiar los miembros del turno programado al turno de runtime.
    // Si por algún motivo el scheduled no tenía members (turno legacy creado
    // antes del refactor), sintetizamos uno a partir del operator_id + el rol
    // 'capturista' del catálogo, para que el runtime no quede sin members.
    await copyMembersToRuntime(client, tenantId, {
      scheduledShiftId: shift.id,
      productionShiftId: newShift[0].id,
      fallbackOperatorId: shift.operator_id,
      fallbackSupervisorId: shift.supervisor_id,
    })

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

// ─── Helper: copia members programados al turno de runtime ──────────────────
//
// SaaS v2 (sesión 2026-05-29):
//  Cuando un turno programado se activa (scheduled → production), los miembros
//  asignados durante la planificación se copian a `production_shift_members`
//  para que el runtime (captura, validación, handover) opere sobre el catálogo
//  dinámico de roles en vez de los campos rígidos operator_id/supervisor_id.
//
//  Si el scheduled no tenía miembros explícitos (turno legacy programado
//  antes del refactor o creado por un test), sintetizamos uno mínimo desde
//  operator_id usando el rol 'capturista' del catálogo del tenant. Sin esa
//  síntesis los turnos legacy quedarían sin members y el runtime caería al
//  fallback de operator_id, lo que ya está cubierto pero perdería trazabilidad.
async function copyMembersToRuntime(client, tenantId, {
  scheduledShiftId, productionShiftId,
  fallbackOperatorId, fallbackSupervisorId,
}) {
  const { rows: existing } = await client.query(
    `SELECT user_id, role_id, is_handover_responsible, notes
       FROM scheduled_shift_members
      WHERE scheduled_shift_id = $1`,
    [scheduledShiftId]
  )

  let toCopy = existing
  if (existing.length === 0) {
    const { rows: roles } = await client.query(
      `SELECT id, code FROM tenant_shift_roles
        WHERE tenant_id = $1 AND code IN ('capturista','supervisor') AND is_active = true`,
      [tenantId]
    )
    const capturista = roles.find(r => r.code === 'capturista')
    const supervisor = roles.find(r => r.code === 'supervisor')
    toCopy = []
    if (capturista && fallbackOperatorId) {
      toCopy.push({ user_id: fallbackOperatorId, role_id: capturista.id, is_handover_responsible: false, notes: null })
    }
    if (supervisor && fallbackSupervisorId && fallbackSupervisorId !== fallbackOperatorId) {
      toCopy.push({ user_id: fallbackSupervisorId, role_id: supervisor.id, is_handover_responsible: false, notes: null })
    }
  }

  for (const m of toCopy) {
    await client.query(
      `INSERT INTO production_shift_members
         (shift_id, user_id, role_id, is_handover_responsible, notes)
       VALUES ($1, $2, $3, $4, $5)`,
      [productionShiftId, m.user_id, m.role_id, !!m.is_handover_responsible, m.notes || null]
    )
  }
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
          await copyMembersToRuntime(client, shift.tenant_id, {
            scheduledShiftId:    shift.id,
            productionShiftId:   newShift[0].id,
            fallbackOperatorId:  shift.operator_id,
            fallbackSupervisorId: shift.supervisor_id,
          })

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
  getOperatorHoursForDate,
  // Exportado para que productionService lo reuse al validar quién puede
  // capturar/validar dentro de un production_shift activo.
  readMembers,
  copyMembersToRuntime,
}
