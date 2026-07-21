'use strict'

// Definición central de las tareas programadas del sistema. Se requiere
// desde app.js ANTES de startBoss() para que los crons se registren.
//
// Cron expressions estilo Unix (5 campos):
//   ┌──── minuto (0-59)
//   │  ┌── hora (0-23)
//   │  │  ┌── día del mes (1-31)
//   │  │  │  ┌── mes (1-12)
//   │  │  │  │  ┌── día de la semana (0-6, dom-sab)
//   │  │  │  │  │
//   *  *  *  *  *
//
// Las horas de pg-boss son UTC. Para 13:00 hora MX (UTC-6) usar hora 19 UTC.

const { registerCron, registerCatchup } = require('./utils/pgboss')
const { withBypass } = require('./db')
const logger = require('./config/logger')

// ── 0) Cola ad-hoc: fan-out de Comunicados en segundo plano ──────────────────
// No es un cron: registra el worker `communications.dispatch` para que
// startBoss() lo levante. El endpoint POST /communications/send encola el job;
// el worker hace el envío individual, actualiza progreso y es reanudable.
require('./modules/communications/communicationsService').registerDispatchWorker()

// ── 1) Auto-activación de turnos programados ────────────────────────────────
// Antes: setInterval cada 60s en app.js. Pg-boss tiene resolución mínima de
// 1 minuto, lo cual es equivalente — y sobra de sobra para activar turnos
// cuando llega su hora programada.
const { autoActivatePendingShifts } = require('./modules/production/scheduledShiftService')

registerCron('production.activate-pending-shifts', '* * * * *', () => withBypass(async () => {
  const n = await autoActivatePendingShifts()
  if (n > 0) logger.info(`Auto-activados ${n} turno(s) programado(s).`)
}))

// ── 2) Auto-expiración de cotizaciones ──────────────────────────────────────
// Antes: setInterval cada hora + setTimeout 6s catch-up al arrancar.
// Pg-boss: cron cada hora + un catchup one-shot 6s después de iniciar.
const { expireStaleQuotations } = require('./modules/quotations/quotationService')

registerCron('quotations.expire-stale', '0 * * * *', () => withBypass(async () => {
  const { expired } = await expireStaleQuotations()
  if (expired > 0) logger.info(`Cotizaciones expiradas automáticamente: ${expired}`)
}))

registerCatchup('quotations.expire-on-boot', 6_000, () => withBypass(async () => {
  const { expired } = await expireStaleQuotations()
  if (expired > 0) logger.info(`Catch-up: ${expired} cotización(es) expiradas al arrancar.`)
}))

// ── 3) Sincronización de tipo de cambio Banxico ─────────────────────────────
// Banxico publica el FIX ~12:00 hora MX. Para asegurar disponibilidad y
// permitir reintentos si la primera llamada falló, corremos cada hora L-V
// entre las 13:00 y 22:00 hora MX (19-04 UTC del día siguiente).
//
// La función ensureRateUpToDate hace el "si ya está al día, skip" — no nos
// preocupa ejecutarla 10 veces al día porque solo la primera trae datos.
//
// Catch-up al arrancar — útil cuando el server estuvo apagado un día hábil.
const { ensureRateUpToDate } = require('./scheduler')

registerCron('banxico.ensure-rate', '0 19-23,0-4 * * 1-5', () => withBypass(async () => {
  await ensureRateUpToDate('hourly-cron')
}))

registerCatchup('banxico.startup-sync', 5_000, () => withBypass(async () => {
  await ensureRateUpToDate('startup')
}))

// ── X) Auto-expiración de lotes (§5h) ───────────────────────────────────────
// Opt-in via env var ENABLE_LOT_EXPIRY_CRON=true. Recorre todos los tenants
// con uses_lots=true y marca raw_material_lots/product_lots vencidos como
// 'expired', generando alertas tenant_alerts (dedupe automático).
//
// Frecuencia: cada hora a los :15 (offset del system-messages cron para no
// solaparse). Si está apagado, ops puede triggerear manualmente via
// POST /api/lots/run-expiration-check.
if (process.env.ENABLE_LOT_EXPIRY_CRON === 'true') {
  const { markExpiredLots } = require('./modules/production/expirationService')
  registerCron('lots.mark-expired', '15 * * * *', () => withBypass(async () => {
    const { query } = require('./db')
    const { rows: tenants } = await query(
      `SELECT tenant_id FROM tenant_process_config WHERE uses_lots = true`
    )
    let totalRm = 0, totalPt = 0
    for (const t of tenants) {
      try {
        const r = await markExpiredLots({ tenantId: t.tenant_id })
        totalRm += r.rmLotsExpired
        totalPt += r.ptLotsExpired
      } catch (err) {
        logger.error(`[lots.mark-expired] tenant ${t.tenant_id}: ${err.message}`)
      }
    }
    if (totalRm + totalPt > 0) {
      logger.info(`[lots.mark-expired] expiraron ${totalRm} MP + ${totalPt} PT en ${tenants.length} tenants.`)
    }
  }))
  logger.info('[crons] Lot expiry cron habilitado (ENABLE_LOT_EXPIRY_CRON=true).')
}

// ── 4b) Stock bajo / punto de reorden ───────────────────────────────────────
// Una vez al día (14:00 UTC ≈ 8:00 MX): por cada tenant que tenga niveles de
// reorden/mínimo configurados, busca ítems activos por debajo y dispara alertas
// tenant_alerts (con push a inventory:read). dispatchAlert dedupea, así un ítem
// ya alertado no vuelve a sonar hasta que se resuelva → un aviso por ítem, no spam.
const { checkLowStock } = require('./modules/inventory/inventoryLevelsService')

registerCron('inventory.low-stock-scan', '0 14 * * *', () => withBypass(async () => {
  const { query } = require('./db')
  const { rows: tenants } = await query(
    `SELECT DISTINCT tenant_id FROM inventory_levels
      WHERE COALESCE(reorder_point, 0) > 0 OR COALESCE(min_stock, 0) > 0`
  )
  let total = 0
  for (const t of tenants) {
    try {
      total += await checkLowStock(t.tenant_id)
    } catch (err) {
      logger.error(`[inventory.low-stock-scan] tenant ${t.tenant_id}: ${err.message}`)
    }
  }
  if (total > 0) logger.info(`[inventory.low-stock-scan] ${total} alerta(s) nueva(s) de stock bajo en ${tenants.length} tenants.`)
}))

// ── 4c) Recordatorios de pago de tarjetas de crédito ────────────────────────
// Una vez al día (15:00 UTC ≈ 9:00 MX): por cada tenant con tarjetas activas,
// dispara una alerta por cada tarjeta cuyo día de pago caiga dentro de su
// ventana de anticipación (reminder_lead_days). dispatchAlert dedupea por
// (tarjeta, ciclo) → un aviso por tarjeta por mes; push al responsable.
const { scanDuePayments } = require('./modules/credit-cards/service')

registerCron('credit-cards.payment-due-scan', '0 15 * * *', () => withBypass(async () => {
  const { query } = require('./db')
  const { rows: tenants } = await query(
    `SELECT DISTINCT tenant_id FROM credit_cards WHERE active = TRUE`
  )
  let total = 0
  for (const t of tenants) {
    try {
      total += await scanDuePayments({ tenantId: t.tenant_id })
    } catch (err) {
      logger.error(`[credit-cards.payment-due-scan] tenant ${t.tenant_id}: ${err.message}`)
    }
  }
  if (total > 0) logger.info(`[credit-cards.payment-due-scan] ${total} recordatorio(s) de pago en ${tenants.length} tenants.`)
}))

// ── 4) Notificaciones de mensajes del sistema ────────────────────────────────
// Cada hora revisamos:
//   a) Mensajes con notify_email=TRUE que ya empezaron y no se han notificado
//      → mandar email inicial a todos los tenants.
//   b) Mantenimientos en 23-26 h sin recordatorio → mandar recordatorio T-1d
//      a tenants + recordatorio al platform admin para que lo ejecute.
const { sendPendingNotifications, sendPendingReminders } = require('./modules/systemMessages/notificationJobs')

registerCron('system-messages.dispatch', '0 * * * *', () => withBypass(async () => {
  await sendPendingNotifications()
  await sendPendingReminders()
}))

registerCatchup('system-messages.catchup-on-boot', 8_000, () => withBypass(async () => {
  // Al arrancar: por si quedó un envío pendiente cuando el server estuvo abajo.
  await sendPendingNotifications()
  await sendPendingReminders()
}))
