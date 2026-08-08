'use strict'

// Cuadre fiscal del periodo: el UNIVERSO de documentos con valor fiscal del mes
// (CFDI emitidos I/E/P + CFDI recibidos y sus REP) y, sobre él, la lista de
// EXCEPCIONES que impiden cerrar limpio — cada una con lo que significa para el
// IVA y qué hay que hacer.
//
// No es un expediente como la trazabilidad de compras: aquí el ancla es el
// documento fiscal y lo que interesa es lo que FALTA (el REP que no llegó, la NC
// sin factura origen, el XML que no está resguardado, la remisión que nunca se
// facturó). Es la lista de pendientes del cierre.
//
// Criterios de corte IDÉNTICOS a accountingReport.js / accountingPackage.js para
// que los conteos cuadren contra el Excel y el ZIP del mismo periodo:
//   emitidas y NC por stamp_date (fallback issue_date), REP emitidos por
//   payment_date, recibidas por invoice_date, REP recibidos por payment_date
//   (fallback issue_date). `to` siempre EXCLUSIVO.
//
// Solo LEE. Sin migraciones.

const { query } = require('../../db')

// Misma tolerancia que el auto-cruce de REPs (supplierComplementService).
const CENTS = 0.005
const round2 = (n) => Math.round(n * 100) / 100

// Formas de pago que exigen complemento (dinero real). Las notas de crédito y
// las aplicaciones de anticipo no generan CFDI de pago.
const AR_CASH_METHODS = ['cash', 'transfer', 'check']
const AP_CASH_METHODS = ['transfer', 'cash', 'check', 'credit_card']

/**
 * Catálogo de excepciones. `meaning` explica el efecto fiscal y `action` lo que
 * hay que hacer — es el texto que ve el usuario, en español de contador.
 */
const ISSUE_TYPES = {
  ar_rep_missing: {
    label: 'Cobros del periodo sin complemento de pago (REP)',
    side: 'issued', severity: 'danger',
    meaning: 'Cobraste una factura PPD y no timbraste su complemento. El SAT lo exige a más tardar el día 5 del mes siguiente al cobro; sin él la factura queda incompleta y el cliente no puede acreditar su IVA.',
    action: 'Timbra el complemento desde Finanzas → Cobros antes del día 5.',
  },
  nc_sin_factura: {
    label: 'Notas de crédito sin factura relacionada',
    side: 'issued', severity: 'warn',
    meaning: 'Una NC sin el UUID de la factura que corrige queda "suelta": el contador no puede saber qué ingreso está reversando y el SAT no la relaciona con nada.',
    action: 'Liga la NC a su factura origen o documenta el motivo por el que va sola.',
  },
  cancel_periodo_anterior: {
    label: 'Cancelaciones que afectan un mes ya declarado',
    side: 'issued', severity: 'warn',
    meaning: 'El CFDI se timbró en un periodo anterior y se canceló dentro de éste. El ingreso y el IVA trasladado ya se declararon en aquel mes: la cancelación obliga a una declaración complementaria.',
    action: 'Avisa a tu contador antes de presentar la declaración de este mes.',
  },
  cancelada_con_cobros: {
    label: 'Facturas canceladas que conservan cobros aplicados',
    side: 'issued', severity: 'danger',
    meaning: 'Hay dinero cobrado contra un CFDI que ya no existe ante el SAT. El depósito del banco no tiene documento que lo respalde.',
    action: 'Reversa el cobro y aplícalo a la factura sustituta, o conviértelo en anticipo del cliente.',
  },
  remision_sin_factura: {
    label: 'Remisiones entregadas sin facturar',
    side: 'issued', severity: 'warn',
    meaning: 'Mercancía entregada y cobrable que no generó CFDI en el periodo. Es ingreso real que no está declarado.',
    action: 'Factúralas (individual o consolidada) o confirma que se facturan en el siguiente corte.',
  },
  ap_rep_missing: {
    label: 'Pagos a proveedor sin REP recibido',
    side: 'received', severity: 'danger',
    meaning: 'Pagaste una factura PPD y el proveedor no ha mandado su complemento. Sin REP el IVA de esa factura NO es acreditable, aunque ya hayas pagado.',
    action: 'Solicítalo desde Compras → Pagos (botón "Solicitar REP").',
  },
  cxp_sin_cfdi: {
    label: 'Cuentas por pagar sin CFDI',
    side: 'received', severity: 'warn',
    meaning: 'Compra o gasto registrado sin factura del proveedor: no es deducible de ISR ni genera IVA acreditable. Solo sirve para control interno del flujo.',
    action: 'Pide la factura al proveedor o marca el registro como no deducible.',
  },
  proveedor_sin_rfc: {
    label: 'CFDI recibidos sin RFC del emisor',
    side: 'received', severity: 'warn',
    meaning: 'Sin RFC el documento no se puede relacionar en el sistema contable (CONTPAQi, Aspel) ni cruzar contra la descarga masiva del SAT.',
    action: 'Captura el RFC en la ficha del proveedor.',
  },
  sin_xml: {
    label: 'Documentos sin XML resguardado',
    side: 'both', severity: 'info',
    meaning: 'El CFDI existe en el sistema pero su XML no está guardado aquí. En una auditoría el XML es el documento válido — el PDF no lo sustituye.',
    action: 'Sube el XML al documento; si es una factura propia se recupera del PAC al armar el paquete.',
  },
}

async function getFiscalReconciliation({ tenantId, from, to }) {
  const p = [tenantId, from, to]

  const [
    issuedDocs, issuedReps, receivedDocs, receivedReps,
    arRepMissing, ncSinFactura, cancelPrevio, canceladaConCobros,
    remisionesSinFactura, apRepMissing, cxpSinCfdi, proveedorSinRfc,
  ] = await Promise.all([
    qIssuedDocs(p), qIssuedReps(p), qReceivedDocs(p), qReceivedReps(p),
    qArRepMissing(p), qNcSinFactura(p), qCancelPeriodoAnterior(p), qCanceladaConCobros(p),
    qRemisionesSinFactura(p), qApRepMissing(p), qCxpSinCfdi(p), qProveedorSinRfc(p),
  ])

  // ── Universo ──────────────────────────────────────────────────────────────
  const issuedInvoices = issuedDocs.filter(d => d.cfdi_type === 'I')
  const issuedNcs      = issuedDocs.filter(d => d.cfdi_type === 'E')
  const receivedInvoices = receivedDocs.filter(d => d.type !== 'credit_note')
  const receivedNcs      = receivedDocs.filter(d => d.type === 'credit_note')

  const live = (rows) => rows.filter(r => r.status !== 'cancelled')

  // IVA en MXN prorrateado (`tax`/`total` vienen en la moneda del CFDI). Mismo
  // criterio que el reporte de trazabilidad: una factura en USD no debe inflar
  // el IVA del periodo.
  const ivaTrasladado = sum(live(issuedInvoices), ivaMxn) - sum(live(issuedNcs), ivaMxn)
  const ivaAcreditable = sum(live(receivedInvoices), ivaMxn) - sum(live(receivedNcs), ivaMxn)
  // El IVA de una factura PPD pagada sin REP no es acreditable todavía.
  const ivaEnRiesgo = sum(apRepMissing, r => parseFloat(r.iva_en_riesgo || 0))

  // ── Excepciones ───────────────────────────────────────────────────────────
  const groups = []
  const addGroup = (key, rows) => {
    if (!rows.length) return
    groups.push({ key, ...ISSUE_TYPES[key], count: rows.length, rows })
  }

  addGroup('ar_rep_missing', arRepMissing.map(r => ({
    doc: r.document_number, uuid: r.cfdi_uuid, date: iso(r.issue_date),
    partner: r.partner_name, rfc: r.partner_rfc,
    amount: num(r.paid),
    detail: num(r.repd) > 0
      ? `Cobrado en el periodo ${money(r.paid)} · complemento timbrado ${money(r.repd)} — falta ${money(num(r.paid) - num(r.repd))}`
      : `Cobrado en el periodo ${money(r.paid)} · sin complemento timbrado`,
  })))

  addGroup('nc_sin_factura', ncSinFactura.map(r => ({
    doc: r.document_number, uuid: r.cfdi_uuid, date: iso(r.doc_date),
    partner: r.partner_name, rfc: r.partner_rfc, amount: num(r.total_mxn),
    detail: 'Sin UUID de factura relacionada',
  })))

  addGroup('cancel_periodo_anterior', cancelPrevio.map(r => ({
    doc: r.document_number, uuid: r.cfdi_uuid, date: iso(r.cancelled_date),
    partner: r.partner_name, rfc: r.partner_rfc, amount: num(r.total_mxn),
    detail: `${r.cfdi_type === 'E' ? 'NC' : 'Factura'} timbrada el ${iso(r.stamp_day)} · cancelada el ${iso(r.cancelled_date)}`,
  })))

  addGroup('cancelada_con_cobros', canceladaConCobros.map(r => ({
    doc: r.document_number, uuid: r.cfdi_uuid, date: iso(r.cancelled_date),
    partner: r.partner_name, rfc: r.partner_rfc, amount: num(r.paid),
    detail: `${money(r.paid)} cobrados siguen aplicados a este CFDI cancelado`,
  })))

  addGroup('remision_sin_factura', remisionesSinFactura.map(r => ({
    doc: r.document_number, uuid: null, date: iso(r.issue_date),
    partner: r.partner_name, rfc: r.partner_rfc, amount: num(r.total_mxn),
    detail: `Remisión ${r.status === 'delivered' ? 'entregada' : r.status} sin CFDI`,
  })))

  addGroup('ap_rep_missing', apRepMissing.map(r => ({
    doc: r.reference || 'Pago sin referencia', uuid: null, date: iso(r.payment_date),
    partner: r.partner_name, rfc: r.partner_rfc, amount: num(r.amount_mxn),
    detail: `Pagado ${money(r.amount_mxn)} a facturas PPD${num(r.rep_amount) > 0 ? ` · REP cruzado ${money(r.rep_amount)}` : ' · sin REP'} — IVA en riesgo ${money(r.iva_en_riesgo)}`,
  })))

  addGroup('cxp_sin_cfdi', cxpSinCfdi.map(r => ({
    doc: r.invoice_number, uuid: null, date: iso(r.invoice_date),
    partner: r.partner_name, rfc: r.partner_rfc, amount: num(r.total_mxn),
    detail: r.is_expense ? `Gasto${r.expense_category ? ` · ${r.expense_category}` : ''} sin CFDI` : 'Compra sin CFDI',
  })))

  addGroup('proveedor_sin_rfc', proveedorSinRfc.map(r => ({
    doc: r.invoice_number, uuid: r.uuid_sat, date: iso(r.invoice_date),
    partner: r.partner_name, rfc: null, amount: num(r.total_mxn),
    detail: 'El emisor no tiene RFC capturado',
  })))

  // "Sin XML" se deriva del universo ya consultado (no vuelve a la BD).
  const sinXml = [
    ...issuedDocs.filter(d => !d.has_xml).map(d => ({
      doc: d.document_number, uuid: d.cfdi_uuid, date: iso(d.doc_date),
      partner: d.partner_name, rfc: d.partner_rfc, amount: num(d.total_mxn),
      detail: d.source === 'imported'
        ? 'Factura importada de otro sistema, sin XML adjunto'
        : 'Emitida por este ERP sin folio del PAC — no se puede recuperar el XML',
    })),
    ...receivedDocs.filter(d => !d.has_xml).map(d => ({
      doc: d.invoice_number, uuid: d.uuid_sat, date: iso(d.invoice_date),
      partner: d.partner_name, rfc: d.partner_rfc, amount: num(d.total_mxn),
      detail: 'CFDI de proveedor capturado a mano, sin XML guardado',
    })),
  ]
  addGroup('sin_xml', sinXml)

  const bySeverity = (s) => groups.filter(g => g.severity === s).reduce((n, g) => n + g.count, 0)

  return {
    period: { from, to },
    universe: {
      issued: {
        invoices:    live(issuedInvoices).length,
        credit_notes: live(issuedNcs).length,
        complements: issuedReps.length,
        cancelled:   issuedDocs.length - live(issuedDocs).length,
        total_mxn:   round2(sum(live(issuedInvoices), d => num(d.total_mxn)) - sum(live(issuedNcs), d => num(d.total_mxn))),
      },
      received: {
        invoices:     live(receivedInvoices).length,
        credit_notes: live(receivedNcs).length,
        complements:  receivedReps.length,
        cancelled:    receivedDocs.length - live(receivedDocs).length,
        total_mxn:    round2(sum(live(receivedInvoices), d => num(d.total_mxn)) - sum(live(receivedNcs), d => num(d.total_mxn))),
      },
    },
    iva: {
      trasladado:  round2(ivaTrasladado),
      acreditable: round2(ivaAcreditable),
      en_riesgo:   round2(ivaEnRiesgo),
      // El neto "en firme" castiga el IVA que aún no es acreditable por REP.
      neto:        round2(ivaTrasladado - ivaAcreditable),
      neto_en_firme: round2(ivaTrasladado - (ivaAcreditable - ivaEnRiesgo)),
    },
    issues: {
      danger: bySeverity('danger'),
      warn:   bySeverity('warn'),
      info:   bySeverity('info'),
      total:  groups.reduce((n, g) => n + g.count, 0),
    },
    groups,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Universo del periodo
// ─────────────────────────────────────────────────────────────────────────────

/**
 * CFDI emitidos (I y E). `has_xml` = el XML es recuperable: las propias por su
 * folio del PAC en notes, las importadas por su adjunto .xml.
 */
async function qIssuedDocs([tenantId, from, to]) {
  const { rows } = await query(`
    SELECT i.id, i.cfdi_type, i.document_number, i.cfdi_uuid, i.status, i.source,
           i.payment_method, i.total, i.total_mxn, i.tax_transferred AS tax,
           COALESCE(i.stamp_date::date, i.issue_date) AS doc_date,
           COALESCE(bp.tax_name, bp.name) AS partner_name, bp.rfc AS partner_rfc,
           (i.notes LIKE '%[facturapi_id:%'
             OR EXISTS (SELECT 1 FROM attachments a
                         WHERE a.tenant_id = i.tenant_id AND a.entity_type = 'invoice'
                           AND a.entity_id = i.id
                           AND (a.mime_type ILIKE '%xml%' OR a.filename ILIKE '%.xml'))
           ) AS has_xml
      FROM invoices i
      JOIN business_partners bp ON bp.id = i.partner_id
     WHERE i.tenant_id = $1 AND i.type = 'issued' AND i.cfdi_type IN ('I', 'E')
       AND i.status IN ('stamped', 'cancelled')
       AND COALESCE(i.stamp_date, i.issue_date::timestamptz) >= $2
       AND COALESCE(i.stamp_date, i.issue_date::timestamptz) <  $3
     ORDER BY doc_date, i.document_number
  `, [tenantId, from, to])
  return rows
}

/** REP emitidos del periodo — un timbre puede cubrir N facturas (mig 214). */
async function qIssuedReps([tenantId, from, to]) {
  const { rows } = await query(`
    SELECT DISTINCT pc.cfdi_uuid
      FROM payment_complements pc
     WHERE pc.tenant_id = $1 AND pc.status = 'stamped'
       AND pc.payment_date >= $2 AND pc.payment_date < $3
  `, [tenantId, from, to])
  return rows
}

/** CFDI recibidos (facturas y NC de proveedor con UUID SAT). */
async function qReceivedDocs([tenantId, from, to]) {
  const { rows } = await query(`
    SELECT si.id, si.type, si.invoice_number, si.uuid_sat, si.status, si.metodo_pago_sat,
           si.total, si.total_mxn, si.tax, si.invoice_date,
           COALESCE(bp.tax_name, bp.name, si.generic_supplier, '—') AS partner_name,
           COALESCE(si.rfc_emisor, bp.rfc) AS partner_rfc,
           (si.xml_content IS NOT NULL
             OR EXISTS (SELECT 1 FROM attachments a
                         WHERE a.tenant_id = si.tenant_id AND a.entity_type = 'supplier_invoice'
                           AND a.entity_id = si.id
                           AND (a.mime_type ILIKE '%xml%' OR a.filename ILIKE '%.xml'))
           ) AS has_xml
      FROM supplier_invoices si
      LEFT JOIN business_partners bp ON bp.id = si.partner_id
     WHERE si.tenant_id = $1 AND si.uuid_sat IS NOT NULL
       AND si.invoice_date >= $2 AND si.invoice_date < $3
     ORDER BY si.invoice_date, si.invoice_number
  `, [tenantId, from, to])
  return rows
}

/** REP recibidos del periodo. */
async function qReceivedReps([tenantId, from, to]) {
  const { rows } = await query(`
    SELECT spc.cfdi_uuid
      FROM supplier_payment_complements spc
     WHERE spc.tenant_id = $1
       AND COALESCE(spc.payment_date, spc.issue_date) >= $2
       AND COALESCE(spc.payment_date, spc.issue_date) <  $3
  `, [tenantId, from, to])
  return rows
}

// ─────────────────────────────────────────────────────────────────────────────
// Excepciones — emitidos
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Cobros en efectivo/transferencia/cheque del periodo sobre facturas PPD cuyo
 * complemento timbrado no cubre lo cobrado. El ancla es el COBRO (no la
 * factura): la obligación del REP nace del pago, no de la emisión.
 */
async function qArRepMissing([tenantId, from, to]) {
  const { rows } = await query(`
    WITH pays AS (
      SELECT ar.document_id AS invoice_id, SUM(ap.amount) AS paid
        FROM ar_payments ap
        JOIN accounts_receivable ar ON ar.id = ap.ar_id
       WHERE ap.tenant_id = $1 AND ap.reversed_at IS NULL
         AND ar.document_type = 'invoice'
         AND ap.payment_method = ANY($4::payment_method[])
         AND ap.payment_date >= $2 AND ap.payment_date < $3
       GROUP BY ar.document_id
    ), reps AS (
      SELECT pc.invoice_id, SUM(pc.amount) AS repd
        FROM payment_complements pc
       WHERE pc.tenant_id = $1 AND pc.status = 'stamped'
         AND pc.payment_date >= $2 AND pc.payment_date < $3
       GROUP BY pc.invoice_id
    )
    SELECT i.document_number, i.cfdi_uuid, i.issue_date, i.total_mxn,
           COALESCE(bp.tax_name, bp.name) AS partner_name, bp.rfc AS partner_rfc,
           p.paid, COALESCE(r.repd, 0) AS repd
      FROM pays p
      JOIN invoices i ON i.id = p.invoice_id AND i.tenant_id = $1
      JOIN business_partners bp ON bp.id = i.partner_id
      LEFT JOIN reps r ON r.invoice_id = i.id
     WHERE i.payment_method = 'PPD' AND i.status <> 'cancelled'
       AND COALESCE(r.repd, 0) < p.paid - 0.005
     ORDER BY i.issue_date, i.document_number
  `, [tenantId, from, to, AR_CASH_METHODS])
  return rows
}

/** NC emitidas del periodo sin la factura que corrigen (relación SAT 01). */
async function qNcSinFactura([tenantId, from, to]) {
  const { rows } = await query(`
    SELECT i.document_number, i.cfdi_uuid, i.total_mxn,
           COALESCE(i.stamp_date::date, i.issue_date) AS doc_date,
           COALESCE(bp.tax_name, bp.name) AS partner_name, bp.rfc AS partner_rfc
      FROM invoices i
      JOIN business_partners bp ON bp.id = i.partner_id
     WHERE i.tenant_id = $1 AND i.type = 'issued' AND i.cfdi_type = 'E'
       AND i.status = 'stamped' AND i.related_invoice_id IS NULL
       AND COALESCE(i.stamp_date, i.issue_date::timestamptz) >= $2
       AND COALESCE(i.stamp_date, i.issue_date::timestamptz) <  $3
     ORDER BY doc_date
  `, [tenantId, from, to])
  return rows
}

/**
 * Canceladas DENTRO del periodo pero timbradas ANTES: el ingreso ya se declaró
 * en otro mes. Estas no aparecen en el universo del periodo — justo por eso hay
 * que sacarlas a la luz.
 */
async function qCancelPeriodoAnterior([tenantId, from, to]) {
  const { rows } = await query(`
    SELECT i.document_number, i.cfdi_uuid, i.cfdi_type, i.total_mxn,
           i.stamp_date::date AS stamp_day, i.cancellation_date::date AS cancelled_date,
           COALESCE(bp.tax_name, bp.name) AS partner_name, bp.rfc AS partner_rfc
      FROM invoices i
      JOIN business_partners bp ON bp.id = i.partner_id
     WHERE i.tenant_id = $1 AND i.type = 'issued' AND i.status = 'cancelled'
       AND i.cancellation_date >= $2 AND i.cancellation_date < $3
       AND i.stamp_date IS NOT NULL AND i.stamp_date < $2
     ORDER BY i.cancellation_date
  `, [tenantId, from, to])
  return rows
}

/** CFDI cancelados que todavía tienen cobros vivos aplicados. */
async function qCanceladaConCobros([tenantId, from, to]) {
  const { rows } = await query(`
    SELECT i.document_number, i.cfdi_uuid, i.cancellation_date::date AS cancelled_date,
           COALESCE(bp.tax_name, bp.name) AS partner_name, bp.rfc AS partner_rfc,
           SUM(ap.amount) AS paid
      FROM invoices i
      JOIN business_partners bp ON bp.id = i.partner_id
      JOIN accounts_receivable ar ON ar.document_id = i.id AND ar.document_type = 'invoice'
                                 AND ar.tenant_id = i.tenant_id
      JOIN ar_payments ap ON ap.ar_id = ar.id AND ap.reversed_at IS NULL
     WHERE i.tenant_id = $1 AND i.type = 'issued' AND i.status = 'cancelled'
       AND i.cancellation_date >= $2 AND i.cancellation_date < $3
     GROUP BY i.id, i.document_number, i.cfdi_uuid, i.cancellation_date, bp.tax_name, bp.name, bp.rfc
    HAVING SUM(ap.amount) > 0.005
     ORDER BY i.cancellation_date
  `, [tenantId, from, to])
  return rows
}

/**
 * Remisiones del periodo sin CFDI vigente. La liga puede venir por
 * `delivery_note_id` (factura individual) o por `invoice_remissions`
 * (consolidada) — mirar solo una de las dos deja falsos positivos.
 */
async function qRemisionesSinFactura([tenantId, from, to]) {
  const { rows } = await query(`
    SELECT dn.document_number, dn.issue_date, dn.total_mxn, dn.status,
           COALESCE(bp.tax_name, bp.name) AS partner_name, bp.rfc AS partner_rfc
      FROM delivery_notes dn
      JOIN business_partners bp ON bp.id = dn.partner_id
     WHERE dn.tenant_id = $1 AND dn.status NOT IN ('cancelled', 'invoiced')
       AND dn.issue_date >= $2 AND dn.issue_date < $3
       AND NOT EXISTS (
         SELECT 1 FROM invoices i
          WHERE i.tenant_id = dn.tenant_id AND i.delivery_note_id = dn.id
            AND i.status <> 'cancelled')
       AND NOT EXISTS (
         SELECT 1 FROM invoice_remissions ir
           JOIN invoices i2 ON i2.id = ir.invoice_id AND i2.status <> 'cancelled'
          WHERE ir.delivery_note_id = dn.id)
     ORDER BY dn.issue_date, dn.document_number
  `, [tenantId, from, to])
  return rows
}

// ─────────────────────────────────────────────────────────────────────────────
// Excepciones — recibidos
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Pagos del periodo aplicados a facturas PPD de proveedor sin REP que los
 * cubra. El ancla es el PAGO (un REP de proveedor cuelga del pago, no de la
 * factura), y el IVA en riesgo se prorratea sobre lo pagado a cada factura.
 */
async function qApRepMissing([tenantId, from, to]) {
  const { rows } = await query(`
    WITH ppd_applied AS (
      -- supplier_payment_applications no tiene tenant_id: el aislamiento entra
      -- por la factura. amount_applied ya está en MXN y (tax/total) es una
      -- razón sin unidades, así que el IVA en riesgo sale directo en MXN.
      SELECT spa.supplier_payment_id AS payment_id,
             SUM(spa.amount_applied) AS ppd_paid,
             SUM(CASE WHEN si.total > 0 THEN spa.amount_applied * (si.tax / si.total) ELSE 0 END) AS iva_en_riesgo
        FROM supplier_payment_applications spa
        JOIN supplier_invoices si ON si.id = spa.supplier_invoice_id
       WHERE si.tenant_id = $1 AND si.metodo_pago_sat = 'PPD' AND si.status <> 'cancelled'
       GROUP BY spa.supplier_payment_id
    ), rep AS (
      SELECT spc.supplier_payment_id AS payment_id, SUM(spc.amount) AS rep_amount
        FROM supplier_payment_complements spc
       WHERE spc.tenant_id = $1 AND spc.match_status = 'matched'
       GROUP BY spc.supplier_payment_id
    )
    SELECT sp.payment_date, sp.reference, sp.method, a.ppd_paid AS amount_mxn,
           COALESCE(r.rep_amount, 0) AS rep_amount, a.iva_en_riesgo,
           COALESCE(bp.tax_name, bp.name, sp.generic_supplier, '—') AS partner_name,
           bp.rfc AS partner_rfc
      FROM supplier_payments sp
      JOIN ppd_applied a ON a.payment_id = sp.id
      LEFT JOIN rep r ON r.payment_id = sp.id
      LEFT JOIN business_partners bp ON bp.id = sp.partner_id
     WHERE sp.tenant_id = $1 AND sp.reversed_at IS NULL
       AND sp.method = ANY($4::ap_payment_method[])
       AND sp.payment_date >= $2 AND sp.payment_date < $3
       AND COALESCE(r.rep_amount, 0) < a.ppd_paid - 0.005
     ORDER BY sp.payment_date
  `, [tenantId, from, to, AP_CASH_METHODS])
  return rows
}

/** CxP del periodo sin CFDI: no deducibles ni acreditables. */
async function qCxpSinCfdi([tenantId, from, to]) {
  const { rows } = await query(`
    SELECT si.invoice_number, si.invoice_date, si.total_mxn, si.is_expense,
           ec.name AS expense_category,
           COALESCE(bp.tax_name, bp.name, si.generic_supplier, '—') AS partner_name,
           bp.rfc AS partner_rfc
      FROM supplier_invoices si
      LEFT JOIN business_partners bp ON bp.id = si.partner_id
      LEFT JOIN tenant_expense_categories ec ON ec.id = si.expense_category_id
     WHERE si.tenant_id = $1 AND si.uuid_sat IS NULL AND si.status <> 'cancelled'
       AND si.invoice_date >= $2 AND si.invoice_date < $3
     ORDER BY si.invoice_date, si.invoice_number
  `, [tenantId, from, to])
  return rows
}

/** CFDI recibidos sin RFC del emisor — no se pueden relacionar en contabilidad. */
async function qProveedorSinRfc([tenantId, from, to]) {
  const { rows } = await query(`
    SELECT si.invoice_number, si.uuid_sat, si.invoice_date, si.total_mxn,
           COALESCE(bp.tax_name, bp.name, si.generic_supplier, '—') AS partner_name
      FROM supplier_invoices si
      LEFT JOIN business_partners bp ON bp.id = si.partner_id
     WHERE si.tenant_id = $1 AND si.uuid_sat IS NOT NULL AND si.status <> 'cancelled'
       AND COALESCE(NULLIF(si.rfc_emisor, ''), NULLIF(bp.rfc, '')) IS NULL
       AND si.invoice_date >= $2 AND si.invoice_date < $3
     ORDER BY si.invoice_date
  `, [tenantId, from, to])
  return rows
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const num = (v) => parseFloat(v || 0) || 0
const sum = (rows, fn) => rows.reduce((s, r) => s + fn(r), 0)

/**
 * IVA del comprobante en MXN. `tax` y `total` están en la moneda del CFDI, así
 * que se prorratean sobre total_mxn para no inflar el IVA de una factura en USD.
 */
function ivaMxn(doc) {
  const tax = num(doc.tax)
  if (!tax) return 0
  const total = num(doc.total)
  const totalMxn = num(doc.total_mxn)
  if (!total || Math.abs(total - totalMxn) < CENTS) return tax
  return totalMxn * (tax / total)
}

/**
 * Normaliza a 'YYYY-MM-DD'. Las columnas DATE llegan como Date a medianoche
 * LOCAL: toISOString() las correría un día atrás en zonas negativas.
 */
function iso(v) {
  if (!v) return null
  if (typeof v === 'string') return v.slice(0, 10)
  const d = v instanceof Date ? v : new Date(v)
  if (Number.isNaN(d.getTime())) return null
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const money = (n) =>
  new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' }).format(num(n))

module.exports = { getFiscalReconciliation, ISSUE_TYPES }
