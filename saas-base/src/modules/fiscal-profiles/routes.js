'use strict'

const express  = require('express')
const multer   = require('multer')
const { tenantResolver }  = require('../../middleware/tenantResolver')
const { authGuard }       = require('../../middleware/authGuard')
const { requireActiveTenant } = require('../../middleware/requireActiveTenant')
const { checkPermission } = require('../../middleware/checkPermission')
const svc = require('./fiscalProfileService')
const { extractCSF, validateCSFVigency, inferPersonType } = require('../business-partners/csfService')

const router = express.Router()
router.use(tenantResolver)
router.use(authGuard)
router.use(requireActiveTenant)

// Multer en memoria para CSD (.cer y .key)
const uploadCert = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 1024 * 1024 },   // 1MB es más que suficiente
})

// Multer para el PDF de la CSF
const uploadCSF = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
})

/**
 * GET /api/fiscal-profiles
 */
router.get('/', checkPermission('settings', 'read'), async (req, res, next) => {
  try {
    const rows = await svc.listProfiles({ tenantId: req.tenant.id })
    res.json(rows)
  } catch (err) { next(err) }
})

/**
 * POST /api/fiscal-profiles
 * Body: { rfc, taxName, taxRegime, zipCode, serie?, isDefault?,
 *         facturapiOrganizationId?, facturapiApiKeyLive?, facturapiApiKeyTest?,
 *         createInFacturapi?, notes? }
 */
router.post('/', checkPermission('settings', 'update'), async (req, res, next) => {
  try {
    const profile = await svc.createProfile({
      tenantId: req.tenant.id, ...req.body,
      userId: req.auth.userId, ipAddress: req.ip, userAgent: req.get('user-agent'),
    })
    res.status(201).json(profile)
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Ya existe un emisor con ese RFC.' })
    }
    next(err)
  }
})

router.patch('/:id', checkPermission('settings', 'update'), async (req, res, next) => {
  try {
    const profile = await svc.updateProfile({
      tenantId: req.tenant.id, profileId: req.params.id, ...req.body,
      userId: req.auth.userId, ipAddress: req.ip, userAgent: req.get('user-agent'),
    })
    res.json(profile)
  } catch (err) { next(err) }
})

router.delete('/:id', checkPermission('settings', 'update'), async (req, res, next) => {
  try {
    const result = await svc.deleteProfile({
      tenantId: req.tenant.id, profileId: req.params.id,
      userId: req.auth.userId, ipAddress: req.ip, userAgent: req.get('user-agent'),
    })
    res.json(result)
  } catch (err) { next(err) }
})

/**
 * POST /api/fiscal-profiles/parse-csf
 * Sube el PDF de la CSF (Constancia de Situación Fiscal) y extrae datos
 * para pre-llenar el form de datos fiscales. Reusa el parser de business-partners.
 * Form-data: file (PDF)
 */
router.post('/parse-csf',
  checkPermission('settings', 'update'),
  uploadCSF.single('file'),
  async (req, res, next) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'Se requiere el PDF de la CSF.' })
      const extracted = await extractCSF(req.file.buffer)
      const vigency   = validateCSFVigency(extracted.issuedAt)
      res.json({
        extracted,
        vigency,
        warning: !vigency.isValid ? vigency.message : null,
      })
    } catch (err) { next(err) }
  }
)

/**
 * POST /api/fiscal-profiles/:id/certificate
 * Form-data: cer (file), key (file), password (string).
 * Sube el CSD a Facturapi para la organization de este profile.
 */
router.post('/:id/certificate',
  checkPermission('settings', 'update'),
  uploadCert.fields([{ name: 'cer', maxCount: 1 }, { name: 'key', maxCount: 1 }]),
  async (req, res, next) => {
    try {
      const cer = req.files?.cer?.[0]
      const key = req.files?.key?.[0]
      const password = req.body?.password
      if (!cer)      return res.status(400).json({ error: 'Falta el archivo .cer' })
      if (!key)      return res.status(400).json({ error: 'Falta el archivo .key' })
      if (!password) return res.status(400).json({ error: 'Falta el password del CSD' })

      const result = await svc.uploadCertificate({
        tenantId: req.tenant.id, profileId: req.params.id,
        cerBuffer: cer.buffer, keyBuffer: key.buffer, password,
        userId: req.auth.userId, ipAddress: req.ip, userAgent: req.get('user-agent'),
      })
      res.json(result)
    } catch (err) { next(err) }
  }
)

module.exports = router
