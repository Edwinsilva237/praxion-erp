'use strict'

/**
 * Importación de facturas EMITIDAS timbradas en OTRO sistema (migración de
 * cartera). El CFDI ya existe ante el SAT — aquí NO se timbra nada: la factura
 * se registra directamente como `stamped` con `source='imported'` y genera su
 * cuenta por cobrar para entrar a cartera/antigüedad/cobranza.
 *
 * Flujo en 2 pasos (espejo del import de gastos, pero con PREVIEW editable
 * porque el XML no trae el saldo actual ni las parcialidades de REP emitidas):
 *   1. parseBatch  → lee los XML y devuelve una fila por factura (sin guardar):
 *      cliente emparejado por RFC receptor, duplicados, errores.
 *   2. importBatch → registra las válidas. `adjustments[uuid]` permite indicar
 *      por factura: { balance, installments } — saldo insoluto real (moneda de
 *      la factura) y nº de parcialidades de REP ya emitidas allá. Sin ajuste:
 *      balance = total (nada cobrado) e installments = 0.
 *
 * Candados: el RFC EMISOR debe ser un RFC del tenant (es una factura que TÚ
 * emitiste); solo CFDI de Ingreso (tipo I); anti-dup por cfdi_uuid (UNIQUE).
 */

const { query, withTransaction } = require('../../db')
const documentParserService = require('../purchases/documentParserService')
const { expandAttachments } = require('../inbound/inboundEmailService')
const attachmentService = require('../attachments/attachmentService')
const { audit } = require('../../utils/audit')
const logger = require('../../config/logger')

function createError(status, message) { const e = new Error(message); e.status = status; return e }
function normRfc(r) { return (r || '').toUpperCase().replace(/\s+/g, '').trim() }
const round2 = (n) => parseFloat(Number(n).toFixed(2))

/** RFCs activos del tenant (perfiles fiscales) + perfil por RFC. */
async function loadTenantProfiles(tenantId) {
  const { rows } = await query(
    `SELECT id, rfc FROM tenant_fiscal_profiles
      WHERE tenant_id = $1 AND is_active = true`, [tenantId])
  return rows
}

/**
 * Parsea UN adjunto y lo clasifica para el preview. No toca la BD más allá de
 * lecturas (dup, match de cliente). Devuelve una fila de preview.
 */
async function previewOne({ tenantId, att, profiles }) {
  const buffer = Buffer.from(att.contentBase64, 'base64')
  let parsed
  try {
    parsed = await documentParserService.parseSupplierDocument(
      buffer, att.mimetype || '', att.filename || '')
  } catch (e) {
    return { filename: att.filename, status: 'error', error: 'No se pudo leer el documento (¿es un CFDI XML?).' }
  }
  if (parsed?.documentType !== 'xml_cfdi' || !parsed?.uuid) {
    return { filename: att.filename, status: 'error', error: 'No es un CFDI XML timbrado (sin UUID). Para facturas emitidas se requiere el XML.' }
  }
  if (parsed.tipoComprobante && parsed.tipoComprobante !== 'I') {
    const label = parsed.tipoComprobante === 'P' ? 'complemento de pago (REP)'
      : parsed.tipoComprobante === 'E' ? 'nota de crédito (Egreso)'
      : `CFDI tipo ${parsed.tipoComprobante}`
    return { filename: att.filename, status: 'error', uuid: parsed.uuid, error: `Es un ${label}, no una factura de ingreso. Solo se importan CFDI tipo I.` }
  }

  // Candado: el EMISOR debe ser el tenant (facturas que TÚ emitiste).
  const emisorRfc = normRfc(parsed?.emisor?.rfc)
  const tenantRfcs = profiles.map(p => normRfc(p.rfc)).filter(Boolean)
  if (tenantRfcs.length && emisorRfc && !tenantRfcs.includes(emisorRfc)) {
    return { filename: att.filename, status: 'error', uuid: parsed.uuid, error: `El RFC emisor (${emisorRfc}) no es de esta empresa — esta pantalla es para facturas que TÚ emitiste. Las facturas de proveedores se importan en Gastos.` }
  }

  // Duplicado por UUID (ya importada o timbrada aquí).
  const { rows: dup } = await query(
    `SELECT id, document_number, source FROM invoices
      WHERE tenant_id = $1 AND cfdi_uuid = $2`, [tenantId, parsed.uuid])

  // Match de cliente por RFC receptor.
  const receptorRfc = normRfc(parsed?.receptor?.rfc)
  let matchedPartner = null
  if (receptorRfc) {
    const { rows: bp } = await query(
      `SELECT id, name, rfc FROM business_partners
        WHERE tenant_id = $1 AND UPPER(REPLACE(rfc, ' ', '')) = $2
          AND type IN ('customer', 'both') AND is_active = true
        LIMIT 1`, [tenantId, receptorRfc])
    matchedPartner = bp[0] || null
  }

  const total = Number(parsed.total || 0)
  if (!(total > 0)) {
    return { filename: att.filename, status: 'error', uuid: parsed.uuid, error: 'El CFDI trae Total en cero.' }
  }

  return {
    filename:   att.filename,
    status:     dup.length ? 'duplicate' : 'ok',
    duplicateOf: dup[0]?.document_number || null,
    uuid:       parsed.uuid,
    serie:      parsed.serie || null,
    folio:      parsed.folio || null,
    invoiceDate: parsed.invoiceDate || null,
    currency:   parsed.currency || 'MXN',
    exchangeRate: parsed.exchangeRate || null,
    subtotal:   Number(parsed.subtotal || 0),
    tax:        Number(parsed.tax || 0),
    total,
    metodoPago: parsed.metodoPago || 'PUE',
    formaPago:  parsed.formaPago || null,
    receptor:   parsed.receptor,
    emisorRfc,
    matchedPartner,
    _parsed:    parsed,          // uso interno de importBatch (no viaja al frontend)
    _att:       att,
  }
}

/** Quita los campos internos de una fila de preview antes de responder. */
function publicRow({ _parsed, _att, ...row }) { return row }

/**
 * PASO 1 — Preview del lote (no guarda nada).
 */
async function parseBatch({ tenantId, files }) {
  const expanded = expandAttachments(files)
  if (!expanded.length) {
    throw createError(422, 'Ningún archivo procesable: se aceptan CFDI XML o .zip que los contenga.')
  }
  const profiles = await loadTenantProfiles(tenantId)
  const rows = []
  for (const att of expanded) {
    rows.push(await previewOne({ tenantId, att, profiles }))
  }
  return {
    rows: rows.map(publicRow),
    summary: {
      ok:         rows.filter(r => r.status === 'ok').length,
      duplicates: rows.filter(r => r.status === 'duplicate').length,
      errors:     rows.filter(r => r.status === 'error').length,
    },
  }
}

/** Busca o crea el cliente por RFC receptor (dentro de la transacción). */
async function resolvePartner(client, { tenantId, receptor, userId }) {
  const rfc = normRfc(receptor?.rfc)
  if (!rfc) throw createError(422, 'El CFDI no trae RFC del receptor.')
  const { rows: bp } = await client.query(
    `SELECT id FROM business_partners
      WHERE tenant_id = $1 AND UPPER(REPLACE(rfc, ' ', '')) = $2
        AND type IN ('customer', 'both') AND is_active = true
      LIMIT 1`, [tenantId, rfc])
  if (bp[0]) return { partnerId: bp[0].id, created: false }

  const { rows: ins } = await client.query(
    `INSERT INTO business_partners
       (tenant_id, type, name, rfc, zip_code, tax_regime_code, cfdi_use)
     VALUES ($1, 'customer', $2, $3, $4, $5, $6)
     RETURNING id`,
    [tenantId, receptor.name || rfc, rfc,
     receptor.zip || null, receptor.regime || null, receptor.useCfdi || null])
  return { partnerId: ins[0].id, created: true }
}

/**
 * PASO 2 — Importa el lote. `adjustments` = { [uuid]: { balance, installments } }.
 * Cada archivo se importa en SU PROPIA transacción: uno malo no tira el lote.
 */
async function importBatch({ tenantId, userId, files, adjustments = {}, ipAddress, userAgent }) {
  const expanded = expandAttachments(files)
  if (!expanded.length) {
    throw createError(422, 'Ningún archivo procesable: se aceptan CFDI XML o .zip que los contenga.')
  }
  const profiles = await loadTenantProfiles(tenantId)

  const results = []
  for (const att of expanded) {
    const row = await previewOne({ tenantId, att, profiles })
    if (row.status !== 'ok') {
      results.push(publicRow(row))
      continue
    }
    try {
      const out = await importOne({
        tenantId, userId, row, adjustment: adjustments[row.uuid] || {},
        ipAddress, userAgent,
      })
      results.push({ ...publicRow(row), ...out, status: 'created' })
    } catch (e) {
      if (e.code === '23505' && (e.constraint || '').includes('uuid')) {
        results.push({ ...publicRow(row), status: 'duplicate' })
      } else {
        logger.warn('import emitidas: archivo no importable', {
          tenantId, filename: att.filename, error: e.message })
        results.push({ ...publicRow(row), status: 'error', error: e.message })
      }
    }
  }

  return {
    results,
    summary: {
      created:    results.filter(r => r.status === 'created').length,
      duplicates: results.filter(r => r.status === 'duplicate').length,
      errors:     results.filter(r => r.status === 'error').length,
      customersCreated: results.filter(r => r.customerCreated).length,
    },
  }
}

/** Importa UNA factura ya validada por previewOne. */
async function importOne({ tenantId, userId, row, adjustment, ipAddress, userAgent }) {
  const parsed = row._parsed
  const total  = row.total
  // Saldo insoluto en la MONEDA de la factura. Default: nada cobrado.
  let balance = adjustment.balance != null && adjustment.balance !== ''
    ? round2(adjustment.balance) : total
  if (!(balance >= 0) || balance > total) {
    throw createError(400, `Saldo inválido para ${row.uuid}: debe estar entre 0 y el total (${total}).`)
  }
  const installments = Math.max(0, parseInt(adjustment.installments || 0, 10) || 0)

  const rate = row.currency === 'MXN' ? 1 : (row.exchangeRate || 1)
  const totalMxn = round2(total * rate)
  const paidMxn  = round2((total - balance) * rate)

  const invoice = await withTransaction(async (client) => {
    const { partnerId, created: customerCreated } = await resolvePartner(client, {
      tenantId, receptor: parsed.receptor, userId,
    })

    // Perfil fiscal del RFC emisor (si el tenant tiene varios).
    const { rows: prof } = await client.query(
      `SELECT id FROM tenant_fiscal_profiles
        WHERE tenant_id = $1 AND is_active = true
          AND UPPER(REPLACE(rfc, ' ', '')) = $2
        ORDER BY created_at LIMIT 1`, [tenantId, row.emisorRfc || ''])
    const fiscalProfileId = prof[0]?.id || null

    // Vencimiento: fecha de emisión + días de crédito del cliente (contado = mismo día).
    const { rows: cred } = await client.query(
      `SELECT credit_type, credit_days FROM business_partners WHERE id = $1`, [partnerId])
    const creditDays = cred[0]?.credit_type === 'credit' ? (parseInt(cred[0].credit_days, 10) || 0) : 0
    let dueDate = row.invoiceDate || null
    if (dueDate && creditDays > 0) {
      const d = new Date(dueDate + 'T12:00:00')
      d.setDate(d.getDate() + creditDays)
      dueDate = d.toISOString().split('T')[0]
    }

    // document_number = SERIE-FOLIO del sistema anterior; si choca con una
    // serie local (UNIQUE tenant+number) se le añade el sufijo -IMP.
    const baseNumber = [row.serie, row.folio].filter(Boolean).join('-') ||
      `IMP-${row.uuid.slice(0, 8).toUpperCase()}`

    const insertInvoice = async (docNumber) => {
      const { rows: inv } = await client.query(
        `INSERT INTO invoices
           (tenant_id, type, cfdi_type, series, folio, document_number, fiscal_profile_id,
            partner_id, currency, exchange_rate_value,
            subtotal, tax_transferred, total, total_mxn,
            payment_method, payment_form, use_cfdi,
            receptor_tax_regime, receptor_zip_code,
            status, cfdi_uuid, issue_date, stamp_date, notes, created_by,
            source, imported_installments, imported_initial_balance)
         VALUES ($1,'issued','I',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,
                 'stamped',$18,$19,$20,$21,$22,'imported',$23,$24)
         RETURNING id, document_number`,
        [tenantId, row.serie, row.folio, docNumber, fiscalProfileId,
         partnerId, row.currency, rate,
         row.subtotal, row.tax, total, totalMxn,
         row.metodoPago || 'PUE', row.formaPago || null, parsed.receptor?.useCfdi || null,
         parsed.receptor?.regime || null, parsed.receptor?.zip || null,
         row.uuid, row.invoiceDate || null,
         row.invoiceDate ? row.invoiceDate + 'T12:00:00' : null,
         'Importada de otro sistema (migración)', userId,
         installments, balance])
      return inv[0]
    }

    let invoiceRow
    try {
      invoiceRow = await insertInvoice(baseNumber)
    } catch (e) {
      // Colisión de folio con una serie local → reintenta con sufijo.
      if (e.code === '23505' && (e.constraint || '').includes('number')) {
        invoiceRow = await insertInvoice(`${baseNumber}-IMP`)
      } else { throw e }
    }

    // CXC para cartera/aging: total en MXN, con lo ya cobrado allá como pagado.
    const arStatus = paidMxn <= 0 ? 'pending' : (paidMxn >= totalMxn ? 'paid' : 'partial')
    await client.query(
      `INSERT INTO accounts_receivable
         (tenant_id, partner_id, document_type, document_id, document_number,
          currency, exchange_rate, amount_total, amount_paid, status,
          issue_date, due_date, created_by)
       VALUES ($1,$2,'invoice',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (tenant_id, document_type, document_id) DO NOTHING`,
      [tenantId, partnerId, invoiceRow.id, invoiceRow.document_number,
       row.currency, rate, totalMxn, paidMxn, arStatus,
       row.invoiceDate || null, dueDate, userId])

    return { ...invoiceRow, partnerId, customerCreated }
  })

  await audit({
    tenantId, userId, action: 'invoice.imported',
    resource: 'invoices', resourceId: invoice.id,
    payload: { uuid: row.uuid, docNumber: invoice.document_number, balance, installments },
    ipAddress, userAgent,
  })

  // Respaldo del XML (y PDF hermano si venía en el zip) pegado a la factura.
  // Best-effort: la factura ya existe; un respaldo faltante no es fatal.
  const backups = [row._att, ...(row._att.siblings || [])]
  for (const f of backups) {
    try {
      await attachmentService.saveAttachment({
        tenantId, entityType: 'invoice', entityId: invoice.id,
        category: 'cfdi',
        originalFilename: f.filename || 'cfdi.xml',
        buffer: Buffer.from(f.contentBase64, 'base64'),
        mimeType: /pdf/i.test(f.mimetype || f.filename || '') ? 'application/pdf' : 'application/xml',
        uploadedBy: userId,
      })
    } catch (e) {
      logger.warn('import emitidas: no se pudo guardar el respaldo', {
        tenantId, invoiceId: invoice.id, filename: f.filename, error: e.message })
    }
  }

  return {
    invoiceId: invoice.id,
    documentNumber: invoice.document_number,
    customerCreated: invoice.customerCreated,
  }
}

module.exports = { parseBatch, importBatch }
