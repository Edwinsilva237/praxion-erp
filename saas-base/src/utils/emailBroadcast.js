'use strict'

// ─────────────────────────────────────────────────────────────────────────────
// Helpers compartidos por los envíos MASIVOS branded del ERP (distribución
// fiscal, comunicados a clientes/proveedores). Centralizados aquí para que esos
// módulos NO dupliquen ni diverjan:
//   - normalizeManualEmails: parsea el campo "Para" tipo Gmail.
//   - resolveIssuerName:     razón social del emisor para asunto/cuerpo.
//   - getTenantEmailBranding: color + logo (adjunto inline por cid) del tenant.
// ─────────────────────────────────────────────────────────────────────────────

const { query } = require('../db')
const storage = require('./storage')

// Logos que los clientes de correo renderizan inline de forma confiable (SVG NO
// — Gmail lo bloquea; si el logo es SVG el correo cae al encabezado de texto).
const LOGO_MIME_BY_EXT = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' }

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/**
 * Correos manuales (campo tipo "Para" de Gmail): separados por coma/;/espacio/
 * salto de línea. Normaliza (trim+lowercase), valida forma básica, DEDUPE y topa
 * a `cap` por seguridad. Los inválidos se IGNORAN en silencio (el front avisa).
 */
function normalizeManualEmails(input, cap = 200) {
  if (!input) return []
  const arr = Array.isArray(input) ? input : String(input).split(/[\s,;]+/)
  const seen = new Set()
  const out = []
  for (const raw of arr) {
    const e = String(raw || '').trim().toLowerCase()
    if (!e || !EMAIL_RE.test(e) || seen.has(e)) continue
    seen.add(e)
    out.push(e)
  }
  return out.slice(0, cap)
}

/**
 * Razón social del emisor (para asunto/cuerpo por default). Muchos socios tienen
 * registrado al tenant por su RAZÓN SOCIAL, no por el nombre comercial. Prioridad:
 * perfil fiscal activo (tax_name) → tenant_fiscal_info legacy → nombre comercial.
 */
async function resolveIssuerName(tenantId) {
  const { rows } = await query(
    `SELECT COALESCE(
       -- El tenant tiene 1 perfil activo en la práctica (igual que getProfile /
       -- listProfiles del módulo fiscal-profiles); ordenamos por created_at.
       (SELECT NULLIF(TRIM(tax_name), '')
          FROM tenant_fiscal_profiles
         WHERE tenant_id = $1 AND is_active = TRUE
         ORDER BY created_at ASC
         LIMIT 1),
       (SELECT NULLIF(TRIM(razon_social), '')
          FROM tenant_fiscal_info WHERE tenant_id = $1),
       (SELECT NULLIF(TRIM(display_name), '') FROM tenants WHERE id = $1),
       (SELECT name FROM tenants WHERE id = $1)
     ) AS issuer_name`,
    [tenantId]
  )
  return rows[0]?.issuer_name || 'Su proveedor'
}

/**
 * Branding del tenant para el correo: color de marca + logo. El logo se devuelve
 * como un ADJUNTO INLINE de nodemailer (cid) — el caller lo agrega UNA vez al
 * arreglo de adjuntos del lote — para que se vea sin depender de hosting público
 * ni CORS. SVG/formatos raros se omiten (cae al encabezado de texto).
 *
 * @returns {{ brandColor: string|null, logoCid: string|null, logoAttachment: object|null }}
 */
async function getTenantEmailBranding(tenantId) {
  const { rows } = await query(
    `SELECT brand_color_primary, logo_storage_path FROM tenants WHERE id = $1`,
    [tenantId]
  )
  const brandColor = rows[0]?.brand_color_primary || null
  const logoPath = rows[0]?.logo_storage_path
  let logoCid = null
  let logoAttachment = null
  if (logoPath) {
    const ext  = String(logoPath.split('.').pop() || '').toLowerCase()
    const mime = LOGO_MIME_BY_EXT[ext]
    if (mime) {
      try {
        const logoBuf = await storage.fetchBuffer(logoPath)
        if (logoBuf) {
          logoCid = 'brandlogo'
          logoAttachment = {
            filename: `logo.${ext}`, content: logoBuf, contentType: mime,
            cid: logoCid, contentDisposition: 'inline',
          }
        }
      } catch (_) { /* si el logo falla, el correo sale con encabezado de texto */ }
    }
  }
  return { brandColor, logoCid, logoAttachment }
}

module.exports = { normalizeManualEmails, resolveIssuerName, getTenantEmailBranding }
