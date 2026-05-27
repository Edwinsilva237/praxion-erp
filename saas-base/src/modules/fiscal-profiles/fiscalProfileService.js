'use strict'

const Facturapi = require('facturapi').default
const { query, withTransaction } = require('../../db')
const { audit } = require('../../utils/audit')
const { invalidateCache: invalidateFacturapiCache } = require('../invoicing/facturapiClient')

function createError(status, message) {
  const err = new Error(message)
  err.status = status
  return err
}

/**
 * Cliente de Facturapi para administración GLOBAL (organizations).
 *
 * IMPORTANTE: Facturapi tiene dos tipos de keys:
 *   - User Secret Key (FACTURAPI_USER_KEY): permite ADMINISTRAR organizations
 *     (crear, listar, subir CSD). Se obtiene en Dashboard → Configuración → API.
 *   - Organization Key (FACTURAPI_KEY): solo emite CFDIs DESDE esa organization.
 *     NO sirve para crear orgs ni subir CSDs.
 *
 * Si intentas crear/subir con la organization key, Facturapi responde:
 *   "Estás intentando consumir este recurso utilizando la API Key de una
 *    organización. Para administrar organizaciones debes usar tu llave
 *    secreta de usuario (User Secret Key)."
 */
function adminFacturapi() {
  const key = process.env.FACTURAPI_USER_KEY
  if (!key) {
    throw createError(500,
      'FACTURAPI_USER_KEY no está configurada en el servidor. ' +
      'Esta llave es necesaria para crear organizations y subir CSDs. ' +
      'Obténla en Facturapi → Dashboard → Configuración → API → Llave Secreta de Usuario.')
  }
  return new Facturapi(key)
}

/**
 * Cliente de Facturapi para una organization específica (un profile/RFC).
 * Usa la api key del profile según si el tenant es sandbox.
 */
async function getFacturapiForProfile({ tenantId, fiscalProfileId }) {
  // Tenant sandbox flag
  const { rows: tRows } = await query(
    `SELECT is_sandbox FROM tenants WHERE id = $1`, [tenantId]
  )
  const isSandbox = tRows[0]?.is_sandbox === true

  // Resolver profile: el dado o el default del tenant
  const profile = await getProfile({ tenantId, profileId: fiscalProfileId })
  if (!profile) {
    throw createError(400,
      'No hay un emisor fiscal (RFC) configurado. Ve a Configuración → Emisores fiscales.')
  }

  const key = isSandbox ? profile.facturapi_api_key_test : profile.facturapi_api_key_live
  if (!key) {
    throw createError(400,
      `El emisor "${profile.tax_name}" no tiene configurada la API key de ` +
      (isSandbox ? 'PRUEBAS' : 'PRODUCCIÓN') +
      '. Edítalo en Configuración → Emisores fiscales.')
  }
  return { facturapi: new Facturapi(key), profile, isSandbox }
}

/**
 * Devuelve un profile específico o el default del tenant si no se especifica.
 */
async function getProfile({ tenantId, profileId }) {
  // Cada tenant tiene exactamente 1 profile fiscal (UNIQUE en BD).
  // El parámetro profileId es opcional — sirve como sanity check si viene.
  const { rows } = await query(
    `SELECT * FROM tenant_fiscal_profiles
      WHERE tenant_id = $1 AND is_active = TRUE
      LIMIT 1`,
    [tenantId]
  )
  if (!rows[0]) return null
  if (profileId && rows[0].id !== profileId) {
    // pedido profile específico pero no coincide → no devolver
    return null
  }
  return rows[0]
}

/**
 * Devuelve el profile fiscal del tenant (siempre 0 o 1, nunca más).
 * Aliasamos como listProfiles para compat con frontend pero estructura
 * pensada para 1 solo.
 */
async function listProfiles({ tenantId }) {
  const { rows } = await query(
    `SELECT id, rfc, tax_name, tax_regime, zip_code, serie, folio_next,
            facturapi_organization_id,
            CASE WHEN facturapi_api_key_live  IS NOT NULL THEN TRUE ELSE FALSE END AS has_live_key,
            CASE WHEN facturapi_api_key_test  IS NOT NULL THEN TRUE ELSE FALSE END AS has_test_key,
            facturapi_certificate_status, facturapi_certificate_expires_at,
            is_active, notes, created_at, updated_at
       FROM tenant_fiscal_profiles
      WHERE tenant_id = $1
      ORDER BY is_active DESC, created_at ASC`,
    [tenantId]
  )
  return rows
}

/**
 * Crea un profile. Opcionalmente crea también la organization en Facturapi
 * si se pasa `createInFacturapi: true`.
 */
async function createProfile({
  tenantId, rfc, taxName, taxRegime, zipCode, serie,
  facturapiOrganizationId, facturapiApiKeyLive, facturapiApiKeyTest,
  notes,
  createInFacturapi = false,
  userId, ipAddress, userAgent,
}) {
  if (!rfc || !taxName || !taxRegime || !zipCode) {
    throw createError(400, 'rfc, taxName, taxRegime y zipCode son requeridos.')
  }
  rfc = rfc.toUpperCase().trim()

  let orgId   = facturapiOrganizationId || null
  let keyTest = facturapiApiKeyTest || null
  let keyLive = facturapiApiKeyLive || null

  // Crear organization en Facturapi automáticamente.
  //
  // Facturapi v4 separó la creación en 2 llamadas:
  //   1. organizations.create({ name })      — crea la org con el nombre.
  //   2. organizations.updateLegal(id, {...}) — setea RFC, régimen, CP, etc.
  //
  // Si todo va bien, también obtenemos la test key automáticamente.
  if (createInFacturapi && !orgId) {
    const fa = adminFacturapi()
    let org
    try {
      org = await fa.organizations.create({ name: taxName })
    } catch (e) {
      const msg = e.message || ''
      // Casos típicos:
      //  - "llave inválida" / "Invalid API key" → key del .env mal
      //  - "Estás intentando consumir... API Key de una organización" → pusieron sk_test_ en vez de sk_user_
      if (/invalid api key|llave inválida|llave invalida|api key/i.test(msg)) {
        throw createError(500,
          'La FACTURAPI_USER_KEY del servidor no es válida. ' +
          'Verifica en .env que sea la "Llave Secreta de Usuario" (sk_user_...), ' +
          'NO la llave de una organización (sk_test_/sk_live_). Reinicia el backend tras cambiarla.')
      }
      if (/organización|organization/i.test(msg) && /user/i.test(msg)) {
        throw createError(500,
          'FACTURAPI_USER_KEY apunta a una organization, no a un usuario. ' +
          'Necesitas la "Llave Secreta de Usuario" (sk_user_...) — la obtienes en ' +
          'Facturapi → Mi cuenta → API. Reinicia el backend tras corregirla.')
      }
      throw createError(400, `Facturapi rechazó la creación de la organization: ${msg}`)
    }
    orgId = org.id

    // Paso 2: setear datos legales (razón social, régimen, CP).
    // El RFC (tax_id) NO se manda aquí — Facturapi lo asigna automáticamente
    // cuando se sube el CSD (lo lee del propio certificado).
    let legalWarning = null
    try {
      await fa.organizations.updateLegal(orgId, {
        name:        taxName,
        legal_name:  taxName,
        tax_system:  taxRegime,
        address: { zip: zipCode },
      })
    } catch (e) {
      // No abortamos: la org existe, guardamos su id, el usuario puede
      // corregir datos legales desde Facturapi o reeditar el profile.
      legalWarning = `Org creada pero datos legales no se aplicaron: ${e.message}`
    }

    // Test key se obtiene automáticamente.
    try {
      const test = await fa.organizations.getTestApiKey(orgId)
      keyTest = typeof test === 'string' ? test : (test?.key || test?.api_key || null)
    } catch (e) {
      // no bloqueante — el usuario podrá renovarla manualmente luego
    }

    if (legalWarning) {
      // Anexa la advertencia a las notas para que quede registrada.
      notes = (notes || '') + (notes ? '\n' : '') + `[${new Date().toISOString().slice(0,10)}] ${legalWarning}`
    }
  }

  return withTransaction(async (client) => {
    // Validar que el tenant aún no tenga profile (constraint también lo cubre).
    const { rows: existing } = await client.query(
      `SELECT id FROM tenant_fiscal_profiles WHERE tenant_id = $1`, [tenantId]
    )
    if (existing.length > 0) {
      throw createError(409,
        'Este tenant ya tiene un emisor fiscal configurado. Edítalo en lugar de crear uno nuevo.')
    }

    const { rows } = await client.query(
      `INSERT INTO tenant_fiscal_profiles
         (tenant_id, rfc, tax_name, tax_regime, zip_code, serie,
          facturapi_organization_id, facturapi_api_key_live, facturapi_api_key_test,
          notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING *`,
      [tenantId, rfc, taxName.trim(), taxRegime.trim(), zipCode.trim(), serie?.trim() || null,
       orgId, keyLive, keyTest,
       notes || null, userId]
    )

    // Crear automáticamente la serie default — sin ella el primer intento
    // de emisión fallaría con "perfil sin series". Espejo del backfill de 147.
    // Desde la 148 la tabla es tenant_document_series discriminada por entity_type.
    const defaultSerie = serie?.trim() || 'A'
    await client.query(
      `INSERT INTO tenant_document_series
         (tenant_id, entity_type, fiscal_profile_id, serie, folio_next,
          is_default, is_active, notes, created_by)
       VALUES ($1, 'invoice', $2, $3, 1, TRUE, TRUE, $4, $5)
       ON CONFLICT DO NOTHING`,
      [tenantId, rows[0].id, defaultSerie, 'Serie creada automáticamente al provisionar el perfil fiscal.', userId]
    )

    await audit({
      tenantId, userId, action: 'fiscal_profile.created',
      resource: 'tenant_fiscal_profiles', resourceId: rows[0].id,
      payload: { rfc, taxName, createInFacturapi, orgId },
      ipAddress, userAgent,
    })

    invalidateFacturapiCache(tenantId)
    return rows[0]
  })
}

async function updateProfile({
  tenantId, profileId,
  rfc, taxName, taxRegime, zipCode, serie,
  facturapiOrganizationId, facturapiApiKeyLive, facturapiApiKeyTest,
  isActive, notes,
  userId, ipAddress, userAgent,
}) {
  const { rows } = await query(
    `UPDATE tenant_fiscal_profiles SET
       rfc                          = COALESCE($1, rfc),
       tax_name                     = COALESCE($2, tax_name),
       tax_regime                   = COALESCE($3, tax_regime),
       zip_code                     = COALESCE($4, zip_code),
       serie                        = COALESCE($5, serie),
       facturapi_organization_id    = COALESCE($6, facturapi_organization_id),
       facturapi_api_key_live       = COALESCE($7, facturapi_api_key_live),
       facturapi_api_key_test       = COALESCE($8, facturapi_api_key_test),
       is_active                    = COALESCE($9, is_active),
       notes                        = COALESCE($10, notes)
     WHERE id = $11 AND tenant_id = $12
     RETURNING *`,
    [rfc?.toUpperCase().trim() || null, taxName?.trim() || null, taxRegime?.trim() || null,
     zipCode?.trim() || null, serie?.trim() || null,
     facturapiOrganizationId || null, facturapiApiKeyLive || null, facturapiApiKeyTest || null,
     isActive === undefined ? null : isActive,
     notes || null,
     profileId, tenantId]
  )
  if (!rows.length) throw createError(404, 'Emisor fiscal no encontrado.')

  await audit({
    tenantId, userId, action: 'fiscal_profile.updated',
    resource: 'tenant_fiscal_profiles', resourceId: profileId,
    payload: { isActive }, ipAddress, userAgent,
  })

  invalidateFacturapiCache(tenantId)
  return rows[0]
}

async function deleteProfile({ tenantId, profileId, userId, ipAddress, userAgent }) {
  // No borrar — solo desactivar (las facturas históricas lo referencian).
  const { rows } = await query(
    `UPDATE tenant_fiscal_profiles SET is_active = FALSE
      WHERE id = $1 AND tenant_id = $2 RETURNING id, rfc`,
    [profileId, tenantId]
  )
  if (!rows.length) throw createError(404, 'Emisor fiscal no encontrado.')

  await audit({
    tenantId, userId, action: 'fiscal_profile.deactivated',
    resource: 'tenant_fiscal_profiles', resourceId: profileId,
    payload: { rfc: rows[0].rfc }, ipAddress, userAgent,
  })

  invalidateFacturapiCache(tenantId)
  return rows[0]
}

/**
 * Sube el CSD (.cer, .key) + password a Facturapi para la organization del
 * profile. NO guardamos archivos ni password en nuestra BD — todo vive en
 * Facturapi.
 *
 * @param {Buffer} cerBuffer
 * @param {Buffer} keyBuffer
 * @param {string} password
 */
async function uploadCertificate({
  tenantId, profileId, cerBuffer, keyBuffer, password,
  userId, ipAddress, userAgent,
}) {
  const { rows } = await query(
    `SELECT id, rfc, facturapi_organization_id FROM tenant_fiscal_profiles
      WHERE id = $1 AND tenant_id = $2`,
    [profileId, tenantId]
  )
  if (!rows.length) throw createError(404, 'Emisor fiscal no encontrado.')
  const profile = rows[0]
  if (!profile.facturapi_organization_id) {
    throw createError(400, 'El emisor no tiene organization de Facturapi configurada.')
  }

  const fa = adminFacturapi()
  try {
    await fa.organizations.uploadCertificate(
      profile.facturapi_organization_id,
      cerBuffer, keyBuffer, password
    )
  } catch (e) {
    throw createError(400, `Facturapi rechazó el CSD: ${e.message}`)
  }

  await query(
    `UPDATE tenant_fiscal_profiles
        SET facturapi_certificate_status = 'uploaded'
      WHERE id = $1`,
    [profileId]
  )

  await audit({
    tenantId, userId, action: 'fiscal_profile.certificate_uploaded',
    resource: 'tenant_fiscal_profiles', resourceId: profileId,
    payload: { rfc: profile.rfc, organizationId: profile.facturapi_organization_id },
    ipAddress, userAgent,
  })
  return { uploaded: true }
}

module.exports = {
  adminFacturapi,
  getFacturapiForProfile,
  getProfile,
  listProfiles,
  createProfile,
  updateProfile,
  deleteProfile,
  uploadCertificate,
}
