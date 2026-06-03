'use strict'

const { query, withTransaction } = require('../../db')
const { audit }                  = require('../../utils/audit')
const { getRateForDate }         = require('../exchange-rates/exchangeRateService')
const invoiceSeriesService       = require('../invoice-series/invoiceSeriesService')
const { normalizeLineTax, lineCausesTax } = require('./lineTax')

/**
 * Carga sat_unit_code para un conjunto de pack_option_id.
 * Devuelve { [id]: { sat_unit_code, pack_unit, base_per_pack } }.
 */
async function loadPackOptions(client, packOptionIds = []) {
  if (!packOptionIds.length) return {}
  const { rows } = await client.query(
    `SELECT id, pack_unit, base_per_pack, sat_unit_code
       FROM product_pack_options
      WHERE id = ANY($1::uuid[])`,
    [packOptionIds]
  )
  return Object.fromEntries(rows.map(r => [r.id, r]))
}

/**
 * Revaluación de líneas con precio original en moneda extranjera.
 *
 * Para cada línea con `original_unit_price` + `original_currency` distinto a
 * la moneda objetivo de la factura, aplica el TC del día (DOF) y devuelve el
 * unit_price en la moneda objetivo. Las líneas sin original_* mantienen su
 * unit_price intacto.
 *
 * Hoy solo soporta USD→MXN (caso común: producto cotizado en USD, factura
 * en MXN al TC del día). Si en el futuro hay otras combinaciones, se agregan
 * aquí sin tocar los callers.
 */
async function revalueLines(client, tenantId, lines, targetCurrency, todayDate) {
  const needsRevalue = lines.some(l =>
    l.original_currency &&
    l.original_unit_price != null &&
    l.original_currency !== targetCurrency
  )
  if (!needsRevalue) {
    return {
      lines: lines.map(l => ({
        ...l,
        finalUnitPrice: parseFloat(l.unit_price),
        finalRate:      l.applied_exchange_rate != null ? parseFloat(l.applied_exchange_rate) : null,
        finalRateDate:  l.applied_exchange_rate_date
          ? (l.applied_exchange_rate_date instanceof Date
               ? l.applied_exchange_rate_date.toISOString().split('T')[0]
               : String(l.applied_exchange_rate_date).slice(0, 10))
          : null,
      })),
      revalued: false,
    }
  }

  let tc = null
  let tcDate = null
  if (targetCurrency === 'MXN' && lines.some(l => l.original_currency === 'USD')) {
    const rate = await getRateForDate({ tenantId, date: todayDate, currency: 'USD' })
    if (!rate) throw createError(400, 'No hay tipo de cambio del día para revaluar líneas en USD. Sincroniza el TC primero.')
    tc = parseFloat(rate.rate_mxn)
    tcDate = rate.rate_date instanceof Date
      ? rate.rate_date.toISOString().split('T')[0]
      : String(rate.rate_date).slice(0, 10)
  }

  const revaluedLines = lines.map(l => {
    if (l.original_currency === 'USD' && targetCurrency === 'MXN' && l.original_unit_price != null) {
      // original_unit_price es por UNIDAD BASE (millar). unit_price del doc
      // ya viene multiplicado por pack_factor (rollo = 3 millares).
      // Para preservar el monto al revaluar, también multiplicamos.
      const factor = l.pack_factor != null ? parseFloat(l.pack_factor) : 1
      return {
        ...l,
        finalUnitPrice: parseFloat((parseFloat(l.original_unit_price) * tc * factor).toFixed(4)),
        finalRate:      tc,
        finalRateDate:  tcDate,
      }
    }
    return {
      ...l,
      finalUnitPrice: parseFloat(l.unit_price),
      finalRate:      l.applied_exchange_rate != null ? parseFloat(l.applied_exchange_rate) : null,
      finalRateDate:  l.applied_exchange_rate_date
        ? (l.applied_exchange_rate_date instanceof Date
             ? l.applied_exchange_rate_date.toISOString().split('T')[0]
             : String(l.applied_exchange_rate_date).slice(0, 10))
        : null,
    }
  })

  return { lines: revaluedLines, revalued: true, tc, tcDate }
}

/**
 * Genera el siguiente número de factura usando el modelo de series multi-RFC
 * (migración 147). El document_number se arma como `{serie}-{folio_padded_4}`.
 *
 * Si el tenant aún no tiene perfiles fiscales configurados (instalación legacy
 * pre-091), cae al patrón viejo `FAC-YYYYMM-NNNN`. Esto permite que tenants
 * que nunca migraron a multi-RFC sigan operando sin tocar nada.
 *
 * Devuelve `{ docNumber, series, folio, fiscalProfileId }`:
 *   - docNumber → string completo para `invoices.document_number`
 *   - series, folio, fiscalProfileId → se guardan en sus columnas dedicadas
 *     (NULL los dos últimos si fue modo legacy).
 *
 * @param {object} opts
 * @param {string} [opts.seriesId]   - Forzar una serie específica (UI selector).
 * @param {string} [opts.seriesCode] - Forzar serie por código (string "A" desde body legacy).
 * @param {string} [opts.cfdiType]   - 'I'/'E'/'P'/... — busca default por tipo.
 * @param {string} [opts.fiscalProfileId] - Forzar perfil; default = el is_default del tenant.
 */
async function nextInvoiceNumber(client, tenantId, opts = {}) {
  let fiscalProfileId = opts.fiscalProfileId
  if (!fiscalProfileId) {
    // La mig 092 dejó un solo perfil fiscal activo por tenant y eliminó la
    // columna is_default. Ordenamos por created_at para elegir el más antiguo
    // de forma estable (antes había un `ORDER BY is_default DESC` que tronaba
    // contra la columna eliminada — rompía createDirect/createFromRemissions
    // también, no solo la factura ocasional).
    const { rows } = await client.query(
      `SELECT id FROM tenant_fiscal_profiles
        WHERE tenant_id = $1 AND is_active = TRUE
        ORDER BY created_at ASC LIMIT 1`,
      [tenantId]
    )
    fiscalProfileId = rows[0]?.id || null
  }

  // Modo legacy — tenant sin perfiles fiscales configurados aún
  if (!fiscalProfileId) {
    const ym = new Date().toISOString().slice(0, 7).replace('-', '')
    const prefix = `FAC-${ym}-`
    const { rows } = await client.query(
      `SELECT document_number FROM invoices
       WHERE tenant_id = $1 AND document_number LIKE $2
       ORDER BY document_number DESC LIMIT 1`,
      [tenantId, `${prefix}%`]
    )
    const last = rows[0]?.document_number
    const seq = last ? parseInt(last.split('-')[2], 10) + 1 : 1
    return {
      docNumber: `${prefix}${String(seq).padStart(4, '0')}`,
      series: null,
      folio: null,
      fiscalProfileId: null,
    }
  }

  // Modo nuevo — resolver serie + consumir folio atómicamente
  const series = await invoiceSeriesService.resolveSeriesForEmission({
    client, tenantId, fiscalProfileId,
    seriesId:   opts.seriesId,
    seriesCode: opts.seriesCode,
    cfdiType:   opts.cfdiType,
  })

  // Consumir folios hasta dar con un document_number LIBRE. El contador
  // (folio_next) puede quedar DETRÁS del folio máximo real de la serie —p.ej.
  // si hay dos series con la misma letra, si se editó "próximo folio", o por
  // facturas previas— y entonces `${serie}-${folio}` choca con la constraint
  // única `inv_number_tenant` → el INSERT reventaba con un 500 al regenerar una
  // factura. Cada vuelta AVANZA el contador, así que el desfase se auto-sana de
  // forma permanente. La cota evita ciclar si algo más anda mal.
  let docNumber = null, serie = null, folio = null
  for (let attempt = 0; attempt < 1000 && docNumber === null; attempt++) {
    const consumed = await invoiceSeriesService.consumeNextFolio({ client, seriesId: series.id })
    const candidate = `${consumed.serie}-${String(consumed.folio).padStart(4, '0')}`
    const { rows: dup } = await client.query(
      `SELECT 1 FROM invoices WHERE tenant_id = $1 AND document_number = $2 LIMIT 1`,
      [tenantId, candidate]
    )
    if (!dup.length) { docNumber = candidate; serie = consumed.serie; folio = consumed.folio }
  }
  if (docNumber === null) {
    throw createError(409,
      'No se pudo asignar un folio libre para la factura. Revisa la serie en Configuración — el contador de folios quedó muy desfasado.')
  }

  return {
    docNumber,
    series:    serie,
    folio:     String(folio),
    fiscalProfileId,
  }
}

/**
 * Lista facturas con filtros.
 */
async function listInvoices({ tenantId, status, partnerId, from, to, page = 1, limit = 50 }) {
  const offset = (page - 1) * limit
  const params = [tenantId]
  const filters = []

  if (status)    { params.push(status);    filters.push(`inv.status = $${params.length}`) }
  if (partnerId) { params.push(partnerId); filters.push(`inv.partner_id = $${params.length}`) }
  if (from)      { params.push(from);      filters.push(`inv.issue_date >= $${params.length}`) }
  if (to)        { params.push(to);        filters.push(`inv.issue_date <= $${params.length}`) }

  const where = filters.length ? `AND ${filters.join(' AND ')}` : ''
  params.push(limit, offset)

  const { rows } = await query(
    `SELECT inv.id, inv.document_number, inv.series, inv.folio,
            inv.status, inv.cfdi_type, inv.cfdi_uuid,
            inv.issue_date, inv.stamp_date,
            inv.currency, inv.subtotal, inv.tax_transferred, inv.total, inv.total_mxn,
            inv.payment_method, inv.payment_form,
            bp.name AS partner_name, bp.rfc AS partner_rfc,
            dn.document_number AS remission_number,
            u.full_name AS created_by_name
     FROM invoices inv
     JOIN business_partners bp ON bp.id = inv.partner_id
     LEFT JOIN delivery_notes dn ON dn.id = inv.delivery_note_id
     LEFT JOIN users u ON u.id = inv.created_by
     WHERE inv.tenant_id = $1 AND inv.type = 'issued' ${where}
     ORDER BY inv.issue_date DESC, inv.document_number DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  )

  const { rows: countRows } = await query(
    `SELECT COUNT(*) FROM invoices inv
     WHERE inv.tenant_id = $1 AND inv.type = 'issued' ${where}`,
    params.slice(0, params.length - 2)
  )

  return { data: rows, total: parseInt(countRows[0].count, 10), page, limit }
}

/**
 * Detalle de una factura con sus líneas.
 */
async function getInvoice({ tenantId, invoiceId }) {
  const { rows } = await query(
    `SELECT inv.*,
            bp.name AS partner_name, bp.tax_name AS partner_tax_name,
            bp.rfc, bp.cfdi_use,
            bp.payment_method AS bp_payment_method,
            bp.payment_form AS bp_payment_form,
            bp.billing_notes, bp.requires_po,
            bp.credit_days, bp.credit_type,
            dn.document_number AS remission_number,
            so.order_number,
            u.full_name AS created_by_name
     FROM invoices inv
     JOIN business_partners bp ON bp.id = inv.partner_id
     LEFT JOIN delivery_notes dn ON dn.id = inv.delivery_note_id
     LEFT JOIN sales_orders so ON so.id = dn.sales_order_id
     LEFT JOIN users u ON u.id = inv.created_by
     WHERE inv.id = $1 AND inv.tenant_id = $2`,
    [invoiceId, tenantId]
  )
  if (!rows.length) return null

  const { rows: lines } = await query(
    `SELECT il.*, p.sku, p.name AS product_name
     FROM invoice_lines il
     LEFT JOIN products p ON p.id = il.product_id
     WHERE il.invoice_id = $1
     ORDER BY il.line_number`,
    [invoiceId]
  )

  // Contactos del cliente con email (para prellenar destinatarios al enviar por correo)
  const { rows: contacts } = await query(
    `SELECT id, name, email, is_primary
       FROM business_partner_contacts
      WHERE business_partner_id = $1
      ORDER BY is_primary DESC NULLS LAST, id ASC`,
    [rows[0].partner_id]
  )

  // Notas de crédito asociadas: están guardadas como invoices(cfdi_type='E')
  // con document_number "NC-{numero_factura}" (legacy, sin sufijo) o
  // "NC-{numero_factura}-NN" (con sufijo desde la migración 081).
  const { rows: creditNotes } = await query(
    `SELECT id, document_number, cfdi_uuid, total, stamp_date, status, notes
       FROM invoices
      WHERE tenant_id = $1
        AND cfdi_type = 'E'
        AND document_number LIKE 'NC-' || $2 || '%'
      ORDER BY stamp_date DESC`,
    [tenantId, rows[0].document_number]
  )

  // Complementos de pago (CFDI tipo P) emitidos para esta factura.
  const { rows: paymentComplements } = await query(
    `SELECT id, facturapi_id, cfdi_uuid, payment_date, payment_form,
            amount, currency, reference, status, created_at
       FROM payment_complements
      WHERE tenant_id = $1 AND invoice_id = $2
      ORDER BY payment_date DESC, created_at DESC`,
    [tenantId, invoiceId]
  )

  // Retenciones (ISR / IVA) de la factura.
  const { rows: retentions } = await query(
    `SELECT id, tax_type, rate, amount FROM invoice_retentions
      WHERE invoice_id = $1 ORDER BY tax_type`,
    [invoiceId]
  )

  return { ...rows[0], lines, contacts, creditNotes, paymentComplements, retentions }
}

/**
 * Crea una factura desde una remisión entregada.
 *
 * Permite facturar todas las líneas o un subset (split):
 *   - Si `deliveryNoteLineIds` NO se pasa → se facturan todas las líneas
 *     pendientes (no facturadas en otra factura activa).
 *   - Si `deliveryNoteLineIds` SÍ se pasa → solo esas líneas.
 *
 * Validaciones:
 *   - La remisión debe estar 'delivered'.
 *   - Ninguna línea seleccionada puede estar ya en una factura activa.
 *   - La remisión NO debe tener pagos en su AR (limita el primer release de
 *     split a casos sin pagos previos para evitar tener que prorratear).
 *
 * Manejo de AR:
 *   - Cobertura completa (todas las líneas pendientes facturadas en esta
 *     operación): se migra el AR de la remisión a la factura (patrón legacy).
 *   - Split parcial: se crea un AR-factura nuevo por el monto facturado y
 *     se reduce el `amount_total` del AR-remisión. Si el AR-remisión queda
 *     en 0 se cancela.
 */
// ── Retenciones (ISR/IVA) compartidas por todos los flujos de factura ────────
// computeRetentions: calcula montos sobre la base gravable (pura, sin DB).
// saveRetentions: persiste invoice_retentions + setea tax_withheld. El `total`
// de cada flujo ya se ajusta restando withheldTotal ANTES de crear la factura y
// su cuenta por cobrar, para que el cliente deba el neto.
function computeRetentions(retentions, taxableBase) {
  const computed = (retentions || [])
    .map(r => ({ taxType: r.taxType === 'ISR' ? 'ISR' : 'IVA', rate: parseFloat(r.rate) || 0 }))
    .filter(r => r.rate > 0)
    .map(r => ({ ...r, amount: parseFloat((taxableBase * r.rate / 100).toFixed(2)) }))
  const withheldTotal = parseFloat(computed.reduce((s, r) => s + r.amount, 0).toFixed(2))
  return { computedRetentions: computed, withheldTotal }
}
async function saveRetentions(client, invoiceId, computedRetentions) {
  if (!computedRetentions || computedRetentions.length === 0) return
  for (const r of computedRetentions) {
    await client.query(
      `INSERT INTO invoice_retentions (invoice_id, tax_type, rate, amount) VALUES ($1,$2,$3,$4)`,
      [invoiceId, r.taxType, r.rate, r.amount]
    )
  }
  const withheld = parseFloat(computedRetentions.reduce((s, r) => s + r.amount, 0).toFixed(2))
  await client.query(`UPDATE invoices SET tax_withheld = $1 WHERE id = $2`, [withheld, invoiceId])
}

async function createFromRemission({
  tenantId, deliveryNoteId, deliveryNoteLineIds,
  series, paymentMethod, paymentForm, useCfdi, poNumber, notes, retentions = [],
  userId, ipAddress, userAgent,
}) {
  return withTransaction(async (client) => {
    // Obtener remisión con datos del cliente y po_number del pedido relacionado
    const { rows: noteRows } = await client.query(
      `SELECT dn.*, bp.cfdi_use, bp.payment_method AS bp_payment_method,
              bp.payment_form AS bp_payment_form, bp.rfc, bp.credit_days, bp.credit_type,
              bp.auto_send_invoice, bp.billing_notes,
              so.po_number AS sales_order_po
       FROM delivery_notes dn
       JOIN business_partners bp ON bp.id = dn.partner_id
       LEFT JOIN sales_orders so ON so.id = dn.sales_order_id
       WHERE dn.id = $1 AND dn.tenant_id = $2 AND dn.status = 'delivered'`,
      [deliveryNoteId, tenantId]
    )
    if (!noteRows.length) throw createError(404, 'Remisión no encontrada o no está entregada.')
    const note = noteRows[0]

    // Bloquear si la remisión ya está en una factura CONSOLIDADA: su
    // delivery_note_id quedó NULL, así que el chequeo de líneas de abajo no la
    // vería y se podría doble-facturar (mig 190 / invoice_remissions).
    const { rows: consolRows } = await client.query(
      `SELECT iv.document_number FROM invoice_remissions ir
         JOIN invoices iv ON iv.id = ir.invoice_id
        WHERE ir.delivery_note_id = $1 AND iv.status <> 'cancelled' LIMIT 1`,
      [deliveryNoteId]
    )
    if (consolRows.length) {
      throw createError(409, `La remisión ya fue facturada (consolidada en ${consolRows[0].document_number}).`)
    }

    // Bloquear split si la remisión tiene pagos en su AR
    const { rows: arRows } = await client.query(
      `SELECT id, amount_total, amount_paid FROM accounts_receivable
        WHERE tenant_id = $1 AND document_type = 'remission' AND document_id = $2
          AND status <> 'cancelled'`,
      [tenantId, deliveryNoteId]
    )
    const remisionAr = arRows[0] || null
    const hasPayments = remisionAr && parseFloat(remisionAr.amount_paid || 0) > 0
    if (hasPayments && Array.isArray(deliveryNoteLineIds)) {
      throw createError(409,
        'La remisión tiene pagos aplicados. Para facturar parcialmente, primero reversa los pagos.')
    }

    const today = new Date().toISOString().split('T')[0]

    // Cargar TODAS las líneas (con campos original_*) y luego filtrar por
    // selección si vino. Necesitamos todas para decidir cobertura.
    const { rows: allNoteLines } = await client.query(
      `SELECT dnl.*, p.sku, p.name AS product_name,
              p.sat_product_code, p.objeto_imp
       FROM delivery_note_lines dnl
       LEFT JOIN products p ON p.id = dnl.product_id
       WHERE dnl.delivery_note_id = $1
       ORDER BY dnl.line_number`,
      [deliveryNoteId]
    )

    // Líneas ya facturadas (en facturas activas) — no se pueden re-facturar
    const allLineIds = allNoteLines.map(l => l.id)
    const { rows: alreadyInvoicedRows } = allLineIds.length ? await client.query(
      `SELECT il.delivery_note_line_id AS dnl_id, inv.document_number
         FROM invoice_lines il
         JOIN invoices inv ON inv.id = il.invoice_id
        WHERE il.delivery_note_line_id = ANY($1::uuid[])
          AND inv.status <> 'cancelled'`,
      [allLineIds]
    ) : { rows: [] }
    const alreadyInvoicedIds = new Set(alreadyInvoicedRows.map(r => r.dnl_id))

    // Resolver qué líneas se van a facturar en esta operación
    let selectedIds
    if (Array.isArray(deliveryNoteLineIds) && deliveryNoteLineIds.length) {
      // Validar que pertenezcan a la remisión
      const allowed = new Set(allLineIds)
      for (const id of deliveryNoteLineIds) {
        if (!allowed.has(id)) {
          throw createError(400, 'Una de las líneas seleccionadas no pertenece a la remisión.')
        }
        if (alreadyInvoicedIds.has(id)) {
          throw createError(409, 'Una de las líneas seleccionadas ya está en otra factura activa.')
        }
      }
      selectedIds = new Set(deliveryNoteLineIds)
    } else {
      // Sin selección explícita: todas las pendientes
      selectedIds = new Set(allLineIds.filter(id => !alreadyInvoicedIds.has(id)))
      if (selectedIds.size === 0) {
        throw createError(409, 'Esta remisión ya tiene todas sus líneas facturadas.')
      }
    }

    const noteLines = allNoteLines.filter(l => selectedIds.has(l.id))
    if (!noteLines.length) {
      throw createError(400, 'No hay líneas seleccionadas para facturar.')
    }

    // Cobertura: ¿esta factura cubre todas las líneas que aún no estaban facturadas?
    const pendingCount = allLineIds.length - alreadyInvoicedIds.size
    const fullCoverage = noteLines.length === pendingCount && alreadyInvoicedIds.size === 0
    const { lines: revaluedLines, revalued } = await revalueLines(
      client, tenantId, noteLines, note.currency, today
    )

    // Recalcular totales con líneas (posiblemente revaluadas)
    let subtotal = 0
    for (const line of revaluedLines) {
      const lineSubtotal = parseFloat(line.quantity_delivered) * line.finalUnitPrice *
                           (1 - parseFloat(line.discount_pct || 0) / 100)
      subtotal += lineSubtotal
    }
    const tax   = subtotal * 0.16
    const { computedRetentions, withheldTotal } = computeRetentions(retentions, subtotal)
    const total = subtotal + tax - withheldTotal

    // TC del documento si la factura sigue siendo USD (caso legacy sin
    // original_*). Mantiene el comportamiento de revaluación previo a 072.
    let exchangeRateId    = note.exchange_rate_id
    let exchangeRateValue = parseFloat(note.exchange_rate_value || 1)
    let totalMxn          = total
    if (note.currency === 'USD' && !revalued) {
      const rate = await getRateForDate({ tenantId, date: today, currency: 'USD' })
      if (rate) {
        exchangeRateId    = rate.id
        exchangeRateValue = parseFloat(rate.rate_mxn)
        totalMxn          = parseFloat((total * exchangeRateValue).toFixed(2))
      } else {
        totalMxn = parseFloat((total * exchangeRateValue).toFixed(2))
      }
    }

    const { docNumber, series: resolvedSeries, folio: resolvedFolio, fiscalProfileId } =
      await nextInvoiceNumber(client, tenantId, { seriesCode: series, cfdiType: 'I' })
    const issueDate = today

    // Obtener datos fiscales del emisor
    const { rows: fiscalRows } = await client.query(
      `SELECT rfc, razon_social, tax_regime, zip_code, serie_default
       FROM tenant_fiscal_info WHERE tenant_id = $1`,
      [tenantId]
    )
    const fiscal = fiscalRows[0] || {}

    // Obtener datos fiscales del receptor
    const { rows: bpRows } = await client.query(
      `SELECT tax_regime_code, zip_code FROM business_partners WHERE id = $1`,
      [note.partner_id]
    )
    const bp = bpRows[0] || {}

    // OC del cliente: prioridad al body, fallback al pedido relacionado
    const resolvedPoNumber = poNumber || note.sales_order_po || null

    // Crear factura
    const { rows: invRows } = await client.query(
      `INSERT INTO invoices
         (tenant_id, type, cfdi_type, series, folio, document_number, fiscal_profile_id,
          partner_id, delivery_note_id,
          currency, exchange_rate_id, exchange_rate_value,
          subtotal, tax_transferred, total, total_mxn,
          payment_method, payment_form, use_cfdi,
          exportacion, lugar_expedicion,
          receptor_tax_regime, receptor_zip_code,
          po_number,
          status, issue_date, notes, created_by)
       VALUES ($1,'issued','I',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,'01',$18,$19,$20,$21,'draft',$22,$23,$24)
       RETURNING *`,
      [tenantId, resolvedSeries || series || fiscal.serie_default || null, resolvedFolio, docNumber, fiscalProfileId,
       note.partner_id, deliveryNoteId,
       note.currency, exchangeRateId, exchangeRateValue,
       subtotal, tax, total, totalMxn,
       paymentMethod || note.bp_payment_method || 'PUE',
       paymentForm   || note.bp_payment_form   || '03',
       useCfdi || note.cfdi_use || 'G01',
       fiscal.zip_code || null,
       bp.tax_regime_code || null,
       bp.zip_code || null,
       resolvedPoNumber,
       issueDate, notes || null, userId]
    )
    const invoice = invRows[0]
    await saveRetentions(client, invoice.id, computedRetentions)

    // Pre-cargar sat_unit_code por pack_option_id (si lo hay) para el CFDI
    const packIds1 = [...new Set(revaluedLines.map(l => l.pack_option_id).filter(Boolean))]
    const packMap1 = await loadPackOptions(client, packIds1)

    // Copiar líneas — con unit_price ya revaluado y trazabilidad original_*
    for (let i = 0; i < revaluedLines.length; i++) {
      const line = revaluedLines[i]
      const pack = line.pack_option_id ? packMap1[line.pack_option_id] : null
      const satUnit = pack?.sat_unit_code || 'H87'
      // sat_product_code real del producto. '01010101' es "No existe en el
      // catálogo" — fallback seguro si el producto no lo tiene capturado.
      const satProductCode = line.sat_product_code || '01010101'
      await client.query(
        `INSERT INTO invoice_lines
           (invoice_id, product_id, description, quantity, unit,
            unit_price, discount_pct, tax_rate,
            sat_product_code, sat_unit_code, line_number,
            original_unit_price, original_currency, applied_exchange_rate,
            applied_exchange_rate_date,
            pack_option_id, pack_factor, quantity_base,
            delivery_note_line_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,16.00,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
        [invoice.id, line.product_id,
         line.description || line.product_name || 'Producto',
         line.quantity_delivered, line.unit || 'paquete',
         line.finalUnitPrice, line.discount_pct || 0,
         satProductCode,
         satUnit,
         i + 1,
         line.original_unit_price != null ? line.original_unit_price : null,
         line.original_currency  || null,
         line.finalRate != null ? line.finalRate : null,
         line.finalRateDate || null,
         line.pack_option_id || null,
         line.pack_factor != null ? parseFloat(line.pack_factor) : 1,
         line.quantity_base != null ? parseFloat(line.quantity_base) : parseFloat(line.quantity_delivered),
         line.id]
      )
    }

    // CxC: tres escenarios
    //   1) Cobertura completa con AR-remisión activo → migrar (UPDATE in-place).
    //      Preserva amount_paid si el cliente ya había abonado la remisión.
    //   2) Cobertura completa sin AR-remisión activo (cancelado o inexistente)
    //      → INSERT nuevo AR-factura. Evita arrastrar status='cancelled' de
    //      consolidaciones previas u operaciones manuales.
    //   3) Split parcial → INSERT nuevo AR-factura y reducir el AR-remisión
    //      restante.
    let invoiceDueDate = null
    if (note.credit_type === 'credit' && note.credit_days > 0) {
      const due = new Date(); due.setDate(due.getDate() + note.credit_days)
      invoiceDueDate = due.toISOString().split('T')[0]
    }

    if (fullCoverage && remisionAr) {
      await client.query(
        `UPDATE accounts_receivable
            SET document_type = 'invoice', document_id = $1, document_number = $2
          WHERE id = $3`,
        [invoice.id, docNumber, remisionAr.id]
      )
    } else {
      await client.query(
        `INSERT INTO accounts_receivable
           (tenant_id, partner_id, document_type, document_id, document_number,
            currency, exchange_rate, amount_total, issue_date, due_date, created_by)
         VALUES ($1,$2,'invoice',$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (tenant_id, document_type, document_id) DO NOTHING`,
        [tenantId, note.partner_id, invoice.id, docNumber,
         note.currency, exchangeRateValue, totalMxn,
         today, invoiceDueDate, userId]
      )

      // Reducir AR-remisión por el monto facturado SOLO en split parcial.
      // Si el saldo llega a 0, se cancela manteniendo el `amount_total`
      // histórico — el constraint `ar_amount_positive` no permite
      // `amount_total = 0`, y conservar el valor original también facilita
      // auditar el monto al cancelar la factura.
      if (!fullCoverage && remisionAr) {
        const newTotal = parseFloat(remisionAr.amount_total) - totalMxn
        if (newTotal <= 0.005) {
          await client.query(
            `UPDATE accounts_receivable SET status = 'cancelled' WHERE id = $1`,
            [remisionAr.id]
          )
        } else {
          await client.query(
            `UPDATE accounts_receivable SET amount_total = $1 WHERE id = $2`,
            [newTotal.toFixed(2), remisionAr.id]
          )
        }
      }
    }

    await audit({
      tenantId, userId, action: 'invoice.created',
      resource: 'invoices', resourceId: invoice.id,
      payload: {
        docNumber, deliveryNoteId,
        total: totalMxn, partnerId: note.partner_id,
        lineIds: noteLines.map(l => l.id),
        fullCoverage,
      },
      ipAddress, userAgent,
    })

    return { ...invoice, autoSendInvoice: note.auto_send_invoice }
  })
}

/**
 * Crea una factura consolidando varias remisiones en una sola.
 * Todas las remisiones deben:
 *   - Ser del mismo cliente
 *   - Estar entregadas (status='delivered')
 *   - No tener factura previa activa
 *   - No tener pagos parciales registrados en su AR (amount_paid = 0)
 *
 * Las líneas se concatenan en orden de las remisiones recibidas.
 * Los AR individuales de cada remisión se cancelan y se crea un AR
 * consolidado para la factura.
 */
async function createFromRemissions({
  tenantId, deliveryNoteIds = [], deliveryNoteLineIds,
  series, paymentMethod, paymentForm, useCfdi, poNumber, notes, retentions = [],
  userId, ipAddress, userAgent,
}) {
  if (!Array.isArray(deliveryNoteIds) || deliveryNoteIds.length === 0) {
    throw createError(400, 'Se requiere al menos una remisión.')
  }
  if (deliveryNoteIds.length === 1) {
    // Atajo: una sola remisión = createFromRemission (preserva pagos parciales del AR
    // y soporta split por líneas).
    return createFromRemission({
      tenantId, deliveryNoteId: deliveryNoteIds[0], deliveryNoteLineIds,
      series, paymentMethod, paymentForm, useCfdi, poNumber, notes, retentions,
      userId, ipAddress, userAgent,
    })
  }
  // Multi-remisión: split de líneas no soportado en Fase 1.
  if (Array.isArray(deliveryNoteLineIds)) {
    throw createError(400,
      'En Fase 1, el split por líneas solo aplica a una remisión a la vez. Para consolidar varias remisiones se facturan todas sus líneas.')
  }

  return withTransaction(async (client) => {
    // Obtener todas las remisiones (con po_number del pedido relacionado)
    const { rows: notesRows } = await client.query(
      `SELECT dn.*, bp.cfdi_use, bp.payment_method AS bp_payment_method,
              bp.payment_form AS bp_payment_form, bp.rfc, bp.credit_days, bp.credit_type,
              bp.auto_send_invoice, bp.billing_notes,
              so.po_number AS sales_order_po
         FROM delivery_notes dn
         JOIN business_partners bp ON bp.id = dn.partner_id
         LEFT JOIN sales_orders so ON so.id = dn.sales_order_id
        WHERE dn.id = ANY($1::uuid[]) AND dn.tenant_id = $2`,
      [deliveryNoteIds, tenantId]
    )
    if (notesRows.length !== deliveryNoteIds.length) {
      throw createError(404, 'Una o más remisiones no fueron encontradas.')
    }

    // Validar mismo cliente
    const partnerIds = [...new Set(notesRows.map(n => n.partner_id))]
    if (partnerIds.length > 1) {
      throw createError(400, 'Todas las remisiones deben ser del mismo cliente.')
    }
    // Validar mismo currency (para no mezclar MXN/USD)
    const currencies = [...new Set(notesRows.map(n => n.currency))]
    if (currencies.length > 1) {
      throw createError(400, 'Todas las remisiones deben estar en la misma moneda.')
    }
    // Validar status = 'delivered'
    const notDelivered = notesRows.filter(n => n.status !== 'delivered')
    if (notDelivered.length > 0) {
      throw createError(400, `Las siguientes remisiones no están entregadas: ${notDelivered.map(n => n.document_number).join(', ')}.`)
    }

    // Validar que ninguna tenga factura: liga directa (delivery_note_id) O
    // consolidada (invoice_remissions). Sin el segundo chequeo una remisión ya
    // consolidada podía re-facturarse (su delivery_note_id quedó NULL).
    const { rows: existing } = await client.query(
      `SELECT dn_id FROM (
         SELECT delivery_note_id AS dn_id FROM invoices
          WHERE delivery_note_id = ANY($1::uuid[]) AND status <> 'cancelled'
         UNION
         SELECT ir.delivery_note_id FROM invoice_remissions ir
           JOIN invoices iv ON iv.id = ir.invoice_id
          WHERE ir.delivery_note_id = ANY($1::uuid[]) AND iv.status <> 'cancelled'
       ) q`,
      [deliveryNoteIds]
    )
    if (existing.length > 0) {
      throw createError(409, `${existing.length} remisión(es) ya tienen factura generada.`)
    }

    // Validar que ningún AR de las remisiones tenga pagos parciales
    const { rows: arWithPayments } = await client.query(
      `SELECT ar.document_id, ar.document_number
         FROM accounts_receivable ar
        WHERE ar.tenant_id = $1
          AND ar.document_type = 'remission'
          AND ar.document_id = ANY($2::uuid[])
          AND ar.amount_paid > 0`,
      [tenantId, deliveryNoteIds]
    )
    if (arWithPayments.length > 0) {
      throw createError(409,
        `No se puede consolidar — las siguientes remisiones tienen pagos parciales registrados: ${arWithPayments.map(r => r.document_number).join(', ')}. Aplica primero el saldo completo o factura por separado.`
      )
    }

    const partnerId = partnerIds[0]
    const note0 = notesRows[0]
    const today = new Date().toISOString().split('T')[0]

    // Cargar todas las líneas de todas las remisiones, en orden
    const allLines = []
    for (const note of notesRows) {
      const { rows: noteLines } = await client.query(
        `SELECT dnl.*, p.sku, p.name AS product_name,
                p.sat_product_code, p.objeto_imp
           FROM delivery_note_lines dnl
           LEFT JOIN products p ON p.id = dnl.product_id
          WHERE dnl.delivery_note_id = $1
          ORDER BY dnl.line_number`,
        [note.id]
      )
      for (const l of noteLines) allLines.push(l)
    }

    // Revaluar si alguna línea tiene precio original en otra moneda
    const { lines: revaluedLines, revalued } = await revalueLines(
      client, tenantId, allLines, note0.currency, today
    )

    // Recalcular totales con líneas (posiblemente revaluadas)
    let subtotal = 0
    for (const line of revaluedLines) {
      const lineSubtotal = parseFloat(line.quantity_delivered) * line.finalUnitPrice *
                           (1 - parseFloat(line.discount_pct || 0) / 100)
      subtotal += lineSubtotal
    }
    const tax   = subtotal * 0.16
    const { computedRetentions, withheldTotal } = computeRetentions(retentions, subtotal)
    const total = subtotal + tax - withheldTotal

    // TC para total_mxn cuando la factura sigue siendo USD (legacy sin original_*)
    let exchangeRateId    = note0.exchange_rate_id
    let exchangeRateValue = parseFloat(note0.exchange_rate_value || 1)
    let totalMxn          = total
    if (note0.currency === 'USD' && !revalued) {
      const rate = await getRateForDate({ tenantId, date: today, currency: 'USD' })
      if (rate) {
        exchangeRateId    = rate.id
        exchangeRateValue = parseFloat(rate.rate_mxn)
      }
      totalMxn = parseFloat((total * exchangeRateValue).toFixed(2))
    }

    const { docNumber, series: resolvedSeries, folio: resolvedFolio, fiscalProfileId } =
      await nextInvoiceNumber(client, tenantId, { seriesCode: series, cfdiType: 'I' })
    const issueDate = today

    // Datos fiscales del emisor
    const { rows: fiscalRows } = await client.query(
      `SELECT zip_code, serie_default FROM tenant_fiscal_info WHERE tenant_id = $1`,
      [tenantId]
    )
    const fiscal = fiscalRows[0] || {}

    // Datos fiscales del receptor
    const { rows: bpRows } = await client.query(
      `SELECT tax_regime_code, zip_code FROM business_partners WHERE id = $1`,
      [partnerId]
    )
    const bp = bpRows[0] || {}

    // OC del cliente: prioridad al body; fallback al primer pedido relacionado
    // que tenga po_number (si los pedidos de las remisiones agrupadas comparten
    // la misma OC el usuario probablemente no la captura manualmente).
    const inheritedPo = notesRows.map(n => n.sales_order_po).find(Boolean) || null
    const resolvedPoNumber = poNumber || inheritedPo

    // Crear factura
    // NOTA: la factura consolidada deja delivery_note_id en NULL porque no
    // corresponde a una sola remisión. La trazabilidad se mantiene vía la
    // tabla invoice_remissions (creada más abajo en la misma transacción).
    const { rows: invRows } = await client.query(
      `INSERT INTO invoices
         (tenant_id, type, cfdi_type, series, folio, document_number, fiscal_profile_id,
          partner_id, delivery_note_id,
          currency, exchange_rate_id, exchange_rate_value,
          subtotal, tax_transferred, total, total_mxn,
          payment_method, payment_form, use_cfdi,
          exportacion, lugar_expedicion,
          receptor_tax_regime, receptor_zip_code,
          po_number,
          status, issue_date, notes, created_by)
       VALUES ($1,'issued','I',$2,$3,$4,$5,$6,NULL,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'01',$17,$18,$19,$20,'draft',$21,$22,$23)
       RETURNING *`,
      [tenantId, resolvedSeries || series || fiscal.serie_default || null, resolvedFolio, docNumber, fiscalProfileId,
       partnerId,
       note0.currency, exchangeRateId, exchangeRateValue,
       subtotal, tax, total, totalMxn,
       paymentMethod || note0.bp_payment_method || 'PUE',
       paymentForm   || note0.bp_payment_form   || '03',
       useCfdi || note0.cfdi_use || 'G01',
       fiscal.zip_code || null,
       bp.tax_regime_code || null,
       bp.zip_code || null,
       resolvedPoNumber,
       issueDate, notes || null, userId]
    )
    const invoice = invRows[0]
    await saveRetentions(client, invoice.id, computedRetentions)

    // Pre-cargar sat_unit_code por pack_option_id
    const packIds2 = [...new Set(revaluedLines.map(l => l.pack_option_id).filter(Boolean))]
    const packMap2 = await loadPackOptions(client, packIds2)

    // Insertar líneas — ya revaluadas si era necesario
    let lineNumber = 1
    for (const line of revaluedLines) {
      const pack = line.pack_option_id ? packMap2[line.pack_option_id] : null
      const satUnit = pack?.sat_unit_code || 'H87'
      const satProductCode = line.sat_product_code || '01010101'
      await client.query(
        `INSERT INTO invoice_lines
           (invoice_id, product_id, description, quantity, unit,
            unit_price, discount_pct, tax_rate,
            sat_product_code, sat_unit_code, line_number,
            original_unit_price, original_currency, applied_exchange_rate,
            applied_exchange_rate_date,
            pack_option_id, pack_factor, quantity_base)
         VALUES ($1,$2,$3,$4,$5,$6,$7,16.00,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
        [invoice.id, line.product_id,
         line.description || line.product_name || 'Producto',
         line.quantity_delivered, line.unit || 'paquete',
         line.finalUnitPrice, line.discount_pct || 0,
         satProductCode,
         satUnit,
         lineNumber++,
         line.original_unit_price != null ? line.original_unit_price : null,
         line.original_currency  || null,
         line.finalRate != null ? line.finalRate : null,
         line.finalRateDate || null,
         line.pack_option_id || null,
         line.pack_factor != null ? parseFloat(line.pack_factor) : 1,
         line.quantity_base != null ? parseFloat(line.quantity_base) : parseFloat(line.quantity_delivered)]
      )
    }

    // Cancelar AR individuales de las remisiones
    await client.query(
      `UPDATE accounts_receivable
          SET status = 'cancelled',
              notes  = COALESCE(notes, '') ||
                       ' [Consolidada en factura ' || $1 || ']'
        WHERE tenant_id = $2 AND document_type = 'remission'
          AND document_id = ANY($3::uuid[])`,
      [docNumber, tenantId, deliveryNoteIds]
    )

    // Crear AR consolidado para la factura
    let dueDate = null
    if (note0.credit_type === 'credit' && note0.credit_days > 0) {
      const due = new Date()
      due.setDate(due.getDate() + note0.credit_days)
      dueDate = due.toISOString().split('T')[0]
    }
    await client.query(
      `INSERT INTO accounts_receivable
         (tenant_id, partner_id, document_type, document_id, document_number,
          currency, exchange_rate, amount_total, issue_date, due_date, notes, created_by)
       VALUES ($1,$2,'invoice',$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (tenant_id, document_type, document_id) DO NOTHING`,
      [tenantId, partnerId, invoice.id, docNumber,
       note0.currency, exchangeRateValue, totalMxn,
       issueDate, dueDate,
       `Consolida remisiones: ${notesRows.map(n => n.document_number).join(', ')}`,
       userId]
    )

    // Liga estructural factura↔remisión (mig 190). La consolidada deja
    // delivery_note_id en NULL, así que ESTA es la única liga consultable: sin
    // ella la lista/detalle de remisiones no detectan la factura.
    await client.query(
      `INSERT INTO invoice_remissions (invoice_id, delivery_note_id)
       SELECT $1, unnest($2::uuid[])
       ON CONFLICT DO NOTHING`,
      [invoice.id, deliveryNoteIds]
    )

    await audit({
      tenantId, userId, action: 'invoice.created_consolidated',
      resource: 'invoices', resourceId: invoice.id,
      payload: { docNumber, deliveryNoteIds, total: totalMxn, partnerId },
      ipAddress, userAgent,
    })

    return { ...invoice, autoSendInvoice: note0.auto_send_invoice, consolidatedFrom: notesRows.length }
  })
}

/**
 * Crea una factura directa desde un pedido (sin remisión).
 * Solo para pedidos con direct_invoice = true.
 */
async function createDirect({
  tenantId, salesOrderId, series, paymentMethod, paymentForm, useCfdi, poNumber, notes, retentions = [],
  userId, ipAddress, userAgent,
}) {
  return withTransaction(async (client) => {
    // Obtener pedido con preferencias del cliente
    const { rows: orderRows } = await client.query(
      `SELECT so.*, bp.cfdi_use, bp.payment_method AS bp_payment_method,
              bp.payment_form AS bp_payment_form, bp.rfc,
              bp.credit_days, bp.credit_type, bp.auto_send_invoice
       FROM sales_orders so
       JOIN business_partners bp ON bp.id = so.partner_id
       WHERE so.id = $1 AND so.tenant_id = $2
         AND so.status IN ('confirmed','in_delivery')
         AND so.direct_invoice = true`,
      [salesOrderId, tenantId]
    )
    if (!orderRows.length) throw createError(404, 'Pedido no encontrado, no confirmado o no es factura directa.')
    const order = orderRows[0]

    // Verificar que no tenga factura ya
    const { rows: existing } = await client.query(
      `SELECT inv.id FROM invoices inv
       JOIN delivery_notes dn ON dn.id = inv.delivery_note_id
       WHERE dn.sales_order_id = $1 AND inv.status != 'cancelled'`,
      [salesOrderId]
    )
    if (existing.length > 0) throw createError(409, 'Este pedido ya tiene una factura generada.')

    const today = new Date().toISOString().split('T')[0]

    // Cargar líneas del pedido para posible revaluación
    const { rows: orderLines } = await client.query(
      `SELECT sol.*, p.name AS product_name, p.sku,
              p.sat_product_code, p.objeto_imp
       FROM sales_order_lines sol
       JOIN products p ON p.id = sol.product_id
       WHERE sol.sales_order_id = $1
       ORDER BY sol.line_number`,
      [salesOrderId]
    )
    const { lines: revaluedLines, revalued } = await revalueLines(
      client, tenantId, orderLines, order.currency, today
    )

    // Recalcular totales con líneas (posiblemente revaluadas)
    let subtotal = 0
    for (const line of revaluedLines) {
      const lineSubtotal = parseFloat(line.quantity) * line.finalUnitPrice *
                           (1 - parseFloat(line.discount_pct || 0) / 100)
      subtotal += lineSubtotal
    }
    const tax   = subtotal * 0.16
    const { computedRetentions, withheldTotal } = computeRetentions(retentions, subtotal)
    const total = subtotal + tax - withheldTotal

    let exchangeRateId    = order.exchange_rate_id
    let exchangeRateValue = parseFloat(order.exchange_rate_value || 1)
    let totalMxn          = total
    if (order.currency === 'USD' && !revalued) {
      const rate = await getRateForDate({ tenantId, date: today, currency: 'USD' })
      if (rate) {
        exchangeRateId    = rate.id
        exchangeRateValue = parseFloat(rate.rate_mxn)
      }
      totalMxn = parseFloat((total * exchangeRateValue).toFixed(2))
    }

    const { docNumber, series: resolvedSeries, folio: resolvedFolio, fiscalProfileId } =
      await nextInvoiceNumber(client, tenantId, { seriesCode: series, cfdiType: 'I' })
    const issueDate = today

    // Obtener datos fiscales del emisor
    const { rows: fiscalRows2 } = await client.query(
      `SELECT rfc, razon_social, tax_regime, zip_code, serie_default
       FROM tenant_fiscal_info WHERE tenant_id = $1`,
      [tenantId]
    )
    const fiscal2 = fiscalRows2[0] || {}

    // Obtener datos fiscales del receptor
    const { rows: bpRows2 } = await client.query(
      `SELECT tax_regime_code, zip_code FROM business_partners WHERE id = $1`,
      [order.partner_id]
    )
    const bp2 = bpRows2[0] || {}

    // Calcular fecha de vencimiento
    let dueDate = null
    if (order.credit_type === 'credit' && order.credit_days > 0) {
      const due = new Date()
      due.setDate(due.getDate() + order.credit_days)
      dueDate = due.toISOString().split('T')[0]
    }

    // OC del cliente: prioridad al body, fallback al pedido
    const resolvedPoNumber = poNumber || order.po_number || null

    // Crear factura.
    // Orden de los literales:
    //   - 'issued' / 'I'   → type / cfdi_type (posiciones 2 y 3)
    //   - '01'             → exportacion (no es operación de exportación)
    //   - 'draft'          → status (antes del timbrado)
    const { rows: invRows } = await client.query(
      `INSERT INTO invoices
         (tenant_id, type, cfdi_type, series, folio, document_number, fiscal_profile_id,
          partner_id,
          currency, exchange_rate_id, exchange_rate_value,
          subtotal, tax_transferred, total, total_mxn,
          payment_method, payment_form, use_cfdi,
          exportacion, lugar_expedicion,
          receptor_tax_regime, receptor_zip_code,
          po_number,
          status, issue_date, notes, created_by)
       VALUES ($1,'issued','I',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'01',$17,$18,$19,$20,'draft',$21,$22,$23)
       RETURNING *`,
      [tenantId, resolvedSeries || series || fiscal2.serie_default || null, resolvedFolio, docNumber, fiscalProfileId,
       order.partner_id,
       order.currency, exchangeRateId, exchangeRateValue,
       subtotal, tax, total, totalMxn,
       paymentMethod || order.bp_payment_method || 'PUE',
       paymentForm   || order.bp_payment_form   || '03',
       useCfdi || order.cfdi_use || 'G01',
       fiscal2.zip_code || null,
       bp2.tax_regime_code || null,
       bp2.zip_code || null,
       resolvedPoNumber,
       issueDate, notes || null, userId]
    )
    const invoice = invRows[0]
    await saveRetentions(client, invoice.id, computedRetentions)

    // Pre-cargar sat_unit_code por pack_option_id
    const packIds3 = [...new Set(revaluedLines.map(l => l.pack_option_id).filter(Boolean))]
    const packMap3 = await loadPackOptions(client, packIds3)

    // Insertar líneas — ya revaluadas si era necesario.
    // Cada línea referencia su sales_order_line origen para soportar el flujo
    // "factura anticipada → entregas parciales": calcular saldo facturado vs
    // entregado por línea de pedido.
    for (let i = 0; i < revaluedLines.length; i++) {
      const line = revaluedLines[i]
      const pack = line.pack_option_id ? packMap3[line.pack_option_id] : null
      const satUnit = pack?.sat_unit_code || 'H87'
      const satProductCode = line.sat_product_code || '01010101'
      await client.query(
        `INSERT INTO invoice_lines
           (invoice_id, product_id, description, quantity, unit,
            unit_price, discount_pct, tax_rate,
            sat_product_code, sat_unit_code, line_number,
            original_unit_price, original_currency, applied_exchange_rate,
            applied_exchange_rate_date,
            pack_option_id, pack_factor, quantity_base,
            sales_order_line_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,16.00,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
        [invoice.id, line.product_id,
         line.description || line.product_name,
         line.quantity, line.unit || 'paquete',
         line.finalUnitPrice, line.discount_pct || 0,
         satProductCode,
         satUnit,
         i + 1,
         line.original_unit_price != null ? line.original_unit_price : null,
         line.original_currency  || null,
         line.finalRate != null ? line.finalRate : null,
         line.finalRateDate || null,
         line.pack_option_id || null,
         line.pack_factor != null ? parseFloat(line.pack_factor) : 1,
         line.quantity_base != null ? parseFloat(line.quantity_base) : parseFloat(line.quantity),
         line.id]  // sales_order_lines.id
      )
    }

    // Generar CXC automáticamente
    await client.query(
      `INSERT INTO accounts_receivable
         (tenant_id, partner_id, document_type, document_id, document_number,
          currency, exchange_rate, amount_total, issue_date, due_date, created_by)
       VALUES ($1,$2,'invoice',$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (tenant_id, document_type, document_id) DO NOTHING`,
      [tenantId, order.partner_id, invoice.id, docNumber,
       order.currency, exchangeRateValue, totalMxn,
       issueDate, dueDate, userId]
    )

    // Actualizar status del pedido:
    //   - Si TODAS las líneas ya están entregadas en remisiones → 'invoiced'.
    //   - Si quedan cantidades por entregar → mantener 'confirmed'/'in_delivery'
    //     para permitir generar remisiones parciales contra esta factura.
    //
    // El cálculo: por cada sales_order_line, comparamos quantity vs
    // SUM(quantity_delivered) en delivery_note_lines no canceladas.
    const { rows: balanceRows } = await client.query(
      `SELECT sol.id,
              sol.quantity                                              AS ordered,
              COALESCE(SUM(dnl.quantity_delivered) FILTER (
                WHERE dn.status <> 'cancelled'
              ), 0)                                                     AS delivered
         FROM sales_order_lines sol
         LEFT JOIN delivery_note_lines dnl ON dnl.sales_order_line_id = sol.id
         LEFT JOIN delivery_notes dn       ON dn.id = dnl.delivery_note_id
        WHERE sol.sales_order_id = $1
        GROUP BY sol.id`,
      [salesOrderId]
    )
    const allDelivered = balanceRows.length > 0
      && balanceRows.every(r => parseFloat(r.delivered) >= parseFloat(r.ordered))

    if (allDelivered) {
      await client.query(
        `UPDATE sales_orders SET status = 'invoiced' WHERE id = $1`,
        [salesOrderId]
      )
    }
    // Si no todo está entregado, dejamos el status como está (confirmed/in_delivery).
    // El pedido quedará facturado-pero-pendiente-de-entregar; las remisiones
    // posteriores actualizarán el status a 'invoiced' cuando cubran todo.

    await audit({
      tenantId, userId, action: 'invoice.created_direct',
      resource: 'invoices', resourceId: invoice.id,
      payload: { docNumber, salesOrderId, total: totalMxn, partnerId: order.partner_id },
      ipAddress, userAgent,
    })

    return { ...invoice, autoSendInvoice: order.auto_send_invoice, dueDate }
  })
}

/**
 * Cancela una factura en draft.
 */
async function cancelInvoice({ tenantId, invoiceId, reason, userId, ipAddress, userAgent }) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `UPDATE invoices
       SET status = 'cancelled', cancellation_date = NOW(), cancellation_reason = $1
       WHERE id = $2 AND tenant_id = $3 AND status = 'draft'
       RETURNING id, document_number, delivery_note_id, total_mxn`,
      [reason || null, invoiceId, tenantId]
    )
    if (!rows.length) throw createError(404, 'Factura no encontrada o no se puede cancelar.')
    const invoice = rows[0]

    if (invoice.delivery_note_id) {
      // SPLIT vs. cobertura completa: si existe AR-remisión (activo o
      // cancelado por haber llegado a 0), la factura nació de un split;
      // recalculamos el saldo del AR-remisión = total_remisión - facturas
      // activas restantes. Si no existe AR-remisión, fue cobertura completa
      // legacy: el AR de la factura era el AR-remisión migrado, lo revertimos.
      await revertInvoiceArOnCancel(client, { tenantId, invoice })
    } else {
      // Factura directa (sin remisión) o consolidada de varias remisiones.
      // Cancelar el AR de la factura.
      await client.query(
        `UPDATE accounts_receivable SET status = 'cancelled'
          WHERE tenant_id = $1 AND document_type = 'invoice' AND document_id = $2`,
        [tenantId, invoiceId]
      )
      // Si era consolidada, las remisiones origen quedaron cancelled con la
      // marca "[Consolidada en factura X]" en notes. Reactivarlas.
      await client.query(
        `UPDATE accounts_receivable
            SET status = 'pending',
                notes  = NULLIF(REPLACE(COALESCE(notes, ''), ' [Consolidada en factura ' || $2 || ']', ''), '')
          WHERE tenant_id = $1
            AND document_type = 'remission'
            AND status = 'cancelled'
            AND notes LIKE '%[Consolidada en factura ' || $2 || ']%'`,
        [tenantId, invoice.document_number]
      )
    }

    await audit({
      tenantId, userId, action: 'invoice.cancelled',
      resource: 'invoices', resourceId: invoiceId,
      payload: { reason }, ipAddress, userAgent,
    })

    return rows[0]
  })
}

/**
 * Elimina de raíz una factura en BORRADOR no timbrada (hard delete). Solo admin
 * (permiso invoicing:delete). Revierte la CXC con la MISMA lógica que
 * cancelInvoice (split → recalcula AR-remisión; consolidada → reactiva las
 * AR-remisión origen) y luego borra la factura: las líneas (invoice_lines) y
 * retenciones (invoice_retentions) cascadean por FK ON DELETE CASCADE.
 *
 * Bloquea cualquier factura con cfdi_uuid (timbrada ante el SAT — esas se
 * cancelan ante el PAC, no se borran) o con cobros registrados en su CXC.
 * El folio de la serie NO se libera (igual que cancelInvoice): un borrador
 * borrado deja un hueco interno inocuo (nunca llegó al SAT).
 */
async function deleteDraftInvoice({ tenantId, invoiceId, userId, ipAddress, userAgent }) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT id, document_number, status, cfdi_uuid, delivery_note_id
         FROM invoices WHERE id = $1 AND tenant_id = $2`,
      [invoiceId, tenantId]
    )
    if (!rows.length) throw createError(404, 'Factura no encontrada.')
    const invoice = rows[0]
    if (invoice.status !== 'draft' || invoice.cfdi_uuid) {
      throw createError(409,
        'Solo se pueden eliminar facturas en borrador no timbradas. Una factura timbrada debe cancelarse ante el SAT.')
    }

    const { rows: arPay } = await client.query(
      `SELECT 1 FROM accounts_receivable
        WHERE tenant_id = $1 AND document_type = 'invoice' AND document_id = $2 AND amount_paid > 0 LIMIT 1`,
      [tenantId, invoiceId]
    )
    if (arPay.length) {
      throw createError(409, 'No se puede eliminar: la factura tiene cobros registrados.')
    }

    // Revertir el efecto en CXC — misma lógica que cancelInvoice.
    if (invoice.delivery_note_id) {
      await revertInvoiceArOnCancel(client, { tenantId, invoice })
    } else {
      // Reactivar CXC de remisiones consolidadas (marca "[Consolidada en factura X]").
      await client.query(
        `UPDATE accounts_receivable
            SET status = 'pending',
                notes  = NULLIF(REPLACE(COALESCE(notes, ''), ' [Consolidada en factura ' || $2 || ']', ''), '')
          WHERE tenant_id = $1
            AND document_type = 'remission'
            AND status = 'cancelled'
            AND notes LIKE '%[Consolidada en factura ' || $2 || ']%'`,
        [tenantId, invoice.document_number]
      )
    }

    // Borrar la CXC-factura (ahora huérfana) y la factura (cascada: líneas + retenciones).
    await client.query(
      `DELETE FROM accounts_receivable
        WHERE tenant_id = $1 AND document_type = 'invoice' AND document_id = $2`,
      [tenantId, invoiceId]
    )
    await client.query(`DELETE FROM invoices WHERE id = $1 AND tenant_id = $2`, [invoiceId, tenantId])

    await audit({
      tenantId, userId, action: 'invoice.deleted',
      resource: 'invoices', resourceId: invoiceId,
      payload: { documentNumber: invoice.document_number }, ipAddress, userAgent,
    })

    return { id: invoiceId, document_number: invoice.document_number }
  })
}

/**
 * Edición de una factura en estado 'draft'.
 *
 * Solo permite cambiar metadatos del CFDI (uso, método/forma de pago,
 * exportación, OC, fecha emisión, notas, razón social y datos fiscales
 * del receptor a nivel factura). Las líneas de producto NO se tocan —
 * provienen de la remisión y son el respaldo de la entrega.
 */
async function updateInvoice({ tenantId, invoiceId, fields, userId, ipAddress, userAgent }) {
  return withTransaction(async (client) => {
    const { rows: invRows } = await client.query(
      `SELECT id, status FROM invoices WHERE id = $1 AND tenant_id = $2`,
      [invoiceId, tenantId]
    )
    if (!invRows.length) throw createError(404, 'Factura no encontrada.')
    if (invRows[0].status !== 'draft') {
      throw createError(409, `No se puede editar una factura en estado '${invRows[0].status}'. Solo borradores.`)
    }

    // Campos editables: nombre en la columna BD → key esperada en el body
    const editable = {
      payment_method:       'paymentMethod',
      payment_form:         'paymentForm',
      use_cfdi:             'useCfdi',
      exportacion:          'exportacion',
      po_number:            'poNumber',
      notes:                'notes',
      issue_date:           'issueDate',
      receptor_legal_name:  'receptorLegalName',
      receptor_tax_regime:  'receptorTaxRegime',
      receptor_zip_code:    'receptorZipCode',
      series:               'series',
    }

    const sets = []
    const params = [invoiceId, tenantId]
    for (const [col, key] of Object.entries(editable)) {
      if (fields[key] !== undefined) {
        params.push(fields[key] === '' ? null : fields[key])
        sets.push(`${col} = $${params.length}`)
      }
    }
    if (!sets.length) {
      throw createError(400, 'Nada que actualizar.')
    }

    const { rows } = await client.query(
      `UPDATE invoices SET ${sets.join(', ')}
        WHERE id = $1 AND tenant_id = $2 AND status = 'draft'
        RETURNING *`,
      params
    )

    await audit({
      tenantId, userId, action: 'invoice.draft_updated',
      resource: 'invoices', resourceId: invoiceId,
      payload: { changed: Object.keys(fields) }, ipAddress, userAgent,
    })

    return rows[0]
  })
}

/**
 * Reversa el efecto en AR cuando una factura ligada a una remisión se cancela.
 * Maneja tanto el caso de cobertura completa legacy (AR migrado) como el
 * de split parcial (AR-factura nuevo + AR-remisión activo o cancelado).
 *
 * Para split, recalcula el AR-remisión desde el origen:
 *   AR-rem.amount_total = remision.total_mxn - SUM(otras facturas activas
 *                                                  con líneas de la misma remisión)
 * Si el resultado > 0, AR-remisión vuelve a 'pending' con ese saldo.
 * Si es 0 o negativo, AR-remisión queda cancelado (no debería pasar en
 * la práctica si el invariant se mantiene).
 */
async function revertInvoiceArOnCancel(client, { tenantId, invoice }) {
  const { rows: remAr } = await client.query(
    `SELECT id FROM accounts_receivable
      WHERE tenant_id = $1 AND document_type = 'remission' AND document_id = $2`,
    [tenantId, invoice.delivery_note_id]
  )

  if (remAr.length) {
    // SPLIT — cancelar AR-factura y recalcular AR-remisión desde el origen.
    await client.query(
      `UPDATE accounts_receivable SET status = 'cancelled'
        WHERE tenant_id = $1 AND document_type = 'invoice' AND document_id = $2`,
      [tenantId, invoice.id]
    )

    const { rows: noteRows } = await client.query(
      `SELECT total_mxn FROM delivery_notes WHERE id = $1`,
      [invoice.delivery_note_id]
    )
    const remTotal = parseFloat(noteRows[0]?.total_mxn || 0)

    const { rows: sumRows } = await client.query(
      `SELECT COALESCE(SUM(iv.total_mxn), 0) AS sum_active
         FROM invoices iv
        WHERE iv.tenant_id = $1
          AND iv.status <> 'cancelled'
          AND iv.id <> $2
          AND EXISTS (
            SELECT 1 FROM invoice_lines il
              JOIN delivery_note_lines dnl ON dnl.id = il.delivery_note_line_id
             WHERE il.invoice_id = iv.id AND dnl.delivery_note_id = $3
          )`,
      [tenantId, invoice.id, invoice.delivery_note_id]
    )
    const sumActive = parseFloat(sumRows[0].sum_active)
    const newRemTotal = remTotal - sumActive

    if (newRemTotal > 0.005) {
      await client.query(
        `UPDATE accounts_receivable
            SET amount_total = $1, status = 'pending'
          WHERE id = $2`,
        [newRemTotal.toFixed(2), remAr[0].id]
      )
    } else {
      // Mantenemos cancelled (no podemos setear amount_total a 0 por constraint).
      await client.query(
        `UPDATE accounts_receivable SET status = 'cancelled' WHERE id = $1`,
        [remAr[0].id]
      )
    }
  } else {
    // Cobertura completa legacy — revertir tipo de AR a remisión.
    const { rows: noteRows } = await client.query(
      `SELECT document_number FROM delivery_notes WHERE id = $1`,
      [invoice.delivery_note_id]
    )
    if (noteRows.length) {
      await client.query(
        `UPDATE accounts_receivable
            SET document_type = 'remission',
                document_id   = $1,
                document_number = $2
          WHERE tenant_id = $3 AND document_type = 'invoice' AND document_id = $4`,
        [invoice.delivery_note_id, noteRows[0].document_number, tenantId, invoice.id]
      )
    }
  }
}

// RFC genérico nacional para "Público en general" (CFDI 4.0).
const RFC_PUBLICO_GENERAL = 'XAXX010101000'

/**
 * Resuelve el cliente de una factura ocasional dentro de la transacción.
 * - Si el RFC ya existe en el tenant → lo reusa (no duplica).
 * - Si no existe → crea un business_partner marcado is_occasional=true, para
 *   que cobranza/complementos/cancelación sigan amarrados a un cliente sin
 *   ensuciar el catálogo principal.
 *
 * @returns {Promise<{ partnerId: string, created: boolean }>}
 */
async function resolveOccasionalPartner(client, tenantId, receptor, emisorZip) {
  const isPublico = receptor.publicoEnGeneral === true
  const rfc = (isPublico ? RFC_PUBLICO_GENERAL : (receptor.rfc || '')).toUpperCase().trim()
  if (!rfc) throw createError(400, 'Captura el RFC del receptor o marca "Público en general".')

  // Reusar si ya existe (catálogo o creado en una ocasional previa).
  const { rows: existing } = await client.query(
    `SELECT id FROM business_partners WHERE tenant_id = $1 AND rfc = $2`,
    [tenantId, rfc]
  )
  if (existing[0]) return { partnerId: existing[0].id, created: false }

  // Datos por defecto para público en general (el domicilio del receptor debe
  // coincidir con el lugar de expedición del emisor).
  const taxName = isPublico
    ? 'PÚBLICO EN GENERAL'
    : (receptor.taxName || receptor.name || '').trim()
  if (!isPublico && !taxName) {
    throw createError(400, 'Captura la razón social del receptor.')
  }
  const personType = rfc.length === 13 ? 'fisica' : 'moral'
  const regimeCode = isPublico ? '616' : (receptor.taxRegimeCode || '').trim() || null
  const cfdiUse    = isPublico ? 'S01' : (receptor.cfdiUse || 'G03')
  const zipCode    = isPublico ? (emisorZip || null) : ((receptor.zipCode || '').trim() || null)

  const { rows: created } = await client.query(
    `INSERT INTO business_partners
       (tenant_id, type, person_type, name, rfc, tax_name, tax_regime_code,
        credit_type, cfdi_use, payment_method, payment_form, preferred_currency,
        zip_code, is_occasional)
     VALUES ($1,'customer',$2,$3,$4,$5,$6,'cash',$7,'PUE','99','MXN',$8,true)
     RETURNING id`,
    [tenantId, personType, taxName, rfc, taxName, regimeCode, cfdiUse, zipCode]
  )
  return { partnerId: created[0].id, created: true }
}

/**
 * Crea una factura "ocasional" en borrador: el cliente y los productos NO
 * están dados de alta — se capturan directo en el formulario de la factura.
 *
 * El cliente se crea/reusa por debajo (resolveOccasionalPartner) para sostener
 * cobranza y complementos. Cada línea trae su clave SAT, unidad y tratamiento
 * de IVA (objeto_imp + tax_factor + tax_rate), respetados al timbrar.
 *
 * @param {object} opts
 * @param {object} opts.receptor   - { publicoEnGeneral, rfc, taxName, taxRegimeCode, cfdiUse, zipCode }
 * @param {Array}  opts.lines      - [{ description, satProductCode, satUnitCode, unit, quantity, unitPrice, discountPct, objetoImp, taxFactor, taxRate }]
 * @param {Array}  opts.retentions - [{ taxType: 'ISR'|'IVA', rate }] retenciones sobre la base gravable.
 */
async function createOccasional({
  tenantId, receptor = {}, lines = [], retentions = [], series,
  paymentMethod, paymentForm, useCfdi, currency = 'MXN', poNumber, notes,
  userId, ipAddress, userAgent,
}) {
  if (!Array.isArray(lines) || lines.length === 0) {
    throw createError(400, 'Captura al menos una línea (concepto) para la factura.')
  }
  for (const [i, l] of lines.entries()) {
    if (!l.description || !String(l.description).trim()) {
      throw createError(400, `La línea ${i + 1} necesita descripción.`)
    }
    if (!(parseFloat(l.quantity) > 0)) throw createError(400, `La línea ${i + 1} necesita cantidad > 0.`)
    if (!(parseFloat(l.unitPrice) > 0)) throw createError(400, `La línea ${i + 1} necesita precio > 0.`)
    if (!l.satProductCode) throw createError(400, `La línea ${i + 1} necesita clave de producto SAT.`)
    if (!l.satUnitCode)    throw createError(400, `La línea ${i + 1} necesita clave de unidad SAT.`)
  }

  return withTransaction(async (client) => {
    const today = new Date().toISOString().split('T')[0]

    // Datos fiscales del emisor (para lugar de expedición + serie default).
    const { rows: fiscalRows } = await client.query(
      `SELECT zip_code, serie_default FROM tenant_fiscal_info WHERE tenant_id = $1`,
      [tenantId]
    )
    const fiscal = fiscalRows[0] || {}

    // Cliente: crear o reusar por RFC.
    const { partnerId } = await resolveOccasionalPartner(client, tenantId, receptor, fiscal.zip_code)

    // Datos fiscales del receptor (ya en el partner, recién creado o reusado).
    const { rows: bpRows } = await client.query(
      `SELECT tax_regime_code, zip_code, cfdi_use, payment_method, payment_form
         FROM business_partners WHERE id = $1`,
      [partnerId]
    )
    const bp = bpRows[0] || {}

    // Totales respetando el tratamiento fiscal de cada línea.
    let subtotal = 0
    let taxTotal = 0
    let taxableBase = 0   // base de líneas objeto de impuesto (para retenciones)
    const computedLines = lines.map((l, i) => {
      const { objetoImp, factor, ratePct } = normalizeLineTax({
        objeto_imp: l.objetoImp, tax_factor: l.taxFactor, tax_rate: l.taxRate,
      })
      const qty   = parseFloat(l.quantity)
      const price = parseFloat(l.unitPrice)
      const disc  = parseFloat(l.discountPct || 0)
      const lineSubtotal = qty * price * (1 - disc / 100)
      const causes = lineCausesTax({ objeto_imp: objetoImp, tax_factor: factor, tax_rate: ratePct })
      // tax_rate persistido: 0 si no causa impuesto (exento / tasa cero / no objeto).
      const storedRate = causes ? ratePct : 0
      const lineTax = lineSubtotal * storedRate / 100
      subtotal += lineSubtotal
      taxTotal += lineTax
      if (objetoImp === '02') taxableBase += lineSubtotal
      return {
        lineNumber: i + 1,
        description: String(l.description).trim(),
        quantity: qty,
        unit: (l.unit || 'pieza').trim(),
        unitPrice: price,
        discountPct: disc,
        objetoImp,
        taxFactor: factor,
        storedRate,
        satProductCode: String(l.satProductCode).trim(),
        satUnitCode: String(l.satUnitCode).trim(),
      }
    })
    subtotal = parseFloat(subtotal.toFixed(2))
    taxTotal = parseFloat(taxTotal.toFixed(2))

    // Retenciones (ISR / IVA) sobre la base gravable.
    const computedRetentions = (retentions || [])
      .map(r => ({
        taxType: r.taxType === 'ISR' ? 'ISR' : 'IVA',
        rate: parseFloat(r.rate) || 0,
      }))
      .filter(r => r.rate > 0)
      .map(r => ({ ...r, amount: parseFloat((taxableBase * r.rate / 100).toFixed(2)) }))
    const withheldTotal = parseFloat(
      computedRetentions.reduce((s, r) => s + r.amount, 0).toFixed(2)
    )

    const total = parseFloat((subtotal + taxTotal - withheldTotal).toFixed(2))

    // Moneda / tipo de cambio.
    let exchangeRateId = null
    let exchangeRateValue = 1
    let totalMxn = total
    if (currency === 'USD') {
      const rate = await getRateForDate({ tenantId, date: today, currency: 'USD' })
      if (rate) {
        exchangeRateId = rate.id
        exchangeRateValue = parseFloat(rate.rate_mxn)
      }
      totalMxn = parseFloat((total * exchangeRateValue).toFixed(2))
    }

    const { docNumber, series: resolvedSeries, folio: resolvedFolio, fiscalProfileId } =
      await nextInvoiceNumber(client, tenantId, { seriesCode: series, cfdiType: 'I' })

    const { rows: invRows } = await client.query(
      `INSERT INTO invoices
         (tenant_id, type, cfdi_type, series, folio, document_number, fiscal_profile_id,
          partner_id,
          currency, exchange_rate_id, exchange_rate_value,
          subtotal, tax_transferred, tax_withheld, total, total_mxn,
          payment_method, payment_form, use_cfdi,
          exportacion, lugar_expedicion,
          receptor_tax_regime, receptor_zip_code,
          po_number,
          status, issue_date, notes, created_by)
       VALUES ($1,'issued','I',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,'01',$18,$19,$20,$21,'draft',$22,$23,$24)
       RETURNING *`,
      [tenantId, resolvedSeries || series || fiscal.serie_default || null, resolvedFolio, docNumber, fiscalProfileId,
       partnerId,
       currency, exchangeRateId, exchangeRateValue,
       subtotal, taxTotal, withheldTotal, total, totalMxn,
       paymentMethod || bp.payment_method || 'PUE',
       paymentForm   || bp.payment_form   || '99',
       useCfdi || bp.cfdi_use || 'G03',
       fiscal.zip_code || null,
       bp.tax_regime_code || null,
       bp.zip_code || null,
       (poNumber || '').trim() || null,
       today, (notes || '').trim() || null, userId]
    )
    const invoice = invRows[0]

    // Guardar las retenciones de la factura (se mandan a Facturapi al timbrar).
    for (const r of computedRetentions) {
      await client.query(
        `INSERT INTO invoice_retentions (invoice_id, tax_type, rate, amount)
         VALUES ($1, $2, $3, $4)`,
        [invoice.id, r.taxType, r.rate, r.amount]
      )
    }

    for (const cl of computedLines) {
      await client.query(
        `INSERT INTO invoice_lines
           (invoice_id, product_id, description, quantity, unit,
            unit_price, discount_pct, tax_rate, tax_factor, objeto_imp,
            sat_product_code, sat_unit_code, line_number)
         VALUES ($1,NULL,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [invoice.id, cl.description, cl.quantity, cl.unit,
         cl.unitPrice, cl.discountPct, cl.storedRate, cl.taxFactor, cl.objetoImp,
         cl.satProductCode, cl.satUnitCode, cl.lineNumber]
      )
    }

    // Cobranza (CXC). Ocasional = contado por default → vence el mismo día.
    await client.query(
      `INSERT INTO accounts_receivable
         (tenant_id, partner_id, document_type, document_id, document_number,
          currency, exchange_rate, amount_total, issue_date, due_date, created_by)
       VALUES ($1,$2,'invoice',$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (tenant_id, document_type, document_id) DO NOTHING`,
      [tenantId, partnerId, invoice.id, docNumber,
       currency, exchangeRateValue, totalMxn, today, today, userId]
    )

    await audit({
      tenantId, userId, action: 'invoice.created_occasional',
      resource: 'invoices', resourceId: invoice.id,
      payload: { docNumber, partnerId, total: totalMxn, lines: computedLines.length },
      ipAddress, userAgent,
    })

    return invoice
  })
}

function createError(status, message) {
  const err = new Error(message)
  err.status = status
  return err
}

module.exports = {
  listInvoices, getInvoice,
  createFromRemission, createFromRemissions, createDirect, createOccasional,
  updateInvoice,
  cancelInvoice, deleteDraftInvoice,
  revertInvoiceArOnCancel,
}