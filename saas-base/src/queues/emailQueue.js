'use strict'

// Cola de envío de correos. Tres puntas:
//   - `enqueueEmail(opts)`     →  para los callers. Mete a la cola si está habilitada,
//                                 o ejecuta sincrónico como fallback.
//   - `emailWorkerInit()`       →  registra el Worker que consume la cola
//                                 (lo invoca app.js vía queue.startWorkers()).
//   - `emailQueue`              →  la instancia Queue, para el panel de admin
//                                 (listar/reintentar fallidos).
//
// Detalle técnico de adjuntos: BullMQ serializa el payload con JSON. Buffers
// se convierten en `{type:'Buffer',data:[…]}` que ocupa ~2x del tamaño real.
// Para PDFs medianos (<2 MB) eso es aceptable. Para uploads grandes habría
// que guardar en R2 y pasar la key — hoy no aplica.

const { createQueue, createWorker, enabled, registerWorkerInit } = require('../utils/queue')
const { sendEmail } = require('../modules/email/emailService')
const logger = require('../config/logger')

const QUEUE_NAME = 'emails'

const emailQueue = createQueue(QUEUE_NAME)

/**
 * Encola un correo para envío en segundo plano. Si la cola no está habilitada
 * (REDIS_URL vacío), envía sincrónico — preserva comportamiento legacy.
 *
 * Mismo shape que emailService.sendEmail. Acepta además:
 *   - dedupeKey: si dos jobs llegan con la misma dedupeKey en ~10 min,
 *                solo se procesa el primero. Útil para evitar reenvíos por
 *                doble-clic en un botón.
 *
 * @returns {Promise<{queued: boolean, jobId?: string, info?: object}>}
 */
async function enqueueEmail(opts, jobOpts = {}) {
  if (!enabled || !emailQueue) {
    // Fallback sincrónico — el caller ve la misma firma que antes.
    const info = await sendEmail(opts)
    return { queued: false, info }
  }

  const job = await emailQueue.add('send', opts, {
    jobId: jobOpts.dedupeKey,
    ...jobOpts,
  })

  logger.info('[queue:emails] job encolado', {
    jobId: job.id,
    to:    opts.to,
    subject: opts.subject,
  })

  return { queued: true, jobId: job.id }
}

// Worker que consume la cola. Cada job ejecuta sendEmail con el payload.
// Si sendEmail tira, BullMQ marca el job como failed y aplica backoff
// exponencial hasta agotar QUEUE_MAX_ATTEMPTS.
function emailWorkerInit() {
  return createWorker(QUEUE_NAME, async (job) => {
    return sendEmail(job.data)
  }, { concurrency: 5 })
}

// Auto-registramos el initializer — app.js solo necesita llamar startWorkers().
registerWorkerInit(emailWorkerInit)

module.exports = { enqueueEmail, emailQueue, QUEUE_NAME }
