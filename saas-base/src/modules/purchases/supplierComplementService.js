'use strict'

/**
 * Complementos de pago de PROVEEDOR (REP, CFDI tipo P) RECIBIDOS — mig 235.
 *
 * Cuando el tenant paga una factura PPD, el proveedor debe emitirle un Recibo
 * Electrónico de Pago (REP). Este servicio los registra (llegan por el buzón de
 * correo o subidos a mano), los liga a las FACTURAS que liquidan (cruce
 * DETERMINISTA: DoctoRelacionado.IdDocumento ↔ supplier_invoices.uuid_sat) y al
 * PAGO que el tenant ya registró (supplier_payments — cruce por aplicación/monto,
 * auto solo si es inequívoco; si no, queda 'review').
 *
 * A diferencia de ligar factura↔recepción (irreversible, toca CXP/inventario),
 * ligar un REP NO mueve dinero: es un registro de CUMPLIMIENTO — por eso el
 * auto-ligado es seguro y todo se puede desligar/eliminar.
 */

const { query, withTransaction } = require('../../db')
const { audit } = require('../../utils/audit')
const logger = require('../../config/logger')

function createError(status, message) { const e = new Error(message); e.status = status; return e }
function normRfc(r) { return (r || '').toUpperCase().replace(/\s+/g, '').trim() }

// El enum document_currency solo admite MXN/USD; cualquier otra divisa (EUR…)
// se guarda como MXN y la moneda real queda en los doctos (currency VARCHAR).
function headerCurrency(c) { return ['MXN', 'USD'].includes(c) ? c : 'MXN' }

// Tolerancia para casar el monto del REP contra un pago registrado:
// máx($1, 0.5%) — cubre redondeos de centavos del PAC sin aceptar pagos ajenos.
function amountsClose(a, b) {
  const tol = Math.max(1, Math.abs(b) * 0.005)
  return Math.abs(a - b) <= tol
}

/**
 * Registra un REP parseado (documentParserService, tipoComprobante='P').
 * Idempotente por UUID: si ya existe, devuelve {status:'duplicate'}.
 *
 * @returns {{status:'created'|'duplicate', complementId, matchStatus,
 *            docsMatched, docsTotal, paymentLinked}}
 */
async function ingestComplement({
  tenantId, parsed, source = 'manual', from = null,
  userId, ipAddress, userAgent,
}) {
  if (parsed?.tipoComprobante !== 'P') {
    throw createError(400, 'El CFDI no es un complemento de pago (tipo P).')
  }
  if (!parsed.uuid) {
    throw createError(422, 'El complemento no trae UUID (¿está timbrado?).')
  }

  return withTransaction(async (client) => {
    // Anti-duplicado por UUID (el correo puede llegar dos veces → idempotente).
    const { rows: dup } = await client.query(
      `SELECT id, match_status FROM supplier_payment_complements
        WHERE tenant_id = $1 AND cfdi_uuid = $2`,
      [tenantId, parsed.uuid])
    if (dup.length) {
      return { status: 'duplicate', complementId: dup[0].id, matchStatus: dup[0].match_status }
    }

    // Proveedor por RFC emisor (o genérico).
    const emisorRfc = normRfc(parsed?.emisor?.rfc)
    let partnerId = null, genericSupplier = null
    if (emisorRfc) {
      const { rows: bp } = await client.query(
        `SELECT id FROM business_partners
          WHERE tenant_id = $1 AND UPPER(REPLACE(rfc, ' ', '')) = $2
            AND type IN ('supplier', 'both') AND is_active = true
          LIMIT 1`,
        [tenantId, emisorRfc])
      if (bp[0]) partnerId = bp[0].id
    }
    if (!partnerId) genericSupplier = parsed?.emisor?.name || 'Proveedor (correo)'

    const payments = parsed?.paymentComplement?.payments || []
    const first = payments[0] || {}
    const totalAmount = parseFloat(
      payments.reduce((s, p) => s + (p.amount || 0), 0).toFixed(2))
    const currency = headerCurrency(first.currency || 'MXN')

    // Cabecera del REP.
    const { rows: hdr } = await client.query(
      `INSERT INTO supplier_payment_complements
         (tenant_id, partner_id, generic_supplier, cfdi_uuid, rfc_emisor,
          serie, folio, issue_date, payment_date, payment_form,
          amount, currency, exchange_rate, source, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       RETURNING *`,
      [tenantId, partnerId, genericSupplier, parsed.uuid,
       parsed?.emisor?.rfc || null,
       parsed.serie || null, parsed.folio || null,
       parsed.invoiceDate || null,
       first.paymentDate || null, first.paymentForm || null,
       totalAmount, currency,
       currency === 'MXN' ? null : (first.exchangeRate || null),
       source,
       from ? `Recibido por correo de ${from}` : null,
       userId])
    const complement = hdr[0]

    // Doctos relacionados: cruce determinista UUID → supplier_invoices.
    let docsTotal = 0, docsMatched = 0
    const matchedInvoiceIds = []
    for (const p of payments) {
      for (const doc of (p.relatedDocs || [])) {
        docsTotal++
        let invoiceId = null
        if (doc.uuid) {
          const { rows: inv } = await client.query(
            `SELECT id FROM supplier_invoices
              WHERE tenant_id = $1 AND uuid_sat = $2 AND status <> 'cancelled'
              LIMIT 1`,
            [tenantId, doc.uuid])
          if (inv[0]) { invoiceId = inv[0].id; docsMatched++; matchedInvoiceIds.push(inv[0].id) }
        }
        await client.query(
          `INSERT INTO supplier_payment_complement_docs
             (complement_id, tenant_id, related_uuid, supplier_invoice_id,
              serie, folio, currency, num_parcialidad,
              imp_saldo_ant, imp_pagado, imp_saldo_insoluto)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [complement.id, tenantId, doc.uuid || null, invoiceId,
           doc.serie || null, doc.folio || null, doc.currency || null,
           doc.parcialidad || null,
           doc.impSaldoAnt ?? null, doc.impPagado || 0, doc.impSaldoInsoluto ?? null])
      }
    }

    // Auto-ligado al PAGO registrado — solo si es INEQUÍVOCO.
    const paymentId = await findPaymentForComplement(client, {
      tenantId, partnerId, matchedInvoiceIds,
      amount: totalAmount, currency,
      paymentDate: first.paymentDate || null,
    })

    const matchStatus = (docsTotal > 0 && docsMatched === docsTotal && paymentId)
      ? 'matched' : 'review'
    await client.query(
      `UPDATE supplier_payment_complements
          SET supplier_payment_id = $1, match_status = $2
        WHERE id = $3`,
      [paymentId, matchStatus, complement.id])

    await audit({
      tenantId, userId, action: 'supplier_complement.received',
      resource: 'supplier_payment_complements', resourceId: complement.id,
      payload: { uuid: parsed.uuid, source, amount: totalAmount, currency,
                 docsTotal, docsMatched, paymentLinked: !!paymentId, matchStatus },
      ipAddress, userAgent,
    })
    logger.info('REP recibido', {
      tenantId, complementId: complement.id, uuid: parsed.uuid,
      docsTotal, docsMatched, paymentId, matchStatus })

    return {
      status: 'created', complementId: complement.id,
      matchStatus, docsTotal, docsMatched, paymentLinked: !!paymentId,
    }
  })
}

/**
 * Busca el pago registrado que corresponde al REP. Devuelve su id SOLO si el
 * cruce es inequívoco (exactamente un candidato); si hay 0 o varios → null.
 *
 * Señal fuerte (1º): pagos NO reversados APLICADOS a las facturas que el REP
 * dice liquidar. Señal débil (2º, fallback sin facturas casadas): pagos del
 * mismo proveedor con monto ≈ y fecha cercana (±7 días).
 */
async function findPaymentForComplement(client, {
  tenantId, partnerId, matchedInvoiceIds, amount, currency, paymentDate,
}) {
  if (matchedInvoiceIds.length) {
    const { rows } = await client.query(
      `SELECT DISTINCT sp.id, sp.amount, sp.currency
         FROM supplier_payments sp
         JOIN supplier_payment_applications spa ON spa.supplier_payment_id = sp.id
        WHERE sp.tenant_id = $1 AND sp.reversed_at IS NULL
          AND spa.supplier_invoice_id = ANY($2::uuid[])`,
      [tenantId, matchedInvoiceIds])
    if (rows.length === 1) return rows[0].id
    if (rows.length > 1) {
      // Varios pagos tocaron esas facturas (parcialidades): desempata el monto.
      const byAmount = rows.filter(r =>
        r.currency === currency && amountsClose(parseFloat(r.amount), amount))
      if (byAmount.length === 1) return byAmount[0].id
      return null
    }
  }
  if (!partnerId || !amount) return null
  const params = [tenantId, partnerId, currency]
  let dateClause = ''
  if (paymentDate) {
    params.push(paymentDate)
    dateClause = `AND sp.payment_date BETWEEN $4::date - 7 AND $4::date + 7`
  }
  const { rows } = await client.query(
    `SELECT sp.id, sp.amount FROM supplier_payments sp
      WHERE sp.tenant_id = $1 AND sp.partner_id = $2 AND sp.reversed_at IS NULL
        AND sp.currency = $3 ${dateClause}`,
    params)
  const close = rows.filter(r => amountsClose(parseFloat(r.amount), amount))
  return close.length === 1 ? close[0].id : null
}

/**
 * Reintenta el cruce de un REP en 'review': re-casa doctos por UUID (útil si la
 * factura se registró DESPUÉS de que llegó el REP) y re-busca el pago.
 */
async function rematchComplement({ tenantId, complementId, userId, ipAddress, userAgent }) {
  // OJO: el detalle se lee DESPUÉS del commit (getComplement usa el pool, no la
  // txn — leerlo adentro devolvía el estado viejo).
  await withTransaction(async (client) => {
    const { rows: hdr } = await client.query(
      `SELECT * FROM supplier_payment_complements WHERE id = $1 AND tenant_id = $2`,
      [complementId, tenantId])
    if (!hdr.length) throw createError(404, 'Complemento no encontrado.')
    const c = hdr[0]

    // Re-casa doctos sin factura.
    await client.query(
      `UPDATE supplier_payment_complement_docs d
          SET supplier_invoice_id = si.id
         FROM supplier_invoices si
        WHERE d.complement_id = $1 AND d.tenant_id = $2
          AND d.supplier_invoice_id IS NULL AND d.related_uuid IS NOT NULL
          AND si.tenant_id = $2 AND si.uuid_sat = d.related_uuid
          AND si.status <> 'cancelled'`,
      [complementId, tenantId])

    const { rows: docs } = await client.query(
      `SELECT supplier_invoice_id FROM supplier_payment_complement_docs
        WHERE complement_id = $1`, [complementId])
    const matchedInvoiceIds = docs.map(d => d.supplier_invoice_id).filter(Boolean)

    let paymentId = c.supplier_payment_id
    if (!paymentId) {
      paymentId = await findPaymentForComplement(client, {
        tenantId, partnerId: c.partner_id, matchedInvoiceIds,
        amount: parseFloat(c.amount), currency: c.currency,
        paymentDate: c.payment_date,
      })
    }

    const matchStatus = (docs.length > 0 && matchedInvoiceIds.length === docs.length && paymentId)
      ? 'matched' : 'review'
    await client.query(
      `UPDATE supplier_payment_complements
          SET supplier_payment_id = $1, match_status = $2
        WHERE id = $3`,
      [paymentId, matchStatus, complementId])

    await audit({
      tenantId, userId, action: 'supplier_complement.rematched',
      resource: 'supplier_payment_complements', resourceId: complementId,
      payload: { docsMatched: matchedInvoiceIds.length, docsTotal: docs.length,
                 paymentLinked: !!paymentId, matchStatus },
      ipAddress, userAgent,
    })
  })
  return getComplement({ tenantId, complementId })
}

/** Liga (o re-liga) el REP a un pago registrado — confirmación humana. */
async function linkPayment({ tenantId, complementId, paymentId, userId, ipAddress, userAgent }) {
  const { rows: sp } = await query(
    `SELECT id, reversed_at FROM supplier_payments WHERE id = $1 AND tenant_id = $2`,
    [paymentId, tenantId])
  if (!sp.length) throw createError(404, 'Pago no encontrado.')
  if (sp[0].reversed_at) throw createError(409, 'Ese pago está reversado; liga el REP al pago vigente.')

  const { rows } = await query(
    `UPDATE supplier_payment_complements
        SET supplier_payment_id = $2,
            match_status = CASE WHEN NOT EXISTS (
              SELECT 1 FROM supplier_payment_complement_docs d
               WHERE d.complement_id = supplier_payment_complements.id
                 AND d.supplier_invoice_id IS NULL)
              THEN 'matched' ELSE 'review' END
      WHERE id = $1 AND tenant_id = $3
      RETURNING id`,
    [complementId, paymentId, tenantId])
  if (!rows.length) throw createError(404, 'Complemento no encontrado.')

  await audit({
    tenantId, userId, action: 'supplier_complement.payment_linked',
    resource: 'supplier_payment_complements', resourceId: complementId,
    payload: { paymentId }, ipAddress, userAgent,
  })
  return getComplement({ tenantId, complementId })
}

/** Desliga el pago (el REP queda 'review'). */
async function unlinkPayment({ tenantId, complementId, userId, ipAddress, userAgent }) {
  const { rows } = await query(
    `UPDATE supplier_payment_complements
        SET supplier_payment_id = NULL, match_status = 'review'
      WHERE id = $1 AND tenant_id = $2
      RETURNING id`,
    [complementId, tenantId])
  if (!rows.length) throw createError(404, 'Complemento no encontrado.')
  await audit({
    tenantId, userId, action: 'supplier_complement.payment_unlinked',
    resource: 'supplier_payment_complements', resourceId: complementId,
    payload: {}, ipAddress, userAgent,
  })
  return getComplement({ tenantId, complementId })
}

/**
 * Elimina un REP recibido (con sus doctos, por CASCADE) y sus respaldos XML/PDF.
 * No mueve dinero → es seguro; el anti-dup deja volver a subirlo si hace falta.
 */
async function removeComplement({ tenantId, complementId, userId, ipAddress, userAgent }) {
  const attachmentService = require('../attachments/attachmentService')
  const { rows } = await query(
    `DELETE FROM supplier_payment_complements
      WHERE id = $1 AND tenant_id = $2
      RETURNING id, cfdi_uuid`,
    [complementId, tenantId])
  if (!rows.length) throw createError(404, 'Complemento no encontrado.')

  // Respaldos (best-effort: si el storage falla, el registro ya se eliminó).
  try {
    const atts = await attachmentService.listAttachments({
      tenantId, entityType: 'supplier_payment_complement', entityId: complementId })
    for (const a of atts) {
      await attachmentService.deleteAttachment({ tenantId, attachmentId: a.id })
    }
  } catch (e) {
    logger.warn('No se pudieron eliminar los respaldos del REP', {
      complementId, error: e.message })
  }

  await audit({
    tenantId, userId, action: 'supplier_complement.deleted',
    resource: 'supplier_payment_complements', resourceId: complementId,
    payload: { uuid: rows[0].cfdi_uuid }, ipAddress, userAgent,
  })
  return { deleted: true }
}

/** Listado de REP recibidos, con filtros. */
async function listComplements({ tenantId, status, partnerId, search, page = 1, limit = 20 }) {
  const offset = (page - 1) * limit
  const params = [tenantId]
  const filters = []
  if (status)    { params.push(status);    filters.push(`c.match_status = $${params.length}`) }
  if (partnerId) { params.push(partnerId); filters.push(`c.partner_id = $${params.length}`) }
  if (search && String(search).trim()) {
    params.push(`%${String(search).trim()}%`)
    filters.push(`(bp.name ILIKE $${params.length} OR c.generic_supplier ILIKE $${params.length}
                   OR c.cfdi_uuid::text ILIKE $${params.length}
                   OR c.serie ILIKE $${params.length} OR c.folio ILIKE $${params.length})`)
  }
  const where = filters.length ? `AND ${filters.join(' AND ')}` : ''
  params.push(limit, offset)

  const { rows } = await query(
    `SELECT c.id, c.cfdi_uuid, c.serie, c.folio, c.issue_date, c.payment_date,
            c.payment_form, c.amount, c.currency, c.match_status, c.source,
            c.created_at, c.supplier_payment_id,
            COALESCE(bp.name, c.generic_supplier) AS partner_name,
            bp.rfc AS partner_rfc,
            sp.payment_date AS linked_payment_date, sp.reference AS linked_payment_reference,
            sp.amount AS linked_payment_amount,
            (SELECT COUNT(*) FROM supplier_payment_complement_docs d
              WHERE d.complement_id = c.id)::int AS docs_total,
            (SELECT COUNT(*) FROM supplier_payment_complement_docs d
              WHERE d.complement_id = c.id AND d.supplier_invoice_id IS NOT NULL)::int AS docs_matched,
            (SELECT string_agg(DISTINCT si.invoice_number, ', ')
               FROM supplier_payment_complement_docs d
               JOIN supplier_invoices si ON si.id = d.supplier_invoice_id
              WHERE d.complement_id = c.id) AS invoice_numbers
       FROM supplier_payment_complements c
       LEFT JOIN business_partners bp ON bp.id = c.partner_id
       LEFT JOIN supplier_payments sp ON sp.id = c.supplier_payment_id
      WHERE c.tenant_id = $1 ${where}
      ORDER BY c.created_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params)

  const { rows: countRows } = await query(
    `SELECT COUNT(*) AS n,
            COUNT(*) FILTER (WHERE c.match_status = 'review') AS review_count
       FROM supplier_payment_complements c
       LEFT JOIN business_partners bp ON bp.id = c.partner_id
      WHERE c.tenant_id = $1 ${where}`,
    params.slice(0, params.length - 2))

  return {
    data: rows,
    total: parseInt(countRows[0].n, 10),
    reviewCount: parseInt(countRows[0].review_count, 10),
    page, limit,
  }
}

/** Detalle de un REP: cabecera + doctos (con su factura) + pago ligado + respaldos. */
async function getComplement({ tenantId, complementId }) {
  const { rows } = await query(
    `SELECT c.*, COALESCE(bp.name, c.generic_supplier) AS partner_name,
            bp.rfc AS partner_rfc,
            sp.payment_date AS linked_payment_date, sp.reference AS linked_payment_reference,
            sp.amount AS linked_payment_amount, sp.currency AS linked_payment_currency,
            sp.method AS linked_payment_method, sp.reversed_at AS linked_payment_reversed_at,
            u.full_name AS created_by_name
       FROM supplier_payment_complements c
       LEFT JOIN business_partners bp ON bp.id = c.partner_id
       LEFT JOIN supplier_payments sp ON sp.id = c.supplier_payment_id
       LEFT JOIN users u ON u.id = c.created_by
      WHERE c.id = $1 AND c.tenant_id = $2`,
    [complementId, tenantId])
  if (!rows.length) throw createError(404, 'Complemento no encontrado.')
  const complement = rows[0]

  const { rows: docs } = await query(
    `SELECT d.id, d.related_uuid, d.supplier_invoice_id, d.serie, d.folio,
            d.currency, d.num_parcialidad, d.imp_saldo_ant, d.imp_pagado,
            d.imp_saldo_insoluto,
            si.invoice_number, si.status AS invoice_status, si.total AS invoice_total,
            si.metodo_pago_sat
       FROM supplier_payment_complement_docs d
       LEFT JOIN supplier_invoices si ON si.id = d.supplier_invoice_id
      WHERE d.complement_id = $1 AND d.tenant_id = $2
      ORDER BY d.created_at`,
    [complementId, tenantId])

  const { rows: attachments } = await query(
    `SELECT a.id, a.filename, a.mime_type, a.file_size_bytes, a.created_at
       FROM attachments a
      WHERE a.tenant_id = $1 AND a.entity_type = 'supplier_payment_complement'
        AND a.entity_id = $2
      ORDER BY a.created_at DESC`,
    [tenantId, complementId])

  return { ...complement, docs, attachments }
}

/**
 * Tablero de cumplimiento: facturas PPD con pagos aplicados cuya suma de REP
 * recibidos NO cubre lo pagado. Son las que hay que perseguir con el proveedor.
 *
 * Los montos se comparan en MXN (la CXP y los pagos se aplican en MXN); la
 * cobertura del REP convierte con su tipo de cambio cuando no es MXN.
 */
async function listCompliance({ tenantId }) {
  const { rows } = await query(
    `SELECT si.id, si.invoice_number, si.uuid_sat, si.invoice_date,
            si.total, si.total_mxn, si.currency, si.status AS invoice_status,
            COALESCE(bp.name, si.generic_supplier) AS partner_name,
            bp.rfc AS partner_rfc, si.partner_id,
            paid.amount_paid_mxn,
            paid.last_payment_date,
            COALESCE(cov.covered_mxn, 0) AS covered_mxn
       FROM supplier_invoices si
       LEFT JOIN business_partners bp ON bp.id = si.partner_id
       JOIN LATERAL (
         SELECT SUM(spa.amount_applied) AS amount_paid_mxn,
                MAX(sp.payment_date)    AS last_payment_date
           FROM supplier_payment_applications spa
           JOIN supplier_payments sp ON sp.id = spa.supplier_payment_id
          WHERE spa.supplier_invoice_id = si.id AND sp.reversed_at IS NULL
       ) paid ON paid.amount_paid_mxn > 0.01
       LEFT JOIN LATERAL (
         SELECT SUM(d.imp_pagado * CASE WHEN c.currency = 'MXN' OR c.exchange_rate IS NULL
                                        THEN 1 ELSE c.exchange_rate END) AS covered_mxn
           FROM supplier_payment_complement_docs d
           JOIN supplier_payment_complements c ON c.id = d.complement_id
          WHERE d.supplier_invoice_id = si.id
       ) cov ON true
      WHERE si.tenant_id = $1
        AND si.type = 'invoice'
        AND si.status <> 'cancelled'
        AND si.metodo_pago_sat = 'PPD'
        AND COALESCE(cov.covered_mxn, 0) < paid.amount_paid_mxn - 0.01
      ORDER BY paid.last_payment_date ASC`,
    [tenantId])

  return {
    data: rows,
    total: rows.length,
    // Aviso de cobertura del tablero: facturas sin MetodoPago conocido (previas
    // a esta versión o registradas sin XML) NO se vigilan — el front lo explica.
    unknownMethodCount: await countUnknownMethod(tenantId),
  }
}

async function countUnknownMethod(tenantId) {
  const { rows } = await query(
    `SELECT COUNT(*) AS n
       FROM supplier_invoices si
      WHERE si.tenant_id = $1 AND si.type = 'invoice'
        AND si.status NOT IN ('cancelled') AND si.metodo_pago_sat IS NULL
        AND si.uuid_sat IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM supplier_payment_applications spa
            JOIN supplier_payments sp ON sp.id = spa.supplier_payment_id
           WHERE spa.supplier_invoice_id = si.id AND sp.reversed_at IS NULL)`,
    [tenantId])
  return parseInt(rows[0].n, 10)
}

module.exports = {
  ingestComplement, rematchComplement,
  linkPayment, unlinkPayment, removeComplement,
  listComplements, getComplement, listCompliance,
}
