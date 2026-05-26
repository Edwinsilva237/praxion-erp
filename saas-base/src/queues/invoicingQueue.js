'use strict'

// Cola para timbrado de CFDI con Facturapi. Diseño:
//
//   POST /invoices/:id/stamp → encola job y responde { jobId } al instante.
//   GET  /invoices/:id/stamp-status?jobId=X → estado del job.
//
// Idempotencia:
//   - JobId = `stamp-${invoiceId}` → BullMQ rechaza duplicados mientras el
//     job esté activo o en cola. Evita doble timbrado si el usuario aprieta
//     dos veces o hay race condition cliente-servidor.
//   - El propio stampInvoice() ya valida `WHERE status='draft'`. Si una
//     llamada exitosa ya cambió status → la siguiente tira 404 limpio
//     (job se marca completado/failed según corresponda).
//   - Caso edge: si Facturapi responde 200 pero nuestro proceso muere
//     antes de UPDATE invoices: la factura queda en SAT pero local sigue
//     'draft'. El reintento timbrará un SEGUNDO CFDI. Para cubrir esto en
//     futuro: pasar `external_id: invoiceId` al payload de Facturapi (campo
//     único por organization). Pendiente para próxima iteración — el riesgo
//     es bajo porque Facturapi responde rápido y el update es la siguiente
//     línea.

const { createQueue, createWorker, enabled, registerWorkerInit } = require('../utils/queue')
const stampService = require('../modules/invoicing/stampService')
const logger = require('../config/logger')

const QUEUE_NAME = 'invoicing'

const invoicingQueue = createQueue(QUEUE_NAME)

/**
 * Encola un job de timbrado. Si la cola no está habilitada, ejecuta el
 * timbrado sincrónico — devolviendo el resultado completo como antes.
 *
 * @returns {Promise<{queued: boolean, jobId?: string, result?: object}>}
 */
async function enqueueInvoiceStamp({ tenantId, invoiceId, userId, ipAddress, userAgent }) {
  if (!enabled || !invoicingQueue) {
    const result = await stampService.stampInvoice({
      tenantId, invoiceId, userId, ipAddress, userAgent,
    })
    return { queued: false, result }
  }

  const jobId = `stamp-${invoiceId}`
  const job = await invoicingQueue.add('stamp',
    { tenantId, invoiceId, userId, ipAddress, userAgent },
    { jobId }
  )

  logger.info('[queue:invoicing] timbrado encolado', { jobId, invoiceId, tenantId })
  return { queued: true, jobId: job.id }
}

/**
 * Devuelve el estado de un job de timbrado. Usado por el endpoint de polling.
 */
async function getStampJobStatus(jobId) {
  if (!enabled || !invoicingQueue) return null
  const job = await invoicingQueue.getJob(jobId)
  if (!job) return { status: 'not_found' }

  const state = await job.getState() // 'waiting'|'active'|'completed'|'failed'|'delayed'|...
  return {
    status: state,
    progress: job.progress,
    attemptsMade: job.attemptsMade,
    result: state === 'completed' ? job.returnvalue : undefined,
    error:  state === 'failed' ? job.failedReason : undefined,
  }
}

function invoicingWorkerInit() {
  return createWorker(QUEUE_NAME, async (job) => {
    return stampService.stampInvoice(job.data)
  }, { concurrency: 2 }) // Facturapi recomienda 2-5 concurrent calls max
}

registerWorkerInit(invoicingWorkerInit)

module.exports = { enqueueInvoiceStamp, getStampJobStatus, invoicingQueue, QUEUE_NAME }
