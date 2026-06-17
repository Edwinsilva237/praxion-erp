'use strict'

/**
 * Ingesta de correo entrante de facturas (Cloudflare Email Worker → API).
 *
 * El Worker recibe un correo a `<token>@inbox.praxionops.com`, extrae el adjunto
 * (CFDI XML o PDF) y lo manda aquí. Este servicio:
 *   1. Resuelve el tenant por el token (ruteo).
 *   2. Parsea el documento con el parser que YA existe (documentParserService).
 *   3. Candado de seguridad: el RFC receptor del CFDI debe ser un RFC del tenant.
 *   4. Empareja al proveedor por RFC emisor (o lo deja como genérico).
 *   5. Da de alta el gasto con anti-duplicado por UUID (idempotente: el correo
 *      puede llegar dos veces → el 2º intento NO duplica).
 *
 * NO requiere sesión de usuario — lo protege un secret compartido en la ruta.
 */

const { query } = require('../../db')
const documentParserService = require('../purchases/documentParserService')
const supplierInvoiceService = require('../purchases/supplierInvoiceService')
const logger = require('../../config/logger')

function err(status, message) { const e = new Error(message); e.status = status; return e }
function normRfc(r) { return (r || '').toUpperCase().replace(/\s+/g, '').trim() }

const INBOUND_DOMAIN = process.env.INBOUND_EMAIL_DOMAIN || 'inbox.praxionops.com'

/** Dirección de correo entrante de un tenant a partir de su token. */
function addressForToken(token) { return `${token}@${INBOUND_DOMAIN}` }

/**
 * Dirección de buzón del tenant (para mostrarla en Gastos → Config).
 * `active` indica si el pipeline está habilitado en el servidor (hay secret).
 */
async function getInboxAddress(tenantId) {
  const { rows } = await query(
    `SELECT inbound_email_token FROM tenants WHERE id = $1`, [tenantId])
  if (!rows.length) throw err(404, 'Tenant no encontrado.')
  const token = rows[0].inbound_email_token
  return {
    token,
    address: addressForToken(token),
    domain: INBOUND_DOMAIN,
    active: !!process.env.INBOUND_INGEST_SECRET,
  }
}

/**
 * Genera una dirección nueva (invalida la anterior) en el formato legible
 * <slug>.<código6>: conserva el nombre de la empresa y rota solo el código corto.
 * Reintenta ante el caso astronómicamente improbable de colisión con el UNIQUE.
 */
async function rotateInboxToken(tenantId) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const { rows } = await query(
        `UPDATE tenants
            SET inbound_email_token =
              regexp_replace(lower(slug), '[^a-z0-9_-]', '', 'g')
              || '.' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 6)
          WHERE id = $1
        RETURNING inbound_email_token`, [tenantId])
      if (!rows.length) throw err(404, 'Tenant no encontrado.')
      logger.info('inbound: dirección de buzón rotada', { tenantId })
      return {
        token: rows[0].inbound_email_token,
        address: addressForToken(rows[0].inbound_email_token),
        domain: INBOUND_DOMAIN,
        active: !!process.env.INBOUND_INGEST_SECRET,
      }
    } catch (e) {
      if (e.code === '23505') continue   // colisión de token: reintenta
      throw e
    }
  }
  throw err(500, 'No se pudo generar una dirección nueva, intenta de nuevo.')
}

/**
 * Procesa UN adjunto recibido por correo.
 * @param {object} p
 * @param {string} p.token         token del buzón (rutea al tenant)
 * @param {string} p.filename      nombre del adjunto (para detectar xml/pdf)
 * @param {string} p.mimetype      mime del adjunto
 * @param {string} p.contentBase64 contenido del adjunto en base64
 * @param {string} [p.from]        remitente del correo (solo para la nota)
 * @returns {{status:'created'|'duplicate', ...}}
 */
async function ingestInboundDocument({ token, filename, mimetype, contentBase64, from = null }) {
  if (!token) throw err(400, 'token requerido.')
  if (!contentBase64) throw err(400, 'contenido del adjunto requerido.')

  // 1. Resolver tenant por token.
  const { rows: t } = await query(
    `SELECT id, slug, name FROM tenants WHERE inbound_email_token = $1`, [token])
  if (!t.length) throw err(404, 'Token de buzón no reconocido.')
  const tenant = t[0]

  // 2. Parsear el adjunto (reusa el parser de CFDI/PDF).
  const buffer = Buffer.from(contentBase64, 'base64')
  let parsed
  try {
    parsed = await documentParserService.parseSupplierDocument(
      buffer, mimetype || '', filename || '')
  } catch (e) {
    logger.warn('inbound: documento ilegible', { tenant: tenant.slug, filename, error: e.message })
    throw err(422, 'No se pudo leer el documento (¿es un CFDI XML o PDF?).')
  }

  // 3. Candado: el RFC receptor del CFDI debe coincidir con un RFC del tenant
  //    (si el tenant tiene RFC configurado). Evita que alguien inyecte facturas
  //    ajenas aunque adivinara el token.
  const receptorRfc = normRfc(parsed?.receptor?.rfc)
  const { rows: rfcRows } = await query(
    `SELECT rfc FROM tenant_fiscal_profiles WHERE tenant_id = $1 AND is_active = true`, [tenant.id])
  const tenantRfcs = rfcRows.map(r => normRfc(r.rfc)).filter(Boolean)
  if (tenantRfcs.length && receptorRfc && !tenantRfcs.includes(receptorRfc)) {
    logger.warn('inbound: RFC receptor no coincide con el tenant', {
      tenant: tenant.slug, receptorRfc })
    throw err(403, 'El RFC receptor del CFDI no corresponde a este tenant.')
  }

  // 4. Match de proveedor por RFC emisor (supplier/both). Si no, gasto genérico.
  const emisorRfc = normRfc(parsed?.emisor?.rfc)
  let supplierId = null, genericSupplier = null
  if (emisorRfc) {
    const { rows: bp } = await query(
      `SELECT id FROM business_partners
        WHERE tenant_id = $1 AND UPPER(REPLACE(rfc, ' ', '')) = $2
          AND type IN ('supplier', 'both') AND is_active = true
        LIMIT 1`,
      [tenant.id, emisorRfc])
    if (bp[0]) supplierId = bp[0].id
  }
  if (!supplierId) genericSupplier = parsed?.emisor?.name || 'Proveedor (correo)'

  // created_by / audit: atribuir al owner del tenant (no hay sesión de usuario).
  const { rows: ow } = await query(
    `SELECT user_id FROM tenant_memberships
      WHERE tenant_id = $1 AND role = 'owner' ORDER BY created_at LIMIT 1`, [tenant.id])
  const userId = ow[0]?.user_id || null

  // 5. Alta del GASTO (anti-dup por UUID dentro de registerInvoice → 409 idempotente).
  //    El correo SIEMPRE crea un gasto (reversible). Si es mercancía que cuadra con
  //    una recepción, el detalle del gasto SUGIERE vincularla (no se liga sola: la
  //    liga es irreversible y la confirma un humano). Ver suggestReceiptForExpense.
  const subtotal = Number(parsed?.subtotal || 0)
  const tax      = Number(parsed?.tax || 0)
  const total    = Number(parsed?.total || (subtotal + tax))
  const docNumber = [parsed?.serie, parsed?.folio].filter(Boolean).join('-') || `GASTO-${Date.now()}`
  const invoiceDate = parsed?.invoiceDate || new Date().toISOString().slice(0, 10)

  try {
    const expense = await supplierInvoiceService.registerInvoice({
      tenantId: tenant.id, supplierId, genericSupplier,
      currency: parsed?.currency || 'MXN',
      documentNumber: docNumber,
      uuidSat: parsed?.uuid || null,
      serie: parsed?.serie || null, folio: parsed?.folio || null,
      rfcEmisor: parsed?.emisor?.rfc || null,
      subtotal, tax, total,
      invoiceDate,
      creditDays: 0,             // → auto: días de crédito del proveedor (si lo hay)
      isExpense: true,
      expenseCategoryId: null,   // sin categoría: el usuario la clasifica al revisar
      notes: `Recibido por correo${from ? ` de ${from}` : ''}`,
      userId,
    })
    logger.info('inbound: gasto creado', {
      tenant: tenant.slug, expenseId: expense.id, uuid: parsed?.uuid || null, supplierId })
    return {
      status: 'created', expenseId: expense.id, tenant: tenant.slug,
      supplierMatched: !!supplierId, uuid: parsed?.uuid || null,
    }
  } catch (e) {
    if (e.status === 409) {
      // Duplicado por UUID → idempotente (el correo pudo llegar dos veces).
      logger.info('inbound: documento duplicado (idempotente)', {
        tenant: tenant.slug, uuid: parsed?.uuid || null })
      return { status: 'duplicate', tenant: tenant.slug, uuid: parsed?.uuid || null }
    }
    throw e
  }
}

module.exports = { ingestInboundDocument, addressForToken, getInboxAddress, rotateInboxToken }
