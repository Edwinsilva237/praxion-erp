'use strict'

const express = require('express')
const multer  = require('multer')
const { tenantResolver }   = require('../../middleware/tenantResolver')
const { authGuard }        = require('../../middleware/authGuard')
const { requireActiveTenant } = require('../../middleware/requireActiveTenant')
const { checkPermission }  = require('../../middleware/checkPermission')
const partnerService       = require('./partnerService')
const { extractCSF, validateCSFVigency, inferPersonType } = require('./csfService')
const attachmentService    = require('../attachments/attachmentService')
const storage              = require('../../utils/storage')
const config               = require('../../config')

const router = express.Router()

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.uploads.maxSizeMb * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    file.mimetype === 'application/pdf' ? cb(null, true) : cb(new Error('Solo PDF.'))
  },
})

router.use(tenantResolver)
router.use(authGuard)
router.use(requireActiveTenant)

// ─── CRUD principal ──────────────────────────────────────────────────────────

router.get('/', checkPermission('business_partners', 'read'), async (req, res, next) => {
  try {
    const { type, isActive, search, page, limit } = req.query
    const result = await partnerService.listPartners({
      tenantId: req.tenant.id, type, search,
      isActive: isActive !== undefined ? isActive === 'true' : undefined,
      page: parseInt(page || 1, 10),
      limit: Math.min(parseInt(limit || 50, 10), 100),
    })
    res.json(result)
  } catch (err) { next(err) }
})

// Resumen de precios negociados — debe ir antes de /:id para no chocar
router.get('/prices-summary', checkPermission('business_partners', 'read'), async (req, res, next) => {
  try {
    const summary = await partnerService.getCustomerPricesSummary({ tenantId: req.tenant.id })
    res.json(summary)
  } catch (err) { next(err) }
})

router.get('/prices-history', checkPermission('business_partners', 'read'), async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || 10, 10), 50)
    const rows = await partnerService.listRecentPriceChanges({ tenantId: req.tenant.id, limit })
    res.json(rows)
  } catch (err) { next(err) }
})

router.get('/:id', checkPermission('business_partners', 'read'), async (req, res, next) => {
  try {
    const partner = await partnerService.getPartner({ tenantId: req.tenant.id, partnerId: req.params.id })
    if (!partner) return res.status(404).json({ error: 'Socio de negocio no encontrado.' })
    res.json(partner)
  } catch (err) { next(err) }
})

router.post('/', checkPermission('business_partners', 'create'), async (req, res, next) => {
  try {
    const { type, name } = req.body
    if (!type || !name) return res.status(400).json({ error: 'type y name son requeridos.' })
    if (!['customer', 'supplier', 'both'].includes(type)) {
      return res.status(400).json({ error: 'type debe ser: customer, supplier o both.' })
    }
    const partner = await partnerService.createPartner({
      tenantId: req.tenant.id, ...req.body,
      userId: req.auth.userId, ipAddress: req.ip, userAgent: req.get('user-agent'),
    })
    res.status(201).json(partner)
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'El RFC ya está registrado.' })
    next(err)
  }
})

router.patch('/:id', checkPermission('business_partners', 'update'), async (req, res, next) => {
  try {
    const partner = await partnerService.updatePartner({
      tenantId: req.tenant.id, partnerId: req.params.id, ...req.body,
      userId: req.auth.userId, ipAddress: req.ip, userAgent: req.get('user-agent'),
    })
    if (!partner) return res.status(404).json({ error: 'Socio de negocio no encontrado.' })
    res.json(partner)
  } catch (err) { next(err) }
})

// ─── CSF — Extracción automática ────────────────────────────────────────────

/**
 * POST /api/business-partners/parse-csf
 * Sube un PDF de CSF del SAT y extrae los datos fiscales automáticamente.
 * No crea el socio de negocio — devuelve los datos para pre-llenar el formulario.
 */
router.post('/parse-csf', checkPermission('business_partners', 'create'),
  upload.single('file'),
  async (req, res, next) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'Se requiere el PDF de la CSF.' })

      const extracted = await extractCSF(req.file.buffer)
      const vigency   = validateCSFVigency(extracted.issuedAt)
      const personType = inferPersonType(extracted.rfc)

      res.json({
        extracted: {
          ...extracted,
          personType,
        },
        vigency,
        warning: !vigency.isValid ? vigency.message : null,
      })
    } catch (err) { next(err) }
  }
)

// ─── Contactos ───────────────────────────────────────────────────────────────

router.post('/:id/contacts', checkPermission('business_partners', 'update'), async (req, res, next) => {
  try {
    const { name, position, email, phone, isPrimary } = req.body
    if (!name) return res.status(400).json({ error: 'name es requerido.' })
    const contact = await partnerService.addContact({
      partnerId: req.params.id, tenantId: req.tenant.id,
      name, position, email, phone, isPrimary,
    })
    if (!contact) return res.status(404).json({ error: 'Socio de negocio no encontrado.' })
    res.status(201).json(contact)
  } catch (err) { next(err) }
})

router.delete('/:id/contacts/:contactId', checkPermission('business_partners', 'update'), async (req, res, next) => {
  try {
    const deleted = await partnerService.deleteContact({
      partnerId: req.params.id, tenantId: req.tenant.id, contactId: req.params.contactId,
    })
    if (!deleted) return res.status(404).json({ error: 'Contacto no encontrado.' })
    res.json({ message: 'Contacto eliminado.' })
  } catch (err) { next(err) }
})

// ─── Domicilios de entrega ───────────────────────────────────────────────────

router.get('/:id/addresses', checkPermission('business_partners', 'read'), async (req, res, next) => {
  try {
    const addresses = await partnerService.listDeliveryAddresses({
      partnerId: req.params.id, tenantId: req.tenant.id,
    })
    res.json(addresses)
  } catch (err) { next(err) }
})

router.post('/:id/addresses', checkPermission('business_partners', 'update'), async (req, res, next) => {
  try {
    const { alias, address, city, state } = req.body
    if (!alias || !address || !city || !state) {
      return res.status(400).json({ error: 'alias, address, city y state son requeridos.' })
    }
    const da = await partnerService.addDeliveryAddress({
      partnerId: req.params.id, tenantId: req.tenant.id, ...req.body,
    })
    if (!da) return res.status(404).json({ error: 'Socio de negocio no encontrado.' })
    res.status(201).json(da)
  } catch (err) { next(err) }
})

router.patch('/:id/addresses/:addressId', checkPermission('business_partners', 'update'), async (req, res, next) => {
  try {
    const da = await partnerService.updateDeliveryAddress({
      addressId: req.params.addressId, partnerId: req.params.id,
      tenantId: req.tenant.id, ...req.body,
    })
    if (!da) return res.status(404).json({ error: 'Domicilio no encontrado.' })
    res.json(da)
  } catch (err) { next(err) }
})

// ─── Precios por cliente ─────────────────────────────────────────────────────

router.get('/:id/prices', checkPermission('business_partners', 'read'), async (req, res, next) => {
  try {
    const { onlyActive = 'true' } = req.query
    const prices = await partnerService.listCustomerPrices({
      partnerId: req.params.id, tenantId: req.tenant.id,
      onlyActive: onlyActive === 'true',
    })
    if (!prices) return res.status(404).json({ error: 'Socio de negocio no encontrado.' })
    res.json(prices)
  } catch (err) { next(err) }
})

router.post('/:id/prices', checkPermission('business_partners', 'update'), async (req, res, next) => {
  try {
    const { productId, unitPrice } = req.body
    if (!productId || !unitPrice) {
      return res.status(400).json({ error: 'productId y unitPrice son requeridos.' })
    }
    const price = await partnerService.setCustomerPrice({
      tenantId: req.tenant.id, partnerId: req.params.id,
      ...req.body,
      userId: req.auth.userId, ipAddress: req.ip, userAgent: req.get('user-agent'),
    })
    res.status(201).json(price)
  } catch (err) { next(err) }
})

router.delete('/:id/prices/:priceId', checkPermission('business_partners', 'update'), async (req, res, next) => {
  try {
    const deleted = await partnerService.deleteCustomerPrice({
      priceId: req.params.priceId, tenantId: req.tenant.id,
      userId: req.auth.userId, ipAddress: req.ip, userAgent: req.get('user-agent'),
    })
    if (!deleted) return res.status(404).json({ error: 'Precio no encontrado.' })
    res.json({ message: 'Precio eliminado.' })
  } catch (err) { next(err) }
})

// ─── Materiales de proveedor ─────────────────────────────────────────────────

router.get('/:id/materials', checkPermission('business_partners', 'read'), async (req, res, next) => {
  try {
    const materials = await partnerService.listSupplierMaterials({
      partnerId: req.params.id, tenantId: req.tenant.id,
    })
    res.json(materials)
  } catch (err) { next(err) }
})

router.post('/:id/materials', checkPermission('business_partners', 'update'), async (req, res, next) => {
  try {
    const { rawMaterialId } = req.body
    if (!rawMaterialId) return res.status(400).json({ error: 'rawMaterialId es requerido.' })
    const material = await partnerService.setSupplierMaterial({
      tenantId: req.tenant.id, partnerId: req.params.id, ...req.body,
    })
    res.status(201).json(material)
  } catch (err) { next(err) }
})

// ─── Adjuntos ────────────────────────────────────────────────────────────────

router.get('/:id/attachments', checkPermission('attachments', 'read'), async (req, res, next) => {
  try {
    const files = await attachmentService.listAttachments({
      tenantId: req.tenant.id, entityType: 'business_partner',
      entityId: req.params.id, category: req.query.category,
    })
    res.json(files)
  } catch (err) { next(err) }
})

router.post('/:id/attachments',
  checkPermission('attachments', 'create'),
  upload.single('file'),
  async (req, res, next) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'Se requiere un archivo PDF.' })
      const attachment = await attachmentService.saveAttachment({
        tenantId: req.tenant.id, entityType: 'business_partner',
        entityId: req.params.id,
        category: req.body.category || 'certificate',
        originalFilename: req.file.originalname,
        buffer: req.file.buffer, mimeType: req.file.mimetype,
        description: req.body.description,
        uploadedBy: req.auth.userId,
      })
      res.status(201).json(attachment)
    } catch (err) { next(err) }
  }
)

router.get('/:id/attachments/:attachmentId/download',
  checkPermission('attachments', 'read'),
  async (req, res, next) => {
    try {
      const file = await attachmentService.getAttachmentInfo({
        tenantId: req.tenant.id, attachmentId: req.params.attachmentId,
      })
      if (!file) return res.status(404).json({ error: 'Archivo no encontrado.' })
      await storage.serve(res, file.storage_path, {
        filename:    file.filename,
        mimeType:    file.mime_type,
        disposition: 'attachment',
      })
    } catch (err) { next(err) }
  }
)

module.exports = router
