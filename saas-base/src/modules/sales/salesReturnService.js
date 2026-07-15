'use strict'

/**
 * SaaS v2 — Devoluciones de VENTA (cliente regresa mercancía ya entregada).
 *
 * Espejo de supplierReturnService. Flujo:
 *   1. createReturn  → borrador (encabezado + líneas). No mueve inventario.
 *   2. confirmReturn → REINGRESA inventario (adjustment_in, ref='sales_return')
 *      + restaura lote. SIN factura: reduce la CXC de la remisión (amount_credited).
 *      CON factura: solo inventario; la nota de crédito se emite aparte.
 *   3. emitCreditNote (solo CON factura) → timbra/vincula la NC (CFDI E) que
 *      reduce la CXC de la factura (reusa creditNoteService por MONTO).
 *   4. cancelReturn → borrador: solo marca cancelada. Confirmada: revierte
 *      inventario + deshace el crédito de CXC (bloquea si ya se timbró la NC).
 *
 * Diferencia con el RECHAZO EN ENTREGA (recordDelivery.deliveredLines): esto NO
 * reabre el pedido — el pedido se cumplió; el cliente devolvió DESPUÉS.
 */

const createError = require('http-errors')
const { query, withTransaction } = require('../../db')
const { audit } = require('../../utils/audit')
const { recordMovement } = require('../inventory/inventoryService')
const documentSeriesService = require('../document-series/documentSeriesService')
const creditNoteService = require('../invoicing/creditNoteService')

// ─── Numeración ──────────────────────────────────────────────────────────────
async function nextReturnNumber(client, tenantId) {
  const result = await documentSeriesService.generateDocumentNumber({
    client, tenantId, entityType: 'sales_return',
  })
  if (result) return result.docNumber

  const ym = new Date().toISOString().slice(0, 7).replace('-', '')
  const pref = `DEV-${ym}-`
  const { rows } = await client.query(
    `SELECT return_number FROM sales_returns
      WHERE tenant_id = $1 AND return_number LIKE $2
      ORDER BY return_number DESC LIMIT 1`,
    [tenantId, `${pref}%`]
  )
  const last = rows[0]?.return_number
  const seq = last ? parseInt(last.split('-')[2], 10) + 1 : 1
  return `${pref}${String(seq).padStart(4, '0')}`
}

/**
 * Detecta la factura ACTIVA que cubre una remisión (directa, consolidada o
 * anticipada). Devuelve {id, document_number, status, cfdi_uuid} o null.
 */
async function detectInvoiceForNote(client, tenantId, noteId) {
  const { rows } = await client.query(
    `SELECT iv.id, iv.document_number, iv.status, iv.cfdi_uuid
       FROM invoices iv
      WHERE iv.tenant_id = $1 AND iv.status <> 'cancelled'
        AND ( iv.delivery_note_id = $2
              OR EXISTS (SELECT 1 FROM invoice_remissions ir
                          WHERE ir.invoice_id = iv.id AND ir.delivery_note_id = $2)
              OR ( iv.delivery_note_id IS NULL
                   AND NOT EXISTS (SELECT 1 FROM invoice_remissions ir2 WHERE ir2.invoice_id = iv.id)
                   AND EXISTS (
                     SELECT 1 FROM invoice_lines il
                       JOIN delivery_note_lines dnl ON dnl.sales_order_line_id = il.sales_order_line_id
                      WHERE il.invoice_id = iv.id AND dnl.delivery_note_id = $2) ) )
      ORDER BY iv.created_at DESC
      LIMIT 1`,
    [tenantId, noteId]
  )
  return rows[0] || null
}

/**
 * Líneas devolvibles de una remisión: por cada línea entregada, cuánto queda por
 * devolver = quantity_delivered − (devoluciones NO canceladas de esa línea).
 */
async function getReturnableLines(client, tenantId, noteId) {
  const { rows } = await client.query(
    `SELECT dnl.id AS delivery_note_line_id, dnl.product_id, p.sku, p.name AS product_name,
            dnl.quantity_delivered, dnl.unit, dnl.unit_price, dnl.discount_pct,
            COALESCE(dnl.pack_factor, 1) AS pack_factor, dnl.warehouse_id, dnl.product_lot_id,
            COALESCE((
              SELECT SUM(srl.quantity)
                FROM sales_return_lines srl
                JOIN sales_returns sr ON sr.id = srl.return_id
               WHERE srl.source_delivery_note_line_id = dnl.id
                 AND sr.status <> 'cancelled'
            ), 0) AS already_returned
       FROM delivery_note_lines dnl
       JOIN products p ON p.id = dnl.product_id
      WHERE dnl.delivery_note_id = $1
      ORDER BY dnl.line_number`,
    [noteId]
  )
  return rows.map(r => ({
    ...r,
    returnable: +(parseFloat(r.quantity_delivered) - parseFloat(r.already_returned)).toFixed(4),
  }))
}

// ─── Crear (borrador) ────────────────────────────────────────────────────────
async function createReturn({
  tenantId, deliveryNoteId, reasonId, returnDate, notes, lines,
  userId, ipAddress, userAgent,
}) {
  if (!deliveryNoteId) throw createError(400, 'La remisión de origen es requerida.')
  if (!Array.isArray(lines) || lines.length === 0) throw createError(400, 'Agrega al menos una línea a devolver.')

  const newId = await withTransaction(async (client) => {
    const { rows: noteRows } = await client.query(
      `SELECT id, partner_id, status, currency, exchange_rate_value
         FROM delivery_notes WHERE id = $1 AND tenant_id = $2`,
      [deliveryNoteId, tenantId]
    )
    const note = noteRows[0]
    if (!note) throw createError(404, 'Remisión no encontrada.')
    if (!['delivered', 'partially_delivered', 'invoiced'].includes(note.status)) {
      throw createError(409, 'Solo se puede devolver una remisión ya entregada.')
    }

    const invoice = await detectInvoiceForNote(client, tenantId, deliveryNoteId)

    const returnable = Object.fromEntries(
      (await getReturnableLines(client, tenantId, deliveryNoteId)).map(l => [l.delivery_note_line_id, l])
    )

    const normalized = []
    for (const inp of lines) {
      const src = returnable[inp.deliveryNoteLineId]
      if (!src) throw createError(400, 'Una de las líneas no pertenece a esta remisión.')
      const qty = parseFloat(inp.quantity)
      if (!(qty > 0)) throw createError(400, 'Cada línea requiere una cantidad mayor a cero.')
      if (qty - src.returnable > 0.0001) {
        throw createError(409,
          `No puedes devolver más de lo entregado en ${src.product_name || src.sku} (quedan ${src.returnable}).`)
      }
      const packFactor = parseFloat(src.pack_factor) || 1
      let warehouseId = src.warehouse_id
      if (!warehouseId) {
        // Remisión vieja sin almacén persistido: usa el default de PT/reventa.
        const { rows: wh } = await client.query(
          `SELECT id FROM warehouses
            WHERE tenant_id = $1 AND type IN ('finished_product','resale') AND is_active = true
            ORDER BY is_default DESC, created_at ASC LIMIT 1`,
          [tenantId]
        )
        warehouseId = wh[0]?.id
        if (!warehouseId) throw createError(500, 'No hay almacén de producto terminado para reingresar.')
      }
      normalized.push({
        productId: src.product_id, warehouseId, productLotId: src.product_lot_id || null,
        quantity: qty, unit: src.unit || 'pieza',
        unitPrice: parseFloat(src.unit_price), discountPct: parseFloat(src.discount_pct || 0),
        packFactor, quantityBase: +(qty * packFactor).toFixed(4),
        sourceDeliveryNoteLineId: inp.deliveryNoteLineId,
      })
    }

    const factor = note.currency === 'USD' ? parseFloat(note.exchange_rate_value || 1) : 1
    const subtotalDoc = normalized.reduce(
      (s, l) => s + l.quantity * l.unitPrice * (1 - l.discountPct / 100), 0
    )
    const totalMxn = +(subtotalDoc * factor).toFixed(2)

    const returnNumber = await nextReturnNumber(client, tenantId)
    const creditStatus = invoice ? 'pending' : 'not_applicable'

    const { rows: hdr } = await client.query(
      `INSERT INTO sales_returns
         (tenant_id, return_number, partner_id, reason_id, source_delivery_note_id,
          source_invoice_id, status, return_date, notes, total_mxn, credit_status, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,'draft',COALESCE($7,CURRENT_DATE),$8,$9,$10,$11)
       RETURNING *`,
      [tenantId, returnNumber, note.partner_id, reasonId || null, deliveryNoteId,
       invoice?.id || null, returnDate || null, notes || null, totalMxn, creditStatus, userId]
    )
    const ret = hdr[0]

    for (const l of normalized) {
      await client.query(
        `INSERT INTO sales_return_lines
           (return_id, tenant_id, product_id, warehouse_id, product_lot_id,
            quantity, unit, unit_price, discount_pct, pack_factor, quantity_base,
            source_delivery_note_line_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [ret.id, tenantId, l.productId, l.warehouseId, l.productLotId,
         l.quantity.toFixed(4), l.unit, l.unitPrice.toFixed(4), l.discountPct.toFixed(2),
         l.packFactor.toFixed(4), l.quantityBase.toFixed(4), l.sourceDeliveryNoteLineId]
      )
    }

    await audit({
      tenantId, userId, action: 'sales_return.created', resource: 'sales_returns',
      resourceId: ret.id,
      payload: { returnNumber, deliveryNoteId, hasInvoice: !!invoice, lines: normalized.length, total: totalMxn },
      ipAddress, userAgent,
    })
    return ret.id
  })
  return getReturn({ tenantId, returnId: newId })
}

// ─── Confirmar (reingresa inventario) ────────────────────────────────────────
async function confirmReturn({ tenantId, returnId, userId, ipAddress, userAgent }) {
  await withTransaction(async (client) => {
    const { rows: hdr } = await client.query(
      `SELECT * FROM sales_returns WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
      [returnId, tenantId]
    )
    const ret = hdr[0]
    if (!ret) throw createError(404, 'Devolución no encontrada.')
    if (ret.status !== 'draft') throw createError(409, 'Solo se puede confirmar una devolución en borrador.')

    const { rows: lines } = await client.query(
      `SELECT * FROM sales_return_lines WHERE return_id = $1`, [returnId]
    )
    if (lines.length === 0) throw createError(409, 'La devolución no tiene líneas.')

    for (const l of lines) {
      const qtyBase = parseFloat(l.quantity_base)
      // Reingreso: el producto vuelve al almacén de origen. allowNegative da igual
      // (sumamos); validateStock false (una entrada nunca se bloquea).
      await recordMovement(client, {
        tenantId, warehouseId: l.warehouse_id, itemType: 'product', itemId: l.product_id,
        movementType: 'adjustment_in', quantity: qtyBase, unit: l.unit,
        unitCost: parseFloat(l.unit_price || 0), statusTo: 'available',
        referenceType: 'sales_return', referenceId: returnId,
        notes: `Devolución de venta ${ret.return_number}`, createdBy: userId,
        productLotId: l.product_lot_id || null,
      })
      // Restaurar saldo del lote (reactivar si estaba agotado).
      if (l.product_lot_id) {
        await client.query(
          `UPDATE product_lots
              SET quantity_remaining = quantity_remaining + $1,
                  status = CASE WHEN status = 'depleted' THEN 'active' ELSE status END
            WHERE id = $2 AND tenant_id = $3`,
          [qtyBase, l.product_lot_id, tenantId]
        )
      }
    }

    // SIN factura: reducir la CXC de la remisión (amount_credited, no toca amount_total).
    let arCredited = false
    if (!ret.source_invoice_id) {
      const { rows: arRows } = await client.query(
        `SELECT id, amount_total, amount_paid, amount_credited
           FROM accounts_receivable
          WHERE tenant_id = $1 AND document_type = 'remission' AND document_id = $2
            AND status <> 'cancelled'`,
        [tenantId, ret.source_delivery_note_id]
      )
      if (arRows[0]) {
        const ar = arRows[0]
        // Cap: no acreditar por debajo de lo ya cobrado (refund a cliente = fuera de alcance).
        const maxCredit = parseFloat(ar.amount_total) - parseFloat(ar.amount_paid || 0)
        const newCredited = Math.min(
          parseFloat(ar.amount_credited || 0) + parseFloat(ret.total_mxn),
          maxCredit
        )
        const pending = parseFloat(ar.amount_total) - parseFloat(ar.amount_paid || 0) - newCredited
        const newStatus = pending <= 0.005
          ? 'paid'
          : (parseFloat(ar.amount_paid || 0) > 0 ? 'partial' : 'pending')
        await client.query(
          `UPDATE accounts_receivable SET amount_credited = $1, status = $2 WHERE id = $3`,
          [newCredited.toFixed(2), newStatus, ar.id]
        )
        arCredited = true
      }
    }

    await client.query(
      `UPDATE sales_returns SET status = 'confirmed', confirmed_at = NOW(), ar_credited = $2 WHERE id = $1`,
      [returnId, arCredited]
    )

    await audit({
      tenantId, userId, action: 'sales_return.confirmed', resource: 'sales_returns',
      resourceId: returnId,
      payload: { returnNumber: ret.return_number, total: ret.total_mxn, hasInvoice: !!ret.source_invoice_id, arCredited },
      ipAddress, userAgent,
    })
  })
  return getReturn({ tenantId, returnId })
}

// ─── Emitir nota de crédito (solo CON factura) ───────────────────────────────
async function emitCreditNote({ tenantId, returnId, paymentForm, userId, ipAddress, userAgent }) {
  // Lecturas + validaciones fuera de transacción (createCreditNote maneja la suya
  // y llama a Facturapi — no debe sostener locks).
  const { rows: hdr } = await query(
    `SELECT * FROM sales_returns WHERE id = $1 AND tenant_id = $2`, [returnId, tenantId]
  )
  const ret = hdr[0]
  if (!ret) throw createError(404, 'Devolución no encontrada.')
  if (ret.status !== 'confirmed') throw createError(409, 'Confirma la devolución antes de emitir la nota de crédito.')
  if (!ret.source_invoice_id) throw createError(409, 'Esta devolución no tiene factura de origen (es sin factura).')
  if (ret.credit_status === 'resolved') throw createError(409, 'La nota de crédito de esta devolución ya se emitió.')

  const { rows: invRows } = await query(
    `SELECT status FROM invoices WHERE id = $1 AND tenant_id = $2`,
    [ret.source_invoice_id, tenantId]
  )
  if (!invRows[0]) throw createError(404, 'Factura de origen no encontrada.')
  if (invRows[0].status !== 'stamped') {
    throw createError(409, 'La factura de origen no está timbrada; no se puede emitir nota de crédito.')
  }

  // total_mxn de la devolución es SIN IVA (las remisiones no llevan IVA) → es el
  // `amount` que createCreditNote espera (le aplica el 16% por dentro).
  const cn = await creditNoteService.createCreditNote({
    tenantId, invoiceId: ret.source_invoice_id,
    reason: 'return', description: `Devolución de venta ${ret.return_number}`,
    amount: parseFloat(ret.total_mxn), paymentForm: paymentForm || '03',
    userId, ipAddress, userAgent,
  })

  await query(
    `UPDATE sales_returns SET credit_note_invoice_id = $1, credit_status = 'resolved' WHERE id = $2`,
    [cn.id, returnId]
  )
  await audit({
    tenantId, userId, action: 'sales_return.credit_note_emitted', resource: 'sales_returns',
    resourceId: returnId, payload: { returnNumber: ret.return_number, creditNote: cn.document_number, uuid: cn.uuid },
    ipAddress, userAgent,
  })
  return getReturn({ tenantId, returnId })
}

// ─── Cancelar ────────────────────────────────────────────────────────────────
async function cancelReturn({ tenantId, returnId, userId, ipAddress, userAgent }) {
  return withTransaction(async (client) => {
    const { rows: hdr } = await client.query(
      `SELECT * FROM sales_returns WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
      [returnId, tenantId]
    )
    const ret = hdr[0]
    if (!ret) throw createError(404, 'Devolución no encontrada.')
    if (ret.status === 'cancelled') throw createError(409, 'La devolución ya está cancelada.')
    if (ret.credit_status === 'resolved') {
      throw createError(409, 'Esta devolución ya tiene nota de crédito timbrada. Cancela primero la nota de crédito.')
    }

    if (ret.status === 'confirmed') {
      const { rows: lines } = await client.query(
        `SELECT * FROM sales_return_lines WHERE return_id = $1`, [returnId]
      )
      for (const l of lines) {
        const qtyBase = parseFloat(l.quantity_base)
        // Sacar de nuevo lo que se había reingresado.
        await recordMovement(client, {
          tenantId, warehouseId: l.warehouse_id, itemType: 'product', itemId: l.product_id,
          movementType: 'adjustment_out', quantity: -qtyBase, unit: l.unit,
          unitCost: parseFloat(l.unit_price || 0), statusTo: 'available',
          referenceType: 'sales_return', referenceId: returnId,
          notes: `Reversa de devolución de venta ${ret.return_number}`, createdBy: userId,
          productLotId: l.product_lot_id || null, allowNegative: true,
        })
        if (l.product_lot_id) {
          await client.query(
            `UPDATE product_lots
                SET quantity_remaining = GREATEST(0, quantity_remaining - $1),
                    status = CASE WHEN quantity_remaining - $1 <= 0 THEN 'depleted' ELSE status END
              WHERE id = $2 AND tenant_id = $3`,
            [qtyBase, l.product_lot_id, tenantId]
          )
        }
      }

      // Deshacer el crédito de CXC (sin factura).
      if (ret.ar_credited) {
        const { rows: arRows } = await client.query(
          `SELECT id, amount_total, amount_paid, amount_credited
             FROM accounts_receivable
            WHERE tenant_id = $1 AND document_type = 'remission' AND document_id = $2
              AND status <> 'cancelled'`,
          [tenantId, ret.source_delivery_note_id]
        )
        if (arRows[0]) {
          const ar = arRows[0]
          const newCredited = Math.max(0, parseFloat(ar.amount_credited || 0) - parseFloat(ret.total_mxn))
          const pending = parseFloat(ar.amount_total) - parseFloat(ar.amount_paid || 0) - newCredited
          const newStatus = pending <= 0.005
            ? 'paid'
            : (parseFloat(ar.amount_paid || 0) > 0 ? 'partial' : 'pending')
          await client.query(
            `UPDATE accounts_receivable SET amount_credited = $1, status = $2 WHERE id = $3`,
            [newCredited.toFixed(2), newStatus, ar.id]
          )
        }
      }
    }

    const { rows: done } = await client.query(
      `UPDATE sales_returns SET status = 'cancelled' WHERE id = $1 RETURNING *`, [returnId]
    )
    await audit({
      tenantId, userId, action: 'sales_return.cancelled', resource: 'sales_returns',
      resourceId: returnId,
      payload: { returnNumber: ret.return_number, wasConfirmed: ret.status === 'confirmed' },
      ipAddress, userAgent,
    })
    return done[0]
  })
}

// ─── Lecturas ────────────────────────────────────────────────────────────────
async function listReturns({ tenantId, status, partnerId, from, to } = {}) {
  const params = [tenantId]
  const filters = []
  if (status)    { params.push(status);    filters.push(`sr.status = $${params.length}`) }
  if (partnerId) { params.push(partnerId); filters.push(`sr.partner_id = $${params.length}`) }
  if (from)      { params.push(from);      filters.push(`sr.return_date >= $${params.length}`) }
  if (to)        { params.push(to);        filters.push(`sr.return_date <= $${params.length}`) }
  const where = filters.length ? `AND ${filters.join(' AND ')}` : ''

  const { rows } = await query(
    `SELECT sr.id, sr.return_number, sr.status, sr.return_date, sr.total_mxn,
            sr.credit_status, sr.source_invoice_id, sr.source_delivery_note_id,
            bp.name AS partner_name,
            dn.document_number AS delivery_note_number,
            inv.document_number AS invoice_number,
            rr.name AS reason_name
       FROM sales_returns sr
       JOIN business_partners bp ON bp.id = sr.partner_id
       LEFT JOIN delivery_notes dn ON dn.id = sr.source_delivery_note_id
       LEFT JOIN invoices inv ON inv.id = sr.source_invoice_id
       LEFT JOIN tenant_return_reasons rr ON rr.id = sr.reason_id
      WHERE sr.tenant_id = $1 ${where}
      ORDER BY sr.created_at DESC`,
    params
  )
  return rows
}

async function getReturn({ tenantId, returnId }) {
  const { rows } = await query(
    `SELECT sr.*, bp.name AS partner_name,
            dn.document_number AS delivery_note_number,
            inv.document_number AS invoice_number, inv.status AS invoice_status,
            cn.document_number AS credit_note_number, cn.cfdi_uuid AS credit_note_uuid,
            rr.name AS reason_name
       FROM sales_returns sr
       JOIN business_partners bp ON bp.id = sr.partner_id
       LEFT JOIN delivery_notes dn ON dn.id = sr.source_delivery_note_id
       LEFT JOIN invoices inv ON inv.id = sr.source_invoice_id
       LEFT JOIN invoices cn ON cn.id = sr.credit_note_invoice_id
       LEFT JOIN tenant_return_reasons rr ON rr.id = sr.reason_id
      WHERE sr.id = $1 AND sr.tenant_id = $2`,
    [returnId, tenantId]
  )
  if (!rows[0]) return null
  const ret = rows[0]
  const { rows: lines } = await query(
    `SELECT srl.*, p.sku, p.name AS product_name
       FROM sales_return_lines srl
       JOIN products p ON p.id = srl.product_id
      WHERE srl.return_id = $1
      ORDER BY srl.created_at`,
    [returnId]
  )
  return { ...ret, lines }
}

module.exports = {
  createReturn, confirmReturn, emitCreditNote, cancelReturn,
  listReturns, getReturn, getReturnableLines, detectInvoiceForNote,
}
