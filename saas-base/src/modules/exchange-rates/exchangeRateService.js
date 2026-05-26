'use strict'

const { query, withTransaction } = require('../../db')
const { audit } = require('../../utils/audit')
const logger = require('../../config/logger')

const BANXICO_URL = 'https://www.banxico.org.mx/SieAPIRest/service/v1/series/SF43718/datos/oportuno'
const BANXICO_TOKEN = process.env.BANXICO_TOKEN || ''

/**
 * Consulta el tipo de cambio FIX del día desde Banxico.
 * Serie SF43718 = Tipo de cambio FIX (USD/MXN) publicado por Banxico/DOF.
 * No requiere token para datos recientes, pero con token tiene mayor límite de requests.
 */
async function fetchRateFromBanxico() {
  const headers = { 'Accept': 'application/json' }
  if (BANXICO_TOKEN) headers['Bmx-Token'] = BANXICO_TOKEN

  const res = await fetch(BANXICO_URL, { headers })
  if (!res.ok) throw new Error(`Banxico API error: ${res.status}`)

  const data = await res.json()
  const series = data?.bmx?.series?.[0]?.datos
  if (!series || series.length === 0) throw new Error('No data from Banxico')

  const latest = series[series.length - 1]
  const rate = parseFloat(latest.dato.replace(',', '.'))
  if (isNaN(rate)) throw new Error(`Invalid rate value: ${latest.dato}`)

  // Banxico devuelve fecha en formato DD/MM/YYYY
  const [day, month, year] = latest.fecha.split('/')
  const rateDate = `${year}-${month}-${day}`

  return { rate, rateDate }
}

/**
 * Guarda o actualiza el TC del día para todos los tenants activos.
 * Se llama desde el cron diario.
 */
async function syncDailyRate() {
  logger.info('Syncing exchange rate from Banxico...')

  let rate, rateDate
  try {
    const result = await fetchRateFromBanxico()
    rate = result.rate
    rateDate = result.rateDate
    logger.info(`Banxico rate: ${rate} MXN/USD for ${rateDate}`)
  } catch (err) {
    logger.error('Failed to fetch rate from Banxico', { error: err.message })
    return { success: false, error: err.message }
  }

  // Obtener todos los tenants activos
  const { rows: tenants } = await query(
    `SELECT id FROM tenants WHERE is_active = true`
  )

  let saved = 0
  for (const tenant of tenants) {
    try {
      await query(
        `INSERT INTO exchange_rates (tenant_id, rate_date, currency, rate_mxn, source)
         VALUES ($1, $2, 'USD', $3, 'dof_auto')
         ON CONFLICT (tenant_id, rate_date, currency)
         DO UPDATE SET rate_mxn = EXCLUDED.rate_mxn, source = 'dof_auto'
         WHERE exchange_rates.source = 'dof_auto'`,
        [tenant.id, rateDate, rate]
      )
      saved++
    } catch (err) {
      logger.error('Failed to save rate for tenant', { tenantId: tenant.id, error: err.message })
    }
  }

  logger.info(`Exchange rate synced for ${saved}/${tenants.length} tenants`)
  return { success: true, rate, rateDate, tenantsSynced: saved }
}

/**
 * Obtiene el TC vigente para una fecha y tenant dados.
 * Si no hay TC para esa fecha exacta, usa el más reciente anterior.
 */
async function getRateForDate({ tenantId, date, currency = 'USD' }) {
  const { rows } = await query(
    `SELECT id, rate_date, rate_mxn, source
     FROM exchange_rates
     WHERE tenant_id = $1 AND currency = $2 AND rate_date <= $3
     ORDER BY rate_date DESC
     LIMIT 1`,
    [tenantId, currency, date]
  )
  return rows[0] || null
}

/**
 * Lista el historial de tipos de cambio del tenant.
 */
async function listRates({ tenantId, currency = 'USD', from, to, page = 1, limit = 30 }) {
  const offset = (page - 1) * limit
  const params = [tenantId, currency]
  const filters = []

  if (from) { params.push(from); filters.push(`rate_date >= $${params.length}`) }
  if (to)   { params.push(to);   filters.push(`rate_date <= $${params.length}`) }

  const where = filters.length ? `AND ${filters.join(' AND ')}` : ''
  params.push(limit, offset)

  const { rows } = await query(
    `SELECT er.id, er.rate_date, er.currency, er.rate_mxn, er.source,
            er.override_reason, er.created_at,
            u.full_name AS override_by_name
     FROM exchange_rates er
     LEFT JOIN users u ON u.id = er.override_by
     WHERE er.tenant_id = $1 AND er.currency = $2 ${where}
     ORDER BY er.rate_date DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  )

  const { rows: countRows } = await query(
    `SELECT COUNT(*) FROM exchange_rates
     WHERE tenant_id = $1 AND currency = $2 ${where}`,
    params.slice(0, params.length - 2)
  )

  return { data: rows, total: parseInt(countRows[0].count, 10), page, limit }
}

/**
 * Sobrescribe el TC de un día específico.
 * Queda registrado quién lo modificó y por qué.
 */
async function overrideRate({ tenantId, date, currency = 'USD', rate, reason, userId, ipAddress, userAgent }) {
  if (!reason) throw createError(400, 'Se requiere una razón para sobrescribir el tipo de cambio.')
  if (rate <= 0) throw createError(400, 'El tipo de cambio debe ser mayor a cero.')

  const { rows } = await query(
    `INSERT INTO exchange_rates
       (tenant_id, rate_date, currency, rate_mxn, source, override_by, override_reason)
     VALUES ($1, $2, $3, $4, 'manual', $5, $6)
     ON CONFLICT (tenant_id, rate_date, currency)
     DO UPDATE SET
       rate_mxn        = EXCLUDED.rate_mxn,
       source          = 'manual',
       override_by     = EXCLUDED.override_by,
       override_reason = EXCLUDED.override_reason
     RETURNING id, rate_date, rate_mxn, source`,
    [tenantId, date, currency, rate, userId, reason]
  )

  await audit({
    tenantId, userId,
    action:     'exchange_rate.overridden',
    resource:   'exchange_rates',
    resourceId: rows[0].id,
    payload:    { date, currency, rate, reason },
    ipAddress,
    userAgent,
  })

  logger.warn('Exchange rate manually overridden', { tenantId, date, currency, rate, userId })
  return rows[0]
}

function createError(status, message) {
  const err = new Error(message)
  err.status = status
  return err
}

module.exports = { syncDailyRate, getRateForDate, listRates, overrideRate, fetchRateFromBanxico }
