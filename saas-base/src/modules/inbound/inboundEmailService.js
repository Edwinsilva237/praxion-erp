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
const { unzipSync } = require('fflate')
const documentParserService = require('../purchases/documentParserService')
const supplierInvoiceService = require('../purchases/supplierInvoiceService')
const attachmentService = require('../attachments/attachmentService')
const logger = require('../../config/logger')

function err(status, message) { const e = new Error(message); e.status = status; return e }
function normRfc(r) { return (r || '').toUpperCase().replace(/\s+/g, '').trim() }

// ── Expansión de adjuntos comprimidos (.zip) ───────────────────────────────
// Los CFDI suelen llegar zippeados (XML + PDF juntos, a veces varios CFDI). Aquí
// descomprimimos y nos quedamos con los XML/PDF de adentro. Preferimos el XML (la
// representación BUENA del CFDI); si el zip no trae XML, caemos al/los PDF. Guardas
// anti-zip-bomb: tope de entradas procesadas y de tamaño por entrada.
const ARCHIVE_MAX_ENTRIES = 50
const ARCHIVE_MAX_ENTRY_BYTES = 15 * 1024 * 1024   // 15 MiB por archivo interno

function isZip(att) {
  const mt = (att.mimetype || '').toLowerCase()
  const name = (att.filename || '').toLowerCase()
  return mt.includes('zip') || name.endsWith('.zip')
}

/** Expande UN adjunto: si es .zip → [XML/PDF internos]; si no → [el adjunto tal cual]. */
function expandAttachment(att) {
  if (!att || !att.contentBase64) return []
  if (!isZip(att)) return [att]

  let files
  try {
    files = unzipSync(Buffer.from(att.contentBase64, 'base64'))
  } catch (e) {
    logger.warn('inbound: zip ilegible, se omite', { filename: att.filename, error: e.message })
    return []   // zip corrupto → nada que procesar (el lote sigue con lo demás)
  }

  const inner = []
  let count = 0
  for (const [name, bytes] of Object.entries(files)) {
    const lower = name.toLowerCase()
    if (lower.endsWith('/')) continue                                  // directorio
    if (lower.startsWith('__macosx/') || lower.includes('/._')) continue  // basura de macOS
    const isXml = lower.endsWith('.xml')
    const isPdf = lower.endsWith('.pdf')
    if (!isXml && !isPdf) continue
    if (bytes.length > ARCHIVE_MAX_ENTRY_BYTES) {
      logger.warn('inbound: entrada de zip demasiado grande, se omite', { name, bytes: bytes.length })
      continue
    }
    if (++count > ARCHIVE_MAX_ENTRIES) break
    inner.push({
      filename: name.split('/').pop(),
      mimetype: isXml ? 'application/xml' : 'application/pdf',
      contentBase64: Buffer.from(bytes).toString('base64'),
      _isXml: isXml,
    })
  }

  // Preferir XML: si hay al menos un XML, NO lo procesamos dos veces con el PDF
  // (versión impresa del mismo CFDI). Pero el PDF SÍ lo conservamos como respaldo
  // adjunto: el caso común es 1 XML + su PDF → procesamos el XML (crea el gasto)
  // y pegamos el PDF como `siblings` para que el gasto guarde ambos archivos.
  // Con varios XML no podemos saber qué PDF corresponde a cuál → sin siblings.
  const strip = ({ _isXml, ...a }) => a
  const xmls = inner.filter(a => a._isXml)
  const pdfs = inner.filter(a => !a._isXml)
  if (xmls.length === 1 && pdfs.length) {
    return [{ ...strip(xmls[0]), siblings: pdfs.map(strip) }]
  }
  const chosen = xmls.length ? xmls : inner
  return chosen.map(strip)
}

// ── Respaldo del CFDI (XML/PDF) pegado al gasto ─────────────────────────────
// El buzón antes leía el CFDI y tiraba el archivo. Ahora lo guardamos como
// adjunto (categoría 'cfdi') del supplier_invoice/gasto para consultarlo y
// descargarlo después. Best-effort: si el storage falla NO rompe la ingesta —
// el gasto ya existe y un respaldo faltante no es fatal.

/** Normaliza el mimetype a partir de la extensión/mime (los correos a veces
 *  mandan application/octet-stream) para que pase la validación de 'cfdi'. */
function cfdiMime(filename, mimetype) {
  const name = (filename || '').toLowerCase()
  if (name.endsWith('.xml')) return 'application/xml'
  if (name.endsWith('.pdf')) return 'application/pdf'
  const mt = (mimetype || '').toLowerCase()
  if (mt.includes('xml')) return 'application/xml'
  if (mt.includes('pdf')) return 'application/pdf'
  return null
}

/** Tipos de respaldo (xml/pdf) que el gasto YA tiene — para no duplicar si el
 *  correo llega repetido (mismo XML dos veces) o llega el XML y luego el PDF. */
async function loadExistingCfdiKinds(tenantId, invoiceId) {
  const kinds = new Set()
  try {
    const { rows } = await query(
      `SELECT mime_type, filename FROM attachments
        WHERE tenant_id = $1 AND entity_type = 'supplier_invoice'
          AND entity_id = $2 AND category = 'cfdi'`,
      [tenantId, invoiceId])
    for (const r of rows) {
      const mt = (r.mime_type || '').toLowerCase()
      const fn = (r.filename || '').toLowerCase()
      if (mt.includes('xml') || fn.endsWith('.xml')) kinds.add('xml')
      if (mt.includes('pdf') || fn.endsWith('.pdf')) kinds.add('pdf')
    }
  } catch { /* best-effort: si falla, intentamos guardar igual */ }
  return kinds
}

/** Guarda UN archivo (XML/PDF) como respaldo del gasto, si su tipo no estaba ya. */
async function storeCfdiBackup({ tenantId, invoiceId, filename, mimetype, contentBase64, userId, kinds }) {
  const mime = cfdiMime(filename, mimetype)
  if (!mime) return
  const kind = mime.includes('xml') ? 'xml' : 'pdf'
  if (kinds.has(kind)) return                 // ya hay un respaldo de ese tipo
  try {
    await attachmentService.saveAttachment({
      tenantId, entityType: 'supplier_invoice', entityId: invoiceId,
      category: 'cfdi',
      originalFilename: filename || (kind === 'xml' ? 'cfdi.xml' : 'cfdi.pdf'),
      buffer: Buffer.from(contentBase64, 'base64'),
      mimeType: mime, uploadedBy: userId,
    })
    kinds.add(kind)
  } catch (e) {
    logger.warn('inbound: no se pudo guardar el respaldo del CFDI', {
      tenantId, invoiceId, filename, error: e.message })
  }
}

function attIsXml(a) {
  return /xml/i.test(a?.mimetype || '') || /\.xml$/i.test(a?.filename || '')
}
function attIsPdf(a) {
  return /pdf/i.test(a?.mimetype || '') || /\.pdf$/i.test(a?.filename || '')
}

/**
 * Expande una lista de adjuntos (descomprime los .zip) y PREFIERE el XML cuando el
 * correo trae el XML y su PDF impreso como adjuntos SEPARADOS (no zippeados): procesa
 * SÓLO el XML (la representación buena del CFDI) y conserva el/los PDF como respaldo
 * (`siblings`) — la MISMA regla que ya aplica la ruta del .zip (ver expandAttachment).
 *
 * Sin esto, si el PDF venía ANTES que el XML en el correo, el parser de texto (frágil)
 * creaba el gasto sin nombre de emisor ("Proveedor (correo)") y el XML posterior se
 * descartaba como duplicado por UUID. Sólo aplica al caso inequívoco 1 XML + N PDF;
 * con varios XML no se puede correlacionar qué PDF va con cuál → se procesan todos
 * como antes (cada XML crea/dedup su gasto y su PDF hermano deduplica por UUID).
 */
function expandAttachments(list) {
  const flat = (list || []).flatMap(expandAttachment)
  const xmls = flat.filter(attIsXml)
  const pdfs = flat.filter(a => !attIsXml(a) && attIsPdf(a))
  if (xmls.length === 1 && pdfs.length) {
    const primary = xmls[0]
    return [{ ...primary, siblings: [...(primary.siblings || []), ...pdfs] }]
  }
  return flat
}

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
 * @param {Array}  [p.siblings]    archivos hermanos a guardar como respaldo junto
 *                                 al mismo gasto (p.ej. el PDF impreso del XML).
 * @returns {{status:'created'|'duplicate', ...}}
 */
async function ingestInboundDocument({ token, filename, mimetype, contentBase64, from = null, siblings = [] }) {
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

  let invoiceId = null
  let result
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
    invoiceId = expense.id
    logger.info('inbound: gasto creado', {
      tenant: tenant.slug, expenseId: expense.id, uuid: parsed?.uuid || null, supplierId })
    result = {
      status: 'created', expenseId: expense.id, tenant: tenant.slug,
      supplierMatched: !!supplierId, uuid: parsed?.uuid || null,
    }
  } catch (e) {
    if (e.status !== 409) throw e
    // Duplicado por UUID → idempotente (el correo pudo llegar dos veces). Igual
    // resolvemos el gasto existente para pegarle el respaldo si aún no lo tenía
    // (p.ej. primero llegó el XML y ahora llega el PDF en otro correo).
    logger.info('inbound: documento duplicado (idempotente)', {
      tenant: tenant.slug, uuid: parsed?.uuid || null })
    if (parsed?.uuid) {
      const { rows } = await query(
        `SELECT id FROM supplier_invoices WHERE tenant_id = $1 AND uuid_sat = $2 LIMIT 1`,
        [tenant.id, parsed.uuid])
      invoiceId = rows[0]?.id || null
    }
    result = { status: 'duplicate', tenant: tenant.slug, uuid: parsed?.uuid || null }
  }

  // Respaldo descargable del CFDI: guarda el archivo recibido (y su PDF hermano,
  // si vino zippeado con el XML) pegado al gasto. Best-effort — no rompe la ingesta.
  if (invoiceId) {
    const kinds = await loadExistingCfdiKinds(tenant.id, invoiceId)
    await storeCfdiBackup({ tenantId: tenant.id, invoiceId, filename, mimetype, contentBase64, userId, kinds })
    for (const sib of (siblings || [])) {
      await storeCfdiBackup({
        tenantId: tenant.id, invoiceId,
        filename: sib.filename, mimetype: sib.mimetype, contentBase64: sib.contentBase64,
        userId, kinds,
      })
    }
  }
  return result
}

module.exports = {
  ingestInboundDocument, expandAttachments,
  addressForToken, getInboxAddress, rotateInboxToken,
}
