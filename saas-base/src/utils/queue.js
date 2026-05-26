'use strict'

// Infraestructura base para colas de tareas en segundo plano (BullMQ + Redis).
//
// Modo dual:
//   - Si REDIS_URL está vacío → `enabled=false`. Los servicios que usan
//     enqueue* deben caer a ejecución sincrónica (cada queue concreto se
//     encarga de su propio fallback).
//   - Si REDIS_URL está poblado → conexión TLS a Upstash (o Redis local).
//     Se crean Queue + Worker por dominio (emails, invoicing, etc.).
//
// Cada Worker se levanta SOLO en el proceso principal del backend (no en
// scripts CLI ni en tests unitarios). app.js se encarga de invocar
// `startWorkers()` cuando arranca.

const { Queue, Worker } = require('bullmq')
const IORedis = require('ioredis')
const config = require('../config')
const logger = require('../config/logger')

const enabled = !!config.queue.redisUrl

let connection = null

if (enabled) {
  // BullMQ requiere maxRetriesPerRequest=null y enableReadyCheck=false
  // según la documentación oficial — Upstash es compatible con esto.
  connection = new IORedis(config.queue.redisUrl, {
    maxRetriesPerRequest: null,
    enableReadyCheck:     false,
  })

  connection.on('connect',      () => logger.info('[queue] Redis conectado'))
  connection.on('error',     err => logger.error('[queue] Redis error', { error: err.message }))
  connection.on('close',        () => logger.warn('[queue] Redis conexión cerrada'))
} else {
  logger.info('[queue] REDIS_URL no configurado — modo sincrónico (fallback)')
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers para crear queues y workers con la configuración estándar.
// Cada módulo de dominio (queues/emailQueue.js, queues/invoicingQueue.js, ...)
// llama a estos helpers — así centralizamos política de reintentos, retención
// de jobs completados/fallidos, etc.
// ─────────────────────────────────────────────────────────────────────────────

function createQueue(name) {
  if (!enabled) return null

  return new Queue(name, {
    connection,
    defaultJobOptions: {
      attempts: config.queue.maxAttempts,
      backoff: {
        type:  'exponential',
        delay: config.queue.backoffMs,
      },
      removeOnComplete: { age: config.queue.keepCompletedSec },
      removeOnFail:     { age: config.queue.keepFailedSec },
    },
  })
}

function createWorker(name, handler, opts = {}) {
  if (!enabled) return null

  const worker = new Worker(name, handler, {
    connection,
    concurrency: opts.concurrency || 1,
    ...opts,
  })

  worker.on('completed', (job) => {
    logger.info(`[queue:${name}] job completado`, {
      jobId: job.id, name: job.name, attemptsMade: job.attemptsMade,
    })
  })

  worker.on('failed', (job, err) => {
    logger.error(`[queue:${name}] job falló`, {
      jobId: job?.id, name: job?.name,
      attemptsMade: job?.attemptsMade,
      attemptsLeft: (config.queue.maxAttempts - (job?.attemptsMade || 0)),
      error: err.message,
    })
  })

  worker.on('error', (err) => {
    logger.error(`[queue:${name}] worker error`, { error: err.message })
  })

  return worker
}

// Para que el caller pueda registrar todos los workers de una sola vez
// desde app.js al arranque. Cada queues/*.js exporta una función init().
const workerInitializers = []

function registerWorkerInit(initFn) {
  workerInitializers.push(initFn)
}

function startWorkers() {
  if (!enabled) {
    logger.info('[queue] Workers no iniciados (modo sincrónico)')
    return
  }
  for (const init of workerInitializers) {
    try { init() } catch (err) {
      logger.error('[queue] Error inicializando worker', { error: err.message })
    }
  }
  logger.info(`[queue] ${workerInitializers.length} worker(s) iniciados`)
}

async function shutdown() {
  if (!enabled || !connection) return
  try { await connection.quit() } catch (_) {}
}

module.exports = {
  enabled,
  connection,
  createQueue,
  createWorker,
  registerWorkerInit,
  startWorkers,
  shutdown,
}
