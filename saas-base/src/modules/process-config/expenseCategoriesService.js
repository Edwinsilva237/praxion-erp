'use strict'

/**
 * SaaS v2 — Service de categorías de gasto (tenant_expense_categories).
 *
 * Catálogo configurable por tenant: renta, energía, fletes, combustible, etc.
 * CRUD simple, mismo patrón que scrapTypesService. Sembrado por la función del
 * Process Template (mig 182); el tenant lo edita libremente.
 */

const { query } = require('../../db')
const { audit } = require('../../utils/audit')

// ─── Lecturas ─────────────────────────────────────────────────────────────

async function listCategories({ tenantId, isActive }) {
  const params = [tenantId]
  const filters = []
  if (isActive !== undefined) { params.push(isActive); filters.push(`is_active = $${params.length}`) }
  const where = filters.length ? `AND ${filters.join(' AND ')}` : ''

  const { rows } = await query(
    `SELECT * FROM tenant_expense_categories
     WHERE tenant_id = $1 ${where}
     ORDER BY sort_order, name`,
    params
  )
  return rows
}

async function getCategory({ tenantId, id }) {
  const { rows } = await query(
    `SELECT * FROM tenant_expense_categories WHERE id = $1 AND tenant_id = $2`,
    [id, tenantId]
  )
  return rows[0] || null
}

// ─── Escrituras ──────────────────────────────────────────────────────────

// Deriva un code estable a partir del nombre (slug) cuando el usuario no manda
// uno — así la UI solo pide "nombre".
function slugify(name) {
  return String(name || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // quita acentos
    .toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
    .slice(0, 40) || 'gasto'
}

async function createCategory({
  tenantId, userId, code, name, affectsCost = false, sortOrder = 0,
  ipAddress, userAgent,
}) {
  if (!name) throw badReq('name es requerido.')
  if (typeof affectsCost !== 'boolean') throw badReq('affects_cost debe ser boolean.')
  const finalCode = (code && String(code).trim()) || slugify(name)

  try {
    const { rows } = await query(
      `INSERT INTO tenant_expense_categories
         (tenant_id, code, name, affects_cost, sort_order, created_by_user_id)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING *`,
      [tenantId, finalCode, name, affectsCost, sortOrder, userId]
    )
    await audit({
      tenantId, userId, action: 'tenant_expense_category.created',
      resource: 'tenant_expense_categories', resourceId: rows[0].id,
      payload: { code: finalCode, name }, ipAddress, userAgent,
    })
    return rows[0]
  } catch (err) {
    if (err.code === '23505' && err.constraint === 'tec_code_per_tenant') {
      throw conflict(`Ya existe una categoría de gasto con código "${finalCode}".`)
    }
    throw err
  }
}

async function updateCategory({
  tenantId, userId, id, name, affectsCost, sortOrder, isActive,
  ipAddress, userAgent,
}) {
  const current = await getCategory({ tenantId, id })
  if (!current) { const e = new Error('Categoría de gasto no encontrada.'); e.status = 404; throw e }

  const setters = []
  const params = []
  let i = 1

  if (name !== undefined) { setters.push(`name = $${i++}`); params.push(name) }
  if (affectsCost !== undefined) {
    if (typeof affectsCost !== 'boolean') throw badReq('affects_cost debe ser boolean.')
    setters.push(`affects_cost = $${i++}`); params.push(affectsCost)
  }
  if (sortOrder !== undefined) { setters.push(`sort_order = $${i++}`); params.push(sortOrder) }
  if (isActive !== undefined) {
    if (typeof isActive !== 'boolean') throw badReq('is_active debe ser boolean.')
    setters.push(`is_active = $${i++}`); params.push(isActive)
  }

  if (setters.length === 0) throw badReq('No hay campos válidos para actualizar.')

  setters.push(`updated_by_user_id = $${i++}`); params.push(userId)
  setters.push(`updated_at = NOW()`)
  params.push(id, tenantId)

  const { rows } = await query(
    `UPDATE tenant_expense_categories SET ${setters.join(', ')}
     WHERE id = $${i++} AND tenant_id = $${i}
     RETURNING *`,
    params
  )

  await audit({
    tenantId, userId, action: 'tenant_expense_category.updated',
    resource: 'tenant_expense_categories', resourceId: id,
    payload: { changedFields: setters.length - 2 }, ipAddress, userAgent,
  })

  return rows[0]
}

function badReq(msg)   { const e = new Error(msg); e.status = 400; return e }
function conflict(msg) { const e = new Error(msg); e.status = 409; return e }

module.exports = {
  listCategories, getCategory, createCategory, updateCategory,
}
