'use strict'

// Sincronización del branding del tenant con su organización en Facturapi.
// Cuando el cliente cambia su logo o colores en Praxion, este service los
// empuja a Facturapi para que el PDF del CFDI salga con esa identidad.
//
// Requiere:
//   - FACTURAPI_USER_KEY en el servidor (User Secret Key, no la org key).
//   - El tenant debe tener `tenant_fiscal_profiles.facturapi_organization_id`
//     (se crea cuando el admin configura sus datos fiscales).

const Facturapi = require('facturapi').default
const fs = require('fs')
const path = require('path')
const { query } = require('../../db')
const storage = require('../../utils/storage')
const logger = require('../../config/logger')

function adminClient() {
  const key = process.env.FACTURAPI_USER_KEY
  if (!key) {
    const err = new Error(
      'FACTURAPI_USER_KEY no configurada. Necesaria para sincronizar branding con Facturapi.'
    )
    err.status = 503
    err.code = 'FACTURAPI_USER_KEY_MISSING'
    throw err
  }
  return new Facturapi(key)
}

/**
 * Devuelve el organization_id de Facturapi para este tenant, o null si no
 * tiene aún un perfil fiscal configurado.
 */
async function getOrgId(tenantId) {
  const { rows } = await query(
    `SELECT facturapi_organization_id
       FROM tenant_fiscal_profiles
      WHERE tenant_id = $1
      LIMIT 1`,
    [tenantId]
  )
  return rows[0]?.facturapi_organization_id || null
}

/**
 * Sincroniza colores con Facturapi (PUT /organizations/{id}).
 * No-op silencioso si el tenant no tiene org fiscal.
 */
async function syncColors(tenantId, { primary, secondary } = {}) {
  const orgId = await getOrgId(tenantId)
  if (!orgId) return { synced: false, reason: 'sin_organizacion_fiscal' }

  const fa = adminClient()

  // Facturapi acepta `colors` como objeto {primary, secondary}. Si no se
  // pasa alguno, se mantiene el valor previo. Para limpiar, pasar string vacía.
  const payload = {}
  if (primary)   payload.colors = { ...(payload.colors || {}), primary   }
  if (secondary) payload.colors = { ...(payload.colors || {}), secondary }

  if (!payload.colors) return { synced: false, reason: 'sin_cambios' }

  try {
    await fa.organizations.update(orgId, payload)
    logger.info('[branding] colores sincronizados con Facturapi', { tenantId, orgId })
    return { synced: true, orgId }
  } catch (err) {
    logger.error('[branding] error sincronizando colores', {
      tenantId, orgId, error: err.message,
    })
    const e = new Error(`Facturapi rechazó los colores: ${err.message}`)
    e.status = 502
    throw e
  }
}

/**
 * Sube el logo del tenant a Facturapi. Si el tenant tiene `logo_storage_path`,
 * descarga el archivo del storage propio y lo envía como multipart a Facturapi.
 *
 * Facturapi SDK acepta el logo como Buffer o ReadStream — usamos Buffer.
 */
async function syncLogo(tenantId) {
  const orgId = await getOrgId(tenantId)
  if (!orgId) return { synced: false, reason: 'sin_organizacion_fiscal' }

  const { rows } = await query(
    `SELECT logo_storage_path FROM tenants WHERE id = $1`, [tenantId]
  )
  const key = rows[0]?.logo_storage_path
  if (!key) return { synced: false, reason: 'sin_logo' }

  // Descargar del storage local/R2 como buffer.
  const buffer = await storage.fetchBuffer(key)
  if (!buffer) return { synced: false, reason: 'logo_no_encontrado_en_storage' }

  const fa = adminClient()
  try {
    // Algunas versiones del SDK exponen uploadLogo(), otras solo permiten
    // pasar el buffer al método update. Probamos uploadLogo primero.
    if (typeof fa.organizations.uploadLogo === 'function') {
      await fa.organizations.uploadLogo(orgId, buffer)
    } else {
      // Fallback: PUT directo al endpoint REST de logo.
      // (esto requeriría axios; lo dejamos para futura iteración si fa SDK
      // no expone uploadLogo en esta versión).
      throw new Error('SDK Facturapi no expone organizations.uploadLogo()')
    }
    logger.info('[branding] logo sincronizado con Facturapi', { tenantId, orgId })
    return { synced: true, orgId }
  } catch (err) {
    logger.error('[branding] error subiendo logo a Facturapi', {
      tenantId, orgId, error: err.message,
    })
    const e = new Error(`Facturapi rechazó el logo: ${err.message}`)
    e.status = 502
    throw e
  }
}

/**
 * Sincroniza TODO el branding (logo + colores) en una sola operación.
 * Retorna detalle por cada parte: { logo, colors }.
 */
async function syncAll(tenantId) {
  const { rows } = await query(
    `SELECT brand_color_primary, brand_color_secondary FROM tenants WHERE id = $1`,
    [tenantId]
  )
  const t = rows[0] || {}

  const colorsResult = (t.brand_color_primary || t.brand_color_secondary)
    ? await syncColors(tenantId, {
        primary:   t.brand_color_primary,
        secondary: t.brand_color_secondary,
      }).catch(err => ({ synced: false, reason: 'error', error: err.message }))
    : { synced: false, reason: 'sin_colores' }

  const logoResult = await syncLogo(tenantId)
    .catch(err => ({ synced: false, reason: 'error', error: err.message }))

  return { logo: logoResult, colors: colorsResult }
}

module.exports = { syncColors, syncLogo, syncAll, getOrgId }
