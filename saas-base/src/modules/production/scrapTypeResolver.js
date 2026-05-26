'use strict'

/**
 * SaaS v2 — Resolver de tipos de merma del catálogo tenant_scrap_types.
 *
 * Puente entre el flujo legacy (enum `scrap_type` hardcoded: arranque/
 * operacion/contaminada/desecho) y el catálogo configurable de la migración 122.
 *
 * Comportamiento:
 *  - Si viene `scrapTypeId`, busca por ID + tenant. Si no existe o cross-tenant
 *    → throw 400 (explícito: el caller pidió el catálogo).
 *  - Si solo viene `scrapTypeCode`, busca por code + tenant. Si NO se encuentra
 *    (típicamente porque el caller mandó un valor del enum legacy como
 *    'desecho'/'arranque' antes de la migración 122), devuelve null
 *    silenciosamente para que el caller use el fallback legacy.
 *  - Si se encuentra pero está inactivo → throw 400 (catálogo encontrado pero
 *    el usuario quiso usar uno deshabilitado a propósito).
 *
 * Referencia: docs/saas-v2/00-design.md §2.2.5, §6.3 (Recicladora).
 */

/** Mapeo del enum legacy scrap_destination (regrind/mezcla/venta/desecho) al
 *  catalog default_destination (reprocess/discard/sell). Se usa cuando el
 *  caller persiste en la columna legacy `destination`. */
const DESTINATION_LEGACY_MAP = {
  reprocess: 'regrind',
  sell:      'venta',
  discard:   'desecho',
}

/** Mapeo opuesto: cuando el caller manda un destination legacy y queremos
 *  saber qué default_destination del catálogo corresponde. */
const DESTINATION_CATALOG_MAP = {
  regrind:  'reprocess',
  mezcla:   'reprocess',  // mezcla no tiene equivalente directo; lo más cercano
  venta:    'sell',
  desecho:  'discard',
}

/** Valores válidos del enum legacy scrap_type. Si el code del catálogo coincide
 *  con uno de estos, se persiste tal cual en `shift_scrap.scrap_type` (la
 *  columna sigue siendo NOT NULL hasta cleanup migrations). Si no coincide,
 *  se usa 'desecho' como fallback genérico. */
const LEGACY_SCRAP_TYPE_ENUM = new Set(['arranque', 'operacion', 'contaminada', 'desecho'])

/**
 * Resuelve un tipo de merma contra el catálogo `tenant_scrap_types`.
 *
 * @param {object} client  pg client (usar dentro de transacción si aplica)
 * @param {object} args
 * @param {string} args.tenantId
 * @param {string} [args.scrapTypeId]   UUID — path explícito SaaS v2
 * @param {string} [args.scrapTypeCode] code del catálogo o enum legacy
 * @returns {Promise<{ id, code, default_destination, default_recovery_value_pct, is_normal, linked_raw_material_id } | null>}
 *   null si solo se mandó code y NO está en el catálogo (fallback legacy).
 */
async function resolveScrapType(client, { tenantId, scrapTypeId, scrapTypeCode }) {
  if (!tenantId) {
    const err = new Error('tenantId es requerido para resolveScrapType.')
    err.status = 500
    throw err
  }
  if (!scrapTypeId && !scrapTypeCode) {
    const err = new Error('Se requiere scrapTypeId o scrapTypeCode.')
    err.status = 400
    throw err
  }

  if (scrapTypeId) {
    const { rows } = await client.query(
      `SELECT id, code, default_destination, default_recovery_value_pct,
              is_normal, linked_raw_material_id, is_active
       FROM tenant_scrap_types
       WHERE id = $1 AND tenant_id = $2`,
      [scrapTypeId, tenantId]
    )
    if (rows.length === 0) {
      const err = new Error(`scrapTypeId no existe en este tenant.`)
      err.status = 400
      throw err
    }
    if (!rows[0].is_active) {
      const err = new Error(`El tipo de merma "${rows[0].code}" está inactivo.`)
      err.status = 400
      throw err
    }
    return rows[0]
  }

  // Solo scrapTypeCode — búsqueda silenciosa.
  const { rows } = await client.query(
    `SELECT id, code, default_destination, default_recovery_value_pct,
            is_normal, linked_raw_material_id, is_active
     FROM tenant_scrap_types
     WHERE tenant_id = $1 AND code = $2`,
    [tenantId, scrapTypeCode]
  )
  if (rows.length === 0) return null
  if (!rows[0].is_active) {
    // Code corresponde a un catalog row pero inactivo: tratamos como "no
    // encuentra" para que el caller use fallback legacy (e.g. cuando el
    // tenant desactivó 'desecho' del catálogo pero el operador escribió ese
    // string desde un cliente viejo).
    return null
  }
  return rows[0]
}

/**
 * Dado un row resuelto del catálogo, devuelve el valor del enum legacy
 * `scrap_type` que se debe persistir en `shift_scrap.scrap_type` (NOT NULL).
 * Si el code está en el enum legacy, lo retorna tal cual; si no, retorna
 * 'desecho' como fallback genérico.
 */
function legacyScrapTypeFor(catalogRow) {
  if (!catalogRow) return null
  if (LEGACY_SCRAP_TYPE_ENUM.has(catalogRow.code)) return catalogRow.code
  return 'desecho'
}

/**
 * Dado un row resuelto del catálogo, devuelve el valor del enum legacy
 * `scrap_destination` (regrind/mezcla/venta/desecho) según `default_destination`.
 */
function legacyDestinationFor(catalogRow) {
  if (!catalogRow) return null
  return DESTINATION_LEGACY_MAP[catalogRow.default_destination] || 'desecho'
}

module.exports = {
  resolveScrapType,
  legacyScrapTypeFor,
  legacyDestinationFor,
  DESTINATION_LEGACY_MAP,
  DESTINATION_CATALOG_MAP,
  LEGACY_SCRAP_TYPE_ENUM,
}
