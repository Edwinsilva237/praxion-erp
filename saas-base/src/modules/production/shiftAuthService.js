'use strict'

const { query, withTransaction } = require('../../db')
const { audit } = require('../../utils/audit')

/**
 * SaaS v2 — Autorización por rol del turno (runtime).
 *
 * Reemplaza las comparaciones rígidas `shift.operator_id === userId` y
 * `shift.supervisor_id === userId` por una consulta al catálogo dinámico
 * tenant_shift_roles + production_shift_members.
 *
 * Capacidades válidas:
 *   - 'capture'   → puede registrar paquetes / progreso     (rol con can_capture)
 *   - 'validate'  → puede cerrar y aprobar el turno         (rol con can_validate)
 *   - 'handover'  → puede recibir handover del turno saliente (rol con can_handover)
 *
 * El helper acepta ambos shapes coexistiendo:
 *   1. Legacy: el usuario es production_shifts.operator_id (= capture+handover) o
 *      production_shifts.supervisor_id (= validate). Esto se mantiene para no
 *      romper tests y flujos donde el turno fue programado antes del refactor.
 *   2. Dinámico: el usuario aparece como member ACTIVO (left_at IS NULL) en
 *      production_shift_members con un rol que tenga el flag relevante en true.
 *
 * Sin uno de los dos → 403 (caller del lado del service decide el mensaje).
 *
 * Uso típico (dentro de un service):
 *
 *   if (!(await userCanActOnShift({ shiftId, userId, capability: 'validate' }))) {
 *     throw createError(403, 'No puedes cerrar este turno.')
 *   }
 *
 * El helper trabaja con `query` global (sin transacción) por default; si llamas
 * desde dentro de una transacción, pasa `client`.
 */

const FLAG_BY_CAPABILITY = {
  capture:  'can_capture',
  validate: 'can_validate',
  handover: 'can_handover',
}

/**
 * Devuelve el user_id del miembro designado como responsable del handover en
 * un turno de runtime, o null si ningún miembro está designado.
 *
 * Cuando hay un responsable designado, gana sobre el comportamiento por default
 * (cualquier miembro con can_handover). Esto soporta el caso operativo donde el
 * admin del turno quiere que firme una persona específica el handover, aunque
 * otros miembros también tengan can_handover en su rol del catálogo.
 */
async function getHandoverResponsibleUserId({ shiftId, client } = {}) {
  const runner = client ? client.query.bind(client) : query
  const { rows } = await runner(
    `SELECT user_id
       FROM production_shift_members
      WHERE shift_id = $1
        AND is_handover_responsible = true
        AND left_at IS NULL
      LIMIT 1`,
    [shiftId]
  )
  return rows[0]?.user_id || null
}

/**
 * Cambia el responsable del handover del turno de runtime atómicamente.
 *   - Desmarca al miembro anterior (si lo había).
 *   - Marca al nuevo miembro indicado por memberId.
 *   - Valida que memberId pertenezca al turno y esté activo (left_at IS NULL).
 *
 * Sin restricción de can_handover — cualquier miembro activo puede ser
 * designado (decisión de quien programa o supervisor en runtime).
 *
 * Devuelve el row actualizado de production_shift_members.
 */
async function setHandoverResponsible({ shiftId, memberId, client } = {}) {
  const runner = client ? client.query.bind(client) : query

  const { rows: target } = await runner(
    `SELECT id, user_id FROM production_shift_members
      WHERE id = $1 AND shift_id = $2 AND left_at IS NULL`,
    [memberId, shiftId]
  )
  if (!target[0]) {
    const err = new Error('El miembro indicado no pertenece a este turno o ya salió.')
    err.status = 400
    throw err
  }

  // Desmarcar al actual responsable (si existe) antes de marcar al nuevo para
  // no chocar con el UNIQUE partial index. Idempotente — si nadie lo era, no
  // afecta nada.
  await runner(
    `UPDATE production_shift_members
        SET is_handover_responsible = false
      WHERE shift_id = $1
        AND is_handover_responsible = true
        AND id <> $2`,
    [shiftId, memberId]
  )
  const { rows: updated } = await runner(
    `UPDATE production_shift_members
        SET is_handover_responsible = true
      WHERE id = $1
      RETURNING *`,
    [memberId]
  )
  return updated[0]
}

async function userCanActOnShift({ shiftId, userId, capability, client } = {}) {
  if (!shiftId || !userId || !capability) return false
  const flagCol = FLAG_BY_CAPABILITY[capability]
  if (!flagCol) return false

  const runner = client ? client.query.bind(client) : query

  // Path 1: campos legacy de production_shifts. Mantienen 100% backward compat.
  //   - operator_id  cubre capture + handover (el operador del turno)
  //   - supervisor_id cubre validate (el supervisor del turno)
  const { rows: shiftRows } = await runner(
    `SELECT operator_id, supervisor_id FROM production_shifts WHERE id = $1`,
    [shiftId]
  )
  if (!shiftRows[0]) return false
  const s = shiftRows[0]

  if (capability === 'capture'  && s.operator_id   === userId) return true
  if (capability === 'handover' && s.operator_id   === userId) return true
  if (capability === 'validate' && (s.operator_id === userId || s.supervisor_id === userId)) return true

  // Path 2: production_shift_members con el flag relevante.
  const { rows: memberRows } = await runner(
    `SELECT 1
       FROM production_shift_members m
       JOIN tenant_shift_roles r ON r.id = m.role_id
      WHERE m.shift_id = $1
        AND m.user_id  = $2
        AND m.left_at  IS NULL
        AND r.${flagCol} = true
        AND r.is_active  = true
      LIMIT 1`,
    [shiftId, userId]
  )
  return memberRows.length > 0
}

/**
 * Lista los miembros activos de un turno de runtime con info de su rol.
 * Útil para que la UI pueda mostrar al equipo del turno y para que el frontend
 * decida qué botones mostrar al usuario actual.
 */
async function listShiftMembers({ shiftId, client } = {}) {
  const runner = client ? client.query.bind(client) : query
  const { rows } = await runner(
    `SELECT m.id, m.user_id, m.role_id, m.joined_at, m.left_at,
            u.full_name AS user_name, u.email AS user_email,
            r.code  AS role_code,  r.name AS role_name,
            r.can_capture, r.can_validate, r.can_handover,
            r.is_required, r.is_unique_per_shift, r.sort_order
       FROM production_shift_members m
       JOIN users u                ON u.id = m.user_id
       JOIN tenant_shift_roles r   ON r.id = m.role_id
      WHERE m.shift_id = $1
      ORDER BY r.sort_order, u.full_name`,
    [shiftId]
  )
  return rows
}

/**
 * Reemplaza un MIEMBRO de un turno de runtime (capturista u otro rol) por otro
 * usuario, conservando el rol — útil cuando el turno YA inició y el capturista
 * cambia a media corrida (se fue, se enfermó, se asignó por error).
 *
 * Qué hace, atómicamente:
 *   1. Valida que el turno esté en runtime ('active' | 'pending_handover').
 *   2. Marca al saliente con left_at = NOW() (deja de poder capturar) y le quita
 *      la responsabilidad de handover.
 *   3. Da de alta al entrante con el MISMO rol; hereda la responsabilidad de
 *      handover si el saliente la tenía.
 *   4. Si el saliente era el operator_id / supervisor_id legacy de production_shifts,
 *      reapunta esa columna al entrante. CRÍTICO: userCanActOnShift autoriza por el
 *      path legacy (operator_id), así que sin esto el saliente CONSERVARÍA el acceso
 *      a capturar y el entrante solo entraría por el path de miembros.
 *
 * Lo ya capturado queda atribuido al TURNO (no se reescribe): el cambio rige de
 * aquí en adelante.
 *
 * @returns {{ outgoing, incoming, members, roleName }}
 */
async function replaceShiftMember({ tenantId, shiftId, memberId, newUserId, userId, ipAddress, userAgent } = {}) {
  if (!memberId)  { const e = new Error('memberId es requerido.');  e.status = 400; throw e }
  if (!newUserId) { const e = new Error('newUserId es requerido.'); e.status = 400; throw e }

  return withTransaction(async (client) => {
    // 1) Turno en runtime
    const { rows: shiftRows } = await client.query(
      `SELECT id, status, operator_id, supervisor_id, shift_number
         FROM production_shifts WHERE id = $1 AND tenant_id = $2`,
      [shiftId, tenantId]
    )
    const shift = shiftRows[0]
    if (!shift) { const e = new Error('Turno no encontrado.'); e.status = 404; throw e }
    if (!['active', 'pending_handover'].includes(shift.status)) {
      const e = new Error('Solo se puede reemplazar un miembro mientras el turno está activo o en relevo. Si ya cerró, usa la reversión/programación.')
      e.status = 400; throw e
    }

    // 2) Miembro saliente (activo)
    const { rows: outRows } = await client.query(
      `SELECT m.id, m.user_id, m.role_id, m.is_handover_responsible,
              u.full_name AS user_name, r.name AS role_name
         FROM production_shift_members m
         JOIN users u              ON u.id = m.user_id
         JOIN tenant_shift_roles r ON r.id = m.role_id
        WHERE m.id = $1 AND m.shift_id = $2 AND m.left_at IS NULL`,
      [memberId, shiftId]
    )
    const outgoing = outRows[0]
    if (!outgoing) { const e = new Error('El miembro indicado no pertenece a este turno o ya salió.'); e.status = 400; throw e }
    if (newUserId === outgoing.user_id) {
      const e = new Error('El nuevo usuario es el mismo que el actual.'); e.status = 400; throw e
    }

    // 3) Entrante válido (mismo tenant, activo)
    const { rows: userRows } = await client.query(
      `SELECT id, full_name FROM users WHERE id = $1 AND tenant_id = $2 AND is_active = true`,
      [newUserId, tenantId]
    )
    const incomingUser = userRows[0]
    if (!incomingUser) { const e = new Error('El nuevo usuario no existe, está inactivo o no pertenece a esta empresa.'); e.status = 400; throw e }

    // 4) Que el entrante no sea ya miembro activo (evita duplicado)
    const { rows: dup } = await client.query(
      `SELECT 1 FROM production_shift_members
        WHERE shift_id = $1 AND user_id = $2 AND left_at IS NULL LIMIT 1`,
      [shiftId, newUserId]
    )
    if (dup[0]) { const e = new Error(`${incomingUser.full_name} ya es miembro activo de este turno.`); e.status = 400; throw e }

    // 5) Saliente → left_at + soltar handover (el índice único filtra left_at IS NULL;
    //    lo soltamos explícito por limpieza).
    const wasHandover = outgoing.is_handover_responsible === true
    await client.query(
      `UPDATE production_shift_members
          SET left_at = NOW(), is_handover_responsible = false
        WHERE id = $1`,
      [memberId]
    )

    // 6) Entrante con el mismo rol; hereda handover si el saliente lo tenía.
    const { rows: inRows } = await client.query(
      `INSERT INTO production_shift_members (shift_id, user_id, role_id, is_handover_responsible)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [shiftId, newUserId, outgoing.role_id, wasHandover]
    )
    const incoming = inRows[0]

    // 7) Reapuntar columnas legacy si el saliente las ocupaba (o conservaría acceso).
    if (shift.operator_id === outgoing.user_id) {
      await client.query(`UPDATE production_shifts SET operator_id = $1 WHERE id = $2`, [newUserId, shiftId])
    }
    if (shift.supervisor_id === outgoing.user_id) {
      await client.query(`UPDATE production_shifts SET supervisor_id = $1 WHERE id = $2`, [newUserId, shiftId])
    }

    await audit({
      tenantId, userId,
      action: 'shift.member_replaced', resource: 'production_shifts', resourceId: shiftId,
      payload: {
        shiftNumber: shift.shift_number, roleName: outgoing.role_name,
        outgoingUserId: outgoing.user_id, outgoingUserName: outgoing.user_name,
        incomingUserId: newUserId, incomingUserName: incomingUser.full_name,
        inheritedHandover: wasHandover,
      },
      ipAddress, userAgent,
    })

    const members = await listShiftMembers({ shiftId, client })
    return {
      outgoing: { memberId: outgoing.id, userId: outgoing.user_id, userName: outgoing.user_name },
      incoming: { memberId: incoming.id, userId: newUserId, userName: incomingUser.full_name },
      roleName: outgoing.role_name,
      members,
    }
  })
}

module.exports = {
  userCanActOnShift,
  listShiftMembers,
  getHandoverResponsibleUserId,
  setHandoverResponsible,
  replaceShiftMember,
}
