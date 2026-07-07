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
const config = require('../config')

const QUEUE_NAME = 'emails'

// Dispara una alerta tenant_alerts (+ push a owner/admin) cuando un correo
// tenant-scoped NO se pudo entregar. Solo si el job/opts trae `tenantId` (los
// correos cross-tenant o de sistema sin tenant no alertan). Best-effort +
// lazy-require para no acoplar el arranque (este módulo se carga muy temprano).
function maybeAlertEmailFailure(data, err) {
  const tenantId = data && data.tenantId
  if (!tenantId) return
  try {
    const { dispatchAlert } = require('../modules/alerts/alertService')
    const to = Array.isArray(data.to) ? data.to.join(', ') : data.to
    dispatchAlert(null, {
      tenantId,
      type: 'email_delivery_failed',
      severity: 'warning',
      title: 'Correo no entregado',
      body: `No se pudo enviar "${data.subject || '(sin asunto)'}" a ${to}.`,
      payload: { to: data.to, subject: data.subject, error: err && err.message },
      audience: { membershipRoles: ['owner', 'admin'] },
    }).catch(() => {})
  } catch { /* best-effort */ }
}

// Traduce un error crudo de nodemailer/SMTP a un Error con `status` != 500 y un
// mensaje accionable para el usuario. Clave: el error handler de app.js
// reemplaza el mensaje por "Internal server error" SOLO cuando el status es 500
// (o ausente). Al marcar 502 el mensaje sobrevive al filtro de producción y el
// frontend puede mostrarlo. Se preserva el error original en la traza para logs.
function friendlyEmailError(err) {
  const raw = (err && err.message) || ''
  const isAuth = /invalid login|535|badcredentials|username and password not accepted/i.test(raw)
  const isConn = /econnrefused|etimedout|enotfound|eai_again|connection|greeting never received|socket|network/i.test(raw)
  const notConfigured = /smtp no configurado|email_from no configurado/i.test(raw)

  let msg
  if (notConfigured) {
    msg = 'No se pudo enviar el correo: el servidor de correo (SMTP) no está configurado.'
  } else if (isAuth) {
    msg = 'No se pudo enviar el correo: el proveedor rechazó las credenciales SMTP. '
        + 'Revisa SMTP_USER/SMTP_PASS — la App Password de Google pudo caducar (se revoca al cambiar la contraseña o la verificación en 2 pasos).'
  } else if (isConn) {
    msg = 'No se pudo enviar el correo: no se pudo conectar al servidor SMTP. Intenta de nuevo en unos minutos.'
  } else {
    msg = `No se pudo enviar el correo: ${raw || 'error desconocido del servidor de correo.'}`
  }

  const e = new Error(msg)
  e.status = 502
  e.code   = 'EMAIL_SEND_FAILED'
  e.cause  = err
  if (err && err.stack) e.stack = `${e.message}\nCaused by: ${err.stack}`
  return e
}

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
    try {
      const info = await sendEmail(opts)
      return { queued: false, info }
    } catch (err) {
      // Aun en modo síncrono, avisamos del fallo (si el correo es tenant-scoped)
      // y re-lanzamos para preservar el contrato (el caller best-effort decide).
      // Se traduce a un error 502 con mensaje accionable: los callers directos
      // (enviar complemento/recibo por correo) lo propagan al usuario en vez de
      // un "Internal server error" genérico; los best-effort igual lo atrapan.
      maybeAlertEmailFailure(opts, err)
      throw friendlyEmailError(err)
    }
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
  const worker = createWorker(QUEUE_NAME, async (job) => {
    return sendEmail(job.data)
  }, { concurrency: 5 })

  // Fallo DEFINITIVO (agotó reintentos) → alerta tenant_alerts + push a admins.
  // BullMQ emite 'failed' en cada intento; solo alertamos cuando ya no quedan.
  if (worker) {
    worker.on('failed', (job, err) => {
      if ((job?.attemptsMade || 0) < config.queue.maxAttempts) return
      maybeAlertEmailFailure(job?.data, err)
    })
  }
  return worker
}

// Auto-registramos el initializer — app.js solo necesita llamar startWorkers().
registerWorkerInit(emailWorkerInit)

module.exports = { enqueueEmail, emailQueue, QUEUE_NAME }
