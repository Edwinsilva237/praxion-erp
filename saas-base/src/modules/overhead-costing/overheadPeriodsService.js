'use strict'

/**
 * SaaS v2 §Fase3 — Servicio de períodos de overhead.
 *
 * Gestiona `tenant_overhead_periods`: CRUD de períodos de overhead por ítem.
 * La finalización (is_finalized = true) es responsabilidad de recostingService.
 */

const { query, withBypass } = require('../../db')

/**
 * Lista períodos con filtros opcionales.
 */
async function listPeriods(tenantId, { year, month, itemId, includeFinalized = true } = {}) {
  const conditions = ['top.tenant_id = $1']
  const params = [tenantId]
  let i = 2

  if (year !== undefined && year !== null) {
    conditions.push(`EXTRACT(YEAR FROM top.period_start) = $${i++}`)
    params.push(parseInt(year))
  }
  if (month !== undefined && month !== null) {
    conditions.push(`EXTRACT(MONTH FROM top.period_start) = $${i++}`)
    params.push(parseInt(month))
  }
  if (itemId) {
    conditions.push(`top.overhead_item_id = $${i++}`)
    params.push(itemId)
  }
  if (!includeFinalized) {
    conditions.push('top.is_finalized = false')
  }

  const { rows } = await withBypass(() =>
    query(
      `SELECT top.*,
              toi.code       AS item_code,
              toi.name       AS item_name,
              toi.allocation_base,
              toi.capture_frequency
       FROM tenant_overhead_periods top
       JOIN tenant_overhead_items toi ON toi.id = top.overhead_item_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY top.period_start, toi.sort_order, toi.name`,
      params
    )
  )
  return rows
}

/**
 * Obtiene un período por id con verificación de tenant.
 */
async function getPeriod(tenantId, periodId) {
  const { rows } = await withBypass(() =>
    query(
      `SELECT top.*,
              toi.code AS item_code, toi.name AS item_name,
              toi.allocation_base, toi.capture_frequency
       FROM tenant_overhead_periods top
       JOIN tenant_overhead_items toi ON toi.id = top.overhead_item_id
       WHERE top.id = $1 AND top.tenant_id = $2`,
      [periodId, tenantId]
    )
  )
  return rows[0] || null
}

/**
 * Crea los períodos del mes para todos los ítems activos del tenant,
 * si todavía no existen. Idempotente.
 *
 * @param {string} tenantId
 * @param {number} year
 * @param {number} month  1-12
 * @returns {{ created: number, skipped: number, rows: object[] }}
 */
async function ensurePeriodsForMonth(tenantId, year, month) {
  const y = parseInt(year)
  const m = parseInt(month)
  if (!y || !m || m < 1 || m > 12) {
    const err = new Error('year y month deben ser números válidos (month: 1-12).')
    err.status = 400; throw err
  }

  // Primer y último día del mes
  const periodStart = new Date(y, m - 1, 1)
  const periodEnd   = new Date(y, m, 0)  // día 0 del mes siguiente = último día del mes actual
  const startStr = periodStart.toISOString().slice(0, 10)
  const endStr   = periodEnd.toISOString().slice(0, 10)

  // Obtener todos los ítems activos del tenant
  const { rows: items } = await withBypass(() =>
    query(
      `SELECT * FROM tenant_overhead_items WHERE tenant_id = $1 AND is_active = true ORDER BY sort_order, name`,
      [tenantId]
    )
  )

  if (items.length === 0) {
    return { created: 0, skipped: 0, rows: [] }
  }

  // Verificar qué períodos ya existen para este mes
  const { rows: existing } = await withBypass(() =>
    query(
      `SELECT overhead_item_id FROM tenant_overhead_periods
       WHERE tenant_id = $1
         AND period_start = $2
         AND period_end   = $3`,
      [tenantId, startStr, endStr]
    )
  )
  const existingItemIds = new Set(existing.map(r => r.overhead_item_id))

  const toCreate = items.filter(item => !existingItemIds.has(item.id))
  const created = []

  for (const item of toCreate) {
    const { rows: newRows } = await withBypass(() =>
      query(
        `INSERT INTO tenant_overhead_periods
           (tenant_id, overhead_item_id, period_start, period_end, estimated_amount)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        [tenantId, item.id, startStr, endStr, item.default_estimated_amount]
      )
    )
    created.push(newRows[0])
  }

  return {
    created: created.length,
    skipped: existing.length,
    rows: created,
  }
}

/**
 * Actualiza campos editables de un período (estimated_amount, real_amount, notes).
 * No permite finalizar un período (eso lo hace recostingService).
 */
async function updatePeriod(tenantId, periodId, patch) {
  const existing = await getPeriod(tenantId, periodId)
  if (!existing) {
    const err = new Error('El período de overhead no existe o no pertenece a este tenant.')
    err.status = 404; throw err
  }
  if (existing.is_finalized) {
    const err = new Error('No se puede modificar un período ya finalizado.')
    err.status = 409; throw err
  }

  const ALLOWED = ['estimated_amount', 'real_amount', 'expected_basis_divisor', 'notes']
  const data = {}
  for (const key of ALLOWED) {
    if (patch[key] !== undefined) data[key] = patch[key]
  }

  if (data.estimated_amount !== undefined && data.estimated_amount !== null) {
    const val = parseFloat(data.estimated_amount)
    if (isNaN(val) || val < 0) {
      const err = new Error('estimated_amount debe ser un número >= 0.')
      err.status = 400; throw err
    }
  }
  if (data.real_amount !== undefined && data.real_amount !== null) {
    const val = parseFloat(data.real_amount)
    if (isNaN(val) || val < 0) {
      const err = new Error('real_amount debe ser un número >= 0.')
      err.status = 400; throw err
    }
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
  params.push(periodId, tenantId)

  const { rows } = await withBypass(() =>
    query(
      `UPDATE tenant_overhead_periods
       SET ${setClauses.join(', ')}
       WHERE id = $${i++} AND tenant_id = $${i}
       RETURNING *`,
      params
    )
  )
  return rows[0]
}

module.exports = { listPeriods, getPeriod, ensurePeriodsForMonth, updatePeriod }
