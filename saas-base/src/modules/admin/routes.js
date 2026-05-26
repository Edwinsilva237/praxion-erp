'use strict'

// Panel de administración de jobs en cola. Permite:
//   - GET  /api/admin/jobs?queue=emails|invoicing&status=failed|completed|...
//   - POST /api/admin/jobs/:queue/:jobId/retry
//   - DELETE /api/admin/jobs/:queue/:jobId
//
// Sólo accesible para usuarios con permiso 'admin'. Modo dual: si la cola
// no está habilitada, devuelve 503 — no hay nada que listar/reintentar.

const express = require('express')
const { tenantResolver } = require('../../middleware/tenantResolver')
const { authGuard } = require('../../middleware/authGuard')
const { requireActiveTenant } = require('../../middleware/requireActiveTenant')
const { checkPermission } = require('../../middleware/checkPermission')
const { emailQueue } = require('../../queues/emailQueue')
const { invoicingQueue } = require('../../queues/invoicingQueue')

const router = express.Router()

router.use(tenantResolver)
router.use(authGuard)
router.use(requireActiveTenant)

const QUEUES = {
  emails:    emailQueue,
  invoicing: invoicingQueue,
}

function getQueue(name) {
  const q = QUEUES[name]
  if (!q) {
    const err = new Error(`Cola desconocida: ${name}. Válidas: ${Object.keys(QUEUES).join(', ')}`)
    err.status = 400
    throw err
  }
  return q
}

// GET /api/admin/jobs?queue=emails&status=failed&limit=50
router.get('/jobs', checkPermission('settings', 'read'), async (req, res, next) => {
  try {
    const queueName = req.query.queue || 'emails'
    const status    = req.query.status || 'failed'
    const limit     = Math.min(parseInt(req.query.limit || 50, 10), 200)

    const q = getQueue(queueName)
    if (!q) return res.status(503).json({ error: 'Cola no disponible (REDIS_URL no configurado).' })

    // BullMQ acepta: 'completed'|'failed'|'delayed'|'active'|'waiting'|'paused'
    const validStatuses = ['completed', 'failed', 'delayed', 'active', 'waiting', 'paused']
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: `status inválido. Usa: ${validStatuses.join(', ')}` })
    }

    const jobs = await q.getJobs([status], 0, limit - 1, false)
    const out = jobs.map(j => ({
      id:           j.id,
      name:         j.name,
      data:         sanitizeJobData(j.data, queueName),
      attemptsMade: j.attemptsMade,
      failedReason: j.failedReason,
      timestamp:    j.timestamp,
      finishedOn:   j.finishedOn,
      processedOn:  j.processedOn,
    }))

    res.json({ queue: queueName, status, jobs: out })
  } catch (err) { next(err) }
})

// POST /api/admin/jobs/:queue/:jobId/retry
router.post('/jobs/:queue/:jobId/retry', checkPermission('settings', 'update'), async (req, res, next) => {
  try {
    const q = getQueue(req.params.queue)
    if (!q) return res.status(503).json({ error: 'Cola no disponible.' })
    const job = await q.getJob(req.params.jobId)
    if (!job) return res.status(404).json({ error: 'Job no encontrado.' })
    await job.retry()
    res.json({ retried: true, jobId: job.id })
  } catch (err) { next(err) }
})

// DELETE /api/admin/jobs/:queue/:jobId
router.delete('/jobs/:queue/:jobId', checkPermission('settings', 'delete'), async (req, res, next) => {
  try {
    const q = getQueue(req.params.queue)
    if (!q) return res.status(503).json({ error: 'Cola no disponible.' })
    const job = await q.getJob(req.params.jobId)
    if (!job) return res.status(404).json({ error: 'Job no encontrado.' })
    await job.remove()
    res.json({ removed: true, jobId: req.params.jobId })
  } catch (err) { next(err) }
})

/**
 * Filtra datos sensibles del payload del job antes de devolverlos. Los
 * correos pueden tener HTML completo con tokens de reset, los timbrados
 * datos fiscales — limitamos lo que se expone al admin.
 */
function sanitizeJobData(data, queueName) {
  if (!data) return null
  if (queueName === 'emails') {
    return {
      to:           data.to,
      subject:      data.subject,
      hasAttachments: Array.isArray(data.attachments) && data.attachments.length > 0,
    }
  }
  if (queueName === 'invoicing') {
    return {
      tenantId:  data.tenantId,
      invoiceId: data.invoiceId,
      userId:    data.userId,
    }
  }
  return data
}

module.exports = router
