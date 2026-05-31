'use strict'

const express = require('express')
const multer  = require('multer')
const path    = require('path')
const { tenantResolver }  = require('../../middleware/tenantResolver')
const { authGuard }       = require('../../middleware/authGuard')
const { requireActiveTenant } = require('../../middleware/requireActiveTenant')
const { checkPermission } = require('../../middleware/checkPermission')
const requireModule       = require('../../middleware/requireModule')
const { query }           = require('../../db')
const orderService        = require('./orderService')
const deliveryNoteService = require('./deliveryNoteService')
const { generateRemisionPDF } = require('./remisionPdfService')
const storage             = require('../../utils/storage')

const router = express.Router()

// Multer para fotos de entrega — acepta imágenes además de PDF
const uploadPhoto = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB para fotos
  fileFilter: (_req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf']
    allowed.includes(file.mimetype) ? cb(null, true) : cb(new Error('Solo imágenes o PDF.'))
  },
})

router.use(tenantResolver)
router.use(authGuard)
router.use(requireActiveTenant)
router.use(requireModule('sales'))

// ─── Pedidos ─────────────────────────────────────────────────────────────────

/**
 * GET /api/sales/orders
 * Query: status, partnerId, from, to, page, limit
 */
router.get('/orders', checkPermission('sales', 'read'), async (req, res, next) => {
  try {
    const { status, partnerId, from, to, page, limit } = req.query
    const result = await orderService.listOrders({
      tenantId: req.tenant.id,
      status, partnerId, from, to,
      page:  parseInt(page || 1, 10),
      limit: Math.min(parseInt(limit || 50, 10), 100),
    })
    res.json(result)
  } catch (err) { next(err) }
})

/**
 * GET /api/sales/orders/:id
 */
router.get('/orders/:id', checkPermission('sales', 'read'), async (req, res, next) => {
  try {
    const order = await orderService.getOrder({ tenantId: req.tenant.id, orderId: req.params.id })
    if (!order) return res.status(404).json({ error: 'Pedido no encontrado.' })
    res.json(order)
  } catch (err) { next(err) }
})

/**
 * GET /api/sales/orders/:id/pending-quantities
 * Devuelve por línea del pedido la qty ordenada, ya remisionada y pendiente.
 * Útil para generar una segunda remisión y sugerir solo el saldo.
 */
router.get('/orders/:id/pending-quantities', checkPermission('sales', 'read'), async (req, res, next) => {
  try {
    const breakdown = await orderService.getOrderDeliveryBreakdown(null, {
      tenantId: req.tenant.id, orderId: req.params.id,
    })
    res.json({ data: breakdown })
  } catch (err) { next(err) }
})

/**
 * GET /api/sales/suggested-price
 * Obtiene el precio sugerido para un cliente+producto.
 * Query: partnerId, productId
 */
router.get('/suggested-price', checkPermission('sales', 'read'), async (req, res, next) => {
  try {
    const { partnerId, productId, orderCurrency } = req.query
    if (!partnerId || !productId) {
      return res.status(400).json({ error: 'partnerId y productId son requeridos.' })
    }
    const price = await orderService.getSuggestedPrice({
      tenantId: req.tenant.id, partnerId, productId,
      orderCurrency: orderCurrency || 'MXN',
    })
    res.json(price || { message: 'Sin precio negociado — captura el precio manualmente.' })
  } catch (err) { next(err) }
})

/**
 * POST /api/sales/orders
 * Body: { partnerId, deliveryAddressId?, currency?, poNumber?, lines[], notes? }
 * lines: [{ productId, quantity, unitPrice, unit?, discountPct?, notes? }]
 */
router.post('/orders', checkPermission('sales', 'create'), async (req, res, next) => {
  try {
    const { partnerId, lines } = req.body
    if (!partnerId) return res.status(400).json({ error: 'partnerId es requerido.' })
    if (!lines || lines.length === 0) return res.status(400).json({ error: 'Se requiere al menos una línea.' })

    const order = await orderService.createOrder({
      tenantId: req.tenant.id, ...req.body,
      userId: req.auth.userId, ipAddress: req.ip, userAgent: req.get('user-agent'),
    })
    res.status(201).json(order)
  } catch (err) { next(err) }
})

/**
 * POST /api/sales/orders/:id/confirm
 */
router.post('/orders/:id/confirm', checkPermission('sales', 'create'), async (req, res, next) => {
  try {
    const order = await orderService.confirmOrder({
      tenantId: req.tenant.id, orderId: req.params.id,
      userId: req.auth.userId, ipAddress: req.ip, userAgent: req.get('user-agent'),
    })
    res.json(order)
  } catch (err) { next(err) }
})

/**
 * POST /api/sales/orders/:id/cancel
 * Body: { reason }
 */
router.post('/orders/:id/cancel', checkPermission('sales', 'update'), async (req, res, next) => {
  try {
    const order = await orderService.cancelOrder({
      tenantId: req.tenant.id, orderId: req.params.id,
      reason: req.body.reason,
      userId: req.auth.userId, ipAddress: req.ip, userAgent: req.get('user-agent'),
    })
    res.json(order)
  } catch (err) { next(err) }
})

// ─── Remisiones ───────────────────────────────────────────────────────────────

/**
 * GET /api/sales/delivery-notes
 * Query: type, status, partnerId, from, to, page, limit
 */
router.get('/delivery-notes', checkPermission('sales', 'read'), async (req, res, next) => {
  try {
    const { type, status, partnerId, from, to, page, limit, invoiceable } = req.query
    const result = await deliveryNoteService.listDeliveryNotes({
      tenantId: req.tenant.id,
      type: type || 'sale', status, partnerId, from, to,
      // Query string siempre llega como string; normalizamos a boolean real.
      invoiceable: invoiceable === 'true' || invoiceable === true,
      page:  parseInt(page || 1, 10),
      limit: Math.min(parseInt(limit || 50, 10), 100),
    })
    res.json(result)
  } catch (err) { next(err) }
})

/**
 * GET /api/sales/delivery-notes/:id
 */
router.get('/delivery-notes/:id', checkPermission('sales', 'read'), async (req, res, next) => {
  try {
    const note = await deliveryNoteService.getDeliveryNote({
      tenantId: req.tenant.id, noteId: req.params.id,
    })
    if (!note) return res.status(404).json({ error: 'Remisión no encontrada.' })
    res.json(note)
  } catch (err) { next(err) }
})

/**
 * POST /api/sales/delivery-notes
 * Crea una remisión desde uno o varios pedidos del mismo cliente.
 * Body: { salesOrderId?, salesOrderIds?: [], lines[]?, notes? }
 *   - Para single-pedido legacy: { salesOrderId, lines? }
 *   - Para multi: { salesOrderIds: [...], lines: [{ ..., salesOrderId, salesOrderLineId? }] }
 */
router.post('/delivery-notes', checkPermission('sales', 'create'), async (req, res, next) => {
  try {
    const { salesOrderId, salesOrderIds } = req.body
    const hasIds = Array.isArray(salesOrderIds) && salesOrderIds.length > 0
    if (!salesOrderId && !hasIds) {
      return res.status(400).json({ error: 'Se requiere salesOrderId o salesOrderIds.' })
    }

    const note = await deliveryNoteService.createDeliveryNote({
      tenantId: req.tenant.id, ...req.body,
      userId: req.auth.userId, ipAddress: req.ip, userAgent: req.get('user-agent'),
    })
    res.status(201).json(note)
  } catch (err) { next(err) }
})

/**
 * POST /api/sales/delivery-notes/:id/no-invoice
 * Marca o desmarca la remisión como "no requiere factura".
 * Body: { noInvoice: boolean }
 */
router.post('/delivery-notes/:id/no-invoice', checkPermission('sales', 'update'), async (req, res, next) => {
  try {
    const { noInvoice } = req.body
    if (typeof noInvoice !== 'boolean') {
      return res.status(400).json({ error: 'noInvoice debe ser un booleano.' })
    }
    const note = await deliveryNoteService.setNoInvoice({
      tenantId: req.tenant.id, noteId: req.params.id,
      noInvoice,
      userId: req.auth.userId, ipAddress: req.ip, userAgent: req.get('user-agent'),
    })
    res.json({
      ...note,
      message: noInvoice
        ? 'Remisión marcada como sin factura. Ya no aparecerá en el modal de nueva factura.'
        : 'Remisión marcada como facturable.',
    })
  } catch (err) { next(err) }
})

/**
 * POST /api/sales/delivery-notes/:id/send-email
 * Envía la remisión por correo al cliente con el PDF adjunto.
 * Body: { emails?: string[] }
 *   - Si emails llega vacío, se usa el contacto principal del cliente.
 *   - Si la remisión está en 'issued', además avanza el status a 'sent_by_email'.
 */
router.post('/delivery-notes/:id/send-email', checkPermission('sales', 'update'), async (req, res, next) => {
  try {
    const note = await deliveryNoteService.markAsSentByEmail({
      tenantId: req.tenant.id, noteId: req.params.id,
      emails:   Array.isArray(req.body?.emails) ? req.body.emails : null,
      userId:   req.auth.userId, ipAddress: req.ip, userAgent: req.get('user-agent'),
    })
    if (!note) return res.status(404).json({ error: 'Remisión no encontrada.' })
    res.json({ ...note, message: `Correo enviado a: ${note.sentTo.join(', ')}` })
  } catch (err) { next(err) }
})

/**
 * GET /api/sales/delivery-notes/:id/pdf
 * Descarga la representación impresa (PDF) de la remisión.
 * ?precios=0 (o false) genera la versión de entrega sin precios.
 */
router.get('/delivery-notes/:id/pdf', checkPermission('sales', 'read'), async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT document_number FROM delivery_notes WHERE id = $1 AND tenant_id = $2`,
      [req.params.id, req.tenant.id]
    )
    if (!rows.length) return res.status(404).json({ error: 'Remisión no encontrada.' })
    const showPrices = !['0', 'false', 'no'].includes(String(req.query.precios).toLowerCase())
    const buf = await generateRemisionPDF({ tenantId: req.tenant.id, noteId: req.params.id, showPrices })
    const suffix = showPrices ? '' : '-sin-precios'
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `attachment; filename="${rows[0].document_number}${suffix}.pdf"`)
    res.end(buf)
  } catch (err) { next(err) }
})

/**
 * POST /api/sales/delivery-notes/:id/deliver
 * Registra la entrega con foto y nombre del receptor.
 * Multipart/form-data: photo (imagen), receiverName, isComplete (bool)
 * Funciona offline — si no hay conexión la foto se guarda localmente.
 */
router.post('/delivery-notes/:id/deliver',
  checkPermission('sales', 'update'),
  uploadPhoto.single('photo'),
  async (req, res, next) => {
    try {
      const { receiverName } = req.body
      if (!receiverName) return res.status(400).json({ error: 'receiverName es requerido.' })

      const note = await deliveryNoteService.recordDelivery({
        tenantId:      req.tenant.id,
        noteId:        req.params.id,
        receiverName,
        photoBuffer:   req.file?.buffer || null,
        photoFilename: req.file?.originalname || null,
        userId:        req.auth.userId,
        ipAddress:     req.ip,
        userAgent:     req.get('user-agent'),
      })
      res.json({
        ...note,
        message: 'Entrega registrada. CXC generado automáticamente.',
      })
    } catch (err) { next(err) }
  }
)

/**
 * POST /api/sales/delivery-notes/:id/cancel
 * Cancela una remisión revirtiendo inventario y AR.
 * Body: { reason }
 */
router.post('/delivery-notes/:id/cancel', checkPermission('sales', 'update'), async (req, res, next) => {
  try {
    const result = await deliveryNoteService.cancelDelivery({
      tenantId:  req.tenant.id,
      noteId:    req.params.id,
      reason:    req.body?.reason || null,
      userId:    req.auth.userId,
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    })
    res.json(result)
  } catch (err) { next(err) }
})

/**
 * GET /api/sales/delivery-notes/:id/photo
 * Sirve la foto de evidencia de entrega.
 */
router.get('/delivery-notes/:id/photo', checkPermission('sales', 'read'), async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT receiver_photo_path FROM delivery_notes WHERE id = $1 AND tenant_id = $2`,
      [req.params.id, req.tenant.id]
    )
    if (!rows.length || !rows[0].receiver_photo_path) {
      return res.status(404).json({ error: 'No hay foto de entrega para esta remisión.' })
    }
    const key = rows[0].receiver_photo_path
    const ext = path.extname(key).toLowerCase()
    const mime = ext === '.png'  ? 'image/png'
              : ext === '.webp' ? 'image/webp'
              : ext === '.pdf'  ? 'application/pdf'
              : 'image/jpeg'
    // proxy: el backend transmite el archivo en vez de redirigir a R2 (cuyo CORS
    // no permite el origen del móvil/webview → "Network Error" al cargar la foto).
    await storage.serve(res, key, { mimeType: mime, disposition: 'inline', proxy: true })
  } catch (err) { next(err) }
})

module.exports = router

// ─── Edición de pedidos en draft ─────────────────────────────────────────────

/**
 * PATCH /api/sales/orders/:id
 * Edita datos generales del pedido — solo en estado draft.
 */
router.patch('/orders/:id', checkPermission('sales', 'update'), async (req, res, next) => {
  try {
    const order = await orderService.updateOrder({
      tenantId: req.tenant.id, orderId: req.params.id,
      ...req.body,
      userId: req.auth.userId, ipAddress: req.ip, userAgent: req.get('user-agent'),
    })
    res.json(order)
  } catch (err) { next(err) }
})

/**
 * POST /api/sales/orders/:id/assign-driver
 * Asigna repartidor, marca "recoge en bodega", o limpia.
 * Permitido en draft, confirmed e in_delivery.
 * Body: { driverId?, pickupInWarehouse?, scheduledDate? }
 *
 *   - { driverId, pickupInWarehouse: false } → asignar repartidor.
 *   - { pickupInWarehouse: true }            → recoge en bodega (sin driver).
 *   - { driverId: null, pickupInWarehouse: false } → limpia asignación.
 */
router.post('/orders/:id/assign-driver', checkPermission('sales', 'update'), async (req, res, next) => {
  try {
    const { driverId, pickupInWarehouse, scheduledDate } = req.body
    const order = await orderService.assignDriver({
      tenantId: req.tenant.id, orderId: req.params.id,
      driverId, pickupInWarehouse, scheduledDate,
      userId: req.auth.userId, ipAddress: req.ip, userAgent: req.get('user-agent'),
    })
    res.json(order)
  } catch (err) { next(err) }
})

/**
 * POST /api/sales/orders/:id/lines
 * Agrega una línea al pedido — solo en draft.
 * Body: { productId, quantity, unitPrice, unit?, discountPct?, notes? }
 */
router.post('/orders/:id/lines', checkPermission('sales', 'create'), async (req, res, next) => {
  try {
    const { productId, quantity, unitPrice } = req.body
    if (!productId || !quantity || !unitPrice) {
      return res.status(400).json({ error: 'productId, quantity y unitPrice son requeridos.' })
    }
    const line = await orderService.addOrderLine({
      tenantId: req.tenant.id, orderId: req.params.id,
      ...req.body, userId: req.auth.userId,
    })
    res.status(201).json(line)
  } catch (err) { next(err) }
})

/**
 * PATCH /api/sales/orders/:id/lines/:lineId
 * Edita una línea del pedido — solo en draft.
 */
router.patch('/orders/:id/lines/:lineId', checkPermission('sales', 'update'), async (req, res, next) => {
  try {
    const line = await orderService.updateOrderLine({
      tenantId: req.tenant.id, orderId: req.params.id,
      lineId: req.params.lineId, ...req.body,
      userId: req.auth.userId,
    })
    res.json(line)
  } catch (err) { next(err) }
})

/**
 * DELETE /api/sales/orders/:id/lines/:lineId
 * Elimina una línea del pedido — solo en draft.
 */
router.delete('/orders/:id/lines/:lineId', checkPermission('sales', 'update'), async (req, res, next) => {
  try {
    await orderService.deleteOrderLine({
      tenantId: req.tenant.id, orderId: req.params.id,
      lineId: req.params.lineId, userId: req.auth.userId,
    })
    res.json({ message: 'Línea eliminada.' })
  } catch (err) { next(err) }
})
