'use strict'

const express = require('express')
const multer  = require('multer')
const { tenantResolver }   = require('../../middleware/tenantResolver')
const { authGuard }        = require('../../middleware/authGuard')
const { requireActiveTenant } = require('../../middleware/requireActiveTenant')
const { checkPermission }  = require('../../middleware/checkPermission')
const requireModule        = require('../../middleware/requireModule')
const storage              = require('../../utils/storage')
const attachmentService    = require('../attachments/attachmentService')
const service = require('./pettyCashService')

const router = express.Router()
router.use(tenantResolver)
router.use(authGuard)
router.use(requireActiveTenant)
router.use(requireModule('petty_cash'))

// ── Upload de comprobantes (fotos/PDFs hasta 5MB) ────────────────────────
const uploadReceipt = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_, file, cb) => {
    const ok = ['image/jpeg','image/png','image/webp','application/pdf'].includes(file.mimetype)
    cb(ok ? null : new Error('Tipo de archivo no soportado (JPG/PNG/WebP/PDF).'), ok)
  },
})

// ─── Fondos ──────────────────────────────────────────────────────────────

router.get('/funds',
  checkPermission('petty_cash', 'read'),
  async (req, res, next) => {
    try {
      const funds = await service.listFunds(req.tenant.id, {
        includeInactive: req.query.includeInactive === 'true',
      })
      res.json({ data: funds })
    } catch (err) { next(err) }
  }
)

router.get('/funds/:id',
  checkPermission('petty_cash', 'read'),
  async (req, res, next) => {
    try {
      const fund = await service.getFund(req.tenant.id, req.params.id)
      if (!fund) return res.status(404).json({ error: 'Fondo no encontrado.' })
      res.json(fund)
    } catch (err) { next(err) }
  }
)

router.post('/funds',
  checkPermission('petty_cash', 'manage'),
  async (req, res, next) => {
    try {
      const fund = await service.createFund(req.tenant.id, req.auth.userId, req.body)
      res.status(201).json(fund)
    } catch (err) { next(err) }
  }
)

router.patch('/funds/:id',
  checkPermission('petty_cash', 'manage'),
  async (req, res, next) => {
    try {
      const fund = await service.updateFund(req.tenant.id, req.params.id, req.body)
      if (!fund) return res.status(404).json({ error: 'Fondo no encontrado.' })
      res.json(fund)
    } catch (err) { next(err) }
  }
)

// ─── Categorías ──────────────────────────────────────────────────────────

router.get('/categories',
  checkPermission('petty_cash', 'read'),
  async (req, res, next) => {
    try {
      const cats = await service.listCategories(req.tenant.id, {
        kind: req.query.kind || null,
        includeInactive: req.query.includeInactive === 'true',
      })
      res.json({ data: cats })
    } catch (err) { next(err) }
  }
)

router.post('/categories',
  checkPermission('petty_cash', 'manage'),
  async (req, res, next) => {
    try {
      const cat = await service.createCategory(req.tenant.id, req.body)
      res.status(201).json(cat)
    } catch (err) { next(err) }
  }
)

router.patch('/categories/:id',
  checkPermission('petty_cash', 'manage'),
  async (req, res, next) => {
    try {
      const cat = await service.updateCategory(req.tenant.id, req.params.id, req.body)
      if (!cat) return res.status(404).json({ error: 'Categoría no encontrada.' })
      res.json(cat)
    } catch (err) { next(err) }
  }
)

// ─── Movimientos ─────────────────────────────────────────────────────────

router.get('/movements',
  checkPermission('petty_cash', 'read'),
  async (req, res, next) => {
    try {
      const result = await service.listMovements(req.tenant.id, req.query)
      res.json(result)
    } catch (err) { next(err) }
  }
)

router.get('/movements/:id',
  checkPermission('petty_cash', 'read'),
  async (req, res, next) => {
    try {
      const mov = await service.getMovement(req.tenant.id, req.params.id)
      if (!mov) return res.status(404).json({ error: 'Movimiento no encontrado.' })
      res.json(mov)
    } catch (err) { next(err) }
  }
)

router.post('/movements',
  checkPermission('petty_cash', 'create'),
  async (req, res, next) => {
    try {
      const mov = await service.createMovement(req.tenant.id, req.auth.userId, req.body)
      res.status(201).json(mov)
    } catch (err) { next(err) }
  }
)

router.post('/movements/:id/cancel',
  checkPermission('petty_cash', 'cancel'),
  async (req, res, next) => {
    try {
      const mov = await service.cancelMovement(
        req.tenant.id, req.auth.userId, req.params.id, req.body?.reason
      )
      res.json(mov)
    } catch (err) { next(err) }
  }
)

// ─── Comprobantes (attachments) ──────────────────────────────────────────

router.post('/movements/:id/attachment',
  checkPermission('petty_cash', 'create'),
  uploadReceipt.single('file'),
  async (req, res, next) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'Se requiere un archivo.' })
      // Valida que el movimiento exista (multi-tenant).
      const mov = await service.getMovement(req.tenant.id, req.params.id)
      if (!mov) return res.status(404).json({ error: 'Movimiento no encontrado.' })

      const attachment = await attachmentService.saveAttachment({
        tenantId:   req.tenant.id,
        entityType: 'petty_cash_movement',
        entityId:   req.params.id,
        category:   'other',
        originalFilename: req.file.originalname,
        buffer:     req.file.buffer,
        mimeType:   req.file.mimetype,
        description: req.body?.description || null,
        uploadedBy: req.auth.userId,
      })
      res.status(201).json(attachment)
    } catch (err) { next(err) }
  }
)

router.get('/movements/:id/attachment',
  checkPermission('petty_cash', 'read'),
  async (req, res, next) => {
    try {
      const mov = await service.getMovement(req.tenant.id, req.params.id)
      if (!mov || !mov.attachment_id) {
        return res.status(404).json({ error: 'Sin comprobante adjunto.' })
      }
      const file = await attachmentService.getAttachmentInfo({
        tenantId: req.tenant.id, attachmentId: mov.attachment_id,
      })
      if (!file) return res.status(404).json({ error: 'Archivo no encontrado.' })
      await storage.serve(res, file.storage_path, {
        filename:    file.filename,
        mimeType:    file.mime_type,
        disposition: 'inline',
      })
    } catch (err) { next(err) }
  }
)

router.delete('/movements/:id/attachment',
  checkPermission('petty_cash', 'create'),
  async (req, res, next) => {
    try {
      const mov = await service.getMovement(req.tenant.id, req.params.id)
      if (!mov || !mov.attachment_id) {
        return res.status(404).json({ error: 'Sin comprobante adjunto.' })
      }
      await attachmentService.deleteAttachment({
        tenantId: req.tenant.id, attachmentId: mov.attachment_id,
      })
      res.json({ ok: true })
    } catch (err) { next(err) }
  }
)

module.exports = router
