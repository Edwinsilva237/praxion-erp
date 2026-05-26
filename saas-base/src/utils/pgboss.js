'use strict'

// Scheduler persistente (pg-boss). Reemplaza los setInterval/setTimeout que
// vivían en app.js y scheduler.js para tareas programadas internas.
//
// Por qué pg-boss en vez de BullMQ:
//   - Usa la misma Postgres que ya tenemos. Cero infra adicional.
//   - Crea su propio schema `pgboss` con tablas internas. Auto-administrado.
//   - Maneja locking con SELECT FOR UPDATE → si hay múltiples instancias del
//     backend, solo UNA ejecuta cada disparo (no se duplican efectos).
//   - Cron strings nativos para tareas recurrentes.
//
// API expuesta:
//   - registerCron(name, cronExpr, handler)  — registra una tarea recurrente.
//   - registerCatchup(name, delayMs, handler) — registra una tarea one-shot
//     que se ejecuta al arrancar (típico catch-up post-restart).
//   - startBoss()  — invocado por app.js al arrancar. Conecta a PG, crea
//     schema si no existe, activa workers para todos los crons registrados.
//   - shutdown()   — graceful shutdown.

const { PgBoss } = require('pg-boss')
const config = require('../config')
const logger = require('../config/logger')

let boss = null
let started = false

// Acumuladores: cada módulo que tiene tareas las registra al require-time.
// startBoss() las procesa al final.
const cronJobs = []   // { name, cronExpr, handler, options }
const catchups = []   // { name, delayMs, handler }

function registerCron(name, cronExpr, handler, options = {}) {
  cronJobs.push({ name, cronExpr, handler, options })
}

function registerCatchup(name, delayMs, handler) {
  catchups.push({ name, delayMs, handler })
}

async function startBoss() {
  if (started) return boss
  started = true

  // pg-boss acepta el mismo shape de conexión que pg.Pool.
  // Mantenemos pools separados a propósito — pg-boss usa su propio pool
  // optimizado para sus patrones de lock.
  boss = new PgBoss({
    host:     config.db.host,
    port:     config.db.port,
    database: config.db.name,
    user:     config.db.user,
    password: config.db.password,
    schema:   'pgboss',
    // Si el monitoreo de pg-boss falla, sólo loguear — no propagar.
    onComplete: false,
  })

  boss.on('error', err => logger.error('[pgboss] error', { error: err.message }))

  try {
    await boss.start()
  } catch (err) {
    logger.error('[pgboss] no se pudo iniciar — tareas programadas DESACTIVADAS', { error: err.message })
    started = false
    return null
  }

  logger.info(`[pgboss] iniciado — registrando ${cronJobs.length} cron(s) y ${catchups.length} catchup(s)`)

  // Registrar los workers que procesan cada cron job. pg-boss v10 requiere
  // que cada "queue" exista antes de poder asignarle worker o schedule.
  for (const job of cronJobs) {
    try {
      await boss.createQueue(job.name)
      await boss.work(job.name, async (jobData) => {
        const startedAt = Date.now()
        try {
          await job.handler(jobData)
          logger.debug(`[pgboss:${job.name}] OK (${Date.now() - startedAt}ms)`)
        } catch (err) {
          logger.error(`[pgboss:${job.name}] falló`, { error: err.message })
          throw err
        }
      })
      // Schedule del cron. Si ya estaba programado igual, pg-boss lo reemplaza.
      await boss.schedule(job.name, job.cronExpr, undefined, job.options)
      logger.info(`[pgboss] cron '${job.name}' → ${job.cronExpr}`)
    } catch (err) {
      logger.error(`[pgboss] no se pudo registrar cron ${job.name}`, { error: err.message })
    }
  }

  // Catch-ups: tareas one-shot que se disparan poco después del arranque.
  // Útil para recuperarse de tiempo offline (p.ej. revisar cotizaciones vencidas).
  for (const cu of catchups) {
    setTimeout(async () => {
      try {
        await cu.handler()
        logger.info(`[pgboss:catchup:${cu.name}] OK`)
      } catch (err) {
        logger.error(`[pgboss:catchup:${cu.name}] falló`, { error: err.message })
      }
    }, cu.delayMs)
  }

  return boss
}

async function shutdown() {
  if (!boss) return
  try { await boss.stop({ graceful: true }) }
  catch (err) { logger.warn('[pgboss] error al detener', { error: err.message }) }
}

module.exports = {
  registerCron,
  registerCatchup,
  startBoss,
  shutdown,
}
