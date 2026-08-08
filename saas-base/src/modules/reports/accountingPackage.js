'use strict'

/**
 * Paquete contable del periodo: un ZIP con TODOS los XML fiscales (emitidos y
 * recibidos) organizados en carpetas + el Reporte Contable en Excel adentro.
 * Es la "Etapa 1" de la vinculación con el sistema contable del despacho:
 * el contador recibe en una sola descarga el insumo completo del periodo y
 * ya no depende de la descarga masiva del SAT.
 *
 * Estructura del ZIP:
 *   Emitidos/Facturas/       CFDI tipo I timbrados vigentes
 *   Emitidos/NotasCredito/   CFDI tipo E vigentes
 *   Emitidos/Complementos/   REP (tipo P) emitidos
 *   Recibidos/Facturas/      CFDI de proveedores con UUID SAT
 *   Recibidos/Complementos/  REP de proveedores recibidos
 *   Cancelados/Emitidos/     facturas y NC propias canceladas ante el SAT
 *   Cancelados/Recibidos/    facturas de proveedor canceladas
 *   Reporte-Contable.xlsx    el Excel de 5 hojas + resumen IVA (mismo periodo)
 *   FALTANTES.txt            documentos del periodo sin XML recuperable
 *   LEEME.txt                criterios de corte y estructura
 *
 * Criterios de fecha IDÉNTICOS a accountingReport.js (para que el ZIP y el
 * Excel cuadren entre sí): emitidas por stamp_date, NC por issue_date,
 * REP emitidos por payment_date, recibidas por invoice_date, REP recibidos
 * por payment_date (fallback issue_date). `to` siempre EXCLUSIVO.
 */

const { zip } = require('fflate')
const { query } = require('../../db')
const storage = require('../../utils/storage')
const logger = require('../../config/logger')
const { generateAccountingWorkbook } = require('./accountingReport')
const { getFacturapiForTenant } = require('../invoicing/facturapiClient')
const { mapLimit, streamToBuffer, facturapiIdFromNotes, safeName } =
  require('../invoicing/exportService')

// Tope de documentos por ZIP. Solo XML (1 descarga de Facturapi por documento
// propio), por eso el tope es mayor que el del export de facturación (300 con
// XML+PDF). Si un tenant lo rebasa, que parta el periodo en dos rangos.
const MAX_PACKAGE_DOCS = 800
const FETCH_CONCURRENCY = 5

function createError(status, message) { const e = new Error(message); e.status = status; return e }

const uuid8 = (u) => String(u || '').replace(/-/g, '').slice(0, 8)
const dstr = (d) => (d ? new Date(d).toISOString().slice(0, 10) : 's-f')

// ─── Queries del periodo (espejo de accountingReport) ────────────────────────

async function qIssuedInvoices(tenantId, from, to) {
  const { rows } = await query(`
    SELECT i.id, i.document_number, i.cfdi_uuid, i.status, i.source, i.notes,
           i.stamp_date
      FROM invoices i
     WHERE i.tenant_id = $1 AND i.type = 'issued' AND i.cfdi_type = 'I'
       AND i.stamp_date IS NOT NULL
       AND i.stamp_date >= $2 AND i.stamp_date < $3
       AND i.status IN ('stamped', 'cancelled')
     ORDER BY i.stamp_date`, [tenantId, from, to])
  return rows
}

/**
 * NC emitidas. Viven en `invoices` con cfdi_type='E' (modelo actual); la tabla
 * `credit_notes` es legacy y se suma para tenants viejos, descartando por UUID
 * las que ya vinieron del modelo actual. `entity` dice de dónde bajar el XML
 * adjunto cuando el PAC no lo tiene.
 */
async function qCreditNotes(tenantId, from, to) {
  const { rows } = await query(`
    SELECT i.id, i.document_number, i.cfdi_uuid, i.status::text AS status, i.notes,
           COALESCE(i.stamp_date::date, i.issue_date) AS issue_date,
           'invoice'::text AS entity
      FROM invoices i
     WHERE i.tenant_id = $1 AND i.type = 'issued' AND i.cfdi_type = 'E'
       AND i.status IN ('stamped', 'cancelled')
       AND COALESCE(i.stamp_date, i.issue_date::timestamptz) >= $2
       AND COALESCE(i.stamp_date, i.issue_date::timestamptz) <  $3

    UNION ALL

    SELECT cn.id, cn.document_number, cn.cfdi_uuid, cn.status::text, cn.notes,
           cn.issue_date, 'credit_note'::text
      FROM credit_notes cn
     WHERE cn.tenant_id = $1
       AND cn.status IN ('stamped', 'cancelled')
       AND cn.issue_date >= $2 AND cn.issue_date < $3
       AND NOT EXISTS (
         SELECT 1 FROM invoices i2
          WHERE i2.tenant_id = cn.tenant_id AND i2.cfdi_type = 'E'
            AND i2.cfdi_uuid IS NOT NULL AND i2.cfdi_uuid = cn.cfdi_uuid)

     ORDER BY 6`, [tenantId, from, to])
  return rows
}

async function qIssuedComplements(tenantId, from, to) {
  // Un timbre puede tener varias filas (una por factura liquidada) con el
  // MISMO facturapi_id/uuid → DISTINCT ON para bajar cada XML una sola vez.
  const { rows } = await query(`
    SELECT DISTINCT ON (pc.cfdi_uuid)
           pc.cfdi_uuid, pc.facturapi_id, pc.payment_date,
           i.document_number AS invoice_number
      FROM payment_complements pc
      JOIN invoices i ON i.id = pc.invoice_id
     WHERE pc.tenant_id = $1 AND pc.status = 'stamped'
       AND pc.payment_date >= $2 AND pc.payment_date < $3
     ORDER BY pc.cfdi_uuid, pc.payment_date`, [tenantId, from, to])
  return rows
}

async function qSupplierInvoices(tenantId, from, to) {
  const { rows } = await query(`
    SELECT si.id, si.invoice_number, si.uuid_sat, si.rfc_emisor,
           si.serie, si.folio, si.invoice_date, si.status,
           (si.xml_content IS NOT NULL) AS has_xml_content,
           COALESCE(bp.name, si.generic_supplier, 'proveedor') AS supplier_name
      FROM supplier_invoices si
      LEFT JOIN business_partners bp ON bp.id = si.partner_id
     WHERE si.tenant_id = $1
       AND si.uuid_sat IS NOT NULL
       AND si.invoice_date >= $2 AND si.invoice_date < $3
     ORDER BY si.invoice_date`, [tenantId, from, to])
  return rows
}

async function qSupplierComplements(tenantId, from, to) {
  const { rows } = await query(`
    SELECT spc.id, spc.cfdi_uuid, spc.serie, spc.folio,
           COALESCE(spc.payment_date, spc.issue_date) AS doc_date,
           COALESCE(bp.name, spc.generic_supplier, 'proveedor') AS supplier_name
      FROM supplier_payment_complements spc
      LEFT JOIN business_partners bp ON bp.id = spc.partner_id
     WHERE spc.tenant_id = $1
       AND COALESCE(spc.payment_date, spc.issue_date) >= $2
       AND COALESCE(spc.payment_date, spc.issue_date) < $3
     ORDER BY doc_date`, [tenantId, from, to])
  return rows
}

// ─── Fuentes de XML ──────────────────────────────────────────────────────────

/** XML adjunto (categoría cfdi o cualquiera que sea .xml) de una entidad. */
async function attachmentXmlBuffer(tenantId, entityType, entityId) {
  const { rows } = await query(`
    SELECT storage_path FROM attachments
     WHERE tenant_id = $1 AND entity_type = $2 AND entity_id = $3
       AND (mime_type ILIKE '%xml%' OR filename ILIKE '%.xml')
     ORDER BY (category = 'cfdi') DESC, created_at
     LIMIT 1`, [tenantId, entityType, entityId])
  if (!rows.length) return null
  try { return await storage.fetchBuffer(rows[0].storage_path) } catch { return null }
}

async function facturapiXml(facturapi, facturapiId) {
  if (!facturapi || !facturapiId) return null
  const stream = await facturapi.invoices.downloadXml(facturapiId)
  return streamToBuffer(stream)
}

// ─── Generador principal ─────────────────────────────────────────────────────

async function generateAccountingPackage({ tenantId, from, to, tenantName }) {
  const [issued, creditNotes, complements, received, receivedReps] = await Promise.all([
    qIssuedInvoices(tenantId, from, to),
    qCreditNotes(tenantId, from, to),
    qIssuedComplements(tenantId, from, to),
    qSupplierInvoices(tenantId, from, to),
    qSupplierComplements(tenantId, from, to),
  ])

  const totalDocs = issued.length + creditNotes.length + complements.length
    + received.length + receivedReps.length
  if (!totalDocs) throw createError(404, 'No hay documentos fiscales en el periodo seleccionado.')
  if (totalDocs > MAX_PACKAGE_DOCS) {
    throw createError(422,
      `El periodo abarca ${totalDocs} documentos y el tope por paquete es ${MAX_PACKAGE_DOCS}. Divide el periodo en rangos más cortos.`)
  }

  // Un solo cliente Facturapi para todo el lote. Sin timbrado configurado el
  // paquete sigue saliendo con importadas/recibidas; lo propio va a FALTANTES.
  let facturapi = null
  try { facturapi = await getFacturapiForTenant(tenantId) } catch { /* sin timbrado */ }

  const files = {}      // ruta dentro del zip → Uint8Array
  const missing = []

  const addFile = (path, buf) => { files[path] = new Uint8Array(buf) }

  const jobs = []

  for (const d of issued) {
    const folder = d.status === 'cancelled' ? 'Cancelados/Emitidos' : 'Emitidos/Facturas'
    jobs.push({
      path: `${folder}/${dstr(d.stamp_date)}_${safeName(d.document_number)}_${uuid8(d.cfdi_uuid)}.xml`,
      label: `Factura ${d.document_number}`,
      fetch: async () => {
        if (d.source === 'imported') return attachmentXmlBuffer(tenantId, 'invoice', d.id)
        return facturapiXml(facturapi, facturapiIdFromNotes(d.notes))
      },
    })
  }

  for (const d of creditNotes) {
    const folder = d.status === 'cancelled' ? 'Cancelados/Emitidos' : 'Emitidos/NotasCredito'
    jobs.push({
      path: `${folder}/${dstr(d.issue_date)}_NC_${safeName(d.document_number)}_${uuid8(d.cfdi_uuid)}.xml`,
      label: `Nota de crédito ${d.document_number}`,
      fetch: async () => {
        const viaFacturapi = await facturapiXml(facturapi, facturapiIdFromNotes(d.notes))
          .catch(() => null)
        if (viaFacturapi) return viaFacturapi
        return attachmentXmlBuffer(tenantId, d.entity, d.id)
      },
    })
  }

  for (const c of complements) {
    jobs.push({
      path: `Emitidos/Complementos/${dstr(c.payment_date)}_REP_${safeName(c.invoice_number)}_${uuid8(c.cfdi_uuid)}.xml`,
      label: `REP emitido de ${c.invoice_number} (${c.cfdi_uuid})`,
      fetch: () => facturapiXml(facturapi, c.facturapi_id),
    })
  }

  for (const r of received) {
    const folder = r.status === 'cancelled' ? 'Cancelados/Recibidos' : 'Recibidos/Facturas'
    const base = safeName(`${r.supplier_name}`.slice(0, 30)) + '_' + safeName(r.invoice_number)
    jobs.push({
      path: `${folder}/${dstr(r.invoice_date)}_${base}_${uuid8(r.uuid_sat)}.xml`,
      label: `Recibida ${r.invoice_number} de ${r.supplier_name}`,
      fetch: async () => {
        if (r.has_xml_content) {
          const { rows } = await query(
            `SELECT xml_content FROM supplier_invoices WHERE id = $1 AND tenant_id = $2`,
            [r.id, tenantId])
          if (rows[0]?.xml_content) return Buffer.from(rows[0].xml_content, 'utf8')
        }
        return attachmentXmlBuffer(tenantId, 'supplier_invoice', r.id)
      },
    })
  }

  for (const r of receivedReps) {
    const base = safeName(`${r.supplier_name}`.slice(0, 30))
    jobs.push({
      path: `Recibidos/Complementos/${dstr(r.doc_date)}_REP_${base}_${uuid8(r.cfdi_uuid)}.xml`,
      label: `REP recibido de ${r.supplier_name} (${r.cfdi_uuid})`,
      fetch: () => attachmentXmlBuffer(tenantId, 'supplier_payment_complement', r.id),
    })
  }

  await mapLimit(jobs, FETCH_CONCURRENCY, async (job) => {
    try {
      const buf = await job.fetch()
      if (buf && buf.length) addFile(job.path, buf)
      else missing.push(`${job.label}: sin XML recuperable.`)
    } catch (e) {
      logger.warn('paquete contable: XML no descargable', { tenantId, label: job.label, error: e.message })
      missing.push(`${job.label}: ${e.message}`)
    }
  })

  // El Reporte Contable del MISMO periodo viaja adentro (modo fiscal).
  try {
    addFile('Reporte-Contable.xlsx', Buffer.from(
      await generateAccountingWorkbook({ tenantId, from, to, tenantName, fiscalOnly: true })))
  } catch (e) {
    logger.warn('paquete contable: no se pudo generar el Excel', { tenantId, error: e.message })
    missing.push(`Reporte-Contable.xlsx: ${e.message}`)
  }

  if (missing.length) {
    addFile('FALTANTES.txt', Buffer.from(
      `Documentos del periodo cuyo XML no se pudo incluir:\n\n${missing.join('\n')}\n`, 'utf8'))
  }

  addFile('LEEME.txt', Buffer.from(buildReadme({ from, to, tenantName, counts: {
    emitidas: issued.filter(d => d.status !== 'cancelled').length,
    nc: creditNotes.filter(d => d.status !== 'cancelled').length,
    repEmitidos: complements.length,
    recibidas: received.filter(d => d.status !== 'cancelled').length,
    repRecibidos: receivedReps.length,
    cancelados: issued.filter(d => d.status === 'cancelled').length
      + creditNotes.filter(d => d.status === 'cancelled').length
      + received.filter(d => d.status === 'cancelled').length,
    faltantes: missing.length,
  } }), 'utf8'))

  // zip() asíncrono (worker threads) — zipSync congela el event loop.
  const zipped = await new Promise((resolve, reject) => {
    zip(files, { level: 6 }, (err, out) => (err ? reject(err) : resolve(out)))
  })
  return Buffer.from(zipped)
}

function buildReadme({ from, to, tenantName, counts }) {
  return [
    `PAQUETE CONTABLE — ${tenantName}`,
    `Periodo: del ${from} al ${to} (fecha final exclusiva)`,
    ``,
    `Contenido:`,
    `  Emitidos/Facturas       ${counts.emitidas} CFDI de ingreso vigentes (corte por fecha de timbrado)`,
    `  Emitidos/NotasCredito   ${counts.nc} notas de crédito vigentes (corte por fecha de emisión)`,
    `  Emitidos/Complementos   ${counts.repEmitidos} REP emitidos (corte por fecha de pago)`,
    `  Recibidos/Facturas      ${counts.recibidas} CFDI de proveedores vigentes (corte por fecha de la factura)`,
    `  Recibidos/Complementos  ${counts.repRecibidos} REP de proveedores (corte por fecha de pago)`,
    `  Cancelados/             ${counts.cancelados} documentos cancelados ante el SAT dentro del periodo`,
    `  Reporte-Contable.xlsx   resumen del periodo: ventas, NC, cobros, compras, pagos e IVA`,
    counts.faltantes
      ? `  FALTANTES.txt           ${counts.faltantes} documentos sin XML recuperable (revisar en el sistema)`
      : `  (Sin faltantes: todos los XML del periodo están incluidos.)`,
    ``,
    `Los archivos se nombran fecha_folio_uuid.xml (los 8 primeros caracteres del UUID fiscal).`,
    `Los totales del Excel usan los mismos criterios de corte que las carpetas de este ZIP.`,
    ``,
    `Generado por Praxion — solo documentos con valor fiscal (CFDI timbrados / con UUID SAT).`,
  ].join('\n')
}

module.exports = { generateAccountingPackage, MAX_PACKAGE_DOCS }
