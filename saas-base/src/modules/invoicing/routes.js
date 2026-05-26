'use strict'

const express             = require('express')
const { tenantResolver }  = require('../../middleware/tenantResolver')
const { authGuard }       = require('../../middleware/authGuard')
const { requireActiveTenant } = require('../../middleware/requireActiveTenant')
const { checkPermission } = require('../../middleware/checkPermission')
const requireModule       = require('../../middleware/requireModule')
const invoiceService      = require('./invoiceService')
const xmlService          = require('./xmlService')
const pdfService          = require('./pdfService')
const stampService               = require('./stampService')
const { enqueueInvoiceStamp, getStampJobStatus } = require('../../queues/invoicingQueue')
const paymentComplementService   = require('./paymentComplementService')
const creditNoteService          = require('./creditNoteService')

const router = express.Router()

router.use(tenantResolver)
router.use(authGuard)
router.use(requireActiveTenant)
router.use(requireModule('invoicing'))

/**
 * GET /api/invoicing/invoices
 * Lista facturas emitidas con filtros.
 * Query: status, partnerId, from, to, page, limit
 */
router.get('/invoices', checkPermission('invoicing', 'read'), async (req, res, next) => {
  try {
    const { status, partnerId, from, to, page, limit } = req.query
    const result = await invoiceService.listInvoices({
      tenantId: req.tenant.id,
      status, partnerId, from, to,
      page:  parseInt(page || 1, 10),
      limit: Math.min(parseInt(limit || 50, 10), 100),
    })
    res.json(result)
  } catch (err) { next(err) }
})

/**
 * GET /api/invoicing/invoices/:id
 */
router.get('/invoices/:id', checkPermission('invoicing', 'read'), async (req, res, next) => {
  try {
    const invoice = await invoiceService.getInvoice({
      tenantId: req.tenant.id, invoiceId: req.params.id,
    })
    if (!invoice) return res.status(404).json({ error: 'Factura no encontrada.' })
    res.json(invoice)
  } catch (err) { next(err) }
})

/**
 * POST /api/invoicing/invoices/from-remission
 * Crea una factura desde una remisión entregada.
 * Body: {
 *   deliveryNoteId,
 *   series?,
 *   paymentMethod?,  -- PUE | PPD
 *   paymentForm?,    -- 03=transferencia, 01=efectivo, 02=cheque
 *   notes?
 * }
 */
router.post('/invoices/from-remission', checkPermission('invoicing', 'create'), async (req, res, next) => {
  try {
    const { deliveryNoteId } = req.body
    if (!deliveryNoteId) return res.status(400).json({ error: 'deliveryNoteId es requerido.' })

    const invoice = await invoiceService.createFromRemission({
      tenantId: req.tenant.id, ...req.body,
      userId: req.auth.userId, ipAddress: req.ip, userAgent: req.get('user-agent'),
    })
    res.status(201).json({
      ...invoice,
      message: invoice.autoSendInvoice
        ? 'Factura generada. Se enviará automáticamente al timbrar.'
        : 'Factura generada en borrador. Recuerda enviarla al cliente al timbrar.',
    })
  } catch (err) { next(err) }
})

/**
 * POST /api/invoicing/invoices/from-remissions
 * Crea una factura consolidando varias remisiones del mismo cliente.
 * Body: { deliveryNoteIds: [uuid, uuid, ...], series?, paymentMethod?, paymentForm?, useCfdi?, notes? }
 */
router.post('/invoices/from-remissions', checkPermission('invoicing', 'create'), async (req, res, next) => {
  try {
    const { deliveryNoteIds } = req.body
    if (!Array.isArray(deliveryNoteIds) || deliveryNoteIds.length === 0) {
      return res.status(400).json({ error: 'deliveryNoteIds debe ser un arreglo con al menos una remisión.' })
    }

    const invoice = await invoiceService.createFromRemissions({
      tenantId: req.tenant.id, ...req.body,
      userId: req.auth.userId, ipAddress: req.ip, userAgent: req.get('user-agent'),
    })
    res.status(201).json({
      ...invoice,
      message: invoice.consolidatedFrom
        ? `Factura consolidada de ${invoice.consolidatedFrom} remisión(es).`
        : 'Factura generada.',
    })
  } catch (err) { next(err) }
})

/**
 * POST /api/invoicing/invoices/direct
 * Crea una factura directa desde un pedido (sin remisión).
 * Solo para pedidos con direct_invoice = true.
 * Body: {
 *   salesOrderId,
 *   series?,
 *   paymentMethod?,
 *   paymentForm?,
 *   notes?
 * }
 */
router.post('/invoices/direct', checkPermission('invoicing', 'create'), async (req, res, next) => {
  try {
    const { salesOrderId } = req.body
    if (!salesOrderId) return res.status(400).json({ error: 'salesOrderId es requerido.' })

    const invoice = await invoiceService.createDirect({
      tenantId: req.tenant.id, ...req.body,
      userId: req.auth.userId, ipAddress: req.ip, userAgent: req.get('user-agent'),
    })
    res.status(201).json({
      ...invoice,
      message: 'Factura directa generada. CXC creado automáticamente.',
    })
  } catch (err) { next(err) }
})

/**
 * PATCH /api/invoicing/invoices/:id
 * Edita metadatos del CFDI de un borrador.
 * Body: { paymentMethod?, paymentForm?, useCfdi?, exportacion?, poNumber?,
 *         notes?, issueDate?, receptorLegalName?, receptorTaxRegime?,
 *         receptorZipCode?, series? }
 */
router.patch('/invoices/:id', checkPermission('invoicing', 'update'), async (req, res, next) => {
  try {
    const invoice = await invoiceService.updateInvoice({
      tenantId: req.tenant.id, invoiceId: req.params.id,
      fields:   req.body || {},
      userId:   req.auth.userId, ipAddress: req.ip, userAgent: req.get('user-agent'),
    })
    res.json({ ...invoice, message: 'Factura actualizada.' })
  } catch (err) { next(err) }
})

/**
 * POST /api/invoicing/invoices/:id/cancel
 * Cancela una factura en borrador.
 * Body: { reason? }
 */
router.post('/invoices/:id/cancel', checkPermission('invoicing', 'update'), async (req, res, next) => {
  try {
    const invoice = await invoiceService.cancelInvoice({
      tenantId: req.tenant.id, invoiceId: req.params.id,
      reason: req.body.reason,
      userId: req.auth.userId, ipAddress: req.ip, userAgent: req.get('user-agent'),
    })
    res.json({ ...invoice, message: 'Factura cancelada.' })
  } catch (err) { next(err) }
})

/**
 * POST /api/invoicing/invoices/:id/stamp
 * Timbra una factura en borrador. Si REDIS_URL está configurado, encola y
 * responde { queued: true, jobId } — el frontend debe hacer polling al
 * endpoint /stamp-status?jobId=X. Si no, ejecuta sincrónico y devuelve el
 * resultado completo como antes.
 */
router.post('/invoices/:id/stamp', checkPermission('invoicing', 'create'), async (req, res, next) => {
  try {
    const out = await enqueueInvoiceStamp({
      tenantId: req.tenant.id, invoiceId: req.params.id,
      userId: req.auth.userId, ipAddress: req.ip, userAgent: req.get('user-agent'),
    })

    if (out.queued) {
      return res.status(202).json({
        queued:  true,
        jobId:   out.jobId,
        message: 'Timbrado en curso. Consulta el estado con /stamp-status.',
      })
    }

    // Modo sincrónico (sin Redis) — comportamiento legacy.
    const result = out.result
    let message = 'Factura timbrada exitosamente.'
    if (result.autoSent?.sent) {
      message += ` Enviada por correo a: ${result.autoSent.emails.join(', ')}.`
    } else if (result.autoSent?.reason === 'sin_contactos_con_email') {
      message += ' (auto-send omitido: el cliente no tiene contactos con correo).'
    } else if (result.autoSent?.error) {
      message += ` (auto-send falló: ${result.autoSent.error}).`
    }
    res.json({ ...result, message })
  } catch (err) { next(err) }
})

/**
 * GET /api/invoicing/invoices/:id/stamp-status?jobId=...
 * Devuelve el estado de un job de timbrado en curso. El frontend hace
 * polling cada ~1s mientras `status` esté en {waiting, active, delayed}.
 */
router.get('/invoices/:id/stamp-status', checkPermission('invoicing', 'read'), async (req, res, next) => {
  try {
    const { jobId } = req.query
    if (!jobId) return res.status(400).json({ error: 'jobId requerido.' })
    const status = await getStampJobStatus(jobId)
    if (!status) return res.status(503).json({ error: 'Cola no disponible.' })
    res.json(status)
  } catch (err) { next(err) }
})

/**
 * POST /api/invoicing/invoices/:id/reconcile
 * Recupera una factura que quedó en limbo: si el timbrado se envió a Facturapi
 * pero nuestra BD no se actualizó (proceso murió, timeout, etc.), busca por
 * external_id y completa la operación. Idempotente.
 */
router.post('/invoices/:id/reconcile', checkPermission('invoicing', 'update'), async (req, res, next) => {
  try {
    const result = await stampService.reconcileInvoice({
      tenantId:  req.tenant.id, invoiceId: req.params.id,
      userId:    req.auth.userId, ipAddress: req.ip, userAgent: req.get('user-agent'),
    })
    res.json(result)
  } catch (err) { next(err) }
})

/**
 * GET /api/invoicing/invoices/:id/xml-stamped
 * Descarga el XML timbrado oficial desde Facturapi.
 */
router.get('/invoices/:id/xml-stamped', checkPermission('invoicing', 'read'), async (req, res, next) => {
  try {
    const { rows } = await require('../../db').query(
      `SELECT document_number FROM invoices WHERE id = $1 AND tenant_id = $2`,
      [req.params.id, req.tenant.id]
    )
    if (!rows.length) return res.status(404).json({ error: 'Factura no encontrada.' })
    const stream = await stampService.downloadXML({ invoiceId: req.params.id, tenantId: req.tenant.id })
    res.setHeader('Content-Type', 'application/xml')
    res.setHeader('Content-Disposition', `attachment; filename="${rows[0].document_number}.xml"`)
    stream.pipe(res)
  } catch (err) { next(err) }
})

/**
 * GET /api/invoicing/invoices/:id/pdf-stamped
 * Descarga el PDF oficial desde Facturapi.
 */
router.get('/invoices/:id/pdf-stamped', checkPermission('invoicing', 'read'), async (req, res, next) => {
  try {
    const { rows } = await require('../../db').query(
      `SELECT document_number FROM invoices WHERE id = $1 AND tenant_id = $2`,
      [req.params.id, req.tenant.id]
    )
    if (!rows.length) return res.status(404).json({ error: 'Factura no encontrada.' })
    const stream = await stampService.downloadPDF({ invoiceId: req.params.id, tenantId: req.tenant.id })
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `attachment; filename="${rows[0].document_number}.pdf"`)
    stream.pipe(res)
  } catch (err) { next(err) }
})

/**
 * POST /api/invoicing/invoices/:id/send-email
 * Envía XML + PDF por correo al cliente.
 * Body: { emails: ['correo@cliente.com'] }
 */
router.post('/invoices/:id/send-email', checkPermission('invoicing', 'create'), async (req, res, next) => {
  try {
    const { emails } = req.body
    if (!emails || !emails.length) return res.status(400).json({ error: 'emails es requerido.' })
    const result = await stampService.sendByEmail({
      invoiceId: req.params.id, tenantId: req.tenant.id, emails,
      userId:    req.auth.userId,
    })
    res.json({ ...result, message: `Correo enviado a: ${result.emails.join(', ')}` })
  } catch (err) { next(err) }
})

/**
 * POST /api/invoicing/invoices/:id/cancel-sat
 * Cancela una factura timbrada ante el SAT.
 * Body: { motive: '01'|'02'|'03'|'04', substitution?: 'uuid-nueva-factura' }
 * Motivos: 01=Comprobante con errores con relación, 02=Comprobante con errores sin relación
 *          03=No se llevó a cabo la operación, 04=Operación nominativa relacionada en factura global
 */
router.post('/invoices/:id/cancel-sat', checkPermission('invoicing', 'update'), async (req, res, next) => {
  try {
    const { motive, substitution } = req.body
    if (!motive) return res.status(400).json({ error: 'motive es requerido (01, 02, 03 o 04).' })
    const result = await stampService.cancelStampedInvoice({
      tenantId: req.tenant.id, invoiceId: req.params.id,
      motive, substitution,
      userId: req.auth.userId, ipAddress: req.ip, userAgent: req.get('user-agent'),
    })
    res.json(result)
  } catch (err) { next(err) }
})

/**
 * POST /api/invoicing/invoices/:id/sync-sat
 * Consulta el estado actual de la factura en Facturapi/SAT y aplica cambios
 * locales si hay desincronización (típicamente: cancelación hecha fuera del
 * sistema). Devuelve un resumen { changes: [...], upToDate }.
 */
router.post('/invoices/:id/sync-sat', checkPermission('invoicing', 'update'), async (req, res, next) => {
  try {
    const result = await stampService.syncInvoiceWithSAT({
      tenantId: req.tenant.id, invoiceId: req.params.id,
      userId: req.auth.userId, ipAddress: req.ip, userAgent: req.get('user-agent'),
    })
    res.json(result)
  } catch (err) { next(err) }
})

/**
 * GET /api/invoicing/invoices/:id/cancellation-receipt/pdf
 * GET /api/invoicing/invoices/:id/cancellation-receipt/xml
 * Descarga el acuse de cancelación SAT (prueba legal de la cancelación).
 * Solo disponible para facturas con status 'cancelled'.
 */
router.get('/invoices/:id/cancellation-receipt/:format(pdf|xml)',
  checkPermission('invoicing', 'read'),
  async (req, res, next) => {
    try {
      const { format } = req.params
      const stream = await stampService.downloadCancellationReceipt({
        tenantId: req.tenant.id, invoiceId: req.params.id, format,
      })
      const mime = format === 'pdf' ? 'application/pdf' : 'application/xml'
      res.setHeader('Content-Type', mime)
      res.setHeader('Content-Disposition',
        `attachment; filename="acuse-cancelacion-${req.params.id}.${format}"`)
      stream.pipe(res)
    } catch (err) { next(err) }
  }
)

/**
 * GET /api/invoicing/invoices/:id/xml
 * Genera y descarga el XML CFDI 4.0 sin timbre.
 */
router.get('/invoices/:id/xml', checkPermission('invoicing', 'read'), async (req, res, next) => {
  try {
    const { xml, filename } = await xmlService.generateXML({
      tenantId: req.tenant.id, invoiceId: req.params.id,
    })
    res.setHeader('Content-Type', 'application/xml')
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
    res.send(xml)
  } catch (err) { next(err) }
})

/**
 * GET /api/invoicing/invoices/:id/pdf
 * Genera y descarga la representación impresa (PDF) de la factura.
 */
router.get('/invoices/:id/pdf', checkPermission('invoicing', 'read'), async (req, res, next) => {
  try {
    const invoice = await require('./invoiceService').getInvoice({
      tenantId: req.tenant.id, invoiceId: req.params.id,
    })
    if (!invoice) return res.status(404).json({ error: 'Factura no encontrada.' })

    const pdfBuffer = await pdfService.generatePDF({
      tenantId: req.tenant.id, invoiceId: req.params.id,
    })
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `attachment; filename="${invoice.document_number}.pdf"`)
    res.send(pdfBuffer)
  } catch (err) { next(err) }
})

// ─── Complemento de pago ─────────────────────────────────────────────────────

/**
 * POST /api/invoicing/invoices/:id/payment-complement
 * Genera un complemento de pago (CFDI tipo P) para una factura PPD timbrada.
 * Body: {
 *   paymentDate?,   -- YYYY-MM-DD
 *   paymentForm,    -- 03=transferencia, 01=efectivo, 02=cheque, 28=tarjeta débito
 *   amount,         -- Monto pagado
 *   currency?,      -- MXN | USD
 *   reference?,     -- Referencia de transferencia
 *   exchangeRate?   -- TC si es USD
 * }
 */
router.post('/invoices/:id/payment-complement', checkPermission('invoicing', 'create'), async (req, res, next) => {
  try {
    const { amount, paymentForm } = req.body
    if (!amount)      return res.status(400).json({ error: 'amount es requerido.' })
    if (!paymentForm) return res.status(400).json({ error: 'paymentForm es requerido.' })

    const result = await paymentComplementService.createPaymentComplement({
      tenantId: req.tenant.id, invoiceId: req.params.id,
      ...req.body,
      userId: req.auth.userId, ipAddress: req.ip, userAgent: req.get('user-agent'),
    })
    res.status(201).json(result)
  } catch (err) { next(err) }
})

/**
 * GET /api/invoicing/invoices/:id/payment-complement/:complementId/xml
 * Descarga el XML del complemento de pago.
 */
router.get('/invoices/:id/payment-complement/:complementId/xml', checkPermission('invoicing', 'read'), async (req, res, next) => {
  try {
    const stream = await paymentComplementService.downloadXML({
      tenantId: req.tenant.id,
      complementFacurApiId: req.params.complementId,
    })
    res.setHeader('Content-Type', 'application/xml')
    res.setHeader('Content-Disposition', `attachment; filename="complemento-${req.params.complementId}.xml"`)
    stream.pipe(res)
  } catch (err) { next(err) }
})

/**
 * GET /api/invoicing/invoices/:id/payment-complement/:complementId/pdf
 * Descarga el PDF del complemento de pago.
 */
router.get('/invoices/:id/payment-complement/:complementId/pdf', checkPermission('invoicing', 'read'), async (req, res, next) => {
  try {
    const stream = await paymentComplementService.downloadPDF({
      tenantId: req.tenant.id,
      complementFacurApiId: req.params.complementId,
    })
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `attachment; filename="complemento-${req.params.complementId}.pdf"`)
    stream.pipe(res)
  } catch (err) { next(err) }
})

// ─── Nota de crédito ─────────────────────────────────────────────────────────

/**
 * POST /api/invoicing/invoices/:id/credit-note
 * Genera una nota de crédito (CFDI tipo E) vinculada a una factura timbrada.
 * Body: {
 *   reason:       'return' | 'discount' | 'correction',
 *   description?: 'Descripción personalizada',
 *   amount:       monto sin IVA,
 *   paymentForm?: '03' | '01' | etc,
 *   relationship?: '01' (default = nota de crédito)
 * }
 */
router.post('/invoices/:id/credit-note', checkPermission('invoicing', 'create'), async (req, res, next) => {
  try {
    const { amount, reason, lines } = req.body
    const byLines = Array.isArray(lines) && lines.length > 0
    if (!byLines && !amount) {
      return res.status(400).json({ error: 'amount o lines[] es requerido.' })
    }
    if (!reason) return res.status(400).json({ error: 'reason es requerido: return, discount o correction.' })

    const result = await creditNoteService.createCreditNote({
      tenantId: req.tenant.id, invoiceId: req.params.id,
      ...req.body,
      userId: req.auth.userId, ipAddress: req.ip, userAgent: req.get('user-agent'),
    })
    res.status(201).json(result)
  } catch (err) { next(err) }
})

/**
 * GET /api/invoicing/invoices/:id/credit-note/:cnId/xml
 */
router.get('/invoices/:id/credit-note/:cnId/xml', checkPermission('invoicing', 'read'), async (req, res, next) => {
  try {
    const { rows } = await require('../../db').query(
      `SELECT notes FROM invoices WHERE id = $1 AND tenant_id = $2`,
      [req.params.cnId, req.tenant.id]
    )
    if (!rows.length) return res.status(404).json({ error: 'Nota de crédito no encontrada.' })
    const match = (rows[0].notes || '').match(/\[facturapi_id:([^\]]+)\]/)
    if (!match) return res.status(404).json({ error: 'ID de Facturapi no encontrado.' })
    const stream = await creditNoteService.downloadXML({ tenantId: req.tenant.id, facturApiId: match[1] })
    res.setHeader('Content-Type', 'application/xml')
    res.setHeader('Content-Disposition', `attachment; filename="nota-credito-${req.params.cnId}.xml"`)
    stream.pipe(res)
  } catch (err) { next(err) }
})

/**
 * GET /api/invoicing/invoices/:id/credit-note/:cnId/pdf
 */
router.get('/invoices/:id/credit-note/:cnId/pdf', checkPermission('invoicing', 'read'), async (req, res, next) => {
  try {
    const { rows } = await require('../../db').query(
      `SELECT notes FROM invoices WHERE id = $1 AND tenant_id = $2`,
      [req.params.cnId, req.tenant.id]
    )
    if (!rows.length) return res.status(404).json({ error: 'Nota de crédito no encontrada.' })
    const match = (rows[0].notes || '').match(/\[facturapi_id:([^\]]+)\]/)
    if (!match) return res.status(404).json({ error: 'ID de Facturapi no encontrado.' })
    const stream = await creditNoteService.downloadPDF({ tenantId: req.tenant.id, facturApiId: match[1] })
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `attachment; filename="nota-credito-${req.params.cnId}.pdf"`)
    stream.pipe(res)
  } catch (err) { next(err) }
})

module.exports = router
