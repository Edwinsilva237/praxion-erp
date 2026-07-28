'use strict'

/**
 * Exportación de facturación por cliente y periodo, en dos sabores:
 *   - Excel: listado (facturas + NC + complementos opcionales) para
 *     análisis/conciliación — una fila por documento con montos y saldos.
 *   - ZIP: los archivos XML/PDF de esos documentos (el "mándame las facturas
 *     del mes" del contador). Las propias se bajan de Facturapi; las
 *     IMPORTADAS salen del respaldo guardado al importar. Lo que falte se
 *     reporta en FALTANTES.txt en lugar de tirar la descarga.
 */

const ExcelJS = require('exceljs')
const { zip } = require('fflate')
const { query } = require('../../db')
const { getFacturapiForTenant } = require('./facturapiClient')
const storage = require('../../utils/storage')
const logger = require('../../config/logger')

// Tope de documentos por ZIP: cada uno son 2 descargas de Facturapi.
const MAX_ZIP_DOCS = 300
// Descargas simultáneas contra Facturapi/almacén.
const FETCH_CONCURRENCY = 5

function createError(status, message) { const e = new Error(message); e.status = status; return e }
const num = (v) => (v == null ? null : parseFloat(v))

/** Facturas (I) y opcionalmente notas de crédito (E) del filtro. */
async function queryDocuments({ tenantId, partnerId, dateFrom, dateTo, includeCancelled, includeCreditNotes }) {
  const types = includeCreditNotes ? ['I', 'E'] : ['I']
  const params = [tenantId, dateFrom, dateTo, types]
  let where = `
    i.tenant_id = $1 AND i.type = 'issued'
    AND i.issue_date >= $2 AND i.issue_date <= $3
    AND i.cfdi_type = ANY($4)
    AND i.status <> 'draft'`
  if (!includeCancelled) where += ` AND i.status = 'stamped'`
  if (partnerId) { params.push(partnerId); where += ` AND i.partner_id = $${params.length}` }

  const { rows } = await query(
    `SELECT i.id, i.document_number, i.cfdi_type, i.issue_date, i.cfdi_uuid,
            i.payment_method, i.status, i.source, i.currency, i.exchange_rate_value,
            i.subtotal, i.tax_transferred, i.total, i.total_mxn, i.notes,
            bp.name AS partner_name, bp.rfc AS partner_rfc,
            ar.amount_paid, ar.amount_credited, ar.amount_pending
       FROM invoices i
       JOIN business_partners bp ON bp.id = i.partner_id
       LEFT JOIN accounts_receivable ar
         ON ar.tenant_id = i.tenant_id AND ar.document_type = 'invoice' AND ar.document_id = i.id
      WHERE ${where}
      ORDER BY i.issue_date, i.document_number`, params)
  return rows
}

/** Complementos de pago (REP) timbrados con fecha de pago en el periodo. */
async function queryComplements({ tenantId, partnerId, dateFrom, dateTo }) {
  const params = [tenantId, dateFrom, dateTo]
  let where = `
    pc.tenant_id = $1 AND pc.status = 'stamped'
    AND pc.payment_date >= $2 AND pc.payment_date <= $3`
  if (partnerId) { params.push(partnerId); where += ` AND i.partner_id = $${params.length}` }

  const { rows } = await query(
    `SELECT pc.id, pc.payment_date, pc.amount, pc.currency, pc.cfdi_uuid, pc.facturapi_id,
            i.document_number AS invoice_number, bp.name AS partner_name
       FROM payment_complements pc
       JOIN invoices i ON i.id = pc.invoice_id
       JOIN business_partners bp ON bp.id = i.partner_id
      WHERE ${where}
      ORDER BY pc.payment_date`, params)
  return rows
}

// ─── Excel ───────────────────────────────────────────────────────────────────

function styleHeader(ws) {
  const h = ws.getRow(1)
  h.font = { bold: true, color: { argb: 'FFFFFFFF' } }
  h.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F2937' } }
  h.alignment = { vertical: 'middle' }
  h.height = 22
  ws.views = [{ state: 'frozen', ySplit: 1 }]
  ws.autoFilter = { from: 'A1', to: { row: 1, column: ws.columns.length } }
}

const MONEY = '#,##0.00'

async function generateExcel({ tenantId, partnerId, dateFrom, dateTo, includeCancelled, includeCreditNotes, includeComplements }) {
  const docs = await queryDocuments({ tenantId, partnerId, dateFrom, dateTo, includeCancelled, includeCreditNotes })
  const complements = includeComplements
    ? await queryComplements({ tenantId, partnerId, dateFrom, dateTo }) : []

  const wb = new ExcelJS.Workbook()
  wb.creator = 'Praxion Systems'
  wb.created = new Date()

  const ws = wb.addWorksheet('Facturas')
  ws.columns = [
    { header: 'Folio',        key: 'folio',    width: 18 },
    { header: 'Tipo',         key: 'tipo',     width: 14 },
    { header: 'Cliente',      key: 'cliente',  width: 34 },
    { header: 'RFC',          key: 'rfc',      width: 16 },
    { header: 'Fecha',        key: 'fecha',    width: 12 },
    { header: 'Estado',       key: 'estado',   width: 11 },
    { header: 'Método',       key: 'metodo',   width: 9 },
    { header: 'Origen',       key: 'origen',   width: 11 },
    { header: 'Moneda',       key: 'moneda',   width: 9 },
    { header: 'TC',           key: 'tc',       width: 8 },
    { header: 'Subtotal',     key: 'subtotal', width: 14, style: { numFmt: MONEY } },
    { header: 'IVA',          key: 'iva',      width: 13, style: { numFmt: MONEY } },
    { header: 'Total',        key: 'total',    width: 14, style: { numFmt: MONEY } },
    { header: 'Total MXN',    key: 'totalMxn', width: 14, style: { numFmt: MONEY } },
    { header: 'Cobrado MXN',  key: 'cobrado',  width: 14, style: { numFmt: MONEY } },
    { header: 'Saldo MXN',    key: 'saldo',    width: 14, style: { numFmt: MONEY } },
    { header: 'UUID fiscal',  key: 'uuid',     width: 40 },
  ]
  for (const d of docs) {
    const isNC = d.cfdi_type === 'E'
    ws.addRow({
      folio:    d.document_number,
      tipo:     isNC ? 'Nota de crédito' : 'Factura',
      cliente:  d.partner_name,
      rfc:      d.partner_rfc || '',
      fecha:    d.issue_date ? d.issue_date.toISOString().slice(0, 10) : '',
      estado:   d.status === 'cancelled' ? 'Cancelada' : 'Timbrada',
      metodo:   isNC ? '' : (d.payment_method || ''),
      origen:   d.source === 'imported' ? 'Importada' : 'Propia',
      moneda:   d.currency || 'MXN',
      tc:       d.currency && d.currency !== 'MXN' ? num(d.exchange_rate_value) : null,
      subtotal: num(d.subtotal),
      iva:      num(d.tax_transferred),
      total:    num(d.total),
      totalMxn: num(d.total_mxn) ?? num(d.total),
      cobrado:  isNC ? null : num(d.amount_paid),
      saldo:    isNC ? null : num(d.amount_pending),
      uuid:     d.cfdi_uuid || '',
    })
  }
  styleHeader(ws)
  // Fila de totales en MXN (solo facturas timbradas; NC y canceladas no suman).
  const sums = docs.reduce((acc, d) => {
    if (d.cfdi_type !== 'I' || d.status === 'cancelled') return acc
    acc.totalMxn += num(d.total_mxn) ?? num(d.total) ?? 0
    acc.cobrado  += num(d.amount_paid) || 0
    acc.saldo    += num(d.amount_pending) || 0
    return acc
  }, { totalMxn: 0, cobrado: 0, saldo: 0 })
  const totalRow = ws.addRow({ folio: 'TOTAL (facturas timbradas)',
    totalMxn: sums.totalMxn, cobrado: sums.cobrado, saldo: sums.saldo })
  totalRow.font = { bold: true }

  if (includeComplements) {
    const wc = wb.addWorksheet('Complementos de pago')
    wc.columns = [
      { header: 'Factura',       key: 'factura', width: 18 },
      { header: 'Cliente',       key: 'cliente', width: 34 },
      { header: 'Fecha de pago', key: 'fecha',   width: 14 },
      { header: 'Monto',         key: 'monto',   width: 14, style: { numFmt: MONEY } },
      { header: 'Moneda',        key: 'moneda',  width: 9 },
      { header: 'UUID fiscal',   key: 'uuid',    width: 40 },
    ]
    for (const c of complements) {
      wc.addRow({
        factura: c.invoice_number, cliente: c.partner_name,
        fecha:   c.payment_date ? c.payment_date.toISOString().slice(0, 10) : '',
        monto:   num(c.amount), moneda: c.currency || 'MXN', uuid: c.cfdi_uuid || '',
      })
    }
    styleHeader(wc)
  }

  return Buffer.from(await wb.xlsx.writeBuffer())
}

// ─── ZIP de XML/PDF ──────────────────────────────────────────────────────────

const facturapiIdFromNotes = (notes) => ((notes || '').match(/\[facturapi_id:([^\]]+)\]/) || [])[1] || null
const safeName = (s) => String(s || '').replace(/[^\w.\-]+/g, '_')

async function streamToBuffer(stream) {
  const chunks = []
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  return Buffer.concat(chunks)
}

/** Corre `fn` sobre `items` con un máximo de `limit` a la vez. */
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length)
  let next = 0
  async function worker() {
    while (next < items.length) {
      const idx = next++
      results[idx] = await fn(items[idx], idx)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

/** Respaldos XML/PDF de una factura importada (attachments category 'cfdi'). */
async function importedBackups(tenantId, invoiceId) {
  const { rows } = await query(
    `SELECT storage_path, mime_type, filename FROM attachments
      WHERE tenant_id = $1 AND entity_type = 'invoice' AND entity_id = $2 AND category = 'cfdi'
      ORDER BY created_at`, [tenantId, invoiceId])
  const pick = (kind) => rows.find(a => kind === 'xml'
    ? (a.mime_type || '').includes('xml') || (a.filename || '').toLowerCase().endsWith('.xml')
    : (a.mime_type || '').includes('pdf') || (a.filename || '').toLowerCase().endsWith('.pdf'))
  return { xml: pick('xml'), pdf: pick('pdf') }
}

async function generateZip({ tenantId, partnerId, dateFrom, dateTo, includeCancelled, includeCreditNotes, includeComplements }) {
  const docs = await queryDocuments({ tenantId, partnerId, dateFrom, dateTo, includeCancelled, includeCreditNotes })
  const complements = includeComplements
    ? await queryComplements({ tenantId, partnerId, dateFrom, dateTo }) : []

  const totalDocs = docs.length + complements.length
  if (!totalDocs) throw createError(404, 'No hay documentos en el filtro seleccionado.')
  if (totalDocs > MAX_ZIP_DOCS) {
    throw createError(422,
      `El filtro abarca ${totalDocs} documentos y el tope por descarga es ${MAX_ZIP_DOCS}. Acota el periodo o exporta por cliente.`)
  }

  // Un solo cliente de Facturapi para todo el lote. Si el tenant no tiene
  // Facturapi configurado aún puede exportar sus importadas.
  let facturapi = null
  try { facturapi = await getFacturapiForTenant(tenantId) } catch { /* sin timbrado */ }

  const files = {}      // ruta dentro del zip → Uint8Array
  const missing = []

  const addDoc = async ({ folder, base, kind, source, invoiceId, facturapiId, label }) => {
    // kind se resuelve adentro: intenta XML y PDF y anota lo que falte.
    try {
      if (source === 'imported') {
        const backups = await importedBackups(tenantId, invoiceId)
        for (const k of ['xml', 'pdf']) {
          if (backups[k]) files[`${folder}/${base}.${k}`] = new Uint8Array(await storage.fetchBuffer(backups[k].storage_path))
          else missing.push(`${label}: sin ${k.toUpperCase()} de respaldo (importada).`)
        }
        return
      }
      if (!facturapi || !facturapiId) {
        missing.push(`${label}: no se pudo resolver el documento en el timbrador.`)
        return
      }
      const [xml, pdf] = await Promise.all([
        facturapi.invoices.downloadXml(facturapiId).then(streamToBuffer),
        facturapi.invoices.downloadPdf(facturapiId).then(streamToBuffer),
      ])
      files[`${folder}/${base}.xml`] = new Uint8Array(xml)
      files[`${folder}/${base}.pdf`] = new Uint8Array(pdf)
    } catch (e) {
      logger.warn('export zip: documento no descargable', { tenantId, label, error: e.message })
      missing.push(`${label}: ${e.message}`)
    }
  }

  const jobs = []
  for (const d of docs) {
    const folder = d.cfdi_type === 'E' ? 'NotasCredito' : 'Facturas'
    const date = d.issue_date ? d.issue_date.toISOString().slice(0, 10) : 's-f'
    jobs.push({
      folder, base: `${date}_${safeName(d.document_number)}`,
      source: d.source, invoiceId: d.id,
      facturapiId: facturapiIdFromNotes(d.notes),
      label: `${d.cfdi_type === 'E' ? 'NC' : 'Factura'} ${d.document_number}`,
    })
  }
  for (const c of complements) {
    const date = c.payment_date ? c.payment_date.toISOString().slice(0, 10) : 's-f'
    jobs.push({
      folder: 'Complementos', base: `${date}_REP_${safeName(c.invoice_number)}_${(c.cfdi_uuid || '').slice(0, 8)}`,
      source: 'system', invoiceId: null,
      facturapiId: c.facturapi_id,
      label: `REP de ${c.invoice_number} (${c.cfdi_uuid})`,
    })
  }

  await mapLimit(jobs, FETCH_CONCURRENCY, addDoc)

  // El Excel de resumen viaja dentro del ZIP: el contador recibe todo junto.
  files['Resumen.xlsx'] = new Uint8Array(await generateExcel({
    tenantId, partnerId, dateFrom, dateTo, includeCancelled, includeCreditNotes, includeComplements }))

  if (missing.length) {
    files['FALTANTES.txt'] = new Uint8Array(Buffer.from(
      `Documentos del filtro que no traen archivo:\n\n${missing.join('\n')}\n`, 'utf8'))
  }

  // zip() asíncrono (worker threads): zipSync congelaba el event loop varios
  // segundos con lotes grandes y TODAS las peticiones del servidor se quedaban
  // colgadas mientras comprimía (los usuarios veían "Conectando con el
  // servidor…"). Los PDF ya vienen comprimidos → level 0 para ellos.
  const zipped = await new Promise((resolve, reject) => {
    const withOpts = {}
    for (const [path, data] of Object.entries(files)) {
      withOpts[path] = path.toLowerCase().endsWith('.pdf') ? [data, { level: 0 }] : data
    }
    zip(withOpts, { level: 6 }, (err, out) => (err ? reject(err) : resolve(out)))
  })
  return Buffer.from(zipped)
}

module.exports = { generateExcel, generateZip, MAX_ZIP_DOCS }
