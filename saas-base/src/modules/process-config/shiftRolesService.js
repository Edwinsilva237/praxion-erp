'use strict'

/**
 * SaaS v2 — Service de roles del turno (tenant_shift_roles).
 *
 * CRUD del catálogo. Reglas:
 *  - code único por tenant.
 *  - Booleans validados (is_required, is_unique_per_shift, can_capture,
 *    can_validate, can_handover, is_active).
 *  - Debe quedar siempre ≥ 1 rol activo en el tenant (no se puede desactivar
 *    el último).
 *  - Debe quedar siempre ≥ 1 rol con is_required=true & is_active=true (no se
 *    puede desmarcar is_required del último requerido activo, ni desactivar
 *    el último requerido activo).
 *
 * Referencia: §2.2.7.
 */

const { query } = require('../../db')
const { audit } = require('../../utils/audit')

// ─── Lecturas ─────────────────────────────────────────────────────────────

async function listRoles({ tenantId, isActive, isRequired }) {
  const params = [tenantId]
  const filters = []
  if (isActive !== undefined) {
    params.push(isActive); filters.push(`tsr.is_active = $${params.length}`)
  }
  if (isRequired !== undefined) {
    params.push(isRequired); filters.push(`tsr.is_required = $${params.length}`)
  }
  const where = filters.length ? `AND ${filters.join(' AND ')}` : ''

  const { rows } = await query(
    `SELECT tsr.*
     FROM tenant_shift_roles tsr
     WHERE tsr.tenant_id = $1 ${where}
     ORDER BY tsr.sort_order, tsr.code`,
    params
  )
  return rows
}

async function getRole({ tenantId, id }) {
  const { rows } = await query(
    `SELECT tsr.*
     FROM tenant_shift_roles tsr
     WHERE tsr.id = $1 AND tsr.tenant_id = $2`,
    [id, tenantId]
  )
  return rows[0] || null
}

// ─── Escrituras ──────────────────────────────────────────────────────────

async function createRole({
  tenantId, userId,
  code, name,
  isRequired = false,
  isUniquePerShift = false,
  canCapture = false,
  canValidate = false,
  canHandover = false,
  sortOrder = 0,
  ipAddress, userAgent,
}) {
  if (!code) throw badReq('code es requerido.')
  if (!name) throw badReq('name es requerido.')

  const bools = {
    is_required: isRequired,
    is_unique_per_shift: isUniquePerShift,
    can_capture: canCapture,
    can_validate: canValidate,
    can_handover: canHandover,
  }
  for (const [key, val] of Object.entries(bools)) {
    if (typeof val !== 'boolean') throw badReq(`${key} debe ser boolean.`)
  }

  try {
    const { rows } = await query(
      `INSERT INTO tenant_shift_roles
         (tenant_id, code, name,
          is_required, is_unique_per_shift,
          can_capture, can_validate, can_handover,
          sort_order, created_by_user_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING *`,
      [tenantId, code, name,
       isRequired, isUniquePerShift,
       canCapture, canValidate, canHandover,
       sortOrder, userId]
    )
    await audit({
      tenantId, userId,
      action: 'tenant_shift_role.created',
      resource: 'tenant_shift_roles',
      resourceId: rows[0].id,
      payload: { code, isRequired, isUniquePerShift },
      ipAddress, userAgent,
    })
    return rows[0]
  } catch (err) {
    if (err.code === '23505' && err.constraint === 'tsr_code_per_tenant') {
      throw conflict(`Ya existe un rol con code="${code}".`)
    }
    throw err
  }
}

async function updateRole({
  tenantId, userId, id,
  name,
  isRequired, isUniquePerShift,
  canCapture, canValidate, canHandover,
  sortOrder, isActive,
  ipAddress, userAgent,
}) {
  const current = await getRole({ tenantId, id })
  if (!current) {
    const err = new Error('Rol no encontrado.')
    err.status = 404
    throw err
  }

  const setters = []
  const params = []
  let i = 1

  if (name !== undefined) {
    setters.push(`name = $${i++}`); params.push(name)
  }

  // Boolean fields with validations
  const validateBool = (val, label) => {
    if (typeof val !== 'boolean') throw badReq(`${label} debe ser boolean.`)
  }

  if (isRequired !== undefined) {
    validateBool(isRequired, 'is_required')
    // Si quita is_required y este era el último requerido activo → bloquear
    if (isRequired === false && current.is_required === true && current.is_active === true) {
      const { rows } = await query(
        `SELECT COUNT(*)::int AS c FROM tenant_shift_roles
         WHERE tenant_id = $1 AND is_required = true AND is_active = true AND id <> $2`,
        [tenantId, id]
      )
      if (rows[0].c === 0) {
        throw badReq('No se puede quitar is_required del último rol requerido activo. Debe existir al menos uno (típicamente capturista).')
      }
    }
    setters.push(`is_required = $${i++}`); params.push(isRequired)
  }

  if (isUniquePerShift !== undefined) {
    validateBool(isUniquePerShift, 'is_unique_per_shift')
    setters.push(`is_unique_per_shift = $${i++}`); params.push(isUniquePerShift)
  }
  if (canCapture !== undefined) {
    validateBool(canCapture, 'can_capture')
    setters.push(`can_capture = $${i++}`); params.push(canCapture)
  }
  if (canValidate !== undefined) {
    validateBool(canValidate, 'can_validate')
    setters.push(`can_validate = $${i++}`); params.push(canValidate)
  }
  if (canHandover !== undefined) {
    validateBool(canHandover, 'can_handover')
    setters.push(`can_handover = $${i++}`); params.push(canHandover)
  }

  if (sortOrder !== undefined) {
    setters.push(`sort_order = $${i++}`); params.push(sortOrder)
  }

  if (isActive !== undefined) {
    validateBool(isActive, 'is_active')
    if (isActive === false && current.is_active === true) {
      // Bloquear desactivar el último rol activo
      const { rows } = await query(
        `SELECT COUNT(*)::int AS c FROM tenant_shift_roles
         WHERE tenant_id = $1 AND is_active = true AND id <> $2`,
        [tenantId, id]
      )
      if (rows[0].c === 0) {
        throw badReq('No se puede desactivar el último rol activo. Debe existir al menos uno.')
      }
      // Bloquear desactivar el último rol requerido activo (si este era requerido)
      const effectiveRequired = isRequired !== undefined ? isRequired : current.is_required
      if (effectiveRequired === true) {
        const { rows: r2 } = await query(
          `SELECT COUNT(*)::int AS c FROM tenant_shift_roles
           WHERE tenant_id = $1 AND is_required = true AND is_active = true AND id <> $2`,
          [tenantId, id]
        )
        if (r2[0].c === 0) {
          throw badReq('No se puede desactivar el último rol requerido activo. Debe existir al menos uno (típicamente capturista).')
        }
      }
    }
    setters.push(`is_active = $${i++}`); params.push(isActive)
  }

  if (setters.length === 0) throw badReq('No hay campos válidos para actualizar.')

  setters.push(`updated_by_user_id = $${i++}`); params.push(userId)
  params.push(id, tenantId)

  const { rows } = await query(
    `UPDATE tenant_shift_roles SET ${setters.join(', ')}
     WHERE id = $${i++} AND tenant_id = $${i}
     RETURNING *`,
    params
  )

  await audit({
    tenantId, userId,
    action: 'tenant_shift_role.updated',
    resource: 'tenant_shift_roles',
    resourceId: id,
    payload: { changedFields: setters.length - 1 },
    ipAddress, userAgent,
  })

  return rows[0]
}

function badReq(msg)   { const e = new Error(msg); e.status = 400; return e }
function conflict(msg) { const e = new Error(msg); e.status = 409; return e }

module.exports = {
  listRoles, getRole, createRole, updateRole,
}
