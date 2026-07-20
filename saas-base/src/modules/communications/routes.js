'use strict'

const express = require('express')
const multer  = require('multer')
const { tenantResolver }       = require('../../middleware/tenantResolver')
const { authGuard }            = require('../../middleware/authGuard')
const { requireActiveTenant }  = require('../../middleware/requireActiveTenant')
const { checkPermission }      = require('../../middleware/checkPermission')
const requireModule            = require('../../middleware/requireModule')
const storage = require('../../utils/storage')
const attachmentService = require('../attachments/attachmentService')
const svc = require('./communicationsService')

// Tipos permitidos en los adjuntos de un comunicado (espejo de la categoría
// 'communication' en attachmentService). Ejecutables bloqueados por seguridad.
const ALLOWED_MIME = new Set([
  'application/pdf',
  'image/jpeg', 'image/png', 'image/webp', 'image/gif',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.ms-powerpoint',
  'text/csv', 'text/plain',
  'application/zip', 'application/x-zip-compressed',
])

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024, files: 10 },
  fileFilter: (_req, file, cb) => ALLOWED_MIME.has(file.mimetype)
    ? cb(null, true)
    : cb(new Error(`Tipo de adjunto no permitido: ${file.mimetype}.`)),
})

// Normaliza errores de multer a 400 legibles (si no, caen al handler global
// como 500 opaco — mismo patrón que sales/purchases).
function handleUpload(field, maxCount) {
  const mw = upload.array(field, maxCount)
  return (req, res, next) => mw(req, res, (err) => {
    if (!err) return next()
    if (err.code === 'LIMIT_FILE_SIZE')  return res.status(400).json({ error: 'Un adjunto supera los 20 MB.' })
    if (err.code === 'LIMIT_FILE_COUNT') return res.status(400).json({ error: 'Máximo 10 adjuntos por comunicado.' })
    return res.status(400).json({ error: err.message || 'Error al subir el adjunto.' })
  })
}

// Parseo tolerante de un campo que llega como JSON string (arreglo) o ausente.
function parseArrayField(v) {
  if (v === undefined || v === null || v === '') return undefined
  if (Array.isArray(v)) return v
  try { const p = JSON.parse(v); return Array.isArray(p) ? p : undefined } catch { return undefined }
}

const router = express.Router()

router.use(tenantResolver)
router.use(authGuard)
router.use(requireActiveTenant)
router.use(requireModule('communications'))

const retErr = (res, next) => (err) => {
  if (err.status) return res.status(err.status).json({ error: err.message })
  next(err)
}

/**
 * GET /api/communications/recipients
 * Todos los clientes y proveedores activos con correo (para el selector) +
 * los que no tienen correo (informativo).
 */
router.get('/recipients', checkPermission('communications', 'read'), async (req, res, next) => {
  try {
    res.json(await svc.previewRecipients({ tenantId: req.tenant.id }))
  } catch (err) { retErr(res, next)(err) }
})

/**
 * POST /api/communications/send  (multipart/form-data)
 * Campos: subject, message?, category?, clientIds? (JSON[]), supplierIds? (JSON[]),
 *         manualEmails? (string), files? (hasta 10 adjuntos).
 */
router.post('/send', checkPermission('communications', 'send'), handleUpload('files', 10),
  async (req, res, next) => {
    try {
      const b = req.body || {}
      const result = await svc.distribute({
        tenantId:    req.tenant.id,
        subject:     b.subject,
        message:     b.message,
        category:    b.category,
        clientIds:   parseArrayField(b.clientIds),
        supplierIds: parseArrayField(b.supplierIds),
        manualEmails: b.manualEmails,
        files:       req.files || [],
        sentBy:      req.auth?.userId,
        ipAddress:   req.ip,
        userAgent:   req.get('user-agent'),
      })
      res.status(201).json({ ok: true, ...result })
    } catch (err) { retErr(res, next)(err) }
  })

/**
 * GET /api/communications/sends — historial de comunicados enviados.
 */
router.get('/sends', checkPermission('communications', 'read'), async (req, res, next) => {
  try {
    res.json(await svc.listSends({ tenantId: req.tenant.id, limit: req.query.limit }))
  } catch (err) { retErr(res, next)(err) }
})

/**
 * GET /api/communications/sends/:id — detalle (destinatarios + adjuntos).
 */
router.get('/sends/:id', checkPermission('communications', 'read'), async (req, res, next) => {
  try {
    const send = await svc.getSend({ tenantId: req.tenant.id, sendId: req.params.id })
    if (!send) return res.status(404).json({ error: 'Comunicado no encontrado.' })
    res.json(send)
  } catch (err) { retErr(res, next)(err) }
})

/**
 * GET /api/communications/sends/:id/attachments/:attachmentId/download
 * Sirve un adjunto del comunicado. proxy=true: el backend transmite los bytes
 * (el CORS de R2 no permite el origen del frontend).
 */
router.get('/sends/:id/attachments/:attachmentId/download',
  checkPermission('communications', 'read'), async (req, res, next) => {
    try {
      const file = await attachmentService.getAttachmentInfo({
        tenantId: req.tenant.id, attachmentId: req.params.attachmentId,
      })
      if (!file) return res.status(404).json({ error: 'Archivo no encontrado.' })
      await storage.serve(res, file.storage_path, {
        filename: file.filename, mimeType: file.mime_type,
        disposition: 'inline', proxy: true,
      })
    } catch (err) { retErr(res, next)(err) }
  })

module.exports = router
