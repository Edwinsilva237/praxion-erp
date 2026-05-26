'use strict'

/**
 * SaaS v2 — Service de calidades (tenant_quality_grades).
 *
 * CRUD del catálogo. Reglas:
 *  - grade_number ∈ [1, 5], único por tenant.
 *  - code único por tenant.
 *  - goes_to_warehouse_type_id debe existir en el tenant si != NULL.
 *  - Mínimo 1 calidad por tenant — no se puede borrar (soft o hard) la última.
 *
 * Referencia: §2.2.6.
 */

const { query } = require('../../db')
const { audit } = require('../../utils/audit')

// ─── Lecturas ─────────────────────────────────────────────────────────────

async function listGrades({ tenantId, isActive }) {
  const params = [tenantId]
  const filters = []
  if (isActive !== undefined) { params.push(isActive); filters.push(`tqg.is_active = $${params.length}`) }
  const where = filters.length ? `AND ${filters.join(' AND ')}` : ''

  const { rows } = await query(
    `SELECT tqg.*, twt.code AS warehouse_type_code, twt.name AS warehouse_type_name
     FROM tenant_quality_grades tqg
     LEFT JOIN tenant_warehouse_types twt ON twt.id = tqg.goes_to_warehouse_type_id
     WHERE tqg.tenant_id = $1 ${where}
     ORDER BY tqg.grade_number`,
    params
  )
  return rows
}

async function getGrade({ tenantId, id }) {
  const { rows } = await query(
    `SELECT tqg.*, twt.code AS warehouse_type_code, twt.name AS warehouse_type_name
     FROM tenant_quality_grades tqg
     LEFT JOIN tenant_warehouse_types twt ON twt.id = tqg.goes_to_warehouse_type_id
     WHERE tqg.id = $1 AND tqg.tenant_id = $2`,
    [id, tenantId]
  )
  return rows[0] || null
}

// ─── Escrituras ──────────────────────────────────────────────────────────

async function createGrade({
  tenantId, userId,
  gradeNumber, code, name,
  countsForOrderFulfillment = false,
  goesToWarehouseTypeId = null,
  defaultColor = null,
  sortOrder = 0,
  ipAddress, userAgent,
}) {
  if (!code) throw badReq('code es requerido.')
  if (!name) throw badReq('name es requerido.')
  if (!Number.isInteger(gradeNumber) || gradeNumber < 1 || gradeNumber > 5) {
    throw badReq('grade_number debe ser entero entre 1 y 5.')
  }
  if (typeof countsForOrderFulfillment !== 'boolean') {
    throw badReq('counts_for_order_fulfillment debe ser boolean.')
  }
  if (defaultColor !== null && !/^#[0-9a-fA-F]{6}$/.test(defaultColor)) {
    throw badReq('default_color debe estar en formato hex #RRGGBB.')
  }

  // Validar warehouse_type pertenece al tenant
  if (goesToWarehouseTypeId) {
    const { rows } = await query(
      `SELECT 1 FROM tenant_warehouse_types WHERE id = $1 AND tenant_id = $2`,
      [goesToWarehouseTypeId, tenantId]
    )
    if (rows.length === 0) {
      throw badReq('goes_to_warehouse_type_id no existe en este tenant.')
    }
  }

  try {
    const { rows } = await query(
      `INSERT INTO tenant_quality_grades
         (tenant_id, grade_number, code, name,
          counts_for_order_fulfillment, goes_to_warehouse_type_id,
          default_color, sort_order, created_by_user_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING *`,
      [tenantId, gradeNumber, code, name,
       countsForOrderFulfillment, goesToWarehouseTypeId,
       defaultColor, sortOrder, userId]
    )
    await audit({
      tenantId, userId,
      action: 'tenant_quality_grade.created',
      resource: 'tenant_quality_grades',
      resourceId: rows[0].id,
      payload: { gradeNumber, code, countsForOrderFulfillment },
      ipAddress, userAgent,
    })
    return rows[0]
  } catch (err) {
    if (err.code === '23505' && err.constraint === 'tqg_grade_per_tenant') {
      throw conflict(`Ya existe una calidad con grade_number=${gradeNumber}.`)
    }
    if (err.code === '23505' && err.constraint === 'tqg_code_per_tenant') {
      throw conflict(`Ya existe una calidad con code="${code}".`)
    }
    throw err
  }
}

async function updateGrade({
  tenantId, userId, id,
  name, countsForOrderFulfillment,
  goesToWarehouseTypeId, defaultColor,
  sortOrder, isActive,
  ipAddress, userAgent,
}) {
  const current = await getGrade({ tenantId, id })
  if (!current) {
    const err = new Error('Calidad no encontrada.')
    err.status = 404
    throw err
  }

  const setters = []
  const params = []
  let i = 1

  if (name !== undefined) { setters.push(`name = $${i++}`); params.push(name) }
  if (countsForOrderFulfillment !== undefined) {
    if (typeof countsForOrderFulfillment !== 'boolean') throw badReq('counts_for_order_fulfillment debe ser boolean.')
    setters.push(`counts_for_order_fulfillment = $${i++}`); params.push(countsForOrderFulfillment)
  }
  if (goesToWarehouseTypeId !== undefined) {
    if (goesToWarehouseTypeId !== null) {
      const { rows } = await query(
        `SELECT 1 FROM tenant_warehouse_types WHERE id = $1 AND tenant_id = $2`,
        [goesToWarehouseTypeId, tenantId]
      )
      if (rows.length === 0) throw badReq('goes_to_warehouse_type_id no existe en este tenant.')
    }
    setters.push(`goes_to_warehouse_type_id = $${i++}`); params.push(goesToWarehouseTypeId)
  }
  if (defaultColor !== undefined) {
    if (defaultColor !== null && !/^#[0-9a-fA-F]{6}$/.test(defaultColor)) {
      throw badReq('default_color debe estar en formato hex #RRGGBB.')
    }
    setters.push(`default_color = $${i++}`); params.push(defaultColor)
  }
  if (sortOrder !== undefined) { setters.push(`sort_order = $${i++}`); params.push(sortOrder) }
  if (isActive !== undefined) {
    if (typeof isActive !== 'boolean') throw badReq('is_active debe ser boolean.')
    // Si va a desactivar, validar que no es la última activa
    if (isActive === false) {
      const { rows } = await query(
        `SELECT COUNT(*)::int AS c FROM tenant_quality_grades
         WHERE tenant_id = $1 AND is_active = true AND id <> $2`,
        [tenantId, id]
      )
      if (rows[0].c === 0) {
        throw badReq('No se puede desactivar la última calidad activa. Debe existir al menos una.')
      }
    }
    setters.push(`is_active = $${i++}`); params.push(isActive)
  }

  if (setters.length === 0) throw badReq('No hay campos válidos para actualizar.')

  setters.push(`updated_by_user_id = $${i++}`); params.push(userId)
  params.push(id, tenantId)

  const { rows } = await query(
    `UPDATE tenant_quality_grades SET ${setters.join(', ')}
     WHERE id = $${i++} AND tenant_id = $${i}
     RETURNING *`,
    params
  )

  await audit({
    tenantId, userId,
    action: 'tenant_quality_grade.updated',
    resource: 'tenant_quality_grades',
    resourceId: id,
    payload: { changedFields: setters.length - 1 },
    ipAddress, userAgent,
  })

  return rows[0]
}

function badReq(msg)   { const e = new Error(msg); e.status = 400; return e }
function conflict(msg) { const e = new Error(msg); e.status = 409; return e }

module.exports = {
  listGrades, getGrade, createGrade, updateGrade,
}
