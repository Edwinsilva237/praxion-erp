'use strict'

/**
 * SaaS v2 — Service de tipos de merma (tenant_scrap_types).
 *
 * CRUD + validaciones:
 *  - default_destination ∈ {reprocess, discard, sell}
 *  - default_recovery_value_pct ∈ [0, 100]
 *  - linked_raw_material_id debe existir en el tenant (si != NULL)
 *  - allows_reprocess_of_expired solo aplica si destination=reprocess
 *
 * Referencia: §2.2.5 + ajuste #1 de §6.6.
 */

const { query } = require('../../db')
const { audit } = require('../../utils/audit')

const DESTINATIONS = ['reprocess', 'discard', 'sell']

// ─── Lecturas ─────────────────────────────────────────────────────────────

async function listTypes({ tenantId, destination, isNormal, isActive }) {
  const params = [tenantId]
  const filters = []
  // OJO: calificar con tst. — raw_materials (el LEFT JOIN) también tiene columnas
  // is_active/is_normal, así que sin prefijo Postgres las marca como ambiguas
  // ("la referencia a la columna is_active es ambigua") → 500.
  if (destination) { params.push(destination); filters.push(`tst.default_destination = $${params.length}`) }
  if (isNormal !== undefined) { params.push(isNormal); filters.push(`tst.is_normal = $${params.length}`) }
  if (isActive !== undefined) { params.push(isActive); filters.push(`tst.is_active = $${params.length}`) }
  const where = filters.length ? `AND ${filters.join(' AND ')}` : ''

  const { rows } = await query(
    `SELECT tst.*, rm.name AS linked_raw_material_name
     FROM tenant_scrap_types tst
     LEFT JOIN raw_materials rm ON rm.id = tst.linked_raw_material_id
     WHERE tst.tenant_id = $1 ${where}
     ORDER BY tst.sort_order, tst.code`,
    params
  )
  return rows
}

async function getType({ tenantId, id }) {
  const { rows } = await query(
    `SELECT tst.*, rm.name AS linked_raw_material_name
     FROM tenant_scrap_types tst
     LEFT JOIN raw_materials rm ON rm.id = tst.linked_raw_material_id
     WHERE tst.id = $1 AND tst.tenant_id = $2`,
    [id, tenantId]
  )
  return rows[0] || null
}

// ─── Escrituras ──────────────────────────────────────────────────────────

async function createType({
  tenantId, userId,
  code, name, defaultDestination,
  defaultRecoveryValuePct = 0,
  isNormal = true,
  linkedRawMaterialId = null,
  allowsReprocessOfExpired = false,
  sortOrder = 0,
  ipAddress, userAgent,
}) {
  if (!code) throw badReq('code es requerido.')
  if (!name) throw badReq('name es requerido.')
  if (!DESTINATIONS.includes(defaultDestination)) {
    throw badReq(`default_destination debe ser uno de: ${DESTINATIONS.join(', ')}.`)
  }

  const recoveryNum = parseFloat(defaultRecoveryValuePct)
  if (!isFinite(recoveryNum) || recoveryNum < 0 || recoveryNum > 100) {
    throw badReq('default_recovery_value_pct debe estar entre 0 y 100.')
  }

  if (typeof isNormal !== 'boolean') throw badReq('is_normal debe ser boolean.')
  if (typeof allowsReprocessOfExpired !== 'boolean') throw badReq('allows_reprocess_of_expired debe ser boolean.')

  if (allowsReprocessOfExpired && defaultDestination !== 'reprocess') {
    throw badReq('allows_reprocess_of_expired solo aplica si default_destination=reprocess.')
  }

  // Validar linkedRawMaterialId si está presente
  if (linkedRawMaterialId) {
    const { rows } = await query(
      `SELECT 1 FROM raw_materials WHERE id = $1 AND tenant_id = $2`,
      [linkedRawMaterialId, tenantId]
    )
    if (rows.length === 0) {
      throw badReq('linked_raw_material_id no existe en este tenant.')
    }
  }

  try {
    const { rows } = await query(
      `INSERT INTO tenant_scrap_types
         (tenant_id, code, name, default_destination, default_recovery_value_pct,
          is_normal, linked_raw_material_id, allows_reprocess_of_expired,
          sort_order, created_by_user_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING *`,
      [tenantId, code, name, defaultDestination, recoveryNum,
       isNormal, linkedRawMaterialId, allowsReprocessOfExpired,
       sortOrder, userId]
    )
    await audit({
      tenantId, userId,
      action: 'tenant_scrap_type.created',
      resource: 'tenant_scrap_types',
      resourceId: rows[0].id,
      payload: { code, defaultDestination, isNormal },
      ipAddress, userAgent,
    })
    return rows[0]
  } catch (err) {
    if (err.code === '23505' && err.constraint === 'tst_code_per_tenant') {
      throw conflict(`Ya existe un tipo de merma con código "${code}".`)
    }
    throw err
  }
}

async function updateType({
  tenantId, userId, id,
  name, defaultDestination, defaultRecoveryValuePct,
  isNormal, linkedRawMaterialId, allowsReprocessOfExpired,
  sortOrder, isActive,
  ipAddress, userAgent,
}) {
  const current = await getType({ tenantId, id })
  if (!current) {
    const err = new Error('Tipo de merma no encontrado.')
    err.status = 404
    throw err
  }

  const setters = []
  const params = []
  let i = 1

  if (name !== undefined) { setters.push(`name = $${i++}`); params.push(name) }

  if (defaultDestination !== undefined) {
    if (!DESTINATIONS.includes(defaultDestination)) {
      throw badReq(`default_destination debe ser uno de: ${DESTINATIONS.join(', ')}.`)
    }
    setters.push(`default_destination = $${i++}`); params.push(defaultDestination)
  }

  if (defaultRecoveryValuePct !== undefined) {
    const v = parseFloat(defaultRecoveryValuePct)
    if (!isFinite(v) || v < 0 || v > 100) {
      throw badReq('default_recovery_value_pct debe estar entre 0 y 100.')
    }
    setters.push(`default_recovery_value_pct = $${i++}`); params.push(v)
  }

  if (isNormal !== undefined) {
    if (typeof isNormal !== 'boolean') throw badReq('is_normal debe ser boolean.')
    setters.push(`is_normal = $${i++}`); params.push(isNormal)
  }

  if (linkedRawMaterialId !== undefined) {
    if (linkedRawMaterialId !== null) {
      const { rows } = await query(
        `SELECT 1 FROM raw_materials WHERE id = $1 AND tenant_id = $2`,
        [linkedRawMaterialId, tenantId]
      )
      if (rows.length === 0) throw badReq('linked_raw_material_id no existe en este tenant.')
    }
    setters.push(`linked_raw_material_id = $${i++}`); params.push(linkedRawMaterialId)
  }

  if (allowsReprocessOfExpired !== undefined) {
    if (typeof allowsReprocessOfExpired !== 'boolean') throw badReq('allows_reprocess_of_expired debe ser boolean.')
    // Si activa flag, la destination resultante debe ser reprocess
    const finalDest = defaultDestination ?? current.default_destination
    if (allowsReprocessOfExpired && finalDest !== 'reprocess') {
      throw badReq('allows_reprocess_of_expired solo aplica si default_destination=reprocess.')
    }
    setters.push(`allows_reprocess_of_expired = $${i++}`); params.push(allowsReprocessOfExpired)
  }

  if (sortOrder !== undefined) { setters.push(`sort_order = $${i++}`); params.push(sortOrder) }
  if (isActive !== undefined) {
    if (typeof isActive !== 'boolean') throw badReq('is_active debe ser boolean.')
    setters.push(`is_active = $${i++}`); params.push(isActive)
  }

  if (setters.length === 0) throw badReq('No hay campos válidos para actualizar.')

  setters.push(`updated_by_user_id = $${i++}`); params.push(userId)
  params.push(id, tenantId)

  const { rows } = await query(
    `UPDATE tenant_scrap_types SET ${setters.join(', ')}
     WHERE id = $${i++} AND tenant_id = $${i}
     RETURNING *`,
    params
  )

  await audit({
    tenantId, userId,
    action: 'tenant_scrap_type.updated',
    resource: 'tenant_scrap_types',
    resourceId: id,
    payload: { changedFields: setters.length - 1 },
    ipAddress, userAgent,
  })

  return rows[0]
}

function badReq(msg)   { const e = new Error(msg); e.status = 400; return e }
function conflict(msg) { const e = new Error(msg); e.status = 409; return e }

module.exports = {
  DESTINATIONS,
  listTypes, getType, createType, updateType,
}
