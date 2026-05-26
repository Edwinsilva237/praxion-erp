'use strict'

const { query } = require('./db')
const { syncDailyRate } = require('./modules/exchange-rates/exchangeRateService')
const logger = require('./config/logger')

/**
 * Devuelve la fecha más reciente con TC USD guardado (cualquier tenant).
 * Útil para decidir si conviene volver a llamar a Banxico.
 */
async function getLastRateDate() {
  const { rows } = await query(
    `SELECT MAX(rate_date) AS last FROM exchange_rates WHERE currency = 'USD'`
  )
  return rows[0]?.last || null
}

/**
 * Sincroniza si el TC más reciente quedó atrás de hoy. Banxico publica solo
 * en días hábiles, así que en fines de semana / feriados la fecha "más
 * reciente" será la del último día hábil — eso ya es correcto y no
 * dispara una nueva sync.
 */
async function ensureRateUpToDate(reason) {
  const today = new Date().toISOString().split('T')[0]
  const last = await getLastRateDate()
  const lastStr = last instanceof Date ? last.toISOString().split('T')[0] : String(last || '').slice(0, 10)

  if (lastStr === today) {
    logger.debug(`Exchange rate already up to date (${today}) — skipping sync (${reason})`)
    return { skipped: true, reason: 'already-today' }
  }

  logger.info(`Exchange rate stale (last=${lastStr || 'none'}, today=${today}) — syncing (${reason})`)
  try {
    const result = await syncDailyRate()
    if (result.success) {
      logger.info(`Sync ok via ${reason}: ${result.rate} MXN/USD for ${result.rateDate}`)
    } else {
      logger.warn(`Sync failed via ${reason}: ${result.error}`)
    }
    return result
  } catch (err) {
    logger.error(`Sync exception via ${reason}`, { error: err.message })
    return { success: false, error: err.message }
  }
}

// Banxico publica el FIX ~12:00 hora MX. La programación de cuándo correr
// ensureRateUpToDate vive ahora en `src/crons.js` (pg-boss). Este módulo
// solo exporta la lógica para ser invocada desde ahí.

module.exports = { ensureRateUpToDate }
