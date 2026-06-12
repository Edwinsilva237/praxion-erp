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
              -- Saldo POR FACTURAR = subtotal de las líneas aún sin factura real activa
              -- (NULL, cancelada, o cubierta por remisión = reemplazable). Con facturación
              -- parcial esto es menor al total de la recepción.
              COALESCE((
                SELECT SUM(srl.subtotal) FROM supplier_receipt_lines srl
                  LEFT JOIN supplier_invoices ci ON ci.id = srl.invoiced_by_invoice_id
                 WHERE srl.supplier_receipt_id = sr.id
                   AND (srl.invoiced_by_invoice_id IS NULL OR ci.status = 'cancelled' OR ci.type = 'remission')
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
    const { total, markPaid, paymentMethod, paymentReference, paymentDate } = req.body
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
