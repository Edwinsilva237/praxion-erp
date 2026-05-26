'use strict'

const { query } = require('../../db')
const { audit } = require('../../utils/audit')

function createError(status, message) {
  const err = new Error(message)
  err.status = status
  return err
}

async function list({ tenantId, includeInactive = false }) {
  const filters = ['tenant_id = $1']
  if (!includeInactive) filters.push('active = TRUE')
  const { rows } = await query(
    `SELECT id, bank_name, alias, account_number, clabe, currency, active, notes,
            created_at, updated_at
       FROM bank_accounts
      WHERE ${filters.join(' AND ')}
      ORDER BY active DESC, bank_name ASC, alias ASC NULLS LAST`,
    [tenantId]
  )
  return rows
}

async function get({ tenantId, id }) {
  const { rows } = await query(
    `SELECT * FROM bank_accounts WHERE id = $1 AND tenant_id = $2`,
    [id, tenantId]
  )
  return rows[0] || null
}

function normalize(body) {
  const bankName = (body.bankName || body.bank_name || '').trim()
  if (!bankName) throw createError(400, 'bank_name es requerido.')
  const currency = (body.currency || 'MXN').toUpperCase()
  if (!['MXN', 'USD'].includes(currency)) throw createError(400, 'currency debe ser MXN o USD.')
  const clabe = (body.clabe || '').trim() || null
  if (clabe && !/^[0-9]{18}$/.test(clabe)) {
    throw createError(400, 'CLABE debe tener exactamente 18 dígitos.')
  }
  return {
    bankName,
    alias:         (body.alias || '').trim() || null,
    accountNumber: (body.accountNumber || body.account_number || '').trim() || null,
    clabe,
    currency,
    active:        body.active === undefined ? true : !!body.active,
    notes:         (body.notes || '').trim() || null,
  }
}

async function create({ tenantId, userId, body, ipAddress, userAgent }) {
  const v = normalize(body)
  const { rows } = await query(
    `INSERT INTO bank_accounts
       (tenant_id, bank_name, alias, account_number, clabe, currency, active, notes, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     RETURNING *`,
    [tenantId, v.bankName, v.alias, v.accountNumber, v.clabe, v.currency, v.active, v.notes, userId]
  )
  await audit({
    tenantId, userId, action: 'bank_account.created',
    resource: 'bank_accounts', resourceId: rows[0].id,
    payload: { bank_name: v.bankName, alias: v.alias, currency: v.currency },
    ipAddress, userAgent,
  })
  return rows[0]
}

async function update({ tenantId, userId, id, body, ipAddress, userAgent }) {
  const existing = await get({ tenantId, id })
  if (!existing) throw createError(404, 'Cuenta bancaria no encontrada.')
  const v = normalize({ ...existing, ...body })
  const { rows } = await query(
    `UPDATE bank_accounts SET
       bank_name      = $1,
       alias          = $2,
       account_number = $3,
       clabe          = $4,
       currency       = $5,
       active         = $6,
       notes          = $7
     WHERE id = $8 AND tenant_id = $9
     RETURNING *`,
    [v.bankName, v.alias, v.accountNumber, v.clabe, v.currency, v.active, v.notes, id, tenantId]
  )
  await audit({
    tenantId, userId, action: 'bank_account.updated',
    resource: 'bank_accounts', resourceId: id,
    payload: { bank_name: v.bankName, alias: v.alias, active: v.active },
    ipAddress, userAgent,
  })
  return rows[0]
}

async function remove({ tenantId, userId, id, ipAddress, userAgent }) {
  // No borramos: desactivamos. Las referencias en ar_payments deben preservarse
  // para auditoría. Si la cuenta no tiene movimientos, podríamos borrarla, pero
  // el comportamiento por defecto es soft-delete.
  const { rows } = await query(
    `UPDATE bank_accounts SET active = FALSE WHERE id = $1 AND tenant_id = $2 RETURNING *`,
    [id, tenantId]
  )
  if (!rows.length) throw createError(404, 'Cuenta bancaria no encontrada.')
  await audit({
    tenantId, userId, action: 'bank_account.deactivated',
    resource: 'bank_accounts', resourceId: id,
    ipAddress, userAgent,
  })
  return rows[0]
}

module.exports = { list, get, create, update, remove }
