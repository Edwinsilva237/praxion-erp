'use strict'

const express = require('express')
const multer  = require('multer')
const { tenantResolver }      = require('../../middleware/tenantResolver')
const { authGuard }           = require('../../middleware/authGuard')
const { requireActiveTenant } = require('../../middleware/requireActiveTenant')
const { checkPermission }     = require('../../middleware/checkPermission')
const storage = require('../../utils/storage')
const config  = require('../../config')
const svc = require('./fiscalDistributionService')

const router = express.Router()

// Solo PDF (CSF y Opinión 32-D se descargan del SAT en PDF).
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.uploads.maxSizeMb * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    file.mimetype === 'application/pdf' ? cb(null, true) : cb(new Error('Solo se aceptan archivos PDF.'))
  },
})

// Normaliza los errores de multer (tamaño/tipo) a 400 legible. Sin esto, el
// error del fileFilter llega sin `.status` y el handler global de app.js lo
// enmascara como 500 "Internal server error".
function handleUpload(field) {
  const mw = upload.single(field)
  return (req, res, next) => mw(req, res, (err) => {
    if (!err) return next()
    if (err instanceof multer.MulterError) {
      err.status = 400
      if (err.code === 'LIMIT_FILE_SIZE') {
        err.message = `El archivo excede el tamaño máximo de ${config.uploads.maxSizeMb}MB.`
      }
    } else if (!err.status) {
      err.status = 400
    }
    next(err)
  })
}

router.use(tenantResolver)
router.use(authGuard)
router.use(requireActiveTenant)

const DOC_TYPES = ['csf', 'opinion']

// ─── Documentos fiscales del tenant ──────────────────────────────────────────

// Ver los docs cargados (CSF + 32-D)
router.get('/docs', checkPermission('fiscal', 'distribute'), async (req, res, next) => {
  try {
    res.json(await svc.getFiscalDocs({ tenantId: req.tenant.id }))
  } catch (err) { next(err) }
})

// Subir/reemplazar un doc: POST /docs/:docType  (docType = csf | opinion)
router.post('/docs/:docType', checkPermission('fiscal', 'distribute'),
  handleUpload('file'), async (req, res, next) => {
    try {
      const { docType } = req.params
      if (!DOC_TYPES.includes(docType)) return res.status(400).json({ error: "docType debe ser 'csf' u 'opinion'." })
      if (!req.file) return res.status(400).json({ error: 'Falta el archivo PDF.' })
      const saved = await svc.uploadFiscalDoc({
        tenantId:         req.tenant.id,
        docType,
        buffer:           req.file.buffer,
        originalFilename: req.file.originalname,
        mimeType:         req.file.mimetype,
        uploadedBy:       req.auth?.userId,
      })
      res.status(201).json(saved)
    } catch (err) { next(err) }
  })

// Descargar/ver un doc cargado
router.get('/docs/:docType/file', checkPermission('fiscal', 'distribute'), async (req, res, next) => {
  try {
    const { docType } = req.params
    if (!DOC_TYPES.includes(docType)) return res.status(400).json({ error: "docType debe ser 'csf' u 'opinion'." })
    const info = await svc.getFiscalDocForServe({ tenantId: req.tenant.id, docType })
    if (!info) return res.status(404).json({ error: 'Documento no encontrado.' })
    // proxy:true → el backend transmite los bytes en vez de redirigir a la URL
    // firmada de R2 (cuyo CORS no permite el origen del frontend → el XHR blob de
    // axios falla y sale "no se pudo abrir el documento"). Mismo patrón que la
    // evidencia de recepción / adjuntos de factura. inline = "ver", no "descargar".
    await storage.serve(res, info.storage_path, {
      filename: info.filename, mimeType: info.mime_type,
      disposition: 'inline', proxy: true,
    })
  } catch (err) { next(err) }
})

// Eliminar un doc cargado
router.delete('/docs/:docType', checkPermission('fiscal', 'distribute'), async (req, res, next) => {
  try {
    const { docType } = req.params
    if (!DOC_TYPES.includes(docType)) return res.status(400).json({ error: "docType debe ser 'csf' u 'opinion'." })
    const deleted = await svc.deleteFiscalDoc({ tenantId: req.tenant.id, docType })
    if (!deleted) return res.status(404).json({ error: 'Documento no encontrado.' })
    res.json({ ok: true })
  } catch (err) { next(err) }
})

// ─── Envío a clientes ────────────────────────────────────────────────────────

// Preview de destinatarios (conteo de clientes/correos). Body opcional:
//   { partnerIds: [uuid, ...] }  → acota a esos clientes; si falta, TODOS los activos.
router.post('/preview', checkPermission('fiscal', 'distribute'), async (req, res, next) => {
  try {
    const partnerIds = Array.isArray(req.body?.partnerIds) ? req.body.partnerIds.filter(Boolean) : undefined
    res.json(await svc.previewRecipients({ tenantId: req.tenant.id, partnerIds }))
  } catch (err) { next(err) }
})

// Enviar. Body: { partnerIds?, manualEmails?, subject?, message? }
//   manualEmails: correos escritos a mano (string o array); se validan/dedupean
//   en el servicio y cada uno recibe un correo individual.
router.post('/send', checkPermission('fiscal', 'distribute'), async (req, res, next) => {
  try {
    const partnerIds = Array.isArray(req.body?.partnerIds) ? req.body.partnerIds.filter(Boolean) : undefined
    const result = await svc.distributeToClients({
      tenantId:  req.tenant.id,
      partnerIds,
      manualEmails: req.body?.manualEmails,
      subject:   req.body?.subject,
      message:   req.body?.message,
      sentBy:    req.auth?.userId,
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    })
    res.json({ ok: true, ...result })
  } catch (err) { next(err) }
})

// Historial de envíos
router.get('/sends', checkPermission('fiscal', 'distribute'), async (req, res, next) => {
  try {
    res.json(await svc.listSends({ tenantId: req.tenant.id, limit: req.query.limit }))
  } catch (err) { next(err) }
})

// Detalle de un envío (con destinatarios)
router.get('/sends/:id', checkPermission('fiscal', 'distribute'), async (req, res, next) => {
  try {
    const send = await svc.getSend({ tenantId: req.tenant.id, sendId: req.params.id })
    if (!send) return res.status(404).json({ error: 'Envío no encontrado.' })
    res.json(send)
  } catch (err) { next(err) }
})

module.exports = router
