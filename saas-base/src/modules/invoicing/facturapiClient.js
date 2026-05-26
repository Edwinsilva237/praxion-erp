'use strict'

const Facturapi = require('facturapi').default || require('facturapi')
const { query }  = require('../../db')

/**
 * Resuelve la API key de Facturapi a usar según el tenant.
 *
 * Modelo actual (migración 092): cada tenant tiene exactamente UN
 * tenant_fiscal_profile (constraint UNIQUE (tenant_id)). Si el caller
 * pasa `fiscalProfileId`, validamos que sea el profile del tenant.
 *
 * Estrategia de resolución (en orden):
 *   1. Tomar el (único) tenant_fiscal_profile activo del tenant.
 *   2. Si el profile tiene la key correspondiente (live o test según
 *      `tenants.is_sandbox`), se usa esa key per-tenant.
 *   3. Si no hay profile o el campo está vacío, se cae a la variable de
 *      entorno global (`FACTURAPI_KEY` / `FACTURAPI_KEY_TEST`). Esto permite
 *      migración gradual: tenants nuevos configuran su profile, los
 *      existentes siguen funcionando con env.
 *   4. Si tampoco hay env, se lanza error claro.
 *
 * Cache: { tenantId, profileIdOrDefault } → { key, isSandbox, ts }.
 * Llamar `invalidateCache(tenantId)` cuando cambien is_sandbox del tenant
 * o las keys del profile.
 */

const cache = new Map()  // cacheKey → { key, isSandbox, ts }
const TTL_MS = 5 * 60 * 1000

function cacheKey(tenantId, profileId) {
  return `${tenantId}::${profileId || 'default'}`
}

async function isSandboxTenant(tenantId) {
  const { rows } = await query(`SELECT is_sandbox FROM tenants WHERE id = $1`, [tenantId])
  return !!rows[0]?.is_sandbox
}

/**
 * Resuelve { key, isSandbox } para un (tenant, profile) y lo cachea.
 * Si el profile no aplica/no existe/no tiene la key, cae al env global.
 */
async function resolveKey(tenantId, fiscalProfileId) {
  const ck = cacheKey(tenantId, fiscalProfileId)
  const cached = cache.get(ck)
  if (cached && Date.now() - cached.ts < TTL_MS) return cached

  // Cargar tenant + profile en una sola query (evita 2 round-trips).
  // Si fiscalProfileId viene null, traemos el default del tenant.
  // Modelo single-profile: el LEFT JOIN trae el (único) profile activo del
  // tenant. Si pasa fiscalProfileId, se valida que coincida (sino el JOIN
  // queda NULL y caemos al env).
  const { rows } = await query(
    `SELECT t.is_sandbox,
            tfp.facturapi_api_key_live,
            tfp.facturapi_api_key_test
       FROM tenants t
       LEFT JOIN tenant_fiscal_profiles tfp
         ON tfp.tenant_id = t.id
        AND tfp.is_active = TRUE
        AND ($2::uuid IS NULL OR tfp.id = $2::uuid)
      WHERE t.id = $1`,
    [tenantId, fiscalProfileId || null]
  )
  if (!rows.length) throw new Error(`Tenant ${tenantId} no encontrado.`)

  const isSandbox = !!rows[0].is_sandbox
  const profileKey = isSandbox ? rows[0].facturapi_api_key_test : rows[0].facturapi_api_key_live

  let key = profileKey
  if (!key) {
    key = isSandbox ? process.env.FACTURAPI_KEY_TEST : process.env.FACTURAPI_KEY
  }

  if (!key) {
    const envVar = isSandbox ? 'FACTURAPI_KEY_TEST' : 'FACTURAPI_KEY'
    const profileNote = fiscalProfileId
      ? `el profile ${fiscalProfileId} no tiene ${isSandbox ? 'facturapi_api_key_test' : 'facturapi_api_key_live'} configurada`
      : `el profile default del tenant ${tenantId} no tiene la key configurada`
    throw new Error(
      `Facturapi: ${profileNote} y la variable ${envVar} tampoco está set. ` +
      `Configura uno de los dos para que el timbrado funcione.`
    )
  }

  const entry = { key, isSandbox, ts: Date.now() }
  cache.set(ck, entry)
  return entry
}

/**
 * Devuelve una instancia de Facturapi configurada para el tenant.
 *
 * @param {string} tenantId — UUID del tenant. Obligatorio.
 * @param {object} [opts]
 * @param {string} [opts.fiscalProfileId] — UUID del fiscal_profile a usar.
 *        Si se omite, se usa el profile is_default=TRUE del tenant.
 */
async function getFacturapiForTenant(tenantId, opts = {}) {
  if (!tenantId) throw new Error('getFacturapiForTenant requiere tenantId.')
  const { key } = await resolveKey(tenantId, opts.fiscalProfileId)
  return new Facturapi(key)
}

/**
 * Sigue exportada porque otros módulos la consultan para decidir si están
 * en sandbox (ej. para no enviar correos reales).
 */
async function isSandboxTenantCached(tenantId) {
  // Usa el cache global pero solo el campo isSandbox del default profile,
  // que es el dato que históricamente cacheaba esta función.
  const { isSandbox } = await resolveKey(tenantId, null).catch(async () => {
    // Si no hay profile ni env, igual queremos saber si el tenant es sandbox.
    const isSandbox = await isSandboxTenant(tenantId)
    return { isSandbox }
  })
  return isSandbox
}

function invalidateCache(tenantId) {
  if (!tenantId) { cache.clear(); return }
  for (const k of cache.keys()) {
    if (k.startsWith(`${tenantId}::`)) cache.delete(k)
  }
}

module.exports = {
  getFacturapiForTenant,
  isSandboxTenant: isSandboxTenantCached,
  invalidateCache,
}
