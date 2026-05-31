'use strict'

const express = require('express')
const multer  = require('multer')
const tenantSvc = require('./tenantService')
const { tenantResolver } = require('../../middleware/tenantResolver')
const { authGuard }      = require('../../middleware/authGuard')
const { checkPermission } = require('../../middleware/checkPermission')
const { query, withBypass } = require('../../db')
const storage = require('../../utils/storage')
const brandingService = require('./brandingService')
const { validatePassword } = require('../../utils/passwordPolicy')
const logger  = require('../../config/logger')

const HEX_REGEX = /^#[0-9A-Fa-f]{6}$/

const router = express.Router()

// Logos: PNG/JPG/WEBP/SVG. Hasta 2MB (un logo no debería pesar más).
const ALLOWED_LOGO = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'])
const logoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    ALLOWED_LOGO.has(file.mimetype)
      ? cb(null, true)
      : cb(new Error('Tipo no permitido. Acepta PNG, JPG, WebP o SVG.'))
  },
})

// ─── Registro de tenants nuevos (público) ──────────────────────────────────

/**
 * POST /api/tenants/provision
 * Crea un nuevo tenant con su primer usuario admin.
 * Este endpoint NO requiere autenticación — es el punto de registro.
 * En producción debería protegerse con una API key de plataforma.
 */
router.post('/provision', async (req, res, next) => {
  try {
    const { slug, name, plan, adminEmail, adminPassword, adminName } = req.body

    if (!slug || !name || !adminEmail || !adminPassword || !adminName) {
      return res.status(400).json({
        error: 'slug, name, adminEmail, adminPassword and adminName are required.',
      })
    }
    const pwCheck = validatePassword(adminPassword)
    if (!pwCheck.valid) {
      return res.status(400).json({ error: pwCheck.reason })
    }

    const result = await withBypass(() => tenantSvc.provisionTenant({
      slug, name, plan, adminEmail, adminPassword, adminName,
    }))

    res.status(201).json({ tenant: result.tenant, user: result.user })
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'A tenant with that slug already exists.' })
    if (err.code === '23514') return res.status(400).json({ error: 'Invalid slug format. Use only lowercase letters, numbers and hyphens.' })
    next(err)
  }
})

// ─── Tenant actual (autenticado) ───────────────────────────────────────────

/**
 * GET /api/tenants/current
 * Datos del tenant del usuario autenticado, incluido branding.
 * Si tiene logo configurado, genera signed URL (TTL configurable en storage).
 */
router.get('/current', tenantResolver, authGuard, async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT id, slug, name, display_name, logo_storage_path,
              brand_color_primary, brand_color_secondary,
              plan, is_active, is_sandbox, notification_email, modules,
              suspended_reason, suspended_at,
              (SELECT allow_self_start_shift FROM tenant_process_config WHERE tenant_id = tenants.id) AS allow_self_start_shift,
              (SELECT allow_quick_order FROM tenant_process_config WHERE tenant_id = tenants.id) AS allow_quick_order
         FROM tenants WHERE id = $1`,
      [req.tenant.id]
    )
    if (!rows.length) return res.status(404).json({ error: 'Tenant no encontrado.' })

    const t = rows[0]

    // Construir signed URL del logo si existe. La URL es temporal (TTL del
    // storage). El frontend la cachea con react-query con staleTime corto.
    let logoUrl = null
    if (t.logo_storage_path) {
      try {
        // Reusamos el helper de storage. Para modo R2 genera signed URL;
        // para modo disco, exponemos una ruta interna que sirve el archivo.
        logoUrl = await getLogoUrl(req, t.logo_storage_path)
      } catch (e) {
        logger.warn('[tenant.current] no se pudo generar logo URL', { error: e.message })
      }
    }

    res.json({
      id:                    t.id,
      slug:                  t.slug,
      name:                  t.name,
      display_name:          t.display_name,
      plan:                  t.plan,
      is_active:             t.is_active,
      is_sandbox:            t.is_sandbox,
      notification_email:    t.notification_email,
      brand_color_primary:   t.brand_color_primary,
      brand_color_secondary: t.brand_color_secondary,
      modules:               t.modules || {},
      suspended_reason:      t.suspended_reason,
      suspended_at:          t.suspended_at,
      allow_self_start_shift: t.allow_self_start_shift === true,
      allow_quick_order:      t.allow_quick_order === true,
      logo_url:              logoUrl,
    })
  } catch (err) { next(err) }
})

/**
 * PATCH /api/tenants/current
 * Actualiza configuración del tenant. Body soportado:
 *   - notificationEmail?: string|null
 *   - displayName?:       string|null  (nombre comercial visible en sidebar)
 */
router.patch('/current', tenantResolver, authGuard, async (req, res, next) => {
  try {
    const { notificationEmail, displayName, brandColorPrimary, brandColorSecondary } = req.body || {}

    if (notificationEmail !== undefined && notificationEmail !== null && notificationEmail !== '') {
      const ok = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(notificationEmail)
      if (!ok) return res.status(400).json({ error: 'notificationEmail no tiene formato válido.' })
    }

    if (displayName !== undefined && displayName !== null && displayName !== '') {
      const trimmed = String(displayName).trim()
      if (trimmed.length > 120) return res.status(400).json({ error: 'displayName excede 120 caracteres.' })
    }

    for (const [name, val] of [['brandColorPrimary', brandColorPrimary], ['brandColorSecondary', brandColorSecondary]]) {
      if (val !== undefined && val !== null && val !== '' && !HEX_REGEX.test(val)) {
        return res.status(400).json({ error: `${name} debe ser un color en formato hexadecimal #RRGGBB.` })
      }
    }

    const fields = []
    const params = [req.tenant.id]
    if (notificationEmail !== undefined) {
      params.push(notificationEmail || null)
      fields.push(`notification_email = $${params.length}`)
    }
    if (displayName !== undefined) {
      params.push(displayName ? String(displayName).trim() : null)
      fields.push(`display_name = $${params.length}`)
    }
    if (brandColorPrimary !== undefined) {
      params.push(brandColorPrimary || null)
      fields.push(`brand_color_primary = $${params.length}`)
    }
    if (brandColorSecondary !== undefined) {
      params.push(brandColorSecondary || null)
      fields.push(`brand_color_secondary = $${params.length}`)
    }
    if (!fields.length) return res.status(400).json({ error: 'Nada que actualizar.' })

    const { rows } = await query(
      `UPDATE tenants SET ${fields.join(', ')} WHERE id = $1
       RETURNING id, slug, name, display_name, brand_color_primary, brand_color_secondary,
                 plan, is_active, is_sandbox, notification_email`,
      params
    )
    res.json(rows[0])
  } catch (err) { next(err) }
})

/**
 * POST /api/tenants/current/branding/sync-fiscal
 * Sincroniza logo + colores con Facturapi para que las facturas timbradas
 * salgan con la identidad del cliente. Operación idempotente.
 */
router.post('/current/branding/sync-fiscal',
  tenantResolver, authGuard, checkPermission('settings', 'update'),
  async (req, res, next) => {
    try {
      const result = await brandingService.syncAll(req.tenant.id)
      res.json(result)
    } catch (err) { next(err) }
  }
)

/**
 * POST /api/tenants/current/logo
 * Sube el logo del tenant (multipart: file). Reemplaza el anterior.
 */
router.post('/current/logo',
  tenantResolver, authGuard, checkPermission('settings', 'update'),
  logoUpload.single('file'),
  async (req, res, next) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'Se requiere un archivo de logo.' })

      // Borrar logo previo si existía
      const { rows: prev } = await query(
        `SELECT logo_storage_path FROM tenants WHERE id = $1`, [req.tenant.id]
      )
      if (prev[0]?.logo_storage_path) {
        await storage.remove(prev[0].logo_storage_path)
      }

      const ext = guessExt(req.file.mimetype)
      const key = `branding/${req.tenant.id}/logo${ext}`
      await storage.put(key, req.file.buffer, { contentType: req.file.mimetype })

      await query(
        `UPDATE tenants SET logo_storage_path = $1 WHERE id = $2`,
        [key, req.tenant.id]
      )

      const logoUrl = await getLogoUrl(req, key)
      res.status(201).json({ logo_url: logoUrl })
    } catch (err) { next(err) }
  }
)

/**
 * DELETE /api/tenants/current/logo
 * Elimina el logo del tenant. El sidebar vuelve a mostrar el isotipo Praxion.
 */
router.delete('/current/logo',
  tenantResolver, authGuard, checkPermission('settings', 'update'),
  async (req, res, next) => {
    try {
      const { rows } = await query(
        `SELECT logo_storage_path FROM tenants WHERE id = $1`, [req.tenant.id]
      )
      if (rows[0]?.logo_storage_path) {
        await storage.remove(rows[0].logo_storage_path)
      }
      await query(`UPDATE tenants SET logo_storage_path = NULL WHERE id = $1`, [req.tenant.id])
      res.json({ removed: true })
    } catch (err) { next(err) }
  }
)


// ─── Helpers ───────────────────────────────────────────────────────────────

function guessExt(mime) {
  if (mime === 'image/png')     return '.png'
  if (mime === 'image/jpeg')    return '.jpg'
  if (mime === 'image/webp')    return '.webp'
  if (mime === 'image/svg+xml') return '.svg'
  return ''
}

/**
 * Construye la URL del logo. Como los tags <img> del navegador NO mandan el
 * token JWT, no podemos servir el logo por un endpoint autenticado normal.
 *
 * Solución: devolver un **data URL** (base64 inline) directamente en la
 * respuesta JSON. El navegador lo renderiza sin segundo request. Cost: ~33%
 * más de bytes en el payload, aceptable para logos hasta 2MB.
 */
async function getLogoUrl(_req, key) {
  const buffer = await storage.fetchBuffer(key)
  if (!buffer) return null
  const mime = guessMimeFromKey(key)
  return `data:${mime};base64,${buffer.toString('base64')}`
}

function guessMimeFromKey(key) {
  if (key.endsWith('.png'))  return 'image/png'
  if (key.endsWith('.jpg') || key.endsWith('.jpeg')) return 'image/jpeg'
  if (key.endsWith('.webp')) return 'image/webp'
  if (key.endsWith('.svg'))  return 'image/svg+xml'
  return 'application/octet-stream'
}

module.exports = router
