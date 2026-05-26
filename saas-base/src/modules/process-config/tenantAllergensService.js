'use strict'

/**
 * SaaS v2 — Service de alérgenos (tenant_allergens).
 *
 * CRUD del catálogo. Reglas:
 *  - code único por tenant.
 *  - Booleans validados (is_priority, is_active).
 *  - NO hay regla de "mínimo 1 activo" — tenants no-alimentarios pueden
 *    desactivar todos.
 *  - is_priority es marcador semántico (8 NOM-051), no se valida que tenga
 *    exactamente 8 activos.
 *
 * Referencia: §4.3.4 + §4.9.
 */

const { query } = require('../../db')
const { audit } = require('../../utils/audit')

// ─── Lecturas ─────────────────────────────────────────────────────────────

async function listAllergens({ tenantId, isActive, isPriority }) {
  const params = [tenantId]
  const filters = []
  if (isActive !== undefined) {
    params.push(isActive); filters.push(`ta.is_active = $${params.length}`)
  }
  if (isPriority !== undefined) {
    params.push(isPriority); filters.push(`ta.is_priority = $${params.length}`)
  }
  const where = filters.length ? `AND ${filters.join(' AND ')}` : ''

  const { rows } = await query(
    `SELECT ta.*
     FROM tenant_allergens ta
     WHERE ta.tenant_id = $1 ${where}
     ORDER BY ta.sort_order, ta.code`,
    params
  )
  return rows
}

async function getAllergen({ tenantId, id }) {
  const { rows } = await query(
    `SELECT * FROM tenant_allergens WHERE id = $1 AND tenant_id = $2`,
    [id, tenantId]
  )
  return rows[0] || null
}

// ─── Escrituras ──────────────────────────────────────────────────────────

async function createAllergen({
  tenantId, userId,
  code, name,
  isPriority = false,
  sortOrder = 0,
  ipAddress, userAgent,
}) {
  if (!code) throw badReq('code es requerido.')
  if (!name) throw badReq('name es requerido.')
  if (typeof isPriority !== 'boolean') throw badReq('is_priority debe ser boolean.')

  try {
    const { rows } = await query(
      `INSERT INTO tenant_allergens
         (tenant_id, code, name, is_priority, sort_order, created_by_user_id)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING *`,
      [tenantId, code, name, isPriority, sortOrder, userId]
    )
    await audit({
      tenantId, userId,
      action: 'tenant_allergen.created',
      resource: 'tenant_allergens',
      resourceId: rows[0].id,
      payload: { code, isPriority },
      ipAddress, userAgent,
    })
    return rows[0]
  } catch (err) {
    if (err.code === '23505' && err.constraint === 'ta_code_per_tenant') {
      throw conflict(`Ya existe un alérgeno con code="${code}".`)
    }
    throw err
  }
}

async function updateAllergen({
  tenantId, userId, id,
  name, isPriority, sortOrder, isActive,
  ipAddress, userAgent,
}) {
  const current = await getAllergen({ tenantId, id })
  if (!current) {
    const err = new Error('Alérgeno no encontrado.')
    err.status = 404
    throw err
  }

  const setters = []
  const params = []
  let i = 1

  if (name !== undefined) {
    setters.push(`name = $${i++}`); params.push(name)
  }
  if (isPriority !== undefined) {
    if (typeof isPriority !== 'boolean') throw badReq('is_priority debe ser boolean.')
    setters.push(`is_priority = $${i++}`); params.push(isPriority)
  }
  if (sortOrder !== undefined) {
    setters.push(`sort_order = $${i++}`); params.push(sortOrder)
  }
  if (isActive !== undefined) {
    if (typeof isActive !== 'boolean') throw badReq('is_active debe ser boolean.')
    setters.push(`is_active = $${i++}`); params.push(isActive)
  }

  if (setters.length === 0) throw badReq('No hay campos válidos para actualizar.')

  setters.push(`updated_by_user_id = $${i++}`); params.push(userId)
  params.push(id, tenantId)

  const { rows } = await query(
    `UPDATE tenant_allergens SET ${setters.join(', ')}
     WHERE id = $${i++} AND tenant_id = $${i}
     RETURNING *`,
    params
  )

  await audit({
    tenantId, userId,
    action: 'tenant_allergen.updated',
    resource: 'tenant_allergens',
    resourceId: id,
    payload: { changedFields: setters.length - 1 },
    ipAddress, userAgent,
  })

  return rows[0]
}

function badReq(msg)   { const e = new Error(msg); e.status = 400; return e }
function conflict(msg) { const e = new Error(msg); e.status = 409; return e }

module.exports = {
  listAllergens, getAllergen, createAllergen, updateAllergen,
}
