'use strict'

/**
 * SaaS v2 §Fase3 — Servicio de ítems de overhead por tenant.
 *
 * CRUD del catálogo `tenant_overhead_items`. Cada ítem representa un costo
 * indirecto (energía, MOI, mantenimiento…) que se distribuirá a los turnos
 * según su allocation_base.
 */

const { query, withBypass } = require('../../db')

// Campos permitidos en creación y actualización
const ALLOWED_FIELDS = {
  create: ['code', 'name', 'allocation_base', 'capture_frequency',
           'default_estimated_amount', 'default_expected_basis_divisor',
           'is_active', 'sort_order', 'notes'],
  update: ['name', 'allocation_base', 'capture_frequency',
           'default_estimated_amount', 'default_expected_basis_divisor',
           'is_active', 'sort_order', 'notes'],
}

const VALID_ALLOCATION_BASES   = ['shifts', 'hours', 'units', 'weight', 'equal']
const VALID_CAPTURE_FREQUENCIES = ['monthly', 'biweekly', 'weekly', 'annual', 'event']

/**
 * Valida y lanza error 400 con mensaje en español si algo falla.
 */
function validate(data, mode) {
  if (mode === 'create') {
    if (!data.code || typeof data.code !== 'string' || !data.code.trim()) {
      const err = new Error('El campo code es requerido.')
      err.status = 400; throw err
    }
    if (!data.name || typeof data.name !== 'string' || !data.name.trim()) {
      const err = new Error('El campo name es requerido.')
      err.status = 400; throw err
    }
  }
  if (data.allocation_base !== undefined &&
      !VALID_ALLOCATION_BASES.includes(data.allocation_base)) {
    const err = new Error(`allocation_base debe ser uno de: ${VALID_ALLOCATION_BASES.join(', ')}.`)
    err.status = 400; throw err
  }
  if (data.capture_frequency !== undefined &&
      !VALID_CAPTURE_FREQUENCIES.includes(data.capture_frequency)) {
    const err = new Error(`capture_frequency debe ser uno de: ${VALID_CAPTURE_FREQUENCIES.join(', ')}.`)
    err.status = 400; throw err
  }
  if (data.default_estimated_amount !== undefined &&
      data.default_estimated_amount !== null &&
      (isNaN(parseFloat(data.default_estimated_amount)) || parseFloat(data.default_estimated_amount) < 0)) {
    const err = new Error('default_estimated_amount debe ser un número >= 0.')
    err.status = 400; throw err
  }
  if (data.default_expected_basis_divisor !== undefined &&
      data.default_expected_basis_divisor !== null &&
      (isNaN(parseFloat(data.default_expected_basis_divisor)) || parseFloat(data.default_expected_basis_divisor) <= 0)) {
    const err = new Error('default_expected_basis_divisor debe ser un número > 0 (o vacío).')
    err.status = 400; throw err
  }
  if (data.is_active !== undefined && typeof data.is_active !== 'boolean') {
    const err = new Error('is_active debe ser boolean.')
    err.status = 400; throw err
  }
  if (data.sort_order !== undefined && data.sort_order !== null &&
      (!Number.isInteger(data.sort_order) || data.sort_order < 0)) {
    const err = new Error('sort_order debe ser un entero >= 0.')
    err.status = 400; throw err
  }
}

/**
 * Lista los ítems de overhead del tenant.
 * @param {string} tenantId
 * @param {{ includeInactive?: boolean }} options
 */
async function listItems(tenantId, { includeInactive = false } = {}) {
  const inactiveClause = includeInactive ? '' : 'AND is_active = true'
  const { rows } = await withBypass(() =>
    query(
      `SELECT * FROM tenant_overhead_items
       WHERE tenant_id = $1 ${inactiveClause}
       ORDER BY sort_order, name`,
      [tenantId]
    )
  )
  return rows
}

/**
 * Obtiene un ítem por id, verificando que pertenece al tenant.
 */
async function getItem(tenantId, id) {
  const { rows } = await withBypass(() =>
    query(
      `SELECT * FROM tenant_overhead_items WHERE id = $1 AND tenant_id = $2`,
      [id, tenantId]
    )
  )
  return rows[0] || null
}

/**
 * Crea un nuevo ítem de overhead.
 */
async function createItem(tenantId, body) {
  validate(body, 'create')

  // Filtrar solo campos permitidos
  const data = {}
  for (const key of ALLOWED_FIELDS.create) {
    if (body[key] !== undefined) data[key] = body[key]
  }

  // Verificar que el code no esté duplicado en el tenant
  const { rows: existing } = await withBypass(() =>
    query(
      `SELECT id FROM tenant_overhead_items WHERE tenant_id = $1 AND code = $2`,
      [tenantId, data.code.trim()]
    )
  )
  if (existing.length > 0) {
    const err = new Error(`Ya existe un ítem de overhead con code '${data.code.trim()}' en este tenant.`)
    err.status = 409; throw err
  }

  const cols = ['tenant_id', ...Object.keys(data)]
  const vals = [tenantId, ...Object.values(data)]
  const placeholders = vals.map((_, i) => `$${i + 1}`).join(', ')

  const { rows } = await withBypass(() =>
    query(
      `INSERT INTO tenant_overhead_items (${cols.join(', ')})
       VALUES (${placeholders})
       RETURNING *`,
      vals
    )
  )
  return rows[0]
}

/**
 * Actualiza campos permitidos de un ítem. Solo modifica los campos enviados.
 */
async function updateItem(tenantId, id, patch) {
  validate(patch, 'update')

  const existing = await getItem(tenantId, id)
  if (!existing) {
    const err = new Error('El ítem de overhead no existe o no pertenece a este tenant.')
    err.status = 404; throw err
  }

  // Filtrar solo campos permitidos
  const data = {}
  for (const key of ALLOWED_FIELDS.update) {
    if (patch[key] !== undefined) data[key] = patch[key]
  }

  if (Object.keys(data).length === 0) {
    const err = new Error('No hay campos válidos para actualizar.')
    err.status = 400; throw err
  }

  const setClauses = []
  const params = []
  let i = 1
  for (const [k, v] of Object.entries(data)) {
    setClauses.push(`${k} = $${i++}`)
    params.push(v)
  }
  params.push(id, tenantId)

  const { rows } = await withBypass(() =>
    query(
      `UPDATE tenant_overhead_items
       SET ${setClauses.join(', ')}
       WHERE id = $${i++} AND tenant_id = $${i}
       RETURNING *`,
      params
    )
  )
  return rows[0]
}

module.exports = { listItems, getItem, createItem, updateItem }
