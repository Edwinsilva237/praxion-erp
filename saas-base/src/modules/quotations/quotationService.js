'use strict'

const { randomUUID } = require('crypto')
const { query, withTransaction } = require('../../db')
const { audit } = require('../../utils/audit')
const { LOCAL_TODAY } = require('../../utils/sqlTime')
const { enqueueEmail: sendMail } = require('../../queues/emailQueue')
const { quotationEmail } = require('../email/templates/sales')
const { generateQuotationPDF } = require('./quotationPdfService')
const logger = require('../../config/logger')
const documentSeriesService = require('../document-series/documentSeriesService')
const { nextOrderNumber } = require('../sales/orderService')
const bundleService = require('../products/bundleService')
const { buildOrderBy } = require('../../utils/sortOrder')

const QUOT_SORT_COLUMNS = {
  folio:   'q.quotation_number',
  fecha:   'q.created_at',
  cliente: 'bp.name',
  estatus: 'q.status',
  total:   'q.total_mxn',
}

/**
 * Servicio de cotizaciones.
 *
 * Ciclo: draft → sent → accepted → converted (genera sales_order) /
 *                                    rejected / expired / cancelled.
 *
 * Sin IVA en la cotización — igual que pedidos y remisiones. El IVA se agrega
 * al facturar el pedido derivado.
 */

// ── Numeración: serie configurable o legacy COT-YYYYMM-XXXX ─────────────────
async function nextQuotationNumber(client, tenantId, opts = {}) {
  const result = await documentSeriesService.generateDocumentNumber({
    client, tenantId, entityType: 'quotation', opts,
  })
  if (result) return result.docNumber

  const ym = new Date().toISOString().slice(0, 7).replace('-', '')
  const prefix = `COT-${ym}-`
  const { rows } = await client.query(
    `SELECT quotation_number FROM quotations
      WHERE tenant_id = $1 AND quotation_number LIKE $2
      ORDER BY quotation_number DESC LIMIT 1`,
    [tenantId, `${prefix}%`]
  )
  const last = rows[0]?.quotation_number
  const seq = last ? parseInt(last.split('-')[2], 10) + 1 : 1
  return `${prefix}${String(seq).padStart(4, '0')}`
}

function createError(status, message) {
  const err = new Error(message)
  err.status = status
  return err
}

// ── Helpers de cálculo ──────────────────────────────────────────────────────
async function recalcQuotationTotals(client, quotationId) {
  const { rows: q } = await client.query(
    `SELECT currency, exchange_rate_value FROM quotations WHERE id = $1`,
    [quotationId]
  )
  if (!q[0]) return
  const factor = q[0].currency === 'USD' ? parseFloat(q[0].exchange_rate_value || 1) : 1
  const { rows } = await client.query(
    `SELECT COALESCE(SUM(subtotal), 0) AS subtotal
       FROM quotation_lines WHERE quotation_id = $1`,
    [quotationId]
  )
  const subtotal = parseFloat(rows[0].subtotal)
  // Cotización sin IVA — total = subtotal.
  await client.query(
    `UPDATE quotations
        SET subtotal_mxn = $1, tax_mxn = 0, total_mxn = $2
      WHERE id = $3`,
    [subtotal * factor, subtotal * factor, quotationId]
  )
}

// ── List ────────────────────────────────────────────────────────────────────
async function listQuotations({ tenantId, status, partnerId, from, to, sortBy, sortDir, page = 1, limit = 25 }) {
  const off = (Math.max(1, page) - 1) * limit
  const orderBy = buildOrderBy({ sortBy, sortDir, columns: QUOT_SORT_COLUMNS, defaultKey: 'fecha', tiebreaker: 'q.id DESC' })
  const params = [tenantId]
  let where = `q.tenant_id = $1`
  if (status)    { params.push(status);    where += ` AND q.status = $${params.length}` }
  if (partnerId) { params.push(partnerId); where += ` AND q.partner_id = $${params.length}` }
  if (from)      { params.push(from);      where += ` AND q.created_at >= $${params.length}` }
  if (to)        { params.push(to);        where += ` AND q.created_at < ($${params.length}::date + INTERVAL '1 day')` }

  const dataSql = `
    SELECT q.id, q.quotation_number, q.partner_id, q.currency, q.status,
           q.subtotal_mxn, q.tax_mxn, q.total_mxn,
           q.valid_until, q.sent_at, q.converted_at, q.converted_order_id,
           q.rejected_at, q.cancelled_at, q.expired_at, q.created_at,
           bp.name AS partner_name, bp.tax_name AS partner_tax_name, bp.rfc AS partner_rfc,
           so.order_number AS converted_order_number
      FROM quotations q
      JOIN business_partners bp ON bp.id = q.partner_id
      LEFT JOIN sales_orders so ON so.id = q.converted_order_id
     WHERE ${where}
     ORDER BY ${orderBy}
     LIMIT ${limit} OFFSET ${off}
  `
  const countSql = `SELECT COUNT(*)::int AS total FROM quotations q WHERE ${where}`

  const [dataRes, countRes] = await Promise.all([query(dataSql, params), query(countSql, params)])
  return { data: dataRes.rows, total: countRes.rows[0].total, page, limit }
}

// ── Get ─────────────────────────────────────────────────────────────────────
async function getQuotation({ tenantId, quotationId, client }) {
  const q = client ? client.query.bind(client) : query
  const { rows } = await q(
    `SELECT q.*,
            bp.name AS partner_name, bp.rfc AS partner_rfc,
            (SELECT email FROM business_partner_contacts
              WHERE business_partner_id = bp.id AND email IS NOT NULL
              ORDER BY is_primary DESC, created_at ASC LIMIT 1) AS partner_email,
            so.order_number AS converted_order_number,
            cu.full_name AS created_by_name,
            su.full_name AS sent_by_name,
            cv.full_name AS converted_by_name
       FROM quotations q
       JOIN business_partners bp ON bp.id = q.partner_id
       LEFT JOIN sales_orders so ON so.id = q.converted_order_id
       LEFT JOIN users cu ON cu.id = q.created_by
       LEFT JOIN users su ON su.id = q.sent_by
       LEFT JOIN users cv ON cv.id = q.converted_by
      WHERE q.id = $1 AND q.tenant_id = $2`,
    [quotationId, tenantId]
  )
  if (rows.length === 0) throw createError(404, 'Cotización no encontrada.')
  const quotation = rows[0]

  const { rows: lines } = await q(
    `SELECT ql.*, p.sku, p.name AS product_name,
            (SELECT a.id FROM attachments a
              WHERE a.entity_type = 'product' AND a.entity_id = p.id
                AND a.category = 'image'
              ORDER BY a.created_at DESC LIMIT 1) AS image_attachment_id
       FROM quotation_lines ql
       JOIN products p ON p.id = ql.product_id
      WHERE ql.quotation_id = $1
      ORDER BY ql.line_number`,
    [quotationId]
  )

  return { ...quotation, lines }
}

// ── Create ──────────────────────────────────────────────────────────────────
async function createQuotation({
  tenantId, partnerId, currency = 'MXN', validUntil, notes,
  lines = [], userId, ipAddress, userAgent,
}) {
  if (!partnerId)       throw createError(400, 'Cliente requerido.')
  if (!lines.length)    throw createError(400, 'La cotización requiere al menos una línea.')

  return withTransaction(async (client) => {
    const { rows: partner } = await client.query(
      `SELECT id FROM business_partners WHERE id = $1 AND tenant_id = $2`,
      [partnerId, tenantId]
    )
    if (!partner[0]) throw createError(404, 'Cliente no encontrado.')

    // Líneas de paquete (mig 204): el paquete debe ser del tenant y de la
    // MISMA moneda de la cotización (el prorrateo es nativo de esa moneda).
    const bundleIds = [...new Set(lines.map(l => l.bundleId).filter(Boolean))]
    if (bundleIds.length) {
      const { rows: bundles } = await client.query(
        `SELECT id, name, currency FROM product_bundles
          WHERE tenant_id = $1 AND id = ANY($2::uuid[])`,
        [tenantId, bundleIds]
      )
      if (bundles.length !== bundleIds.length) {
        throw createError(404, 'Uno de los paquetes de la cotización no existe.')
      }
      const wrong = bundles.find(b => b.currency !== currency)
      if (wrong) {
        throw createError(400,
          `El paquete "${wrong.name}" está definido en ${wrong.currency} y la cotización es en ${currency}.`)
      }
    }

    const quotationNumber = await nextQuotationNumber(client, tenantId)

    const { rows } = await client.query(
      `INSERT INTO quotations
         (tenant_id, quotation_number, partner_id, currency,
          subtotal_mxn, tax_mxn, total_mxn, status, valid_until, notes, created_by)
       VALUES ($1, $2, $3, $4, 0, 0, 0, 'draft', $5, $6, $7)
       RETURNING *`,
      [tenantId, quotationNumber, partnerId, currency,
       validUntil || null, notes || null, userId]
    )
    const quotation = rows[0]

    // Líneas
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i]
      if (!l.productId)  throw createError(400, `Línea ${i + 1}: producto requerido.`)
      if (!l.quantity)   throw createError(400, `Línea ${i + 1}: cantidad requerida.`)
      if (!l.unitPrice)  throw createError(400, `Línea ${i + 1}: precio requerido.`)
      const packFactor = l.packFactor != null ? parseFloat(l.packFactor) : 1
      const quantityBase = parseFloat(l.quantity) * packFactor
      await client.query(
        `INSERT INTO quotation_lines
           (quotation_id, product_id, quantity, unit, unit_price, currency,
            discount_pct, notes, line_number,
            pack_option_id, pack_factor, quantity_base,
            bundle_id, bundle_group_id, bundle_name, bundle_quantity)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
        [quotation.id, l.productId, l.quantity, l.unit || 'paquete',
         l.unitPrice, currency, l.discountPct || 0, l.notes || null, i + 1,
         l.packOptionId || null, packFactor, quantityBase,
         l.bundleId || null,
         l.bundleId ? (l.bundleGroupId || null) : null,
         l.bundleId ? (l.bundleName || null) : null,
         l.bundleId ? (l.bundleQuantity || null) : null]
      )
    }

    await recalcQuotationTotals(client, quotation.id)
    await audit({ tenantId, userId, ipAddress, userAgent,
      action: 'quotation.created', resource: 'quotations', resourceId: quotation.id,
      payload: { quotation_number: quotation.quotation_number, partner_id: partnerId } })

    return await getQuotation({ tenantId, quotationId: quotation.id, client })
  })
}

// ── Update datos generales (solo draft) ──────────────────────────────────────
async function updateQuotation({
  tenantId, quotationId, validUntil, notes, currency,
  userId, ipAddress, userAgent,
}) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `UPDATE quotations
          SET valid_until = COALESCE($1, valid_until),
              notes       = COALESCE($2, notes),
              currency    = COALESCE($3, currency)
        WHERE id = $4 AND tenant_id = $5 AND status = 'draft'
        RETURNING *`,
      [validUntil, notes, currency, quotationId, tenantId]
    )
    if (!rows[0]) throw createError(409, 'Solo se puede editar una cotización en borrador.')
    await audit({ tenantId, userId, ipAddress, userAgent,
      action: 'quotation.updated', resource: 'quotations', resourceId: quotationId })
    return await getQuotation({ tenantId, quotationId, client })
  })
}

// ── Líneas: add / update / delete (solo draft) ───────────────────────────────
async function _assertDraft(client, tenantId, quotationId) {
  const { rows } = await client.query(
    `SELECT id, status FROM quotations WHERE id = $1 AND tenant_id = $2`,
    [quotationId, tenantId]
  )
  if (!rows[0]) throw createError(404, 'Cotización no encontrada.')
  if (rows[0].status !== 'draft') throw createError(409, 'Solo se pueden editar líneas en borrador.')
}

async function addLine({ tenantId, quotationId, productId, quantity, unit,
  unitPrice, discountPct, notes, packOptionId, packFactor, userId }) {
  return withTransaction(async (client) => {
    await _assertDraft(client, tenantId, quotationId)
    const { rows: last } = await client.query(
      `SELECT COALESCE(MAX(line_number), 0) AS n FROM quotation_lines WHERE quotation_id = $1`,
      [quotationId]
    )
    const lineNumber = last[0].n + 1
    const { rows: q } = await client.query(`SELECT currency FROM quotations WHERE id = $1`, [quotationId])
    const factor = packFactor != null ? parseFloat(packFactor) : 1
    const quantityBase = parseFloat(quantity) * factor
    await client.query(
      `INSERT INTO quotation_lines
         (quotation_id, product_id, quantity, unit, unit_price, currency,
          discount_pct, notes, line_number,
          pack_option_id, pack_factor, quantity_base)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [quotationId, productId, quantity, unit || 'paquete',
       unitPrice, q[0].currency, discountPct || 0, notes || null, lineNumber,
       packOptionId || null, factor, quantityBase]
    )
    await recalcQuotationTotals(client, quotationId)
    return await getQuotation({ tenantId, quotationId, client })
  })
}

async function _assertNotBundleLine(client, quotationId, lineId) {
  const { rows } = await client.query(
    `SELECT bundle_name FROM quotation_lines
      WHERE id = $1 AND quotation_id = $2 AND bundle_group_id IS NOT NULL`,
    [lineId, quotationId]
  )
  if (rows.length) {
    throw createError(409,
      `Esta línea pertenece al paquete "${rows[0].bundle_name}". No se edita individualmente: quita el paquete completo y agrégalo de nuevo (o agrega el producto como línea suelta).`)
  }
}

async function updateLine({ tenantId, quotationId, lineId,
  quantity, unit, unitPrice, discountPct, notes,
  packOptionId, packFactor, userId }) {
  return withTransaction(async (client) => {
    await _assertDraft(client, tenantId, quotationId)
    await _assertNotBundleLine(client, quotationId, lineId)
    // Recalcular quantity_base si alguno de sus dos factores cambia. Si no
    // viene quantity ni packFactor en el body, mantenemos el valor previo
    // dejando que COALESCE no lo toque (subquery a la fila original).
    const { rows } = await client.query(
      `UPDATE quotation_lines
          SET quantity        = COALESCE($1, quantity),
              unit            = COALESCE($2, unit),
              unit_price      = COALESCE($3, unit_price),
              discount_pct    = COALESCE($4, discount_pct),
              notes           = COALESCE($5, notes),
              pack_option_id  = COALESCE($6, pack_option_id),
              pack_factor     = COALESCE($7, pack_factor),
              quantity_base   = COALESCE($1, quantity) * COALESCE($7, pack_factor)
        WHERE id = $8 AND quotation_id = $9
        RETURNING id`,
      [quantity, unit, unitPrice, discountPct, notes,
       packOptionId, packFactor, lineId, quotationId]
    )
    if (!rows[0]) throw createError(404, 'Línea no encontrada.')
    await recalcQuotationTotals(client, quotationId)
    return await getQuotation({ tenantId, quotationId, client })
  })
}

async function deleteLine({ tenantId, quotationId, lineId }) {
  return withTransaction(async (client) => {
    await _assertDraft(client, tenantId, quotationId)
    await _assertNotBundleLine(client, quotationId, lineId)
    const { rowCount } = await client.query(
      `DELETE FROM quotation_lines WHERE id = $1 AND quotation_id = $2`,
      [lineId, quotationId]
    )
    if (rowCount === 0) throw createError(404, 'Línea no encontrada.')
    const { rows: remaining } = await client.query(
      `SELECT COUNT(*)::int AS n FROM quotation_lines WHERE quotation_id = $1`,
      [quotationId]
    )
    if (remaining[0].n === 0) {
      throw createError(409, 'No puedes eliminar la última línea. Cancela la cotización si ya no aplica.')
    }
    await recalcQuotationTotals(client, quotationId)
    return await getQuotation({ tenantId, quotationId, client })
  })
}

/**
 * Agrega un PAQUETE a una cotización en draft: explota el paquete del catálogo
 * en líneas componente con precio prorrateado (bundleService.explodeBundle) y
 * las inserta como un grupo atómico (bundle_group_id compartido). Espejo de
 * orderService.addBundleToOrder.
 */
async function addBundleToQuotation({
  tenantId, quotationId, bundleId, bundleQuantity = 1,
  userId, ipAddress, userAgent,
}) {
  const qty = parseFloat(bundleQuantity)
  if (!(qty > 0)) throw createError(400, 'La cantidad de paquetes debe ser mayor a cero.')

  // El prorrateo lee catálogo + TC — fuera de la transacción de escritura.
  const exploded = await bundleService.explodeBundle({ tenantId, bundleId })

  return withTransaction(async (client) => {
    const { rows: q } = await client.query(
      `SELECT id, currency, status FROM quotations WHERE id = $1 AND tenant_id = $2`,
      [quotationId, tenantId]
    )
    if (!q[0]) throw createError(404, 'Cotización no encontrada.')
    if (q[0].status !== 'draft') throw createError(409, 'Solo se pueden agregar paquetes en borrador.')

    if (exploded.bundle.currency !== q[0].currency) {
      throw createError(400,
        `El paquete "${exploded.bundle.name}" está definido en ${exploded.bundle.currency} y la cotización es en ${q[0].currency}.`)
    }

    const { rows: last } = await client.query(
      `SELECT COALESCE(MAX(line_number), 0) AS n FROM quotation_lines WHERE quotation_id = $1`,
      [quotationId]
    )

    const groupId = randomUUID()
    for (let i = 0; i < exploded.lines.length; i++) {
      const l = exploded.lines[i]
      const lineQty = l.quantity * qty
      await client.query(
        `INSERT INTO quotation_lines
           (quotation_id, product_id, quantity, unit, unit_price, currency,
            discount_pct, line_number, pack_option_id, pack_factor, quantity_base,
            bundle_id, bundle_group_id, bundle_name, bundle_quantity)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
        [quotationId, l.productId, lineQty, l.unit, l.unitPrice, q[0].currency,
         0, last[0].n + i + 1, l.packOptionId || null, l.packFactor,
         lineQty * l.packFactor,
         exploded.bundle.id, groupId, exploded.bundle.name, qty]
      )
    }

    await recalcQuotationTotals(client, quotationId)
    await audit({ tenantId, userId, ipAddress, userAgent,
      action: 'quotation.bundle_added', resource: 'quotations', resourceId: quotationId,
      payload: { bundleId, bundleName: exploded.bundle.name, bundleQuantity: qty } })

    return await getQuotation({ tenantId, quotationId, client })
  })
}

/**
 * Quita un paquete completo (todas las líneas del grupo) de una cotización draft.
 */
async function removeBundleGroup({
  tenantId, quotationId, bundleGroupId, userId, ipAddress, userAgent,
}) {
  return withTransaction(async (client) => {
    await _assertDraft(client, tenantId, quotationId)

    const { rows } = await client.query(
      `DELETE FROM quotation_lines
        WHERE quotation_id = $1 AND bundle_group_id = $2
        RETURNING id, bundle_name`,
      [quotationId, bundleGroupId]
    )
    if (rows.length === 0) throw createError(404, 'Paquete no encontrado en esta cotización.')

    const { rows: remaining } = await client.query(
      `SELECT COUNT(*)::int AS n FROM quotation_lines WHERE quotation_id = $1`,
      [quotationId]
    )
    if (remaining[0].n === 0) {
      throw createError(409, 'No puedes dejar la cotización sin líneas. Cancélala si ya no aplica.')
    }

    await recalcQuotationTotals(client, quotationId)
    await audit({ tenantId, userId, ipAddress, userAgent,
      action: 'quotation.bundle_removed', resource: 'quotations', resourceId: quotationId,
      payload: { bundleGroupId, bundleName: rows[0].bundle_name, linesRemoved: rows.length } })

    return await getQuotation({ tenantId, quotationId, client })
  })
}

// ── Transiciones de estado ───────────────────────────────────────────────────

/**
 * Resuelve destinatarios por defecto: contactos del cliente con email,
 * ordenados primario primero.
 */
async function defaultRecipientsForQuotation(tenantId, partnerId) {
  const { rows } = await query(
    `SELECT email
       FROM business_partner_contacts
      WHERE business_partner_id = $1 AND email IS NOT NULL AND email <> ''
      ORDER BY is_primary DESC NULLS LAST, id ASC`,
    [partnerId]
  )
  return rows.map(r => r.email).filter(Boolean)
}

/**
 * Lista los contactos del partner (para que el frontend muestre el modal
 * de selección de destinatarios).
 */
async function listPartnerContacts(tenantId, partnerId) {
  const { rows } = await query(
    `SELECT bpc.id, bpc.name, bpc.position, bpc.email, bpc.phone, bpc.is_primary
       FROM business_partner_contacts bpc
       JOIN business_partners bp ON bp.id = bpc.business_partner_id
      WHERE bpc.business_partner_id = $1 AND bp.tenant_id = $2
      ORDER BY bpc.is_primary DESC NULLS LAST, bpc.created_at ASC`,
    [partnerId, tenantId]
  )
  return rows
}

/**
 * draft → sent. Genera PDF, lo adjunta al correo y envía a los destinatarios
 * indicados (o los contactos del cliente por defecto).
 *
 * - `emails`: array de correos. Si está vacío se usan los contactos del partner.
 * - Si no hay correos (ni indicados ni contactos), se permite la transición
 *   pero sin enviar email (el operador puede reintentar después).
 * - El envío del correo es best-effort: si falla, el status se mantiene en
 *   'sent' y se loguea — igual que en remisiones.
 */
async function sendQuotation({ tenantId, quotationId, emails, skipEmail = false,
  userId, ipAddress, userAgent }) {
  // Transición primero (corta, dentro de transacción). Solo borrador → enviada.
  // Para sent/accepted/converted/expired se REENVÍA el PDF por correo SIN cambiar
  // el estado — permite reenviar una cotización aunque ya se haya convertido a
  // pedido (no la regresa a "enviada"). Solo se bloquea 'cancelled'.
  const transitioned = await withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT * FROM quotations WHERE id = $1 AND tenant_id = $2`,
      [quotationId, tenantId]
    )
    if (!rows[0]) throw createError(404, 'Cotización no encontrada.')
    const q = rows[0]
    if (q.status === 'cancelled') {
      throw createError(409, 'No se puede enviar una cotización cancelada.')
    }
    if (q.status === 'draft') {
      const { rows: upd } = await client.query(
        `UPDATE quotations
            SET status = 'sent',
                sent_at = COALESCE(sent_at, NOW()),
                sent_by = COALESCE(sent_by, $1)
          WHERE id = $2 AND tenant_id = $3
          RETURNING *`,
        [userId, quotationId, tenantId]
      )
      return upd[0]
    }
    return q
  })

  // Si el operador eligió "marcar enviada sin correo", no resolvemos contactos.
  let recipients = []
  if (!skipEmail) {
    recipients = Array.isArray(emails) ? emails.filter(Boolean) : []
    if (!recipients.length) {
      recipients = await defaultRecipientsForQuotation(tenantId, transitioned.partner_id)
    }
  }

  let emailResult = { sent: false, recipients: [], reason: null }

  if (recipients.length) {
    try {
      const q = await getQuotation({ tenantId, quotationId })

      // BCC: notification_email del tenant, o correo del usuario logueado.
      let senderEmail = null
      const { rows: trows } = await query(
        `SELECT notification_email, name AS tenant_name, brand_color_primary FROM tenants WHERE id = $1`,
        [tenantId]
      )
      if (trows[0]?.notification_email) {
        senderEmail = trows[0].notification_email
      } else if (userId) {
        const { rows: u } = await query(
          `SELECT email FROM users WHERE id = $1 AND tenant_id = $2`,
          [userId, tenantId]
        )
        if (u[0]?.email) senderEmail = u[0].email
      }
      if (senderEmail && recipients.includes(senderEmail)) senderEmail = null

      const tenantDisplayName = await resolveTenantDisplayName(tenantId, trows[0]?.tenant_name)
      const partnerDisplayName = q.partner_tax_name || q.partner_name || ''

      const pdfBuffer = await generateQuotationPDF({ tenantId, quotationId })
      const html = quotationEmail({
        tenantName:  tenantDisplayName,
        brandColor:  trows[0]?.brand_color_primary || null,
        partnerName: partnerDisplayName,
        docNumber:   q.quotation_number,
        total:       q.total_mxn || q.subtotal_mxn,
        currency:    q.currency,
        issueDate:   q.created_at,
        validUntil:  q.valid_until,
        notes:       q.notes,
      })

      await sendMail({
        tenantId,
        to:        recipients,
        bcc:       senderEmail || undefined,
        replyTo:   senderEmail || undefined,
        subject:   `Cotización ${q.quotation_number} — ${tenantDisplayName}`,
        html,
        fromName:  tenantDisplayName,
        attachments: [{
          filename:    `${q.quotation_number}.pdf`,
          content:     pdfBuffer,
          contentType: 'application/pdf',
        }],
      })

      emailResult = { sent: true, recipients, bcc: senderEmail }
    } catch (err) {
      // No revertimos — el operador puede reintentar desde el panel.
      logger.warn(`Cotización ${quotationId}: status='sent' OK pero envío email falló: ${err.message}`)
      emailResult = { sent: false, recipients, reason: err.message }
    }
  } else if (skipEmail) {
    emailResult = { sent: false, recipients: [], reason: 'omitido_por_operador' }
  } else {
    emailResult = { sent: false, recipients: [], reason: 'sin_destinatarios' }
  }

  await audit({
    tenantId, userId, ipAddress, userAgent,
    action: 'quotation.sent', resource: 'quotations', resourceId: quotationId,
    payload: { email_sent: emailResult.sent, recipients: emailResult.recipients },
  })

  const quotation = await getQuotation({ tenantId, quotationId })
  return { ...quotation, email: emailResult }
}

async function resolveTenantDisplayName(tenantId, fallback) {
  const { rows } = await query(
    `SELECT razon_social FROM tenant_fiscal_info WHERE tenant_id = $1`,
    [tenantId]
  )
  return rows[0]?.razon_social || fallback || 'Emisor'
}

/**
 * sent → accepted. NO crea pedido todavía — eso es convertToOrder.
 * Permite separar "cliente aceptó verbalmente" de "vamos a producir".
 */
async function acceptQuotation({ tenantId, quotationId, userId, ipAddress, userAgent }) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `UPDATE quotations SET status = 'accepted'
        WHERE id = $1 AND tenant_id = $2 AND status = 'sent'
        RETURNING *`,
      [quotationId, tenantId]
    )
    if (!rows[0]) throw createError(409, 'Solo se puede marcar como aceptada una cotización enviada.')
    await audit({ tenantId, userId, ipAddress, userAgent,
      action: 'quotation.accepted', resource: 'quotations', resourceId: quotationId })
    return await getQuotation({ tenantId, quotationId, client })
  })
}

/**
 * accepted → converted. Crea sales_order con las líneas de la cotización.
 * También válido desde 'sent' (atajo: aceptar + convertir en un paso).
 */
async function convertToOrder({ tenantId, quotationId, userId, ipAddress, userAgent }) {
  return withTransaction(async (client) => {
    const { rows: qRows } = await client.query(
      `SELECT * FROM quotations WHERE id = $1 AND tenant_id = $2`,
      [quotationId, tenantId]
    )
    const q = qRows[0]
    if (!q) throw createError(404, 'Cotización no encontrada.')
    if (!['sent', 'accepted'].includes(q.status)) {
      throw createError(409, `No se puede convertir desde estado '${q.status}'.`)
    }
    if (q.converted_order_id) throw createError(409, 'Esta cotización ya fue convertida a pedido.')

    // Generar número de pedido usando el mismo generador centralizado que el
    // módulo de pedidos. Antes esta función duplicaba el patrón legacy y se
    // saltaba la serie configurada en tenant_document_series, por eso los
    // pedidos creados desde cotización ignoraban la nomenclatura del tenant.
    const orderNumber = await nextOrderNumber(client, tenantId)

    // Crear pedido (sin IVA, igual que orderService.createOrder)
    const { rows: orderRows } = await client.query(
      `INSERT INTO sales_orders
         (tenant_id, order_number, partner_id, currency, exchange_rate_id,
          exchange_rate_value, subtotal_mxn, tax_mxn, total_mxn,
          status, notes, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 0, $7, 'draft', $8, $9)
       RETURNING *`,
      [tenantId, orderNumber, q.partner_id, q.currency, q.exchange_rate_id,
       q.exchange_rate_value, q.subtotal_mxn,
       q.notes ? `Desde cotización ${q.quotation_number}. ${q.notes}` : `Desde cotización ${q.quotation_number}.`,
       userId]
    )
    const order = orderRows[0]

    // Copiar líneas
    const { rows: qLines } = await client.query(
      `SELECT * FROM quotation_lines WHERE quotation_id = $1 ORDER BY line_number`,
      [quotationId]
    )
    for (const l of qLines) {
      await client.query(
        `INSERT INTO sales_order_lines
           (sales_order_id, product_id, quantity, unit, unit_price, currency,
            discount_pct, notes, line_number,
            pack_option_id, pack_factor, quantity_base,
            bundle_id, bundle_group_id, bundle_name, bundle_quantity)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
        [order.id, l.product_id, l.quantity, l.unit, l.unit_price, l.currency,
         l.discount_pct, l.notes, l.line_number,
         l.pack_option_id, l.pack_factor, l.quantity_base,
         l.bundle_id, l.bundle_group_id, l.bundle_name, l.bundle_quantity]
      )
    }

    // Marcar cotización como convertida
    await client.query(
      `UPDATE quotations
          SET status = 'converted', converted_order_id = $1,
              converted_at = NOW(), converted_by = $2
        WHERE id = $3`,
      [order.id, userId, quotationId]
    )

    await audit({ tenantId, userId, ipAddress, userAgent,
      action: 'quotation.converted', resource: 'quotations', resourceId: quotationId,
      payload: { sales_order_id: order.id, order_number: orderNumber } })

    return {
      quotation: await getQuotation({ tenantId, quotationId, client }),
      order: { id: order.id, order_number: orderNumber, status: 'draft' },
    }
  })
}

async function rejectQuotation({ tenantId, quotationId, reason, userId, ipAddress, userAgent }) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `UPDATE quotations
          SET status = 'rejected', rejected_at = NOW(), rejected_reason = $1
        WHERE id = $2 AND tenant_id = $3 AND status IN ('sent', 'accepted')
        RETURNING *`,
      [reason || null, quotationId, tenantId]
    )
    if (!rows[0]) throw createError(409, 'Solo se puede rechazar una cotización enviada o aceptada.')
    await audit({ tenantId, userId, ipAddress, userAgent,
      action: 'quotation.rejected', resource: 'quotations', resourceId: quotationId,
      payload: { reason: reason || null } })
    return await getQuotation({ tenantId, quotationId, client })
  })
}

async function cancelQuotation({ tenantId, quotationId, userId, ipAddress, userAgent }) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `UPDATE quotations
          SET status = 'cancelled', cancelled_at = NOW()
        WHERE id = $1 AND tenant_id = $2
          AND status IN ('draft', 'sent')
        RETURNING *`,
      [quotationId, tenantId]
    )
    if (!rows[0]) throw createError(409, 'Solo se puede cancelar una cotización en borrador o enviada.')
    await audit({ tenantId, userId, ipAddress, userAgent,
      action: 'quotation.cancelled', resource: 'quotations', resourceId: quotationId })
    return await getQuotation({ tenantId, quotationId, client })
  })
}

/**
 * Auto-expiración. Mueve a 'expired' las cotizaciones cuya `valid_until`
 * ya pasó y que siguen en draft/sent. Idempotente.
 * Llamado por scheduler diario en app.js.
 */
async function expireStaleQuotations() {
  const { rowCount } = await query(
    `UPDATE quotations
        SET status = 'expired', expired_at = NOW()
      WHERE status IN ('draft', 'sent')
        AND valid_until IS NOT NULL
        AND valid_until < ${LOCAL_TODAY}`
  )
  return { expired: rowCount }
}

module.exports = {
  listQuotations,
  getQuotation,
  createQuotation,
  updateQuotation,
  addLine,
  updateLine,
  deleteLine,
  addBundleToQuotation,
  removeBundleGroup,
  sendQuotation,
  acceptQuotation,
  convertToOrder,
  rejectQuotation,
  cancelQuotation,
  expireStaleQuotations,
  listPartnerContacts,
  defaultRecipientsForQuotation,
}
