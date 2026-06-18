'use strict'

/**
 * Catálogo de tarjetas de crédito del tenant (mig 212) + escaneo de pagos
 * próximos a vencer para recordatorios.
 *
 * Espejo del módulo bank-accounts, con campos de tarjeta (corte/pago/responsable)
 * y la función scanDuePayments que el cron usa para disparar alertas.
 */

const { query } = require('../../db')
const { audit } = require('../../utils/audit')
const { dispatchAlert } = require('../alerts/alertService')

function createError(status, message) {
  const err = new Error(message)
  err.status = status
  return err
}

const CARD_COLS = `id, alias, bank_name, last_four, statement_day, payment_day,
                   responsible_user_id, responsible_name, credit_limit, currency,
                   reminder_lead_days, active, notes, created_at, updated_at`

async function list({ tenantId, includeInactive = false }) {
  const filters = ['cc.tenant_id = $1']
  if (!includeInactive) filters.push('cc.active = TRUE')
  const { rows } = await query(
    `SELECT cc.id, cc.alias, cc.bank_name, cc.last_four, cc.statement_day, cc.payment_day,
            cc.responsible_user_id, cc.responsible_name, cc.credit_limit, cc.currency,
            cc.reminder_lead_days, cc.active, cc.notes, cc.created_at, cc.updated_at,
            u.full_name AS responsible_full_name
       FROM credit_cards cc
       LEFT JOIN users u ON u.id = cc.responsible_user_id
      WHERE ${filters.join(' AND ')}
      ORDER BY cc.active DESC, cc.alias ASC`,
    [tenantId]
  )
  return rows
}

async function get({ tenantId, id }) {
  const { rows } = await query(
    `SELECT ${CARD_COLS} FROM credit_cards WHERE id = $1 AND tenant_id = $2`,
    [id, tenantId]
  )
  return rows[0] || null
}

async function normalize(tenantId, body) {
  const alias = (body.alias || '').trim()
  if (!alias) throw createError(400, 'El alias de la tarjeta es requerido.')

  const statementDay = parseInt(body.statementDay ?? body.statement_day, 10)
  const paymentDay   = parseInt(body.paymentDay   ?? body.payment_day, 10)
  if (!(statementDay >= 1 && statementDay <= 31)) throw createError(400, 'El día de corte debe estar entre 1 y 31.')
  if (!(paymentDay   >= 1 && paymentDay   <= 31)) throw createError(400, 'El día límite de pago debe estar entre 1 y 31.')

  const lastFour = (body.lastFour || body.last_four || '').trim() || null
  if (lastFour && !/^[0-9]{4}$/.test(lastFour)) throw createError(400, 'Los últimos 4 dígitos deben ser 4 números.')

  const currency = (body.currency || 'MXN').toUpperCase()
  if (!['MXN', 'USD'].includes(currency)) throw createError(400, 'currency debe ser MXN o USD.')

  let leadDays = body.reminderLeadDays ?? body.reminder_lead_days
  leadDays = leadDays === undefined || leadDays === null || leadDays === '' ? 3 : parseInt(leadDays, 10)
  if (!(leadDays >= 0 && leadDays <= 30)) throw createError(400, 'Los días de anticipación deben estar entre 0 y 30.')

  let creditLimit = body.creditLimit ?? body.credit_limit
  creditLimit = creditLimit === undefined || creditLimit === null || creditLimit === '' ? null : parseFloat(creditLimit)
  if (creditLimit !== null && (isNaN(creditLimit) || creditLimit < 0)) throw createError(400, 'El límite de crédito no es válido.')

  // Responsable: si es un usuario, debe pertenecer a este tenant (evita asignar a alguien de otro).
  let responsibleUserId = body.responsibleUserId ?? body.responsible_user_id ?? null
  responsibleUserId = responsibleUserId || null
  if (responsibleUserId) {
    const { rows } = await query(
      `SELECT id FROM users WHERE id = $1 AND tenant_id = $2`, [responsibleUserId, tenantId])
    if (!rows.length) throw createError(400, 'El usuario responsable no pertenece a este tenant.')
  }

  return {
    alias,
    bankName: (body.bankName || body.bank_name || '').trim() || null,
    lastFour,
    statementDay,
    paymentDay,
    responsibleUserId,
    responsibleName: (body.responsibleName || body.responsible_name || '').trim() || null,
    creditLimit,
    currency,
    reminderLeadDays: leadDays,
    active: body.active === undefined ? true : !!body.active,
    notes: (body.notes || '').trim() || null,
  }
}

async function create({ tenantId, userId, body, ipAddress, userAgent }) {
  const v = await normalize(tenantId, body)
  const { rows } = await query(
    `INSERT INTO credit_cards
       (tenant_id, alias, bank_name, last_four, statement_day, payment_day,
        responsible_user_id, responsible_name, credit_limit, currency,
        reminder_lead_days, active, notes, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     RETURNING ${CARD_COLS}`,
    [tenantId, v.alias, v.bankName, v.lastFour, v.statementDay, v.paymentDay,
     v.responsibleUserId, v.responsibleName, v.creditLimit, v.currency,
     v.reminderLeadDays, v.active, v.notes, userId]
  )
  await audit({
    tenantId, userId, action: 'credit_card.created',
    resource: 'credit_cards', resourceId: rows[0].id,
    payload: { alias: v.alias, last_four: v.lastFour }, ipAddress, userAgent,
  })
  return rows[0]
}

async function update({ tenantId, userId, id, body, ipAddress, userAgent }) {
  const existing = await get({ tenantId, id })
  if (!existing) throw createError(404, 'Tarjeta no encontrada.')
  const v = await normalize(tenantId, { ...existing, ...body })
  const { rows } = await query(
    `UPDATE credit_cards SET
       alias = $1, bank_name = $2, last_four = $3, statement_day = $4, payment_day = $5,
       responsible_user_id = $6, responsible_name = $7, credit_limit = $8, currency = $9,
       reminder_lead_days = $10, active = $11, notes = $12
     WHERE id = $13 AND tenant_id = $14
     RETURNING ${CARD_COLS}`,
    [v.alias, v.bankName, v.lastFour, v.statementDay, v.paymentDay,
     v.responsibleUserId, v.responsibleName, v.creditLimit, v.currency,
     v.reminderLeadDays, v.active, v.notes, id, tenantId]
  )
  await audit({
    tenantId, userId, action: 'credit_card.updated',
    resource: 'credit_cards', resourceId: id,
    payload: { alias: v.alias, active: v.active }, ipAddress, userAgent,
  })
  return rows[0]
}

async function remove({ tenantId, userId, id, ipAddress, userAgent }) {
  // Soft-delete: las referencias en supplier_payments deben preservarse.
  const { rows } = await query(
    `UPDATE credit_cards SET active = FALSE WHERE id = $1 AND tenant_id = $2 RETURNING ${CARD_COLS}`,
    [id, tenantId]
  )
  if (!rows.length) throw createError(404, 'Tarjeta no encontrada.')
  await audit({
    tenantId, userId, action: 'credit_card.deactivated',
    resource: 'credit_cards', resourceId: id, ipAddress, userAgent,
  })
  return rows[0]
}

// ── Recordatorios de pago (Fase 2) ──────────────────────────────────────────

function daysInMonth(year, month1) { return new Date(Date.UTC(year, month1, 0)).getUTCDate() }
function buildUTC(y, m1, d) { return new Date(Date.UTC(y, m1 - 1, d)) }

/** Fecha de hoy en zona horaria de México como 'YYYY-MM-DD'. */
function mxToday() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' })
}

/**
 * Próxima ocurrencia de un día-del-mes a partir de `todayStr` (YYYY-MM-DD).
 * Clampa al último día del mes (ej. día 31 en febrero → 28/29).
 * @returns {{ date: Date, cycle: string, daysUntil: number }}
 */
function nextOccurrence(dayOfMonth, todayStr) {
  const [ty, tm, td] = todayStr.split('-').map(Number)
  const today = buildUTC(ty, tm, td)
  let y = ty, m = tm
  let cand = buildUTC(y, m, Math.min(dayOfMonth, daysInMonth(y, m)))
  if (cand < today) {
    m += 1
    if (m > 12) { m = 1; y += 1 }
    cand = buildUTC(y, m, Math.min(dayOfMonth, daysInMonth(y, m)))
  }
  const daysUntil = Math.round((cand - today) / 86400000)
  return { date: cand, cycle: `${y}-${String(m).padStart(2, '0')}`, daysUntil }
}

/**
 * Escanea las tarjetas activas del tenant y dispara una alerta por cada una
 * cuyo día de pago caiga dentro de su ventana de anticipación. dispatchAlert
 * dedupea por (tipo, source) y el sourceId incluye el ciclo (YYYY-MM) → un aviso
 * por tarjeta por ciclo. Push dirigido al responsable (si es usuario) o a finanzas.
 *
 * @returns {Promise<number>} alertas nuevas disparadas.
 */
async function scanDuePayments({ tenantId, today = mxToday() }) {
  const { rows: cards } = await query(
    `SELECT id, alias, last_four, payment_day, reminder_lead_days, responsible_user_id, responsible_name
       FROM credit_cards WHERE tenant_id = $1 AND active = TRUE`,
    [tenantId]
  )
  let fired = 0
  for (const card of cards) {
    const { date, cycle, daysUntil } = nextOccurrence(card.payment_day, today)
    if (daysUntil > card.reminder_lead_days) continue   // todavía no entra en la ventana

    const fecha = date.toISOString().slice(0, 10)
    const last4 = card.last_four ? ` ••${card.last_four}` : ''
    const quien = card.responsible_name ? ` Responsable: ${card.responsible_name}.` : ''
    const cuando = daysUntil === 0 ? 'hoy' : daysUntil === 1 ? 'mañana' : `en ${daysUntil} días`

    const res = await dispatchAlert(null, {
      tenantId,
      type: 'credit_card_payment_due',
      severity: daysUntil <= 1 ? 'critical' : 'warning',
      title: `Pago de tarjeta ${card.alias}${last4} ${cuando}`,
      body: `La fecha límite de pago de la tarjeta ${card.alias}${last4} es el ${fecha}.${quien}`,
      payload: { creditCardId: card.id, paymentDate: fecha, daysUntil, cycle },
      sourceType: 'credit_card',
      // source_id es UUID → usamos la tarjeta. Dedup: un aviso PENDIENTE por
      // tarjeta hasta que se reconozca/resuelva; al resolverlo, el siguiente
      // ciclo genera uno nuevo. El ciclo concreto va en el payload.
      sourceId: card.id,
      audience: card.responsible_user_id
        ? { userIds: [card.responsible_user_id] }
        : { permission: ['financials', 'read'] },
    })
    if (res && !res.deduped) fired += 1
  }
  return fired
}

module.exports = { list, get, create, update, remove, scanDuePayments, nextOccurrence, mxToday }
