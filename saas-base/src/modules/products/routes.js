'use strict'

const express = require('express')
const multer  = require('multer')
const { tenantResolver }   = require('../../middleware/tenantResolver')
const { authGuard }        = require('../../middleware/authGuard')
const { requireActiveTenant } = require('../../middleware/requireActiveTenant')
const { checkPermission }  = require('../../middleware/checkPermission')
const productService       = require('./productService')
const attachmentService    = require('../attachments/attachmentService')
const storage              = require('../../utils/storage')
const config               = require('../../config')

const router = express.Router()

// El filtro global acepta PDF (fichas técnicas) e imágenes (fotos de
// producto). La validación FINA por categoría la hace attachmentService.
const ALLOWED = new Set([
  'application/pdf', 'image/jpeg', 'image/png', 'image/webp',
])
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.uploads.maxSizeMb * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED.has(file.mimetype)) cb(null, true)
    else cb(new Error('Tipo no permitido. Solo PDF o imágenes (JPG/PNG/WebP).'))
  },
})

router.use(tenantResolver)
router.use(authGuard)
router.use(requireActiveTenant)

/** GET /api/products */
router.get('/', checkPermission('products', 'read'), async (req, res, next) => {
  try {
    const { type, resinType, isActive, isProduced, search, page, limit } = req.query
    const result = await productService.listProducts({
      tenantId: req.tenant.id,
      type,
      resinType,
      isActive:   isActive   !== undefined ? isActive   === 'true' : undefined,
      isProduced: isProduced !== undefined ? isProduced === 'true' : undefined,
      search,
      page:  parseInt(page  || 1,  10),
      limit: Math.min(parseInt(limit || 50, 10), 100),
    })
    res.json(result)
  } catch (err) { next(err) }
})

/** GET /api/products/:id */
router.get('/:id', checkPermission('products', 'read'), async (req, res, next) => {
  try {
    const product = await productService.getProduct({
      tenantId: req.tenant.id, productId: req.params.id,
    })
    if (!product) return res.status(404).json({ error: 'Producto no encontrado.' })
    res.json(product)
  } catch (err) { next(err) }
})

/** POST /api/products */
router.post('/', checkPermission('products', 'create'), async (req, res, next) => {
  try {
    const {
      sku, name, type, isProduced, is_produced,
      productKindId, product_kind_id,
      resinType,
      lengthMm, widthMm, thicknessMm,
      unitsPerPackage, saleUnit, description,
      satProductCode, satUnitCode, objetoImp, taxFactor, taxRate, leadTimeDays,
      basePrice, baseCurrency,
    } = req.body

    // type queda como dato legacy. Aceptamos isProduced como nuevo discriminador;
    // si solo viene type, se deriva. Si no viene ninguno → error.
    const resolvedIsProduced = (isProduced ?? is_produced)
    if (!sku || !name || (resolvedIsProduced === undefined && !type)) {
      return res.status(400).json({ error: 'sku, name e isProduced (o type legacy) son requeridos.' })
    }

    const product = await productService.createProduct({
      tenantId: req.tenant.id,
      sku, name, type, isProduced: resolvedIsProduced,
      productKindId: productKindId ?? product_kind_id,
      resinType,
      lengthMm, widthMm, thicknessMm,
      unitsPerPackage, saleUnit, description,
      satProductCode, satUnitCode, objetoImp, taxFactor, taxRate, leadTimeDays,
      basePrice, baseCurrency,
      userId:    req.auth.userId,
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    })

    res.status(201).json(product)
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'El SKU ya existe.' })
    if (err.code === '23514') return res.status(400).json({ error: 'Datos inválidos — verifica tipo y campos requeridos.' })
    next(err)
  }
})

/** PATCH /api/products/:id */
router.patch('/:id', checkPermission('products', 'update'), async (req, res, next) => {
  try {
    const {
      name, description, saleUnit, isActive,
      satProductCode, satUnitCode, objetoImp, taxFactor, taxRate, leadTimeDays,
      basePrice, baseCurrency,
      expectedSalePrice, expected_sale_price,
      productKindId,     product_kind_id,
      defaultQualityGradeId, default_quality_grade_id,
      isProduced,        is_produced,
    } = req.body

    const product = await productService.updateProduct({
      tenantId:  req.tenant.id,
      productId: req.params.id,
      name, description, saleUnit, isActive,
      satProductCode, satUnitCode, objetoImp, taxFactor, taxRate, leadTimeDays,
      basePrice, baseCurrency,
      expectedSalePrice:      expectedSalePrice      ?? expected_sale_price,
      productKindId:          productKindId          ?? product_kind_id,
      defaultQualityGradeId:  defaultQualityGradeId  ?? default_quality_grade_id,
      isProduced:             isProduced             ?? is_produced,
      userId:    req.auth.userId,
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    })
    if (!product) return res.status(404).json({ error: 'Producto no encontrado.' })
    res.json(product)
  } catch (err) { next(err) }
})

// ─── Presentaciones (pack options) ──────────────────────────────────────────

router.get('/:id/pack-options', checkPermission('products', 'read'), async (req, res, next) => {
  try {
    const rows = await productService.listPackOptions({
      tenantId: req.tenant.id, productId: req.params.id,
    })
    res.json(rows)
  } catch (err) { next(err) }
})

router.post('/:id/pack-options', checkPermission('products', 'update'), async (req, res, next) => {
  try {
    const { packUnit, basePerPack, satUnitCode, isDefault, notes } = req.body
    if (!packUnit || basePerPack == null) {
      return res.status(400).json({ error: 'packUnit y basePerPack son requeridos.' })
    }
    const row = await productService.createPackOption({
      tenantId: req.tenant.id, productId: req.params.id,
      packUnit, basePerPack, satUnitCode, isDefault, notes,
      userId: req.auth.userId, ipAddress: req.ip, userAgent: req.get('user-agent'),
    })
    res.status(201).json(row)
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Ya existe una presentación con esa unidad para este producto.' })
    next(err)
  }
})

router.patch('/:id/pack-options/:packOptionId', checkPermission('products', 'update'), async (req, res, next) => {
  try {
    const row = await productService.updatePackOption({
      tenantId: req.tenant.id, packOptionId: req.params.packOptionId,
      ...req.body,
      userId: req.auth.userId, ipAddress: req.ip, userAgent: req.get('user-agent'),
    })
    res.json(row)
  } catch (err) { next(err) }
})

router.delete('/:id/pack-options/:packOptionId', checkPermission('products', 'update'), async (req, res, next) => {
  try {
    const ok = await productService.deletePackOption({
      tenantId: req.tenant.id, packOptionId: req.params.packOptionId,
      userId: req.auth.userId, ipAddress: req.ip, userAgent: req.get('user-agent'),
    })
    if (!ok) return res.status(404).json({ error: 'Presentación no encontrada.' })
    res.json({ message: 'Presentación eliminada.' })
  } catch (err) { next(err) }
})

/** GET /api/products/:id/quality-specs */
router.get('/:id/quality-specs', checkPermission('products', 'read'), async (req, res, next) => {
  try {
    const specs = await productService.getQualitySpecHistory({
      tenantId: req.tenant.id, productId: req.params.id,
    })
    if (!specs) return res.status(404).json({ error: 'Producto no encontrado.' })
    res.json(specs)
  } catch (err) { next(err) }
})

/** POST /api/products/:id/quality-specs */
router.post('/:id/quality-specs', checkPermission('products', 'update'), async (req, res, next) => {
  try {
    const { gramsPerLinearMeter, tolerancePct, unitsPerPackage, notes } = req.body
    // SaaS v2 §144: tolerancePct es el único campo obligatorio. gramsPerLinearMeter
    // solo aplica a productos lineales (esquineros, tubos) — para frituras / pastel
    // / cualquier producto puntual viene null y se persiste como NULL.
    if (!tolerancePct || parseFloat(tolerancePct) <= 0) {
      return res.status(400).json({ error: 'tolerancePct es requerido y debe ser > 0.' })
    }
    if (gramsPerLinearMeter != null && gramsPerLinearMeter !== '' && parseFloat(gramsPerLinearMeter) <= 0) {
      return res.status(400).json({ error: 'gramsPerLinearMeter, si se proporciona, debe ser > 0.' })
    }
    const spec = await productService.addQualitySpec({
      tenantId: req.tenant.id, productId: req.params.id,
      gramsPerLinearMeter: gramsPerLinearMeter || null,
      tolerancePct, unitsPerPackage, notes,
      userId:    req.auth.userId,
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    })
    res.status(201).json(spec)
  } catch (err) { next(err) }
})

/** GET /api/products/:id/attachments */
router.get('/:id/attachments', checkPermission('attachments', 'read'), async (req, res, next) => {
  try {
    const { category } = req.query
    const files = await attachmentService.listAttachments({
      tenantId: req.tenant.id, entityType: 'product',
      entityId: req.params.id, category,
    })
    res.json(files)
  } catch (err) { next(err) }
})

/** POST /api/products/:id/attachments
 *  Categorías soportadas:
 *    technical_sheet → PDF (múltiples por producto)
 *    image           → JPG/PNG/WebP (única — reemplaza la anterior)
 */
router.post('/:id/attachments',
  checkPermission('attachments', 'create'),
  upload.single('file'),
  async (req, res, next) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'Se requiere un archivo.' })
      const { category = 'technical_sheet', description } = req.body
      const attachment = await attachmentService.saveAttachment({
        tenantId:         req.tenant.id,
        entityType:       'product',
        entityId:         req.params.id,
        category,
        originalFilename: req.file.originalname,
        buffer:           req.file.buffer,
        mimeType:         req.file.mimetype,
        description,
        uploadedBy:       req.auth.userId,
        // La imagen es única por producto: reemplaza la anterior.
        replaceCategory:  category === 'image',
      })
      res.status(201).json(attachment)
    } catch (err) { next(err) }
  }
)

/** GET /api/products/:id/attachments/:attachmentId/download */
router.get('/:id/attachments/:attachmentId/download',
  checkPermission('attachments', 'read'),
  async (req, res, next) => {
    try {
      const file = await attachmentService.getAttachmentInfo({
        tenantId: req.tenant.id, attachmentId: req.params.attachmentId,
      })
      if (!file) return res.status(404).json({ error: 'Archivo no encontrado.' })
      // Imágenes: proxy del blob (evita CORS contra R2 cuando el bucket no
      // tiene CORS habilitado para el dominio del SaaS). Otros (PDFs, etc):
      // redirect a signed URL para no pasar bytes grandes por nuestro backend.
      const isImage = (file.mime_type || '').startsWith('image/')
      await storage.serve(res, file.storage_path, {
        filename:    file.filename,
        mimeType:    file.mime_type,
        disposition: isImage ? 'inline' : 'attachment',
        proxy:       isImage,
      })
    } catch (err) { next(err) }
  }
)

/** DELETE /api/products/:id/attachments/:attachmentId */
router.delete('/:id/attachments/:attachmentId',
  checkPermission('attachments', 'delete'),
  async (req, res, next) => {
    try {
      const deleted = await attachmentService.deleteAttachment({
        tenantId: req.tenant.id, attachmentId: req.params.attachmentId,
      })
      if (!deleted) return res.status(404).json({ error: 'Archivo no encontrado.' })
      res.json({ message: `Archivo ${deleted.filename} eliminado.` })
    } catch (err) { next(err) }
  }
)

module.exports = router
