'use strict'

// Caja chica — service. CRUD de fondos, categorías y movimientos.
// Saldo de un fondo = initial_balance + SUM(in_active) − SUM(out_active).
// Los movimientos cancelados NO afectan el saldo.

const { query } = require('../../db')

// ─── Fondos ──────────────────────────────────────────────────────────────

/**
 * Lista fondos del tenant con su saldo calculado en vivo.
 */
async function listFunds(tenantId, { includeInactive = false } = {}) {
  const conditions = ['f.tenant_id = $1']
  if (!includeInactive) conditions.push('f.is_active = true')

  const { rows } = await query(`
    SELECT f.id, f.name, f.location, f.responsible_user_id,
           u.full_name AS responsible_name,
           f.initial_balance, f.is_active, f.notes,
           f.created_at, f.updated_at,
           COALESCE((
             SELECT SUM(CASE WHEN kind = 'in' THEN amount ELSE -amount END)
               FROM petty_cash_movements
              WHERE fund_id = f.id AND status = 'active'
           ), 0)::numeric AS net_movements,
           COALESCE((
             SELECT COUNT(*) FROM petty_cash_movements
              WHERE fund_id = f.id AND status = 'active'
           ), 0)::int AS movements_count
      FROM petty_cash_funds f
      LEFT JOIN users u ON u.id = f.responsible_user_id
     WHERE ${conditions.join(' AND ')}
     ORDER BY f.is_active DESC, f.name
  `, [tenantId])

  return rows.map(r => ({
    id:                  r.id,
    name:                r.name,
    location:            r.location,
    responsible_user_id: r.responsible_user_id,
    responsible_name:    r.responsible_name,
    initial_balance:     parseFloat(r.initial_balance) || 0,
    is_active:           r.is_active,
    notes:               r.notes,
    movements_count:     r.movements_count,
    current_balance:     (parseFloat(r.initial_balance) || 0) + (parseFloat(r.net_movements) || 0),
    created_at:          r.created_at,
    updated_at:          r.updated_at,
  }))
}

async function getFund(tenantId, fundId) {
  const rows = await listFunds(tenantId, { includeInactive: true })
  return rows.find(f => f.id === fundId) || null
}

async function createFund(tenantId, userId, payload) {
  const { name, location, responsibleUserId, initialBalance, notes } = payload
  if (!name?.trim()) throw badRequest('El nombre del fondo es requerido.')
  const initBal = parseFloat(initialBalance) || 0
  if (initBal < 0) throw badRequest('El saldo inicial no puede ser negativo.')

  const { rows } = await query(`
    INSERT INTO petty_cash_funds
      (tenant_id, name, location, responsible_user_id, initial_balance, notes, created_by)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    RETURNING id
  `, [tenantId, name.trim(), location || null, responsibleUserId || null, initBal, notes || null, userId])

  return getFund(tenantId, rows[0].id)
}

async function updateFund(tenantId, fundId, payload) {
  const { name, location, responsibleUserId, initialBalance, isActive, notes } = payload
  const sets = []
  const params = [tenantId, fundId]
  let idx = 3

  if (name !== undefined)              { sets.push(`name = $${idx++}`);                params.push(name.trim()) }
  if (location !== undefined)          { sets.push(`location = $${idx++}`);            params.push(location || null) }
  if (responsibleUserId !== undefined) { sets.push(`responsible_user_id = $${idx++}`); params.push(responsibleUserId || null) }
  if (initialBalance !== undefined)    { sets.push(`initial_balance = $${idx++}`);     params.push(parseFloat(initialBalance) || 0) }
  if (isActive !== undefined)          { sets.push(`is_active = $${idx++}`);           params.push(!!isActive) }
  if (notes !== undefined)             { sets.push(`notes = $${idx++}`);               params.push(notes || null) }

  if (sets.length === 0) return getFund(tenantId, fundId)

  await query(`
    UPDATE petty_cash_funds SET ${sets.join(', ')}
     WHERE tenant_id = $1 AND id = $2
  `, params)
  return getFund(tenantId, fundId)
}

// ─── Categorías ──────────────────────────────────────────────────────────

async function listCategories(tenantId, { kind = null, includeInactive = false } = {}) {
  const conditions = ['tenant_id = $1']
  const params = [tenantId]
  let idx = 2
  if (kind) { conditions.push(`kind = $${idx++}`); params.push(kind) }
  if (!includeInactive) conditions.push('is_active = true')

  const { rows } = await query(`
    SELECT id, name, kind, is_active, created_at
      FROM petty_cash_categories
     WHERE ${conditions.join(' AND ')}
     ORDER BY kind, name
  `, params)
  return rows
}

async function createCategory(tenantId, payload) {
  const { name, kind } = payload
  if (!name?.trim()) throw badRequest('El nombre de la categoría es requerido.')
  if (!['in', 'out'].includes(kind)) throw badRequest('kind debe ser "in" u "out".')

  const { rows } = await query(`
    INSERT INTO petty_cash_categories (tenant_id, name, kind)
    VALUES ($1, $2, $3)
    ON CONFLICT (tenant_id, kind, name) DO UPDATE
      SET is_active = true
    RETURNING id, name, kind, is_active, created_at
  `, [tenantId, name.trim(), kind])
  return rows[0]
}

async function updateCategory(tenantId, categoryId, payload) {
  const { name, isActive } = payload
  const sets = []
  const params = [tenantId, categoryId]
  let idx = 3
  if (name !== undefined)     { sets.push(`name = $${idx++}`);      params.push(name.trim()) }
  if (isActive !== undefined) { sets.push(`is_active = $${idx++}`); params.push(!!isActive) }
  if (sets.length === 0) return null

  const { rows } = await query(`
    UPDATE petty_cash_categories SET ${sets.join(', ')}
     WHERE tenant_id = $1 AND id = $2
    RETURNING id, name, kind, is_active, created_at
  `, params)
  return rows[0] || null
}

// ─── Movimientos ────────────────────────────────────────────────────────

async function listMovements(tenantId, filters = {}) {
  const conditions = ['m.tenant_id = $1']
  const params = [tenantId]
  let idx = 2

  if (filters.fundId)     { conditions.push(`m.fund_id = $${idx++}`);     params.push(filters.fundId) }
  if (filters.kind)       { conditions.push(`m.kind = $${idx++}`);        params.push(filters.kind) }
  if (filters.categoryId) { conditions.push(`m.category_id = $${idx++}`); params.push(filters.categoryId) }
  if (filters.status)     { conditions.push(`m.status = $${idx++}`);      params.push(filters.status) }
  if (filters.from)       { conditions.push(`m.occurred_at >= $${idx++}`); params.push(filters.from) }
  if (filters.to)         { conditions.push(`m.occurred_at <= $${idx++}`); params.push(filters.to) }

  const limit  = Math.min(parseInt(filters.limit, 10) || 100, 500)
  const offset = parseInt(filters.offset, 10) || 0

  const { rows } = await query(`
    SELECT m.id, m.fund_id, f.name AS fund_name,
           m.kind, m.amount, m.category_id, c.name AS category_name,
           m.description, m.paid_to, m.occurred_at, m.status,
           m.cancelled_reason, m.cancelled_at,
           uc.full_name AS cancelled_by_name,
           uo.full_name AS created_by_name,
           m.created_at,
           (SELECT a.id FROM attachments a
             WHERE a.entity_type = 'petty_cash_movement' AND a.entity_id = m.id
             LIMIT 1) AS attachment_id
      FROM petty_cash_movements m
      JOIN petty_cash_funds f      ON f.id = m.fund_id
      LEFT JOIN petty_cash_categories c ON c.id = m.category_id
      LEFT JOIN users uc ON uc.id = m.cancelled_by
      LEFT JOIN users uo ON uo.id = m.created_by
     WHERE ${conditions.join(' AND ')}
     ORDER BY m.occurred_at DESC, m.created_at DESC
     LIMIT $${idx++} OFFSET $${idx++}
  `, [...params, limit, offset])

  const { rows: countRows } = await query(`
    SELECT COUNT(*)::int AS total FROM petty_cash_movements m
     WHERE ${conditions.join(' AND ')}
  `, params)

  return {
    data: rows.map(r => ({
      id:                r.id,
      fund_id:           r.fund_id,
      fund_name:         r.fund_name,
      kind:              r.kind,
      amount:            parseFloat(r.amount) || 0,
      category_id:       r.category_id,
      category_name:     r.category_name,
      description:       r.description,
      paid_to:           r.paid_to,
      occurred_at:       r.occurred_at,
      status:            r.status,
      cancelled_reason:  r.cancelled_reason,
      cancelled_by_name: r.cancelled_by_name,
      cancelled_at:      r.cancelled_at,
      created_by_name:   r.created_by_name,
      created_at:        r.created_at,
      attachment_id:     r.attachment_id,
    })),
    total:  countRows[0].total,
    limit,
    offset,
  }
}

async function createMovement(tenantId, userId, payload) {
  const { fundId, kind, amount, categoryId, description, paidTo, occurredAt } = payload

  if (!fundId) throw badRequest('fundId es requerido.')
  if (!['in', 'out'].includes(kind)) throw badRequest('kind debe ser "in" u "out".')
  const amt = parseFloat(amount)
  if (!amt || amt <= 0) throw badRequest('El monto debe ser un número positivo.')

  const paidToClean = (paidTo || '').toString().trim()
  if (kind === 'out' && !paidToClean) {
    throw badRequest('En las salidas debes indicar a quién se le entregó el dinero.')
  }

  // Valida que el fondo exista y esté activo.
  const { rows: fundRows } = await query(
    `SELECT id, is_active FROM petty_cash_funds WHERE tenant_id = $1 AND id = $2`,
    [tenantId, fundId]
  )
  if (fundRows.length === 0) throw badRequest('Fondo no encontrado.', 404)
  if (!fundRows[0].is_active) throw badRequest('El fondo está inactivo — reactívalo antes de capturar movimientos.')

  // Para salidas, valida que haya saldo suficiente.
  if (kind === 'out') {
    const fund = await getFund(tenantId, fundId)
    if (fund.current_balance < amt) {
      throw badRequest(`Saldo insuficiente. Disponible: $${fund.current_balance.toFixed(2)}.`)
    }
  }

  // Si trae categoryId, valida que pertenezca al tenant y sea del mismo kind.
  if (categoryId) {
    const { rows: catRows } = await query(
      `SELECT kind FROM petty_cash_categories WHERE tenant_id = $1 AND id = $2 AND is_active = true`,
      [tenantId, categoryId]
    )
    if (catRows.length === 0) throw badRequest('Categoría no encontrada o inactiva.')
    if (catRows[0].kind !== kind) {
      throw badRequest(`La categoría es de tipo "${catRows[0].kind}" — no coincide con el movimiento.`)
    }
  }

  const { rows } = await query(`
    INSERT INTO petty_cash_movements
      (tenant_id, fund_id, kind, amount, category_id, description, paid_to, occurred_at, created_by)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    RETURNING id
  `, [tenantId, fundId, kind, amt, categoryId || null, description || null,
      paidToClean || null,
      occurredAt || new Date().toISOString().slice(0, 10), userId])

  return getMovement(tenantId, rows[0].id)
}

async function getMovement(tenantId, movementId) {
  const { rows } = await query(`
    SELECT m.id, m.fund_id, f.name AS fund_name,
           m.kind, m.amount, m.category_id, c.name AS category_name,
           m.description, m.paid_to, m.occurred_at, m.status,
           m.cancelled_reason, m.cancelled_at,
           uc.full_name AS cancelled_by_name,
           uo.full_name AS created_by_name,
           m.created_at,
           (SELECT a.id FROM attachments a
             WHERE a.entity_type = 'petty_cash_movement' AND a.entity_id = m.id
             LIMIT 1) AS attachment_id
      FROM petty_cash_movements m
      JOIN petty_cash_funds f      ON f.id = m.fund_id
      LEFT JOIN petty_cash_categories c ON c.id = m.category_id
      LEFT JOIN users uc ON uc.id = m.cancelled_by
      LEFT JOIN users uo ON uo.id = m.created_by
     WHERE m.tenant_id = $1 AND m.id = $2
  `, [tenantId, movementId])
  if (rows.length === 0) return null
  const r = rows[0]
  return {
    id:                r.id,
    fund_id:           r.fund_id,
    fund_name:         r.fund_name,
    kind:              r.kind,
    amount:            parseFloat(r.amount) || 0,
    category_id:       r.category_id,
    category_name:     r.category_name,
    description:       r.description,
    paid_to:           r.paid_to,
    occurred_at:       r.occurred_at,
    status:            r.status,
    cancelled_reason:  r.cancelled_reason,
    cancelled_by_name: r.cancelled_by_name,
    cancelled_at:      r.cancelled_at,
    created_by_name:   r.created_by_name,
    created_at:        r.created_at,
    attachment_id:     r.attachment_id,
  }
}

async function cancelMovement(tenantId, userId, movementId, reason) {
  if (!reason?.trim()) throw badRequest('El motivo de cancelación es requerido.')
  const { rowCount } = await query(`
    UPDATE petty_cash_movements
       SET status = 'cancelled',
           cancelled_reason = $3,
           cancelled_by = $4,
           cancelled_at = NOW()
     WHERE tenant_id = $1 AND id = $2 AND status = 'active'
  `, [tenantId, movementId, reason.trim(), userId])
  if (rowCount === 0) {
    throw badRequest('Movimiento no encontrado o ya cancelado.', 404)
  }
  return getMovement(tenantId, movementId)
}

// ─── Utils ──────────────────────────────────────────────────────────────

function badRequest(message, status = 400) {
  const e = new Error(message)
  e.status = status
  return e
}

module.exports = {
  listFunds, getFund, createFund, updateFund,
  listCategories, createCategory, updateCategory,
  listMovements, getMovement, createMovement, cancelMovement,
}
