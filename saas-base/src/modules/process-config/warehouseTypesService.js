'use strict'

/**
 * SaaS v2 — Service de tipos de almacén (tenant_warehouse_types).
 *
 * CRUD del catálogo. Reglas:
 *  - system_role debe estar en el enum permitido.
 *  - default_scrap_destination solo tiene sentido si system_role='scrap'.
 *    Se fuerza NULL si no aplica (en lugar de lanzar error) para que el
 *    cliente pueda ser laxo enviando ambos campos.
 *  - Soft-delete vía is_active (no se borra histórico).
 *  - No se valida "en uso" todavía — pendiente para cuando los warehouses
 *    se rediseñen para depender estrictamente del catálogo (post cleanup).
 *
 * Referencia: docs/saas-v2/00-design.md §2.2.4.
 */

const { query } = require('../../db')
const { audit } = require('../../utils/audit')

const SYSTEM_ROLES = ['input', 'wip', 'output', 'scrap', 'blocked', 'resale']
const SCRAP_DESTINATIONS = ['reprocess', 'discard', 'sell']

// ─── Lecturas ─────────────────────────────────────────────────────────────

async function listTypes({ tenantId, systemRole, isActive }) {
  const params = [tenantId]
  const filters = []
  if (systemRole) { params.push(systemRole); filters.push(`system_role = $${params.length}`) }
  if (isActive !== undefined) {
    params.push(isActive)
    filters.push(`is_active = $${params.length}`)
  }
  const where = filters.length ? `AND ${filters.join(' AND ')}` : ''

  const { rows } = await query(
    `SELECT * FROM tenant_warehouse_types
     WHERE tenant_id = $1 ${where}
     ORDER BY sort_order, code`,
    params
  )
  return rows
}

async function getType({ tenantId, id }) {
  const { rows } = await query(
    `SELECT * FROM tenant_warehouse_types WHERE id = $1 AND tenant_id = $2`,
    [id, tenantId]
  )
  return rows[0] || null
}

// ─── Escrituras ──────────────────────────────────────────────────────────

async function createType({
  tenantId, userId,
  code, name, systemRole,
  defaultScrapDestination,
  color, sortOrder = 0,
  ipAddress, userAgent,
}) {
  if (!code) throw badReq('code es requerido.')
  if (!name) throw badReq('name es requerido.')
  if (!SYSTEM_ROLES.includes(systemRole)) {
    throw badReq(`system_role debe ser uno de: ${SYSTEM_ROLES.join(', ')}.`)
  }

  // Normalizar default_scrap_destination: solo aplica si system_role=scrap
  let dest = defaultScrapDestination ?? null
  if (systemRole !== 'scrap') {
    dest = null   // forzar NULL si no es scrap
  } else if (dest !== null && !SCRAP_DESTINATIONS.includes(dest)) {
    throw badReq(`default_scrap_destination debe ser uno de: ${SCRAP_DESTINATIONS.join(', ')}.`)
  }

  if (color !== null && color !== undefined && !/^#[0-9a-fA-F]{6}$/.test(color)) {
    throw badReq('color debe estar en formato hex #RRGGBB.')
  }

  try {
    const { rows } = await query(
      `INSERT INTO tenant_warehouse_types
         (tenant_id, code, name, system_role, default_scrap_destination, color, sort_order, created_by_user_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING *`,
      [tenantId, code, name, systemRole, dest, color || null, sortOrder, userId]
    )
    await audit({
      tenantId, userId,
      action: 'tenant_warehouse_type.created',
      resource: 'tenant_warehouse_types',
      resourceId: rows[0].id,
      payload: { code, systemRole, defaultScrapDestination: dest },
      ipAddress, userAgent,
    })
    return rows[0]
  } catch (err) {
    if (err.code === '23505' && err.constraint === 'twt_code_per_tenant') {
      throw conflict(`Ya existe un tipo con código "${code}".`)
    }
    throw err
  }
}

async function updateType({
  tenantId, userId, id,
  name, defaultScrapDestination, color, sortOrder, isActive,
  ipAddress, userAgent,
}) {
  const current = await getType({ tenantId, id })
  if (!current) {
    const err = new Error('Tipo de almacén no encontrado.')
    err.status = 404
    throw err
  }

  const setters = []
  const params = []
  let i = 1
  if (name !== undefined) { setters.push(`name = $${i++}`); params.push(name) }
  if (defaultScrapDestination !== undefined) {
    if (current.system_role !== 'scrap' && defaultScrapDestination !== null) {
      throw badReq('default_scrap_destination solo aplica si system_role=scrap.')
    }
    if (defaultScrapDestination !== null && !SCRAP_DESTINATIONS.includes(defaultScrapDestination)) {
      throw badReq(`default_scrap_destination debe ser uno de: ${SCRAP_DESTINATIONS.join(', ')}.`)
    }
    setters.push(`default_scrap_destination = $${i++}`)
    params.push(defaultScrapDestination)
  }
  if (color !== undefined) {
    if (color !== null && !/^#[0-9a-fA-F]{6}$/.test(color)) {
      throw badReq('color debe estar en formato hex #RRGGBB.')
    }
    setters.push(`color = $${i++}`); params.push(color)
  }
  if (sortOrder !== undefined) { setters.push(`sort_order = $${i++}`); params.push(sortOrder) }
  if (isActive !== undefined) {
    if (typeof isActive !== 'boolean') throw badReq('is_active debe ser boolean.')
    setters.push(`is_active = $${i++}`); params.push(isActive)
  }

  // No permitimos cambiar system_role ni code post-creación — son la identidad
  // del tipo y cualquier almacén apuntando a ellos asumiría su valor original.
  // Para cambiar, el admin debe crear un tipo nuevo y migrar los almacenes.

  if (setters.length === 0) throw badReq('No hay campos válidos para actualizar.')

  setters.push(`updated_by_user_id = $${i++}`); params.push(userId)
  params.push(id, tenantId)

  const { rows } = await query(
    `UPDATE tenant_warehouse_types SET ${setters.join(', ')}
     WHERE id = $${i++} AND tenant_id = $${i}
     RETURNING *`,
    params
  )

  await audit({
    tenantId, userId,
    action: 'tenant_warehouse_type.updated',
    resource: 'tenant_warehouse_types',
    resourceId: id,
    payload: { changedFields: setters.length - 1 },
    ipAddress, userAgent,
  })

  return rows[0]
}

// ─── helpers ──────────────────────────────────────────────────────────────

function badReq(msg)   { const e = new Error(msg); e.status = 400; return e }
function conflict(msg) { const e = new Error(msg); e.status = 409; return e }

module.exports = {
  SYSTEM_ROLES, SCRAP_DESTINATIONS,
  listTypes, getType, createType, updateType,
}
