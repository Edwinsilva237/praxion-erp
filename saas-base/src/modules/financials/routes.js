'use strict'

const express             = require('express')
const { tenantResolver }  = require('../../middleware/tenantResolver')
const { authGuard }       = require('../../middleware/authGuard')
const { requireActiveTenant } = require('../../middleware/requireActiveTenant')
const { checkPermission } = require('../../middleware/checkPermission')
const cxcService          = require('./cxcService')
const paymentComplementService = require('../invoicing/paymentComplementService')
const paymentReceiptService    = require('./paymentReceiptService')
const { generatePaymentReceiptPDF } = require('./paymentReceiptPdfService')
const paymentMatcher           = require('./paymentMatcherService')

const router = express.Router()

router.use(tenantResolver)
router.use(authGuard)
router.use(requireActiveTenant)

// ─── CXC — Cuentas por cobrar ─────────────────────────────────────────────────

/**
 * GET /api/financials/cxc
 * Lista CXC con filtros.
 * Query: status, partnerId, from, to, page, limit
 */
router.get('/cxc', checkPermission('financials', 'read'), async (req, res, next) => {
  try {
    const { status, partnerId, from, to, sortBy, sortDir, page, limit } = req.query
    const result = await cxcService.listCXC({
      tenantId: req.tenant.id,
      status, partnerId, from, to, sortBy, sortDir,
      page:  parseInt(page || 1, 10),
      limit: Math.min(parseInt(limit || 50, 10), 100),
    })
    res.json(result)
  } catch (err) { next(err) }
})

/**
 * GET /api/financials/payments — Historial de PAGOS RECIBIDOS (cobros reales).
 */
router.get('/payments', checkPermission('financials', 'read'), async (req, res, next) => {
  try {
    const { partnerId, from, to, method, sortBy, sortDir, page, limit } = req.query
    const result = await cxcService.listPayments({
      tenantId: req.tenant.id,
      partnerId, from, to, method, sortBy, sortDir,
      page:  parseInt(page || 1, 10),
      limit: Math.min(parseInt(limit || 50, 10), 100),
    })
    res.json(result)
  } catch (err) { next(err) }
})

/**
 * GET /api/financials/payments/:id — Detalle de un cobro recibido (panel que
 * abre al hacer clic en una fila de "Pagos recibidos").
 */
router.get('/payments/:id', checkPermission('financials', 'read'), async (req, res, next) => {
  try {
    const payment = await cxcService.getPaymentDetail({
      tenantId: req.tenant.id, paymentId: req.params.id,
    })
    if (!payment) return res.status(404).json({ error: 'Cobro no encontrado.' })
    res.json(payment)
  } catch (err) { next(err) }
})

/**
 * GET /api/financials/cxc/:id
 * Detalle de un documento CXC con pagos aplicados y datos del documento origen.
 */
router.get('/cxc/:id', checkPermission('financials', 'read'), async (req, res, next) => {
  try {
    const ar = await cxcService.getCXC({ tenantId: req.tenant.id, arId: req.params.id })
    if (!ar) return res.status(404).json({ error: 'CXC no encontrado.' })
    res.json(ar)
  } catch (err) { next(err) }
})

/**
 * GET /api/financials/customers/:id/statement
 * Estado de cuenta de un cliente.
 * Query: from?, to?
 */
router.get('/customers/:id/statement', checkPermission('financials', 'read'), async (req, res, next) => {
  try {
    const { from, to } = req.query
    const statement = await cxcService.getCustomerStatement({
      tenantId: req.tenant.id, partnerId: req.params.id, from, to,
    })
    res.json(statement)
  } catch (err) { next(err) }
})

/**
 * POST /api/financials/cxc/payments
 * Registra un pago de cliente y lo aplica a documentos CXC.
 * Body: {
 *   partnerId,
 *   paymentDate?, method, reference?,
 *   amount, currency?,
 *   applications: [{ arId, amountApplied }],
 *   notes?
 * }
 */
router.post('/cxc/payments', checkPermission('financials', 'create'), async (req, res, next) => {
  try {
    const { partnerId, amount, method } = req.body
    if (!partnerId) return res.status(400).json({ error: 'partnerId es requerido.' })
    if (!amount)    return res.status(400).json({ error: 'amount es requerido.' })
    if (!method)    return res.status(400).json({ error: 'method es requerido.' })

    const result = await cxcService.registerPayment({
      tenantId: req.tenant.id, ...req.body,
      userId: req.auth.userId, ipAddress: req.ip, userAgent: req.get('user-agent'),
    })
    res.status(201).json(result)
  } catch (err) { next(err) }
})

/**
 * POST /api/financials/cxc/advances/:id/apply
 * Aplica un anticipo existente a documentos CXC.
 * Body: {
 *   partnerId,
 *   applications: [{ arId, amountApplied }]
 * }
 */
router.post('/cxc/advances/:id/apply', checkPermission('financials', 'create'), async (req, res, next) => {
  try {
    const { partnerId, applications } = req.body
    if (!partnerId)    return res.status(400).json({ error: 'partnerId es requerido.' })
    if (!applications) return res.status(400).json({ error: 'applications es requerido.' })

    const result = await cxcService.applyAdvance({
      tenantId: req.tenant.id, advanceId: req.params.id,
      ...req.body,
      userId: req.auth.userId, ipAddress: req.ip, userAgent: req.get('user-agent'),
    })
    res.json(result)
  } catch (err) { next(err) }
})

/**
 * POST /api/financials/payment-matcher
 * Identifica candidatos de facturas pendientes que sumen un monto recibido
 * en el banco (conciliación bancaria sin emisor identificado).
 * Body: { amount, currency?, tolerance?, partnerId?, maxComb? }
 */
router.post('/payment-matcher', checkPermission('financials', 'read'),
  async (req, res, next) => {
    try {
      const result = await paymentMatcher.findMatches({
        tenantId:  req.tenant.id,
        amount:    req.body.amount,
        currency:  req.body.currency,
        tolerance: req.body.tolerance,
        partnerId: req.body.partnerId,
        maxComb:   req.body.maxComb,
      })
      res.json(result)
    } catch (err) { next(err) }
  })

// ─── Recibos de pago (PDF no fiscal) ─────────────────────────────────────────

/**
 * GET /api/financials/payments/:id/receipt-pdf
 * Descarga el PDF del recibo de pago.
 */
router.get('/payments/:id/receipt-pdf', checkPermission('financials', 'read'),
  async (req, res, next) => {
    try {
      const { buffer, folio } = await generatePaymentReceiptPDF({
        tenantId: req.tenant.id, paymentId: req.params.id,
      })
      res.setHeader('Content-Type', 'application/pdf')
      res.setHeader('Content-Disposition', `attachment; filename="${folio}.pdf"`)
      res.send(buffer)
    } catch (err) { next(err) }
  })

/**
 * POST /api/financials/payments/:id/receipt-email
 * Envía el recibo de pago al cliente (SMTP, PDF adjunto, BCC institucional).
 * Body: { emails?: string[] }
 */
router.post('/payments/:id/receipt-email', checkPermission('financials', 'create'),
  async (req, res, next) => {
    try {
      const result = await paymentReceiptService.sendReceiptByEmail({
        tenantId:  req.tenant.id,
        paymentId: req.params.id,
        emails:    req.body?.emails,
        userId:    req.auth.userId,
        ipAddress: req.ip, userAgent: req.get('user-agent'),
      })
      res.json(result)
    } catch (err) { next(err) }
  })

/**
 * POST /api/financials/payments/:id/reverse
 * Reversa un cobro aplicado: revierte el saldo de la CXC y cancela el
 * complemento de pago (CFDI tipo P) ante el SAT si el cobro lo generó.
 * Body: { reason }
 */
router.post('/payments/:id/reverse', checkPermission('financials', 'reverse_payment'),
  async (req, res, next) => {
    try {
      const result = await cxcService.reversePayment({
        tenantId:  req.tenant.id,
        paymentId: req.params.id,
        reason:    req.body?.reason,
        userId:    req.auth.userId,
        ipAddress: req.ip,
        userAgent: req.get('user-agent'),
      })
      res.json(result)
    } catch (err) { next(err) }
  })

/**
 * POST /api/financials/payment-complements/:id/send-email
 * Envía un complemento de pago timbrado por correo (SMTP) con PDF+XML.
 * Body: { emails?: string[] } — si no llegan se usan contactos del cliente.
 */
router.post('/payment-complements/:id/send-email', checkPermission('financials', 'create'),
  async (req, res, next) => {
    try {
      const result = await paymentComplementService.sendComplementByEmail({
        tenantId:     req.tenant.id,
        complementId: req.params.id,
        emails:       req.body?.emails,
        userId:       req.auth.userId,
        ipAddress:    req.ip,
        userAgent:    req.get('user-agent'),
      })
      res.json(result)
    } catch (err) { next(err) }
  })

/**
 * GET /api/financials/payment-complements/:complementId/xml
 * Descarga el XML del complemento (proxy hacia Facturapi).
 * El complementId aquí es el facturapi_id, no el id local — mismo patrón
 * que el endpoint equivalente en /invoicing para reuso de la lógica.
 */
router.get('/payment-complements/:complementId/xml', checkPermission('financials', 'read'),
  async (req, res, next) => {
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

router.get('/payment-complements/:complementId/pdf', checkPermission('financials', 'read'),
  async (req, res, next) => {
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

/**
 * POST /api/financials/cxc/:arId/stamp-complement
 * Timbra el complemento faltante para una factura PPD ya cobrada cuyo
 * pago no generó CFDI tipo P en su momento.
 * Body: { paymentDate?, paymentForm?, amount?, reference?, exchangeRate? }
 */
router.post('/cxc/:arId/stamp-complement', checkPermission('financials', 'create'),
  async (req, res, next) => {
    try {
      const result = await cxcService.stampMissingComplement({
        tenantId: req.tenant.id, arId: req.params.arId,
        ...req.body,
        userId: req.auth.userId, ipAddress: req.ip, userAgent: req.get('user-agent'),
      })
      res.json(result)
    } catch (err) { next(err) }
  })

module.exports = router
