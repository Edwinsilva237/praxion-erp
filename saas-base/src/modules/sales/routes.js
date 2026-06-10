'use strict'

const express = require('express')
const multer  = require('multer')
const path    = require('path')
const { tenantResolver }  = require('../../middleware/tenantResolver')
const { authGuard }       = require('../../middleware/authGuard')
const { requireActiveTenant } = require('../../middleware/requireActiveTenant')
const { checkPermission, checkAnyPermission } = require('../../middleware/checkPermission')
const requireModule       = require('../../middleware/requireModule')
const { query }           = require('../../db')
const orderService        = require('./orderService')
const deliveryNoteService = require('./deliveryNoteService')
const { generateRemisionPDF } = require('./remisionPdfService')
const storage             = require('../../utils/storage')
const attachmentService   = require('../attachments/attachmentService')

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
    // Auto-corrección de status pegado (best-effort): si el pedido quedó con un
    // status viejo (ej. "Remisionado" tras entregar una remisión consolidada),
    // lo re-derivamos de sus remisiones actuales al abrirlo. No bloquea la vista.
    try {
      await orderService.recalcOrderStatus({ tenantId: req.tenant.id, orderId: req.params.id })
    } catch (e) { /* no romper el detalle por un fallo de recálculo */ }

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

// Eliminar de raíz un pedido sin documentos asociados (solo admin).
router.delete('/orders/:id', checkPermission('sales', 'delete'), async (req, res, next) => {
  try {
    const result = await orderService.deleteOrder({
      tenantId:  req.tenant.id,
      orderId:   req.params.id,
      userId:    req.auth.userId,
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    })
    res.json({ message: `Pedido ${result.order_number} eliminado.`, ...result })
  } catch (err) { next(err) }
})

// ─── OC del cliente adjunta al pedido (attachments) ──────────────────────────
// El cliente a veces exige su propia orden de compra impresa para recibir la
// mercancía. Se adjunta al pedido (entityType='sales_order', category='customer_po')
// y se puede descargar/imprimir desde el pedido y desde la remisión ligada.
// Aditivo (varios documentos por pedido); reusa la infra genérica de attachments.

async function loadOrderForPo(req, res) {
  const { rows } = await query(
    `SELECT id, order_number FROM sales_orders WHERE id = $1 AND tenant_id = $2`,
    [req.params.id, req.tenant.id]
  )
  if (!rows.length) { res.status(404).json({ error: 'Pedido no encontrado.' }); return null }
  return rows[0]
}

/** GET /api/sales/orders/:id/attachments → lista los documentos de OC del cliente. */
router.get('/orders/:id/attachments',
  checkPermission('sales', 'read'),
  async (req, res, next) => {
    try {
      const order = await loadOrderForPo(req, res)
      if (!order) return
      const files = await attachmentService.listAttachments({
        tenantId: req.tenant.id, entityType: 'sales_order', entityId: order.id,
        category: 'customer_po',
      })
      res.json(files)
    } catch (err) { next(err) }
  }
)

/** POST /api/sales/orders/:id/attachments → adjunta un documento de OC (aditivo). */
router.post('/orders/:id/attachments',
  checkAnyPermission([['sales', 'create'], ['sales', 'update']]),
  uploadPhoto.single('file'),
  async (req, res, next) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'Se requiere un archivo.' })
      const order = await loadOrderForPo(req, res)
      if (!order) return
      const attachment = await attachmentService.saveAttachment({
        tenantId: req.tenant.id,
        entityType: 'sales_order', entityId: order.id,
        category: 'customer_po',
        originalFilename: req.file.originalname,
        buffer: req.file.buffer, mimeType: req.file.mimetype,
        description: req.body.description || null,
        uploadedBy: req.auth.userId,
        replaceCategory: false,  // ADITIVO: varios documentos por pedido
      })
      res.status(201).json(attachment)
    } catch (err) { next(err) }
  }
)

/** GET /api/sales/orders/:id/attachments/:attachmentId/download */
router.get('/orders/:id/attachments/:attachmentId/download',
  checkPermission('sales', 'read'),
  async (req, res, next) => {
    try {
      const file = await attachmentService.getAttachmentInfo({
        tenantId: req.tenant.id, attachmentId: req.params.attachmentId,
      })
      if (!file) return res.status(404).json({ error: 'Archivo no encontrado.' })
      // proxy:true (sin redirect) = abre en el webview móvil sin chocar con el CORS de R2.
      await storage.serve(res, file.storage_path, {
        filename: file.filename, mimeType: file.mime_type, disposition: 'inline', proxy: true,
      })
    } catch (err) { next(err) }
  }
)

/** DELETE /api/sales/orders/:id/attachments/:attachmentId → quita un documento de OC. */
router.delete('/orders/:id/attachments/:attachmentId',
  checkAnyPermission([['sales', 'update'], ['sales', 'delete']]),
  async (req, res, next) => {
    try {
      const order = await loadOrderForPo(req, res)
      if (!order) return
      const deleted = await attachmentService.deleteAttachment({
        tenantId: req.tenant.id, attachmentId: req.params.attachmentId,
      })
      if (!deleted) return res.status(404).json({ error: 'Archivo no encontrado.' })
      res.json({ message: 'Documento eliminado.', id: deleted.id })
    } catch (err) { next(err) }
  }
)

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
  // Registrar entrega + evidencia: el repartidor puede tener solo `sales:deliver`
  // (sin edición general). Los roles con `sales:update` siguen funcionando.
  checkAnyPermission([['sales', 'update'], ['sales', 'deliver']]),
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

// ─── Evidencia ADITIVA de remisión (attachments) ─────────────────────────────
// Para adjuntar el acuse/firma cuando el cliente recibe la mercancía DESPUÉS de
// facturar (pide la factura impresa para recibir). Es SOLO aditivo: no toca status,
// inventario ni CXC, y no edita/borra la evidencia previa (la entrega normal sigue
// usando /deliver). entityType='delivery_note', category='delivery_evidence'.

async function loadNoteForEvidence(req, res) {
  const { rows } = await query(
    `SELECT id, status FROM delivery_notes WHERE id = $1 AND tenant_id = $2`,
    [req.params.id, req.tenant.id]
  )
  if (!rows.length) { res.status(404).json({ error: 'Remisión no encontrada.' }); return null }
  return rows[0]
}

/** GET /api/sales/delivery-notes/:id/attachments → lista la evidencia adjunta. */
router.get('/delivery-notes/:id/attachments',
  checkPermission('sales', 'read'),
  async (req, res, next) => {
    try {
      const note = await loadNoteForEvidence(req, res)
      if (!note) return
      const files = await attachmentService.listAttachments({
        tenantId: req.tenant.id, entityType: 'delivery_note', entityId: note.id,
      })
      res.json(files)
    } catch (err) { next(err) }
  }
)

/** POST /api/sales/delivery-notes/:id/attachments → agrega evidencia (aditivo). */
router.post('/delivery-notes/:id/attachments',
  checkAnyPermission([['sales', 'deliver'], ['sales', 'update']]),
  uploadPhoto.single('file'),
  async (req, res, next) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'Se requiere un archivo.' })
      const note = await loadNoteForEvidence(req, res)
      if (!note) return
      if (note.status === 'cancelled') {
        return res.status(409).json({ error: 'La remisión está cancelada.' })
      }
      const attachment = await attachmentService.saveAttachment({
        tenantId: req.tenant.id,
        entityType: 'delivery_note', entityId: note.id,
        category: 'delivery_evidence',
        originalFilename: req.file.originalname,
        buffer: req.file.buffer, mimeType: req.file.mimetype,
        description: req.body.description || null,
        uploadedBy: req.auth.userId,
        replaceCategory: false,  // ADITIVO: nunca pisa la evidencia previa
      })
      res.status(201).json(attachment)
    } catch (err) { next(err) }
  }
)

/** GET /api/sales/delivery-notes/:id/attachments/:attachmentId/download */
router.get('/delivery-notes/:id/attachments/:attachmentId/download',
  checkPermission('sales', 'read'),
  async (req, res, next) => {
    try {
      const file = await attachmentService.getAttachmentInfo({
        tenantId: req.tenant.id, attachmentId: req.params.attachmentId,
      })
      if (!file) return res.status(404).json({ error: 'Archivo no encontrado.' })
      // proxy:true (sin redirect) = abre en el webview móvil sin chocar con el CORS de R2.
      await storage.serve(res, file.storage_path, {
        filename: file.filename, mimeType: file.mime_type, disposition: 'inline', proxy: true,
      })
    } catch (err) { next(err) }
  }
)

/**
 * POST /api/sales/delivery-notes/:id/adjust-prices
 * Corrige precios (unit_price/discount_pct) de una remisión NO facturada, con
 * observación obligatoria. Recalcula total + CXC y espeja el precio al pedido.
 * Body: { lines: [{ lineId, unitPrice, discountPct? }], reason }
 * Permiso dedicado (sensible) — solo admin por default (mig 187).
 */
router.post('/delivery-notes/:id/adjust-prices', checkPermission('sales', 'adjust_price'), async (req, res, next) => {
  try {
    const { lines, reason } = req.body
    if (!Array.isArray(lines) || lines.length === 0) {
      return res.status(400).json({ error: 'Se requiere al menos una línea a corregir.' })
    }
    const result = await deliveryNoteService.adjustDeliveryNotePrices({
      tenantId:  req.tenant.id,
      noteId:    req.params.id,
      lines,
      reason,
      userId:    req.auth.userId,
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    })
    res.json({ ...result, message: `Precios corregidos (${result.changed}). Total: ${result.total_mxn}.` })
  } catch (err) { next(err) }
})

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

// Eliminar de raíz una remisión sin movimientos asociados (solo admin).
router.delete('/delivery-notes/:id', checkPermission('sales', 'delete'), async (req, res, next) => {
  try {
    const result = await deliveryNoteService.deleteDelivery({
      tenantId:  req.tenant.id,
      noteId:    req.params.id,
      userId:    req.auth.userId,
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    })
    res.json({ message: `Remisión ${result.document_number} eliminada.`, ...result })
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
 * POST /api/sales/orders/:id/bundles
 * Agrega un PAQUETE del catálogo al pedido (solo draft): el backend lo explota
 * en líneas componente con precio prorrateado (grupo atómico).
 * Body: { bundleId, bundleQuantity? }
 */
router.post('/orders/:id/bundles', checkPermission('sales', 'create'), async (req, res, next) => {
  try {
    const { bundleId, bundleQuantity } = req.body
    if (!bundleId) return res.status(400).json({ error: 'bundleId es requerido.' })
    const result = await orderService.addBundleToOrder({
      tenantId: req.tenant.id, orderId: req.params.id,
      bundleId, bundleQuantity,
      userId: req.auth.userId, ipAddress: req.ip, userAgent: req.get('user-agent'),
    })
    res.status(201).json(result)
  } catch (err) { next(err) }
})

/**
 * DELETE /api/sales/orders/:id/bundle-groups/:groupId
 * Quita un paquete completo (todas sus líneas) del pedido — solo en draft.
 */
router.delete('/orders/:id/bundle-groups/:groupId', checkPermission('sales', 'update'), async (req, res, next) => {
  try {
    const result = await orderService.removeBundleGroup({
      tenantId: req.tenant.id, orderId: req.params.id,
      bundleGroupId: req.params.groupId,
      userId: req.auth.userId, ipAddress: req.ip, userAgent: req.get('user-agent'),
    })
    res.json({ message: 'Paquete quitado del pedido.', ...result })
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
