'use strict'

const express             = require('express')
const multer              = require('multer')
const { tenantResolver }  = require('../../middleware/tenantResolver')
const { authGuard }       = require('../../middleware/authGuard')
const { requireActiveTenant } = require('../../middleware/requireActiveTenant')
const { checkPermission, checkAnyPermission } = require('../../middleware/checkPermission')
const requireModule       = require('../../middleware/requireModule')
const purchaseOrderService    = require('./purchaseOrderService')
const supplierReceiptService  = require('./supplierReceiptService')
const documentParserService   = require('./documentParserService')
const supplierInvoiceService  = require('./supplierInvoiceService')
const cxpService              = require('./cxpService')
const apAdvanceService        = require('./apAdvanceService')
const supplierPriceService    = require('./supplierPriceService')
const supplierReturnService   = require('./supplierReturnService')
const supplierComplementService = require('./supplierComplementService')
const inboundEmailService     = require('../inbound/inboundEmailService')
const attachmentService       = require('../attachments/attachmentService')
const storage                 = require('../../utils/storage')
const config                  = require('../../config')
const { generatePurchaseOrderPDF } = require('./purchaseOrderPdfService')
const { generateReceiptPDF }       = require('./receiptPdfService')

// Multer para XML y PDF de facturas/OC de proveedor
const uploadDoc = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB
  fileFilter: (_req, file, cb) => {
    const allowed = ['application/pdf', 'text/xml', 'application/xml']
    const extOk   = file.originalname.toLowerCase().match(/\.(pdf|xml)$/)
    allowed.includes(file.mimetype) || extOk
      ? cb(null, true)
      : cb(new Error('Solo se permiten archivos PDF o XML.'))
  },
})

// Multer para evidencias de facturas/CXP (PDF, JPG, PNG, WebP).
const uploadEvidence = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.uploads.maxSizeMb * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    config.uploads.allowedMimeTypes.includes(file.mimetype)
      ? cb(null, true)
      : cb(new Error(`Tipo no permitido: ${file.mimetype}. Acepta PDF, JPG, PNG, WebP.`))
  },
})

const router = express.Router()

router.use(tenantResolver)
router.use(authGuard)
router.use(requireActiveTenant)
router.use(requireModule('purchases'))

// ─── Devoluciones a proveedor (Fase 1) ───────────────────────────────────────
const retErr = (res, next) => (err) => {
  if (err.status) return res.status(err.status).json({ error: err.message })
  next(err)
}

// Catálogo de motivos
router.get('/return-reasons', checkPermission('purchases', 'read'), async (req, res, next) => {
  try {
    res.json(await supplierReturnService.listReasons({
      tenantId: req.tenant.id, includeInactive: req.query.includeInactive === 'true',
    }))
  } catch (err) { retErr(res, next)(err) }
})
router.post('/return-reasons', checkPermission('purchases', 'update'), async (req, res, next) => {
  try {
    res.status(201).json(await supplierReturnService.createReason({ tenantId: req.tenant.id, ...req.body }))
  } catch (err) { retErr(res, next)(err) }
})
router.patch('/return-reasons/:id', checkPermission('purchases', 'update'), async (req, res, next) => {
  try {
    res.json(await supplierReturnService.updateReason({ tenantId: req.tenant.id, reasonId: req.params.id, ...req.body }))
  } catch (err) { retErr(res, next)(err) }
})

// Lotes devolvibles (para el selector del front)
router.get('/returnable-lots', checkPermission('purchases', 'read'), async (req, res, next) => {
  try {
    const { rawMaterialId, warehouseId, partnerId } = req.query
    res.json(await supplierReturnService.listReturnableLots({
      tenantId: req.tenant.id, rawMaterialId, warehouseId, partnerId,
    }))
  } catch (err) { retErr(res, next)(err) }
})

// Devoluciones
router.get('/returns', checkPermission('purchases', 'read'), async (req, res, next) => {
  try {
    const { status, partnerId, from, to, sortBy, sortDir, page, limit } = req.query
    res.json(await supplierReturnService.listReturns({
      tenantId: req.tenant.id, status, partnerId, from, to, sortBy, sortDir,
      page: page ? parseInt(page, 10) : 1, limit: limit ? parseInt(limit, 10) : 50,
    }))
  } catch (err) { retErr(res, next)(err) }
})
router.get('/returns/:id', checkPermission('purchases', 'read'), async (req, res, next) => {
  try {
    const ret = await supplierReturnService.getReturn({ tenantId: req.tenant.id, returnId: req.params.id })
    if (!ret) return res.status(404).json({ error: 'Devolución no encontrada.' })
    res.json(ret)
  } catch (err) { retErr(res, next)(err) }
})
router.post('/returns', checkPermission('purchases', 'return'), async (req, res, next) => {
  try {
    res.status(201).json(await supplierReturnService.createReturn({
      tenantId: req.tenant.id, ...req.body,
      userId: req.auth.userId, ipAddress: req.ip, userAgent: req.get('user-agent'),
    }))
  } catch (err) { retErr(res, next)(err) }
})
router.post('/returns/:id/confirm', checkPermission('purchases', 'return'), async (req, res, next) => {
  try {
    res.json(await supplierReturnService.confirmReturn({
      tenantId: req.tenant.id, returnId: req.params.id,
      userId: req.auth.userId, ipAddress: req.ip, userAgent: req.get('user-agent'),
    }))
  } catch (err) { retErr(res, next)(err) }
})
router.post('/returns/:id/cancel', checkPermission('purchases', 'return'), async (req, res, next) => {
  try {
    res.json(await supplierReturnService.cancelReturn({
      tenantId: req.tenant.id, returnId: req.params.id,
      userId: req.auth.userId, ipAddress: req.ip, userAgent: req.get('user-agent'),
    }))
  } catch (err) { retErr(res, next)(err) }
})
// Fase 2: resolución fiscal (nota de crédito / cancelación / sustitución del CFDI).
// Body: { resolution, supplierInvoiceId?, creditNote?, substitute?, notes? }
router.post('/returns/:id/resolve', checkPermission('purchases', 'return'), async (req, res, next) => {
  try {
    res.json(await supplierReturnService.resolveFiscal({
      tenantId: req.tenant.id, returnId: req.params.id, ...req.body,
      userId: req.auth.userId, ipAddress: req.ip, userAgent: req.get('user-agent'),
    }))
  } catch (err) {
    if (err.code === '23505' && err.constraint?.includes('uuid_sat')) {
      return res.status(409).json({ error: 'Ya existe una factura/nota de crédito con ese UUID SAT.' })
    }
    retErr(res, next)(err)
  }
})

// ─── Precios por proveedor (precarga rápida de OC) ───────────────────────────

/**
 * GET /api/purchases/suggested-price?supplierId&itemType&itemId&currency
 * Precio sugerido para una línea de OC (manual → aprendido → costo del ítem).
 */
router.get('/suggested-price', checkPermission('purchases', 'read'), async (req, res, next) => {
  try {
    const { supplierId, itemType, itemId, currency } = req.query
    if (!supplierId || !itemType || !itemId) {
      return res.status(400).json({ error: 'supplierId, itemType e itemId son requeridos.' })
    }
    const price = await supplierPriceService.getSuggestedSupplierPrice({
      tenantId: req.tenant.id, supplierId, itemType, itemId, currency: currency || 'MXN',
    })
    res.json(price || { message: 'Sin precio previo — captura manualmente.' })
  } catch (err) { next(err) }
})

/**
 * GET /api/purchases/supplier-prices?supplierId&itemType&itemId
 * Lista de precios vigentes por proveedor (pantalla de gestión).
 */
router.get('/supplier-prices', checkPermission('purchases', 'read'), async (req, res, next) => {
  try {
    const { supplierId, itemType, itemId } = req.query
    const rows = await supplierPriceService.listSupplierPrices({
      tenantId: req.tenant.id, supplierId, itemType, itemId,
    })
    res.json({ data: rows })
  } catch (err) { next(err) }
})

/**
 * POST /api/purchases/supplier-prices
 * Crea/edita un precio NEGOCIADO (manual). Body: { supplierId, itemType, itemId,
 * unitPrice, currency?, supplierSku?, minOrderQty?, leadTimeDays?, notes? }
 */
router.post('/supplier-prices',
  checkAnyPermission([['purchases', 'create'], ['purchases', 'update']]),
  async (req, res, next) => {
    try {
      const row = await supplierPriceService.upsertManualSupplierPrice({
        tenantId: req.tenant.id, ...req.body, userId: req.auth.userId,
      })
      res.status(201).json(row)
    } catch (err) { next(err) }
  }
)

/**
 * DELETE /api/purchases/supplier-prices/:id
 */
router.delete('/supplier-prices/:id',
  checkAnyPermission([['purchases', 'update'], ['purchases', 'create']]),
  async (req, res, next) => {
    try {
      const r = await supplierPriceService.deleteSupplierPrice({
        tenantId: req.tenant.id, id: req.params.id,
      })
      res.json({ message: 'Precio eliminado.', ...r })
    } catch (err) { next(err) }
  }
)

// ─── Órdenes de Compra ────────────────────────────────────────────────────────

/**
 * GET /api/purchases/orders
 * Query: status, partnerId, from, to, page, limit
 */
router.get('/orders', checkPermission('purchases', 'read'), async (req, res, next) => {
  try {
    const { status, order_type, partnerId, search, from, to, sortBy, sortDir, page, limit } = req.query
    const result = await purchaseOrderService.listOrders({
      tenantId: req.tenant.id,
      status, orderType: order_type, partnerId, search, from, to, sortBy, sortDir,
      page:  parseInt(page || 1, 10),
      limit: Math.min(parseInt(limit || 50, 10), 100),
    })
    res.json(result)
  } catch (err) { next(err) }
})

/**
 * GET /api/purchases/orders/:id
 */
router.get('/orders/:id', checkPermission('purchases', 'read'), async (req, res, next) => {
  try {
    const order = await purchaseOrderService.getOrder({
      tenantId: req.tenant.id, orderId: req.params.id,
    })
    if (!order) return res.status(404).json({ error: 'OC no encontrada.' })
    res.json(order)
  } catch (err) { next(err) }
})

/**
 * GET /api/purchases/orders/:id/pdf
 * Descarga el PDF de la orden de compra (documento de control interno).
 */
router.get('/orders/:id/pdf', checkPermission('purchases', 'read'),
  async (req, res, next) => {
    try {
      const buffer = await generatePurchaseOrderPDF({
        tenantId: req.tenant.id, orderId: req.params.id,
      })
      // Buscamos el order_number para nombrar el archivo
      const order = await purchaseOrderService.getOrder({
        tenantId: req.tenant.id, orderId: req.params.id,
      })
      const filename = order?.order_number ? `${order.order_number}.pdf` : `OC-${req.params.id}.pdf`
      res.setHeader('Content-Type', 'application/pdf')
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
      res.send(buffer)
    } catch (err) { next(err) }
  })

/**
 * POST /api/purchases/orders
 * Body: {
 *   partnerId?, isGeneric?, genericSupplier?,
 *   currency?, expectedDate?, notes?,
 *   lines: [{
 *     itemType?, itemId?, description?,
 *     quantity, unit?, unitPrice,
 *     isEstimated?, estimatedQty?, estimatedPrice?,
 *     isGeneric?, genericCategory?,
 *     warehouseId?, notes?
 *   }]
 * }
 */
router.post('/orders', checkPermission('purchases', 'create'), async (req, res, next) => {
  try {
    const { lines } = req.body
    if (!lines || lines.length === 0) {
      return res.status(400).json({ error: 'Se requiere al menos una línea.' })
    }
    const order = await purchaseOrderService.createOrder({
      tenantId: req.tenant.id, ...req.body,
      userId: req.auth.userId, ipAddress: req.ip, userAgent: req.get('user-agent'),
    })
    res.status(201).json(order)
  } catch (err) { next(err) }
})

/**
 * PATCH /api/purchases/orders/:id
 * Edita datos generales — solo en draft.
 * Body: { expectedDate?, notes?, genericSupplier? }
 */
router.patch('/orders/:id', checkPermission('purchases', 'update'), async (req, res, next) => {
  try {
    const order = await purchaseOrderService.updateOrder({
      tenantId: req.tenant.id, orderId: req.params.id,
      ...req.body,
      userId: req.auth.userId, ipAddress: req.ip, userAgent: req.get('user-agent'),
    })
    res.json(order)
  } catch (err) { next(err) }
})

/**
 * POST /api/purchases/orders/:id/confirm
 * Confirma la OC — pasa a estatus 'sent'.
 */
router.post('/orders/:id/confirm', checkPermission('purchases', 'create'), async (req, res, next) => {
  try {
    const order = await purchaseOrderService.confirmOrder({
      tenantId: req.tenant.id, orderId: req.params.id,
      userId: req.auth.userId, ipAddress: req.ip, userAgent: req.get('user-agent'),
    })
    res.json(order)
  } catch (err) { next(err) }
})

/**
 * POST /api/purchases/orders/:id/cancel
 * Body: { reason? }
 */
router.post('/orders/:id/cancel', checkPermission('purchases', 'update'), async (req, res, next) => {
  try {
    const order = await purchaseOrderService.cancelOrder({
      tenantId: req.tenant.id, orderId: req.params.id,
      reason: req.body.reason,
      userId: req.auth.userId, ipAddress: req.ip, userAgent: req.get('user-agent'),
    })
    res.json(order)
  } catch (err) { next(err) }
})

/**
 * POST /api/purchases/orders/:id/close-reception
 * Da por COMPLETA una OC parcialmente recibida (cantidad estimada / granel):
 * pasa a 'closed' aunque lo recibido no cuadre con lo pedido. No mueve
 * inventario. Body: { reason? }. Misma puerta que cancelar (purchases:update).
 */
router.post('/orders/:id/close-reception', checkPermission('purchases', 'update'), async (req, res, next) => {
  try {
    const order = await purchaseOrderService.closeOrderReception({
      tenantId: req.tenant.id, orderId: req.params.id,
      reason: req.body?.reason,
      userId: req.auth.userId, ipAddress: req.ip, userAgent: req.get('user-agent'),
    })
    res.json(order)
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message })
    next(err)
  }
})

/**
 * POST /api/purchases/orders/:id/lines
 * Agrega línea a OC en draft.
 */
router.post('/orders/:id/lines', checkPermission('purchases', 'create'), async (req, res, next) => {
  try {
    const line = await purchaseOrderService.addOrderLine({
      tenantId: req.tenant.id, orderId: req.params.id,
      ...req.body, userId: req.auth.userId,
    })
    res.status(201).json(line)
  } catch (err) { next(err) }
})

/**
 * PATCH /api/purchases/orders/:id/lines/:lineId
 * Edita línea en draft.
 */
router.patch('/orders/:id/lines/:lineId', checkPermission('purchases', 'update'), async (req, res, next) => {
  try {
    const line = await purchaseOrderService.updateOrderLine({
      tenantId: req.tenant.id, orderId: req.params.id,
      lineId: req.params.lineId, ...req.body,
      userId: req.auth.userId,
    })
    res.json(line)
  } catch (err) { next(err) }
})

/**
 * DELETE /api/purchases/orders/:id/lines/:lineId
 */
router.delete('/orders/:id/lines/:lineId', checkPermission('purchases', 'update'), async (req, res, next) => {
  try {
    await purchaseOrderService.deleteOrderLine({
      tenantId: req.tenant.id, orderId: req.params.id,
      lineId: req.params.lineId, userId: req.auth.userId,
    })
    res.json({ message: 'Línea eliminada.' })
  } catch (err) { next(err) }
})

// ─── Parseo de documentos de proveedor ───────────────────────────────────────

/**
 * POST /api/purchases/parse-document
 * Parsea un XML (CFDI) o PDF (factura/remisión/OC) de proveedor.
 * Devuelve los datos extraídos para precargar en la recepción o factura.
 * No guarda nada — solo extrae y devuelve para que el usuario valide.
 * Field: file (multipart)
 */
router.post('/parse-document',
  checkPermission('purchases', 'create'),
  uploadDoc.single('file'),
  async (req, res, next) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'Se requiere un archivo PDF o XML.' })

      const result = await documentParserService.parseSupplierDocument(
        req.file.buffer,
        req.file.mimetype,
        req.file.originalname,
      )
      // Buscar proveedor por RFC del emisor (igual que /invoices/parse-xml) para
      // que el flujo de Nueva factura preseleccione al proveedor — sirve tanto
      // para XML (CFDI) como para PDF (factura escaneada/extraída).
      let matchedPartner = null
      if (result?.emisor?.rfc) {
        const { rows } = await require('../../db').query(
          `SELECT id, name, rfc FROM business_partners
           WHERE tenant_id=$1 AND rfc=$2 AND is_active=true LIMIT 1`,
          [req.tenant.id, result.emisor.rfc]
        )
        if (rows[0]) matchedPartner = rows[0]
      }
      res.json({ ...result, matchedPartner })
    } catch (err) { next(err) }
  }
)

// ─── Recepciones de Mercancía ─────────────────────────────────────────────────

/**
 * GET /api/purchases/receipts
 * Query: status, partnerId, purchaseOrderId, from, to, page, limit
 */
router.get('/receipts', checkPermission('purchases', 'read'), async (req, res, next) => {
  try {
    const { status, partnerId, purchaseOrderId, from, to, invoiceStatus, search, sortBy, sortDir, page, limit } = req.query
    const result = await supplierReceiptService.listReceipts({
      tenantId: req.tenant.id,
      status, partnerId, purchaseOrderId, from, to, invoiceStatus, search, sortBy, sortDir,
      page:  parseInt(page || 1, 10),
      limit: Math.min(parseInt(limit || 50, 10), 100),
    })
    res.json(result)
  } catch (err) { next(err) }
})

/**
 * GET /api/purchases/receipts/pending-invoice
 * Lista recepciones confirmadas sin factura del proveedor.
 * Query: partner_id?
 *
 * IMPORTANTE: debe declararse ANTES de /receipts/:id porque Express
 * captura 'pending-invoice' como :id (que espera UUID) y truena.
 */
router.get('/receipts/pending-invoice', checkPermission('purchases', 'read'), async (req, res, next) => {
  try {
    const { partner_id } = req.query
    const params = [req.tenant.id]
    let partnerFilter = ''
    if (partner_id) { params.push(partner_id); partnerFilter = `AND sr.partner_id = $${params.length}` }
    const { rows } = await require('../../db').query(
      `SELECT sr.id, sr.receipt_number, sr.received_date, sr.status,
              sr.invoiced_at,
              bp.name AS partner_name,
              -- ¿ya tiene una CXP sin factura (remisión)? Al facturar se reemplaza.
              EXISTS (
                SELECT 1 FROM invoice_receipt_links irl
                  JOIN supplier_invoices si ON si.id = irl.supplier_invoice_id
                 WHERE irl.supplier_receipt_id = sr.id
                   AND si.status <> 'cancelled' AND si.type = 'remission'
              ) AS has_remission,
              -- Saldo POR FACTURAR (por MONTO) = subtotal total de la recepción menos lo
              -- ya cubierto por facturas REALES activas (invoice_receipt_links). Cubre
              -- tanto la facturación parcial por líneas (materiales distintos) como la
              -- parcial por monto (varias facturas dividen el mismo material).
              COALESCE((
                SELECT SUM(srl.subtotal) FROM supplier_receipt_lines srl
                 WHERE srl.supplier_receipt_id = sr.id
              ), 0)::numeric
              - COALESCE((
                SELECT SUM(irl.amount_applied) FROM invoice_receipt_links irl
                  JOIN supplier_invoices si ON si.id = irl.supplier_invoice_id
                 WHERE irl.supplier_receipt_id = sr.id
                   AND si.status <> 'cancelled' AND si.type = 'invoice'
              ), 0)::numeric AS total_mxn
       FROM supplier_receipts sr
       LEFT JOIN business_partners bp ON bp.id = sr.partner_id
       WHERE sr.tenant_id = $1
         AND sr.status = 'confirmed'
         -- "Pendiente de facturar" (nivel LÍNEA): aparece si tiene AL MENOS UNA línea
         -- sin factura REAL activa (NULL / cancelada / cubierta por remisión). Así una
         -- recepción parcialmente facturada SIGUE apareciendo por sus líneas pendientes,
         -- y una con remisión-CXP también (para registrar el CFDI y sustituir).
         AND EXISTS (
           SELECT 1 FROM supplier_receipt_lines srl
             LEFT JOIN supplier_invoices ci ON ci.id = srl.invoiced_by_invoice_id
            WHERE srl.supplier_receipt_id = sr.id
              AND (srl.invoiced_by_invoice_id IS NULL OR ci.status = 'cancelled' OR ci.type = 'remission')
         )
         ${partnerFilter}
       ORDER BY sr.received_date DESC
       LIMIT 100`,
      params
    )
    res.json(rows)
  } catch (err) { next(err) }
})

/**
 * GET /api/purchases/receipts/:id
 */
router.get('/receipts/:id', checkPermission('purchases', 'read'), async (req, res, next) => {
  try {
    const receipt = await supplierReceiptService.getReceipt({
      tenantId: req.tenant.id, receiptId: req.params.id,
    })
    if (!receipt) return res.status(404).json({ error: 'Recepción no encontrada.' })
    res.json(receipt)
  } catch (err) { next(err) }
})

/**
 * POST /api/purchases/receipts
 * Body: {
 *   purchaseOrderId?, partnerId?, genericSupplier?,
 *   warehouseId, receivedDate?, notes?,
 *   lines: [{
 *     purchaseOrderLineId?, itemType?, itemId?, description?,
 *     quantityReceived, unit?, unitPrice?,
 *     warehouseId?, isGeneric?, genericCategory?, notes?
 *   }]
 * }
 */
router.post('/receipts', checkPermission('purchases', 'create'), async (req, res, next) => {
  try {
    const { warehouseId, lines } = req.body
    if (!warehouseId) return res.status(400).json({ error: 'warehouseId es requerido.' })
    if (!lines || lines.length === 0) return res.status(400).json({ error: 'Se requiere al menos una línea.' })

    const receipt = await supplierReceiptService.createReceipt({
      tenantId: req.tenant.id, ...req.body,
      userId: req.auth.userId, ipAddress: req.ip, userAgent: req.get('user-agent'),
    })
    res.status(201).json(receipt)
  } catch (err) { next(err) }
})

/**
 * POST /api/purchases/receipts/:id/confirm
 * Confirma la recepción: mueve inventario y actualiza estatus de OC.
 */
router.post('/receipts/:id/confirm', checkPermission('purchases', 'create'), async (req, res, next) => {
  try {
    const receipt = await supplierReceiptService.confirmReceipt({
      tenantId: req.tenant.id, receiptId: req.params.id,
      userId: req.auth.userId, ipAddress: req.ip, userAgent: req.get('user-agent'),
    })
    res.json({ ...receipt, message: 'Recepción confirmada. Inventario actualizado.' })
  } catch (err) { next(err) }
})

/**
 * POST /api/purchases/receipts/:id/remission  (Fase 2)
 * "No se espera factura" → genera una CXP sin factura (documento tipo remisión,
 * NO fiscal, SIN IVA) por el valor de la recepción, vencimiento por
 * supplier_credit_days. Reversible: si luego llega el CFDI, registrar la factura
 * de la recepción anula esta remisión automáticamente.
 */
router.post('/receipts/:id/remission', checkPermission('purchases', 'create'), async (req, res, next) => {
  try {
    const result = await supplierInvoiceService.generateReceiptRemission({
      tenantId: req.tenant.id, receiptId: req.params.id,
      notes: req.body?.notes || null,
      userId: req.auth.userId, ipAddress: req.ip, userAgent: req.get('user-agent'),
    })
    res.status(201).json({ ...result, message: 'CXP sin factura generada. Aparece en Cuentas por pagar.' })
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message })
    next(err)
  }
})

/**
 * PUT /api/purchases/receipts/:id
 * Edita una recepción EN BORRADOR (reemplaza líneas + encabezado editable).
 * Body: { warehouseId, receivedDate?, documentType?, documentNumber?, notes?, lines: [...] }
 */
router.put('/receipts/:id', checkPermission('purchases', 'update'), async (req, res, next) => {
  try {
    const { warehouseId, lines } = req.body
    if (!warehouseId) return res.status(400).json({ error: 'warehouseId es requerido.' })
    if (!lines || lines.length === 0) return res.status(400).json({ error: 'Se requiere al menos una línea.' })

    const receipt = await supplierReceiptService.updateReceipt({
      tenantId: req.tenant.id, receiptId: req.params.id, ...req.body,
      userId: req.auth.userId, ipAddress: req.ip, userAgent: req.get('user-agent'),
    })
    res.json(receipt)
  } catch (err) { next(err) }
})

/**
 * POST /api/purchases/receipts/:id/cancel
 * Body: { reason? }
 */
router.post('/receipts/:id/cancel', checkPermission('purchases', 'update'), async (req, res, next) => {
  try {
    const receipt = await supplierReceiptService.cancelReceipt({
      tenantId: req.tenant.id, receiptId: req.params.id,
      reason: req.body.reason,
      userId: req.auth.userId, ipAddress: req.ip, userAgent: req.get('user-agent'),
    })
    res.json(receipt)
  } catch (err) { next(err) }
})

/**
 * GET /api/purchases/receipts/:id/pdf
 * PDF de la recepción con branding del tenant (logo + colores). Incluye la
 * evidencia/firma de entrega cuando es imagen.
 */
router.get('/receipts/:id/pdf', checkPermission('purchases', 'read'), async (req, res, next) => {
  try {
    const buf = await generateReceiptPDF({ tenantId: req.tenant.id, receiptId: req.params.id })
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `inline; filename="recepcion-${req.params.id}.pdf"`)
    res.send(buf)
  } catch (err) { next(err) }
})

/**
 * POST /api/purchases/receipts/:id/evidence
 * Sube (o reemplaza) la evidencia de una recepción: foto, PDF escaneado o la
 * firma digital de quien entrega (PNG). Form-data: file (PDF/JPG/PNG/WebP).
 */
router.post('/receipts/:id/evidence',
  // Subir evidencia: un rol de apoyo en almacén puede tener solo
  // `purchases:upload_evidence` (sin crear/editar compras). Los roles con
  // `purchases:create` siguen funcionando.
  checkAnyPermission([['purchases', 'create'], ['purchases', 'upload_evidence']]),
  uploadEvidence.single('file'),
  async (req, res, next) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'Se requiere un archivo.' })
      const result = await supplierReceiptService.uploadEvidence({
        tenantId: req.tenant.id, receiptId: req.params.id,
        buffer: req.file.buffer, originalname: req.file.originalname,
        mimetype: req.file.mimetype, userId: req.auth.userId,
      })
      res.status(201).json(result)
    } catch (err) { next(err) }
  }
)

/**
 * GET /api/purchases/receipts/:id/evidence
 * Sirve la evidencia de la recepción. proxy=true: el backend transmite los bytes
 * en vez de redirigir a R2 (cuyo CORS no permite el origen móvil/webview).
 */
router.get('/receipts/:id/evidence',
  checkPermission('purchases', 'read'),
  async (req, res, next) => {
    try {
      const file = await supplierReceiptService.getEvidenceFile({
        tenantId: req.tenant.id, receiptId: req.params.id,
      })
      if (!file) return res.status(404).json({ error: 'Sin evidencia.' })
      await storage.serve(res, file.storagePath, {
        mimeType: file.mimetype, filename: file.filename,
        disposition: 'inline', proxy: true,
      })
    } catch (err) { next(err) }
  }
)

/**
 * DELETE /api/purchases/receipts/:id/evidence
 * Quita la evidencia de la recepción (cuando se subió en el documento equivocado).
 */
router.delete('/receipts/:id/evidence',
  checkAnyPermission([['purchases', 'create'], ['purchases', 'upload_evidence']]),
  async (req, res, next) => {
    try {
      const result = await supplierReceiptService.deleteEvidence({
        tenantId: req.tenant.id, receiptId: req.params.id,
        userId: req.auth.userId, ipAddress: req.ip, userAgent: req.get('user-agent'),
      })
      res.json(result)
    } catch (err) { next(err) }
  }
)

// ─── Facturas y CXP de proveedor ─────────────────────────────────────────────

/**
 * GET /api/purchases/expenses
 * Lista GASTOS (facturas de proveedor con is_expense=true) con su categoría y
 * los dos semáforos (CFDI / pago). Query: categoryId, status, hasCfdi, from, to,
 * search, page, limit.
 */
router.get('/expenses', checkPermission('expenses', 'read'), async (req, res, next) => {
  try {
    const { categoryId, status, hasCfdi, from, to, search, sortBy, sortDir, page, limit } = req.query
    const result = await supplierInvoiceService.listExpenses({
      tenantId: req.tenant.id,
      categoryId, status, hasCfdi, from, to, search, sortBy, sortDir,
      page:  parseInt(page || 1, 10),
      limit: Math.min(parseInt(limit || 50, 10), 100),
    })
    res.json(result)
  } catch (err) { next(err) }
})

/**
 * POST /api/purchases/expenses
 * Registra un GASTO de proveedor (sin recepción). Reusa registerInvoice con
 * is_expense=true. Body: { supplierId|genericSupplier, expenseCategoryId,
 * documentNumber?, uuidSat?, invoiceDate, subtotal, tax, total, creditDays?, notes? }
 */
router.post('/expenses', checkPermission('expenses', 'create'), async (req, res, next) => {
  try {
    const { total, markPaid, paymentMethod, paymentReference, paymentDate, paymentBankAccountId, paymentCreditCardId } = req.body
    if (!total) return res.status(400).json({ error: 'total es requerido.' })
    const expense = await supplierInvoiceService.registerInvoice({
      tenantId: req.tenant.id, ...req.body,
      // Un gasto puede no tener folio fiscal aún (lo registras esperando el CFDI).
      documentNumber: req.body.documentNumber || `GASTO-${Date.now()}`,
      isExpense: true,
      userId: req.auth.userId, ipAddress: req.ip, userAgent: req.get('user-agent'),
    })

    // "Ya lo pagué": liquida el gasto al registrarlo con la misma forma de pago.
    // Requiere proveedor del catálogo (es quien genera el CXP — ap_id). El gasto
    // genérico no tiene CXP, así que ahí no se puede marcar pagado.
    if (markPaid && expense.ap_id) {
      await supplierInvoiceService.registerPayment({
        tenantId: req.tenant.id,
        supplierId: expense.partner_id,
        paymentDate: paymentDate || req.body.invoiceDate || undefined,
        method: paymentMethod || 'transfer',
        reference: paymentReference || null,
        amount: expense.total,
        currency: expense.currency || 'MXN',
        bankAccountId: paymentBankAccountId || null,
        creditCardId: paymentCreditCardId || null,
        applications: [{ apId: expense.ap_id, amountApplied: expense.total_mxn }],
        userId: req.auth.userId, ipAddress: req.ip, userAgent: req.get('user-agent'),
      })
      expense.ap_status = 'paid'
    }

    res.status(201).json(expense)
  } catch (err) {
    if (err.code === '23505') {
      if (err.constraint?.includes('uuid_sat')) {
        return res.status(409).json({ error: 'Ya existe una factura registrada con ese UUID SAT.' })
      }
      return res.status(409).json({ error: 'Documento duplicado.' })
    }
    next(err)
  }
})

/**
 * POST /api/purchases/expenses/parse
 * Parsea un XML (CFDI) o PDF de gasto y precarga los datos para el form (espejo
 * de /parse-document pero gateado por `expenses`). Empareja al proveedor por RFC
 * del emisor. NO guarda nada — el alta es con POST /expenses (anti-dup por UUID).
 */
router.post('/expenses/parse',
  checkPermission('expenses', 'create'),
  uploadDoc.single('file'),
  async (req, res, next) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'Se requiere un archivo XML o PDF.' })
      const result = await documentParserService.parseSupplierDocument(
        req.file.buffer, req.file.mimetype, req.file.originalname)
      let matchedPartner = null
      if (result?.emisor?.rfc) {
        const { rows } = await require('../../db').query(
          `SELECT id, name, rfc FROM business_partners
            WHERE tenant_id = $1 AND rfc = $2 AND is_active = true LIMIT 1`,
          [req.tenant.id, result.emisor.rfc])
        if (rows[0]) matchedPartner = rows[0]
      }
      res.json({ ...result, matchedPartner })
    } catch (err) { next(err) }
  }
)

/**
 * GET /api/purchases/expenses/summary
 * Totales de gasto por categoría (¿en qué se va el dinero?) + total del período
 * + total sin CFDI. Mismos filtros que el listado. Debe ir ANTES de /expenses/:id.
 */
router.get('/expenses/summary', checkPermission('expenses', 'read'), async (req, res, next) => {
  try {
    const { categoryId, hasCfdi, from, to, search } = req.query
    const result = await supplierInvoiceService.listExpensesSummary({
      tenantId: req.tenant.id, categoryId, hasCfdi, from, to, search,
    })
    res.json(result)
  } catch (err) { next(err) }
})

/**
 * GET /api/purchases/expenses/inbox
 * Dirección de correo entrante de facturas del tenant (para darla a proveedores).
 * Debe ir ANTES de /expenses/:id.
 */
router.get('/expenses/inbox', checkPermission('expenses', 'read'), async (req, res, next) => {
  try {
    res.json(await inboundEmailService.getInboxAddress(req.tenant.id))
  } catch (err) { next(err) }
})

/**
 * POST /api/purchases/expenses/inbox/rotate
 * Genera una dirección nueva (invalida la anterior). Acción de configuración →
 * gateada por settings:update (admin/owner), no por expenses.
 */
router.post('/expenses/inbox/rotate', checkPermission('settings', 'update'), async (req, res, next) => {
  try {
    res.json(await inboundEmailService.rotateInboxToken(req.tenant.id))
  } catch (err) { next(err) }
})

/**
 * GET /api/purchases/expenses/:id
 * Detalle de un gasto (con categoría, proveedor y los dos semáforos).
 */
router.get('/expenses/:id', checkPermission('expenses', 'read'), async (req, res, next) => {
  try {
    const expense = await supplierInvoiceService.getExpense({
      tenantId: req.tenant.id, id: req.params.id,
    })
    if (!expense) return res.status(404).json({ error: 'Gasto no encontrado.' })
    res.json(expense)
  } catch (err) { next(err) }
})

/**
 * PATCH /api/purchases/expenses/:id
 * Edita un gasto. Body (todos opcionales): { expenseCategoryId, supplierId,
 * invoiceDate, subtotal, tax, currency, paymentMethod, documentNumber, uuidSat,
 * notes }. Los montos y la MONEDA solo se editan si el gasto NO tiene pago
 * aplicado (cambiar la moneda recalcula total_mxn y la cuenta por pagar).
 */
router.patch('/expenses/:id', checkPermission('expenses', 'create'), async (req, res, next) => {
  try {
    const updated = await supplierInvoiceService.updateExpense({
      tenantId: req.tenant.id, id: req.params.id, ...req.body,
      userId: req.auth.userId, ipAddress: req.ip, userAgent: req.get('user-agent'),
    })
    res.json(updated)
  } catch (err) {
    if (err.code === '23505' && err.constraint?.includes('uuid_sat')) {
      return res.status(409).json({ error: 'Ya existe una factura registrada con ese UUID SAT.' })
    }
    next(err)
  }
})

/**
 * POST /api/purchases/expenses/:id/cancel
 * Cancela un gasto + su CXP (bloqueado si ya tiene pago aplicado). Body: { reason? }.
 */
router.post('/expenses/:id/cancel', checkPermission('expenses', 'create'), async (req, res, next) => {
  try {
    const result = await supplierInvoiceService.cancelExpense({
      tenantId: req.tenant.id, id: req.params.id, reason: req.body?.reason,
      userId: req.auth.userId, ipAddress: req.ip, userAgent: req.get('user-agent'),
    })
    res.json(result)
  } catch (err) { next(err) }
})

/**
 * POST /api/purchases/expenses/:id/pay
 * Liquida un gasto DE CONTADO en un paso: registra el pago por el total pendiente
 * y deja su CXP en "Pagado", sin pasar por Cuentas por pagar. Body opcional:
 * { method?, reference?, paymentDate? }. Gateado por expenses:create — misma
 * puerta que el toggle "Pagado" del alta de gasto (que también registra el pago).
 */
router.post('/expenses/:id/pay', checkPermission('expenses', 'create'), async (req, res, next) => {
  try {
    const { method, reference, paymentDate, bankAccountId, creditCardId } = req.body || {}
    const result = await supplierInvoiceService.payExpense({
      tenantId: req.tenant.id, id: req.params.id,
      method, reference, paymentDate, bankAccountId, creditCardId,
      userId: req.auth.userId, ipAddress: req.ip, userAgent: req.get('user-agent'),
    })
    res.json(result)
  } catch (err) { next(err) }
})

/**
 * POST /api/purchases/expenses/:id/request-invoice
 * Solicita al proveedor (por correo) la factura de un gasto sin CFDI.
 */
router.post('/expenses/:id/request-invoice', checkPermission('expenses', 'create'), async (req, res, next) => {
  try {
    const result = await supplierInvoiceService.requestExpenseInvoice({
      tenantId: req.tenant.id, id: req.params.id,
      userId: req.auth.userId, ipAddress: req.ip, userAgent: req.get('user-agent'),
    })
    res.json(result)
  } catch (err) { next(err) }
})

/**
 * POST /api/purchases/expenses/:id/create-supplier
 * Crea (o reusa) un PROVEEDOR a partir de un gasto genérico (emisor no catalogado)
 * y lo vincula al gasto, generando la CXP que faltaba. Body opcional:
 * { name, rfc, partnerType }. Gateado por business_partners:create (da de alta un socio).
 */
router.post('/expenses/:id/create-supplier',
  checkPermission('business_partners', 'create'), async (req, res, next) => {
    try {
      const { name, rfc, partnerType, isOccasional } = req.body || {}
      const result = await supplierInvoiceService.assignExpenseSupplier({
        tenantId: req.tenant.id, id: req.params.id,
        name, rfc, partnerType, isOccasional,
        userId: req.auth.userId, ipAddress: req.ip, userAgent: req.get('user-agent'),
      })
      res.json(result)
    } catch (err) {
      if (err.code === '23505' && err.constraint === 'si_number_partner_tenant') {
        return res.status(409).json({
          error: 'Ya existe una factura con ese folio para este proveedor. Revisa si el gasto está duplicado.',
        })
      }
      next(err)
    }
  })

/**
 * GET /api/purchases/expenses/:id/receipt-suggestion
 * Sugiere (no liga) la recepción pendiente que cuadra con este gasto de mercancía.
 */
router.get('/expenses/:id/receipt-suggestion', checkPermission('expenses', 'read'), async (req, res, next) => {
  try {
    res.json(await supplierInvoiceService.suggestReceiptForExpense({
      tenantId: req.tenant.id, expenseId: req.params.id,
    }))
  } catch (err) { next(err) }
})

/**
 * POST /api/purchases/expenses/:id/link-receipt
 * Vincula un gasto a una recepción → lo reclasifica como factura de compra ligada
 * (mitad manual de la Fase 5A). Body: { receiptId }.
 */
router.post('/expenses/:id/link-receipt',
  checkAnyPermission([['expenses', 'create'], ['purchases', 'create']]),
  async (req, res, next) => {
    try {
      // Acepta una sola recepción (receiptId/receiptLineIds) o VARIAS (receipts[]).
      const { receiptId, receiptLineIds, receipts } = req.body || {}
      if (!receiptId && !(Array.isArray(receipts) && receipts.length)) {
        return res.status(400).json({ error: 'receiptId o receipts[] es requerido.' })
      }
      const result = await supplierInvoiceService.linkExpenseToReceipt({
        tenantId: req.tenant.id, expenseId: req.params.id, receiptId,
        receiptLineIds: Array.isArray(receiptLineIds) ? receiptLineIds : [],
        receipts: Array.isArray(receipts) ? receipts : null,
        userId: req.auth.userId, ipAddress: req.ip, userAgent: req.get('user-agent'),
      })
      res.json(result)
    } catch (err) { next(err) }
  })

/**
 * GET /api/purchases/expenses/:id/conceptos
 * Conceptos (líneas) del CFDI del gasto, para previsualizar. Parsea el XML guardado.
 */
router.get('/expenses/:id/conceptos', checkPermission('expenses', 'read'), async (req, res, next) => {
  try {
    const result = await supplierInvoiceService.getExpenseConceptos({
      tenantId: req.tenant.id, id: req.params.id,
    })
    res.json(result)
  } catch (err) { next(err) }
})

/**
 * POST /api/purchases/expenses/:id/reread-xml
 * Re-lee el XML guardado del gasto y recupera el emisor (razón social + RFC) que la
 * ingesta por PDF pudo perder ("Proveedor (correo)"); si sigue genérico, refresca
 * los totales. Edita el gasto → gateado por expenses:create (como PATCH /expenses/:id).
 */
router.post('/expenses/:id/reread-xml', checkPermission('expenses', 'create'), async (req, res, next) => {
  try {
    const result = await supplierInvoiceService.reReadExpenseFromXml({
      tenantId: req.tenant.id, id: req.params.id,
      userId: req.auth.userId, ipAddress: req.ip, userAgent: req.get('user-agent'),
    })
    res.json(result)
  } catch (err) { next(err) }
})

/**
 * POST /api/purchases/expenses/:id/unlink-receipt
 * Desvincula una factura de compra de su(s) recepción(es) y la revierte a gasto
 * (inverso de link-receipt). Útil cuando se vinculó a la recepción equivocada.
 */
router.post('/expenses/:id/unlink-receipt',
  checkAnyPermission([['expenses', 'create'], ['purchases', 'create']]),
  async (req, res, next) => {
    try {
      const result = await supplierInvoiceService.unlinkInvoiceFromReceipt({
        tenantId: req.tenant.id, expenseId: req.params.id,
        userId: req.auth.userId, ipAddress: req.ip, userAgent: req.get('user-agent'),
      })
      res.json(result)
    } catch (err) { next(err) }
  })

// ─── Respaldo del CFDI de un gasto (XML/PDF descargable) ─────────────────────
// Un gasto ES un supplier_invoice (is_expense=true), así que el respaldo se
// guarda como attachment de entity_type='supplier_invoice', categoría 'cfdi'.
// Gateado por `expenses` (no por `attachments`) para mantener el módulo de
// Gastos autocontenido en permisos. El buzón de correo guarda estos archivos
// solo; aquí van el listado/descarga + la subida manual desde el detalle.

/**
 * GET /api/purchases/expenses/:id/attachments
 * Lista los respaldos (XML/PDF) del gasto.
 */
router.get('/expenses/:id/attachments', checkPermission('expenses', 'read'), async (req, res, next) => {
  try {
    const files = await attachmentService.listAttachments({
      tenantId: req.tenant.id, entityType: 'supplier_invoice', entityId: req.params.id,
      category: 'cfdi',
    })
    res.json(files)
  } catch (err) { next(err) }
})

/**
 * POST /api/purchases/expenses/:id/attachments
 * Sube un respaldo XML/PDF al gasto (form-data: file). Acepta XML (uploadDoc).
 */
router.post('/expenses/:id/attachments',
  checkPermission('expenses', 'create'),
  uploadDoc.single('file'),
  async (req, res, next) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'Se requiere un archivo XML o PDF.' })
      // El gasto debe existir y ser del tenant (getExpense filtra is_expense=true).
      const exp = await supplierInvoiceService.getExpense({ tenantId: req.tenant.id, id: req.params.id })
      if (!exp) return res.status(404).json({ error: 'Gasto no encontrado.' })

      const attachment = await attachmentService.saveAttachment({
        tenantId: req.tenant.id,
        entityType: 'supplier_invoice', entityId: req.params.id,
        category: 'cfdi',
        originalFilename: req.file.originalname,
        buffer: req.file.buffer, mimeType: req.file.mimetype,
        uploadedBy: req.auth.userId,
      })
      res.status(201).json(attachment)
    } catch (err) { next(err) }
  }
)

/**
 * GET /api/purchases/expenses/:id/attachments/:attachmentId/download
 */
router.get('/expenses/:id/attachments/:attachmentId/download',
  checkPermission('expenses', 'read'),
  async (req, res, next) => {
    try {
      const file = await attachmentService.getAttachmentInfo({
        tenantId: req.tenant.id, attachmentId: req.params.attachmentId,
      })
      if (!file) return res.status(404).json({ error: 'Archivo no encontrado.' })
      // proxy:true → el backend transmite los bytes en vez de redirigir a R2
      // (mismo patrón que la evidencia: el CORS de R2 no permite el webview móvil).
      await storage.serve(res, file.storage_path, {
        filename:    file.filename,
        mimeType:    file.mime_type,
        disposition: 'inline',
        proxy:       true,
      })
    } catch (err) { next(err) }
  }
)

/**
 * GET /api/purchases/invoices
 * Query: type, status, supplierId, from, to, page, limit
 */
router.get('/invoices', checkPermission('purchases', 'read'), async (req, res, next) => {
  try {
    const { type, status, supplierId, from, to, sortBy, sortDir, page, limit } = req.query
    const result = await supplierInvoiceService.listInvoices({
      tenantId: req.tenant.id,
      type, status, supplierId, from, to, sortBy, sortDir,
      page:  parseInt(page || 1, 10),
      limit: Math.min(parseInt(limit || 50, 10), 100),
    })
    res.json(result)
  } catch (err) { next(err) }
})

/**
 * GET /api/purchases/invoices/:id
 */
router.get('/invoices/:id', checkPermission('purchases', 'read'), async (req, res, next) => {
  try {
    const invoice = await supplierInvoiceService.getInvoice({
      tenantId: req.tenant.id, invoiceId: req.params.id,
    })
    if (!invoice) return res.status(404).json({ error: 'Factura no encontrada.' })
    res.json(invoice)
  } catch (err) { next(err) }
})

/**
 * Parsea un XML CFDI 4.0 y devuelve los datos extraídos + proveedor encontrado.
 */
router.post('/invoices/parse-xml',
  checkPermission('purchases', 'create'),
  uploadDoc.single('xml'),
  async (req, res, next) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'Se requiere un archivo XML.' })
      const parsed = await documentParserService.parseSupplierDocument(
        req.file.buffer, req.file.mimetype, req.file.originalname
      )
      // Buscar proveedor por RFC en Socios de Negocio
      let partner = null
      if (parsed.emisor?.rfc) {
        const { rows } = await require('../../db').query(
          `SELECT id, name, rfc FROM business_partners
           WHERE tenant_id=$1 AND rfc=$2 AND is_active=true LIMIT 1`,
          [req.tenant.id, parsed.emisor.rfc]
        )
        if (rows[0]) partner = rows[0]
      }
      res.json({ ...parsed, matchedPartner: partner })
    } catch (err) { next(err) }
  }
)

/**
 * POST /api/purchases/invoices
 * Registra una factura o remisión de proveedor y genera CXP.
 * Body: {
 *   supplierId?, genericSupplier?,
 *   documentType: 'invoice' | 'remission',
 *   documentNumber, uuidSat?, serie?, folio?, rfcEmisor?,
 *   invoiceDate, currency?, subtotal, tax, total,
 *   receiptIds?: string[],     // múltiples recepciones (factura toda la recepción)
 *   receiptLineIds?: string[], // facturación PARCIAL: solo estas líneas (mig 202)
 *   supplierReceiptId?,        // compatibilidad hacia atrás
 *   purchaseOrderId?,
 *   xmlContent?,
 *   creditDays?, notes?
 * }
 */
router.post('/invoices', checkPermission('purchases', 'create'), async (req, res, next) => {
  try {
    const { documentNumber, total } = req.body
    if (!documentNumber) return res.status(400).json({ error: 'documentNumber es requerido.' })
    if (!total) return res.status(400).json({ error: 'total es requerido.' })

    const invoice = await supplierInvoiceService.registerInvoice({
      tenantId: req.tenant.id, ...req.body,
      userId: req.auth.userId, ipAddress: req.ip, userAgent: req.get('user-agent'),
    })
    res.status(201).json(invoice)
  } catch (err) {
    // Duplicado por (tenant_id, partner_id, invoice_number) o UUID SAT
    if (err.code === '23505') {
      if (err.constraint?.includes('uuid_sat')) {
        return res.status(409).json({ error: 'Ya existe una factura registrada con ese UUID SAT.' })
      }
      if (err.constraint?.includes('si_number')) {
        return res.status(409).json({
          error: `Ya existe un documento con folio "${req.body.documentNumber}" para este proveedor. Verifica el número.`,
        })
      }
      return res.status(409).json({ error: 'Documento duplicado.' })
    }
    next(err)
  }
})

/**
 * POST /api/purchases/payments
 * Registra un pago a proveedor y lo aplica a facturas.
 * Body: {
 *   supplierId?, genericSupplier?,
 *   paymentDate?, method, reference?,
 *   amount, currency?,
 *   applications: [{ apId, amountApplied }],
 *   notes?
 * }
 */
router.post('/payments', checkPermission('purchases', 'create'), async (req, res, next) => {
  try {
    const { amount, method } = req.body
    if (!amount) return res.status(400).json({ error: 'amount es requerido.' })
    if (!method) return res.status(400).json({ error: 'method es requerido.' })

    const payment = await supplierInvoiceService.registerPayment({
      tenantId: req.tenant.id, ...req.body,
      userId: req.auth.userId, ipAddress: req.ip, userAgent: req.get('user-agent'),
    })
    res.status(201).json(payment)
  } catch (err) { next(err) }
})

/**
 * POST /api/purchases/payments/:id/reverse
 * Reversa un pago a proveedor: revierte el saldo de la CXP de las facturas que
 * liquidó. Body: { reason }
 */
router.post('/payments/:id/reverse', checkPermission('purchases', 'reverse_payment'), async (req, res, next) => {
  try {
    const result = await supplierInvoiceService.reverseSupplierPayment({
      tenantId: req.tenant.id, paymentId: req.params.id,
      reason: req.body?.reason,
      userId: req.auth.userId, ipAddress: req.ip, userAgent: req.get('user-agent'),
    })
    res.json(result)
  } catch (err) { next(err) }
})

/**
 * GET /api/purchases/suppliers/:id/statement
 * Estado de cuenta de un proveedor.
 * Query: from?, to?
 */
router.get('/suppliers/:id/statement', checkPermission('purchases', 'read'), async (req, res, next) => {
  try {
    const { from, to } = req.query
    const statement = await supplierInvoiceService.getSupplierStatement({
      tenantId: req.tenant.id, supplierId: req.params.id, from, to,
    })
    res.json(statement)
  } catch (err) { next(err) }
})

// ─── Complementos de pago RECIBIDOS (REP, CFDI tipo P — mig 235) ─────────────
// Reusa permisos purchases:* (SIN permiso nuevo → sin re-login).

/**
 * GET /api/purchases/complements
 * Query: status (matched|review), partnerId, search, page, limit
 */
router.get('/complements', checkPermission('purchases', 'read'), async (req, res, next) => {
  try {
    const { status, partnerId, search, page, limit } = req.query
    res.json(await supplierComplementService.listComplements({
      tenantId: req.tenant.id, status, partnerId, search,
      page:  parseInt(page || 1, 10),
      limit: Math.min(parseInt(limit || 20, 10), 100),
    }))
  } catch (err) { retErr(res, next)(err) }
})

/**
 * GET /api/purchases/complements/compliance
 * Tablero: facturas PPD con pago aplicado cuya cobertura de REP no alcanza.
 */
router.get('/complements/compliance', checkPermission('purchases', 'read'), async (req, res, next) => {
  try {
    res.json(await supplierComplementService.listCompliance({ tenantId: req.tenant.id }))
  } catch (err) { retErr(res, next)(err) }
})

/**
 * POST /api/purchases/complements/upload
 * Sube el XML de un REP a mano (multipart 'file'). Mismo procesamiento que el
 * correo: parseo, candado de tipo P, anti-dup por UUID, auto-ligado.
 */
router.post('/complements/upload',
  checkPermission('purchases', 'create'),
  uploadDoc.single('file'),
  async (req, res, next) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'Archivo requerido (XML del complemento).' })
      const parsed = await documentParserService.parseSupplierDocument(
        req.file.buffer, req.file.mimetype, req.file.originalname)
      if (parsed?.tipoComprobante !== 'P') {
        return res.status(400).json({
          error: 'Ese XML no es un complemento de pago (tipo P). Si es una factura, regístrala en Gastos o Facturas de compra.' })
      }
      const result = await supplierComplementService.ingestComplement({
        tenantId: req.tenant.id, parsed, source: 'manual',
        userId: req.auth.userId, ipAddress: req.ip, userAgent: req.get('user-agent'),
      })
      // Respaldo del XML pegado al complemento (best-effort).
      if (result.complementId && result.status === 'created') {
        try {
          await attachmentService.saveAttachment({
            tenantId: req.tenant.id,
            entityType: 'supplier_payment_complement', entityId: result.complementId,
            category: 'cfdi',
            originalFilename: req.file.originalname || 'rep.xml',
            buffer: req.file.buffer,
            mimeType: req.file.mimetype.includes('xml') ? req.file.mimetype : 'application/xml',
            uploadedBy: req.auth.userId,
          })
        } catch { /* respaldo faltante no es fatal */ }
      }
      res.status(result.status === 'created' ? 201 : 200).json(result)
    } catch (err) { retErr(res, next)(err) }
  }
)

/**
 * GET /api/purchases/complements/:id
 */
router.get('/complements/:id', checkPermission('purchases', 'read'), async (req, res, next) => {
  try {
    res.json(await supplierComplementService.getComplement({
      tenantId: req.tenant.id, complementId: req.params.id }))
  } catch (err) { retErr(res, next)(err) }
})

/**
 * POST /api/purchases/complements/:id/rematch
 * Reintenta el cruce (facturas registradas después del REP + pago).
 */
router.post('/complements/:id/rematch', checkPermission('purchases', 'update'), async (req, res, next) => {
  try {
    res.json(await supplierComplementService.rematchComplement({
      tenantId: req.tenant.id, complementId: req.params.id,
      userId: req.auth.userId, ipAddress: req.ip, userAgent: req.get('user-agent'),
    }))
  } catch (err) { retErr(res, next)(err) }
})

/**
 * POST /api/purchases/complements/:id/link-payment   Body: { paymentId }
 */
router.post('/complements/:id/link-payment', checkPermission('purchases', 'update'), async (req, res, next) => {
  try {
    if (!req.body?.paymentId) return res.status(400).json({ error: 'paymentId es requerido.' })
    res.json(await supplierComplementService.linkPayment({
      tenantId: req.tenant.id, complementId: req.params.id, paymentId: req.body.paymentId,
      userId: req.auth.userId, ipAddress: req.ip, userAgent: req.get('user-agent'),
    }))
  } catch (err) { retErr(res, next)(err) }
})

/**
 * POST /api/purchases/complements/:id/unlink-payment
 */
router.post('/complements/:id/unlink-payment', checkPermission('purchases', 'update'), async (req, res, next) => {
  try {
    res.json(await supplierComplementService.unlinkPayment({
      tenantId: req.tenant.id, complementId: req.params.id,
      userId: req.auth.userId, ipAddress: req.ip, userAgent: req.get('user-agent'),
    }))
  } catch (err) { retErr(res, next)(err) }
})

/**
 * DELETE /api/purchases/complements/:id
 * Elimina el REP (no mueve dinero; el anti-dup permite re-subirlo).
 */
router.delete('/complements/:id', checkPermission('purchases', 'update'), async (req, res, next) => {
  try {
    res.json(await supplierComplementService.removeComplement({
      tenantId: req.tenant.id, complementId: req.params.id,
      userId: req.auth.userId, ipAddress: req.ip, userAgent: req.get('user-agent'),
    }))
  } catch (err) { retErr(res, next)(err) }
})

/**
 * GET /api/purchases/complements/:id/attachments/:attachmentId/download
 * Descarga el XML/PDF de respaldo. proxy:true — gotcha R2 (todo endpoint que
 * sirve archivo al navegador DEBE proxear; el redirect a R2 muere por CORS).
 */
router.get('/complements/:id/attachments/:attachmentId/download',
  checkPermission('purchases', 'read'),
  async (req, res, next) => {
    try {
      const file = await attachmentService.getAttachmentInfo({
        tenantId: req.tenant.id, attachmentId: req.params.attachmentId,
      })
      if (!file) return res.status(404).json({ error: 'Archivo no encontrado.' })
      await storage.serve(res, file.storage_path, {
        filename:    file.filename,
        mimeType:    file.mime_type,
        disposition: 'inline',
        proxy:       true,
      })
    } catch (err) { next(err) }
  }
)

// ─── CXP — Cuentas por pagar (vista centrada en accounts_payable) ────────────

/**
 * GET /api/purchases/cxp
 * Query: status, partnerId, from, to, page, limit
 */
router.get('/cxp', checkPermission('purchases', 'read'), async (req, res, next) => {
  try {
    const { status, partnerId, from, to, sortBy, sortDir, page, limit } = req.query
    const result = await cxpService.listCXP({
      tenantId: req.tenant.id,
      status, partnerId, from, to, sortBy, sortDir,
      page:  parseInt(page || 1, 10),
      limit: Math.min(parseInt(limit || 50, 10), 100),
    })
    res.json(result)
  } catch (err) { next(err) }
})

/**
 * GET /api/purchases/payments — Historial de PAGOS EMITIDOS (a proveedor).
 */
router.get('/payments', checkPermission('purchases', 'read'), async (req, res, next) => {
  try {
    const { partnerId, from, to, method, sortBy, sortDir, page, limit } = req.query
    const result = await cxpService.listPayments({
      tenantId: req.tenant.id,
      partnerId, from, to, method, sortBy, sortDir,
      page:  parseInt(page || 1, 10),
      limit: Math.min(parseInt(limit || 50, 10), 100),
    })
    res.json(result)
  } catch (err) { next(err) }
})

/**
 * GET /api/purchases/payments/:id — Detalle de UN pago emitido.
 */
router.get('/payments/:id', checkPermission('purchases', 'read'), async (req, res, next) => {
  try {
    const result = await cxpService.getPayment({ tenantId: req.tenant.id, paymentId: req.params.id })
    res.json(result)
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message })
    next(err)
  }
})

/**
 * GET /api/purchases/cxp/:id
 */
router.get('/cxp/:id', checkPermission('purchases', 'read'), async (req, res, next) => {
  try {
    const ap = await cxpService.getCXP({ tenantId: req.tenant.id, apId: req.params.id })
    if (!ap) return res.status(404).json({ error: 'CXP no encontrado.' })
    res.json(ap)
  } catch (err) { next(err) }
})

// ─── Anticipos a proveedor (ap_advances) ─────────────────────────────────────

/**
 * GET /api/purchases/advances
 * Query: partnerId?, onlyAvailable=1
 */
router.get('/advances', checkPermission('purchases', 'read'), async (req, res, next) => {
  try {
    const advances = await apAdvanceService.listAdvances({
      tenantId: req.tenant.id,
      partnerId: req.query.partnerId,
      onlyAvailable: req.query.onlyAvailable === '1' || req.query.onlyAvailable === 'true',
    })
    res.json(advances)
  } catch (err) { next(err) }
})

/**
 * POST /api/purchases/advances
 * Registra un anticipo "manual" (no derivado de un pago a factura).
 * Body: { partnerId, amount, currency?, paymentMethod, reference?,
 *         bankAccountId?, paymentDate?, notes? }
 */
router.post('/advances', checkPermission('purchases', 'create'), async (req, res, next) => {
  try {
    const advance = await apAdvanceService.registerAdvance({
      tenantId: req.tenant.id, ...req.body,
      userId: req.auth.userId, ipAddress: req.ip, userAgent: req.get('user-agent'),
    })
    res.status(201).json(advance)
  } catch (err) { next(err) }
})

/**
 * POST /api/purchases/advances/:id/apply
 * Body: { apId, amount }
 */
router.post('/advances/:id/apply', checkPermission('purchases', 'create'), async (req, res, next) => {
  try {
    const result = await apAdvanceService.applyAdvance({
      tenantId: req.tenant.id, advanceId: req.params.id,
      apId: req.body.apId, amount: req.body.amount,
      userId: req.auth.userId, ipAddress: req.ip, userAgent: req.get('user-agent'),
    })
    res.json(result)
  } catch (err) { next(err) }
})

// ─── Evidencias de facturas de proveedor (attachments) ───────────────────────
// Se vinculan a `supplier_invoices` (entityType='supplier_invoice'). Para
// localizar desde CXP, primero se resuelve el supplier_invoice_id desde el AP.

async function resolveSupplierInvoiceId({ tenantId, apIdOrInvoiceId }) {
  const { rows } = await require('../../db').query(
    `SELECT si.id
       FROM supplier_invoices si
      WHERE si.tenant_id = $1 AND si.id = $2
      UNION
     SELECT ap.document_id
       FROM accounts_payable ap
      WHERE ap.tenant_id = $1 AND ap.id = $2
        AND ap.document_id IS NOT NULL
      LIMIT 1`,
    [tenantId, apIdOrInvoiceId]
  )
  return rows[0]?.id || null
}

/**
 * GET /api/purchases/invoices/:id/attachments
 * `:id` acepta supplier_invoice_id O accounts_payable.id (resuelve automático).
 */
router.get('/invoices/:id/attachments',
  checkPermission('attachments', 'read'),
  async (req, res, next) => {
    try {
      const siId = await resolveSupplierInvoiceId({
        tenantId: req.tenant.id, apIdOrInvoiceId: req.params.id,
      })
      if (!siId) return res.json([])
      const files = await attachmentService.listAttachments({
        tenantId: req.tenant.id, entityType: 'supplier_invoice', entityId: siId,
      })
      res.json(files)
    } catch (err) { next(err) }
  }
)

/**
 * POST /api/purchases/invoices/:id/attachments
 * Form-data: file (PDF/JPG/PNG/WebP), description? (string)
 */
router.post('/invoices/:id/attachments',
  checkPermission('attachments', 'create'),
  uploadEvidence.single('file'),
  async (req, res, next) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'Se requiere un archivo.' })
      const siId = await resolveSupplierInvoiceId({
        tenantId: req.tenant.id, apIdOrInvoiceId: req.params.id,
      })
      if (!siId) return res.status(404).json({ error: 'Factura no encontrada.' })

      const attachment = await attachmentService.saveAttachment({
        tenantId: req.tenant.id,
        entityType: 'supplier_invoice', entityId: siId,
        category: 'other',
        originalFilename: req.file.originalname,
        buffer: req.file.buffer, mimeType: req.file.mimetype,
        description: req.body.description || null,
        uploadedBy: req.auth.userId,
      })
      res.status(201).json(attachment)
    } catch (err) { next(err) }
  }
)

/**
 * GET /api/purchases/invoices/:id/attachments/:attachmentId/download
 */
router.get('/invoices/:id/attachments/:attachmentId/download',
  checkPermission('attachments', 'read'),
  async (req, res, next) => {
    try {
      const file = await attachmentService.getAttachmentInfo({
        tenantId: req.tenant.id, attachmentId: req.params.attachmentId,
      })
      if (!file) return res.status(404).json({ error: 'Archivo no encontrado.' })
      // proxy:true → el backend transmite los bytes en vez de redirigir a R2 (cuyo
      // CORS no permite el origen del webview móvil → "Network Error" al abrir la
      // evidencia desde Pagos emitidos / CXP). Mismo patrón que la evidencia de recepción.
      await storage.serve(res, file.storage_path, {
        filename:    file.filename,
        mimeType:    file.mime_type,
        disposition: 'inline',
        proxy:       true,
      })
    } catch (err) { next(err) }
  }
)

/**
 * DELETE /api/purchases/invoices/:id/attachments/:attachmentId
 */
router.delete('/invoices/:id/attachments/:attachmentId',
  checkPermission('attachments', 'delete'),
  async (req, res, next) => {
    try {
      const result = await attachmentService.deleteAttachment({
        tenantId: req.tenant.id, attachmentId: req.params.attachmentId,
      })
      if (!result) return res.status(404).json({ error: 'Archivo no encontrado.' })
      res.json(result)
    } catch (err) { next(err) }
  }
)

module.exports = router
