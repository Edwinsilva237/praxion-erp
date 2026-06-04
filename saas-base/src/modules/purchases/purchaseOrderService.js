'use strict'

const { query, withTransaction } = require('../../db')
const { audit } = require('../../utils/audit')
const pushService = require('../push/pushService')
const { getRateForDate } = require('../exchange-rates/exchangeRateService')
const documentSeriesService = require('../document-series/documentSeriesService')
const supplierPriceService = require('./supplierPriceService')

/**
 * Genera el siguiente número de OC. Usa serie configurada si existe,
 * fallback al legacy `OC-YYYYMM-NNNN`.
 */
async function nextOrderNumber(client, tenantId, opts = {}) {
  const result = await documentSeriesService.generateDocumentNumber({
    client, tenantId, entityType: 'purchase_order', opts,
  })
  if (result) return result.docNumber

  const ym = new Date().toISOString().slice(0, 7).replace('-', '')
  const prefix = `OC-${ym}-`
  const { rows } = await client.query(
    `SELECT order_number FROM purchase_orders
     WHERE tenant_id = $1 AND order_number LIKE $2
     ORDER BY order_number DESC LIMIT 1`,
    [tenantId, `${prefix}%`]
  )
  const last = rows[0]?.order_number
  const seq = last ? parseInt(last.split('-')[2], 10) + 1 : 1
  return `${prefix}${String(seq).padStart(4, '0')}`
}

/**
 * Lista OC con filtros y estatus.
 */
async function listOrders({ tenantId, status, orderType, partnerId, search, from, to, page = 1, limit = 50 }) {
  const offset = (page - 1) * limit
  const params = [tenantId]
  const filters = []

  if (status)    { params.push(status);    filters.push(`po.status = $${params.length}`) }
  if (orderType) { params.push(orderType); filters.push(`po.order_type = $${params.length}`) }
  if (partnerId) { params.push(partnerId); filters.push(`po.partner_id = $${params.length}`) }
  if (from)      { params.push(from);      filters.push(`po.created_at >= $${params.length}`) }
  if (to)        { params.push(to);        filters.push(`po.created_at <= $${params.length}`) }
  if (search) {
    params.push(`%${search}%`)
    const sN = params.length
    filters.push(`(po.order_number ILIKE $${sN} OR bp.name ILIKE $${sN})`)
  }

  const where = filters.length ? `AND ${filters.join(' AND ')}` : ''
  params.push(limit, offset)

  const { rows } = await query(
    `SELECT po.id, po.order_number, po.status, po.currency, po.is_generic,
            po.generic_supplier, po.expected_date, po.order_type,
            po.subtotal_mxn, po.tax_mxn, po.total_mxn,
            po.created_at, po.approved_at,
            bp.name AS partner_name, bp.rfc AS partner_rfc,
            u.full_name AS created_by_name,
            COUNT(pol.id) AS line_count
     FROM purchase_orders po
     LEFT JOIN business_partners bp ON bp.id = po.partner_id
     LEFT JOIN users u ON u.id = po.created_by
     LEFT JOIN purchase_order_lines pol ON pol.purchase_order_id = po.id
     WHERE po.tenant_id = $1 ${where}
     GROUP BY po.id, bp.id, u.id
     ORDER BY po.created_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  )

  const { rows: countRows } = await query(
    `SELECT COUNT(*) FROM purchase_orders po
     LEFT JOIN business_partners bp ON bp.id = po.partner_id
     WHERE po.tenant_id = $1 ${where}`,
    params.slice(0, params.length - 2)
  )

  return { data: rows, total: parseInt(countRows[0].count, 10), page, limit }
}

/**
 * Detalle de una OC con sus líneas.
 */
async function getOrder({ tenantId, orderId }) {
  const { rows } = await query(
    `SELECT po.*,
            bp.name AS partner_name, bp.rfc, bp.credit_type, bp.credit_days,
            u.full_name AS created_by_name,
            ab.full_name AS approved_by_name
     FROM purchase_orders po
     LEFT JOIN business_partners bp ON bp.id = po.partner_id
     LEFT JOIN users u  ON u.id  = po.created_by
     LEFT JOIN users ab ON ab.id = po.approved_by
     WHERE po.id = $1 AND po.tenant_id = $2`,
    [orderId, tenantId]
  )
  if (rows.length === 0) return null

  const order = rows[0]

  const { rows: lines } = await query(
    `SELECT pol.*,
            COALESCE(rm.name, pt.name)        AS item_name,
            COALESCE(rm.unit, pt.sale_unit)   AS item_unit,
            w.name                            AS warehouse_name,
            COALESCE(
              NULLIF((
                SELECT SUM(srl.quantity_received)
                FROM supplier_receipt_lines srl
                JOIN supplier_receipts sr ON sr.id = srl.supplier_receipt_id
                WHERE srl.purchase_order_line_id = pol.id
                  AND sr.status = 'confirmed'
              ), 0),
              (
                SELECT COALESCE(SUM(srl.quantity_received), 0)
                FROM supplier_receipt_lines srl
                JOIN supplier_receipts sr ON sr.id = srl.supplier_receipt_id
                WHERE srl.purchase_order_line_id IS NULL
                  AND srl.item_id   = pol.item_id
                  AND srl.item_type = pol.item_type
                  AND sr.purchase_order_id = pol.purchase_order_id
                  AND sr.status = 'confirmed'
              )
            )::numeric AS quantity_received
     FROM purchase_order_lines pol
     LEFT JOIN raw_materials rm ON rm.id = pol.item_id AND pol.item_type = 'raw_material'
     LEFT JOIN products      pt ON pt.id = pol.item_id AND pol.item_type = 'product'
     LEFT JOIN warehouses     w ON w.id  = pol.warehouse_id
     WHERE pol.purchase_order_id = $1
     ORDER BY pol.line_number`,
    [orderId]
  )

  // Recepciones vinculadas
  const { rows: receipts } = await query(
    `SELECT sr.id, sr.receipt_number, sr.received_date, sr.status,
            COUNT(srl.id) AS line_count
     FROM supplier_receipts sr
     LEFT JOIN supplier_receipt_lines srl ON srl.supplier_receipt_id = sr.id
     WHERE sr.purchase_order_id = $1
     GROUP BY sr.id
     ORDER BY sr.received_date DESC`,
    [orderId]
  )

  return { ...order, lines, receipts }
}

/**
 * Crea una OC. Soporta OC normal y OC genérica (sin proveedor del catálogo).
 */
async function createOrder({
  tenantId, partnerId, isGeneric = false, genericSupplier,
  currency, lines = [], expectedDate, notes, taxRate,
  userId, ipAddress, userAgent,
}) {
  const order = await withTransaction(async (client) => {
    // Validaciones — partner es opcional (OC sin proveedor definido)
    if (lines.length === 0) throw createError(400, 'Se requiere al menos una línea.')

    // Almacén destino requerido en cada línea NO genérica.
    // Sin él, el cálculo de "en tránsito" no puede asociar la cantidad pendiente
    // a un (item × almacén). Genéricas (sin item_id) quedan exentas.
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i]
      if (!l.isGeneric && l.itemId && !l.warehouseId) {
        throw createError(400, `Línea ${i + 1}: falta seleccionar almacén destino.`)
      }
    }

    // Resolver moneda y TC
    const resolvedCurrency = currency || 'MXN'
    let exchangeRateId = null
    let exchangeRateValue = 1
    if (resolvedCurrency === 'USD') {
      const today = new Date().toISOString().split('T')[0]
      const rate = await getRateForDate({ tenantId, date: today, currency: 'USD' })
      if (!rate) throw createError(400, 'No hay tipo de cambio disponible para hoy. Sincroniza el TC primero.')
      exchangeRateId = rate.id
      exchangeRateValue = parseFloat(rate.rate_mxn)
    }

    const orderNumber = await nextOrderNumber(client, tenantId)

    // Calcular totales (líneas estimadas usan precio tentativo)
    const resolvedTaxRate = (taxRate !== undefined && taxRate !== null) ? parseFloat(taxRate) : 0.16
    let subtotal = 0
    for (const line of lines) {
      const price = line.isEstimated ? (line.estimatedPrice || line.unitPrice || 0) : (line.unitPrice || 0)
      const qty   = line.isEstimated ? (line.estimatedQty  || line.quantity  || 0) : (line.quantity  || 0)
      subtotal += qty * price
    }
    const tax    = subtotal * resolvedTaxRate
    const total  = subtotal + tax
    const factor = resolvedCurrency === 'USD' ? exchangeRateValue : 1

    const { rows } = await client.query(
      `INSERT INTO purchase_orders
         (tenant_id, order_number, partner_id, is_generic, generic_supplier,
          currency, exchange_rate_id, exchange_rate_value,
          subtotal_mxn, tax_mxn, total_mxn,
          expected_date, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       RETURNING *`,
      [tenantId, orderNumber, partnerId || null, isGeneric, genericSupplier || null,
       resolvedCurrency, exchangeRateId, resolvedCurrency === 'USD' ? exchangeRateValue : null,
       subtotal * factor, tax * factor, total * factor,
       expectedDate || null, notes || null, userId]
    )
    const order = rows[0]

    // Insertar líneas
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      await client.query(
        `INSERT INTO purchase_order_lines
           (purchase_order_id, item_type, item_id, description,
            quantity, unit, unit_price, currency,
            is_estimated, estimated_qty, estimated_price,
            is_generic, generic_category,
            warehouse_id, line_number, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
        [order.id,
         line.itemType || null, line.itemId || null, line.description || null,
         line.quantity || 0, line.unit || 'kg', line.unitPrice || 0, resolvedCurrency,
         line.isEstimated || false, line.estimatedQty || null, line.estimatedPrice || null,
         line.isGeneric || false, line.genericCategory || null,
         line.warehouseId || null, i + 1, line.notes || null]
      )
    }

    // Auto-aprender precios del proveedor → la próxima OC se precarga sola.
    // Solo cuando hay proveedor del catálogo (las OC genéricas no tienen a quién
    // atarle el precio). Best-effort dentro de la misma transacción.
    if (partnerId) {
      await supplierPriceService.learnFromLines(client, {
        tenantId, supplierId: partnerId, currency: resolvedCurrency,
        source: 'po', userId,
        lines: lines.map(l => ({
          itemType:  l.itemType,
          itemId:    l.itemId,
          unitPrice: l.isEstimated ? (l.estimatedPrice || l.unitPrice) : l.unitPrice,
          isGeneric: l.isGeneric,
        })),
      })
    }

    await client.query(
      `INSERT INTO document_status_log
         (tenant_id, entity_type, entity_id, from_status, to_status, changed_by)
       VALUES ($1, 'purchase_order', $2, NULL, 'draft', $3)`,
      [tenantId, order.id, userId]
    )

    await audit({
      tenantId, userId, action: 'purchase_order.created',
      resource: 'purchase_orders', resourceId: order.id,
      payload: { orderNumber, partnerId, isGeneric, genericSupplier, total: total * factor },
      ipAddress, userAgent,
    })

    return order
  })

  // Push best-effort (post-commit): avisa a compras de la nueva OC.
  pushService.notify(tenantId, {
    audience: { permission: ['purchases', 'read'] },
    title: 'Nueva orden de compra',
    body: `OC ${order.order_number}`,
    data: { type: 'purchase_order.created', orderId: order.id, route: '/compras/ordenes' },
  }).catch(() => {})

  return order
}

/**
 * Confirma una OC — cambia estatus a sent.
 */
async function confirmOrder({ tenantId, orderId, userId, ipAddress, userAgent }) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `UPDATE purchase_orders
       SET status = 'sent', approved_by = $1, approved_at = NOW()
       WHERE id = $2 AND tenant_id = $3 AND status = 'draft'
       RETURNING id, order_number, status`,
      [userId, orderId, tenantId]
    )
    if (rows.length === 0) throw createError(404, 'OC no encontrada o ya no está en borrador.')

    await client.query(
      `INSERT INTO document_status_log
         (tenant_id, entity_type, entity_id, from_status, to_status, changed_by)
       VALUES ($1, 'purchase_order', $2, 'draft', 'sent', $3)`,
      [tenantId, orderId, userId]
    )

    await audit({
      tenantId, userId, action: 'purchase_order.confirmed',
      resource: 'purchase_orders', resourceId: orderId,
      ipAddress, userAgent,
    })

    return rows[0]
  })
}

/**
 * Cancela una OC — solo en draft o sent.
 */
async function cancelOrder({ tenantId, orderId, reason, userId, ipAddress, userAgent }) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `UPDATE purchase_orders SET status = 'cancelled'
       WHERE id = $1 AND tenant_id = $2 AND status IN ('draft', 'sent')
       RETURNING id, order_number`,
      [orderId, tenantId]
    )
    if (rows.length === 0) throw createError(404, 'OC no encontrada o no se puede cancelar.')

    await client.query(
      `INSERT INTO document_status_log
         (tenant_id, entity_type, entity_id, from_status, to_status, changed_by, notes)
       VALUES ($1, 'purchase_order', $2, 'sent', 'cancelled', $3, $4)`,
      [tenantId, orderId, userId, reason || null]
    )

    await audit({
      tenantId, userId, action: 'purchase_order.cancelled',
      resource: 'purchase_orders', resourceId: orderId,
      payload: { reason }, ipAddress, userAgent,
    })

    return rows[0]
  })
}

/**
 * Edita datos generales de una OC en draft.
 */
async function updateOrder({
  tenantId, orderId, expectedDate, notes, genericSupplier,
  userId, ipAddress, userAgent,
}) {
  const { rows } = await query(
    `UPDATE purchase_orders SET
       expected_date    = COALESCE($1, expected_date),
       notes            = COALESCE($2, notes),
       generic_supplier = COALESCE($3, generic_supplier)
     WHERE id = $4 AND tenant_id = $5 AND status = 'draft'
     RETURNING id, order_number, status, expected_date`,
    [expectedDate || null, notes || null, genericSupplier || null, orderId, tenantId]
  )
  if (rows.length === 0) throw createError(404, 'OC no encontrada o ya no está en borrador.')

  await audit({
    tenantId, userId, action: 'purchase_order.updated',
    resource: 'purchase_orders', resourceId: orderId,
    payload: { expectedDate, genericSupplier },
    ipAddress, userAgent,
  })

  return rows[0]
}

/**
 * Agrega una línea a una OC en draft.
 */
async function addOrderLine({
  tenantId, orderId,
  itemType, itemId, description,
  quantity, unit, unitPrice,
  isEstimated, estimatedQty, estimatedPrice,
  isGeneric, genericCategory,
  warehouseId, notes,
  userId,
}) {
  return withTransaction(async (client) => {
    const { rows: order } = await client.query(
      `SELECT id, currency, exchange_rate_value FROM purchase_orders
       WHERE id = $1 AND tenant_id = $2 AND status = 'draft'`,
      [orderId, tenantId]
    )
    if (order.length === 0) throw createError(404, 'OC no encontrada o ya no está en borrador.')

    if (!isGeneric && itemId && !warehouseId) {
      throw createError(400, 'Falta seleccionar almacén destino para la línea.')
    }

    const { rows: maxLine } = await client.query(
      `SELECT COALESCE(MAX(line_number), 0) AS max FROM purchase_order_lines WHERE purchase_order_id = $1`,
      [orderId]
    )

    const { rows } = await client.query(
      `INSERT INTO purchase_order_lines
         (purchase_order_id, item_type, item_id, description,
          quantity, unit, unit_price, currency,
          is_estimated, estimated_qty, estimated_price,
          is_generic, generic_category,
          warehouse_id, line_number, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       RETURNING *`,
      [orderId,
       itemType || null, itemId || null, description || null,
       quantity || 0, unit || 'kg', unitPrice || 0, order[0].currency,
       isEstimated || false, estimatedQty || null, estimatedPrice || null,
       isGeneric || false, genericCategory || null,
       warehouseId || null, maxLine[0].max + 1, notes || null]
    )

    await recalcOrderTotals(client, orderId)
    return rows[0]
  })
}

/**
 * Edita una línea existente en draft.
 */
async function updateOrderLine({
  tenantId, orderId, lineId,
  quantity, unitPrice, estimatedQty, estimatedPrice, notes,
}) {
  return withTransaction(async (client) => {
    const { rows: order } = await client.query(
      `SELECT id FROM purchase_orders WHERE id = $1 AND tenant_id = $2 AND status = 'draft'`,
      [orderId, tenantId]
    )
    if (order.length === 0) throw createError(404, 'OC no encontrada o ya no está en borrador.')

    const { rows } = await client.query(
      `UPDATE purchase_order_lines SET
         quantity       = COALESCE($1, quantity),
         unit_price     = COALESCE($2, unit_price),
         estimated_qty  = COALESCE($3, estimated_qty),
         estimated_price= COALESCE($4, estimated_price),
         notes          = COALESCE($5, notes)
       WHERE id = $6 AND purchase_order_id = $7 RETURNING *`,
      [quantity || null, unitPrice || null, estimatedQty || null,
       estimatedPrice || null, notes || null, lineId, orderId]
    )
    if (rows.length === 0) throw createError(404, 'Línea no encontrada.')

    await recalcOrderTotals(client, orderId)
    return rows[0]
  })
}

/**
 * Elimina una línea de una OC en draft.
 */
async function deleteOrderLine({ tenantId, orderId, lineId }) {
  return withTransaction(async (client) => {
    const { rows: order } = await client.query(
      `SELECT id FROM purchase_orders WHERE id = $1 AND tenant_id = $2 AND status = 'draft'`,
      [orderId, tenantId]
    )
    if (order.length === 0) throw createError(404, 'OC no encontrada o ya no está en borrador.')

    const { rows } = await client.query(
      `DELETE FROM purchase_order_lines WHERE id = $1 AND purchase_order_id = $2 RETURNING id`,
      [lineId, orderId]
    )
    if (rows.length === 0) throw createError(404, 'Línea no encontrada.')

    await recalcOrderTotals(client, orderId)
    return true
  })
}

/**
 * Recalcula totales de la OC sumando sus líneas.
 * Para líneas estimadas usa estimated_qty y estimated_price si existen.
 */
async function recalcOrderTotals(client, orderId) {
  const { rows: order } = await client.query(
    `SELECT currency, exchange_rate_value FROM purchase_orders WHERE id = $1`, [orderId]
  )
  const factor = order[0].currency === 'USD' ? parseFloat(order[0].exchange_rate_value || 1) : 1

  const { rows } = await client.query(
    `SELECT COALESCE(SUM(
       CASE
         WHEN is_estimated AND estimated_qty IS NOT NULL AND estimated_price IS NOT NULL
           THEN ROUND((estimated_qty * estimated_price)::numeric, 2)
         ELSE subtotal
       END
     ), 0) AS subtotal
     FROM purchase_order_lines WHERE purchase_order_id = $1`,
    [orderId]
  )

  const subtotal = parseFloat(rows[0].subtotal)
  const tax = subtotal * 0.16
  await client.query(
    `UPDATE purchase_orders SET subtotal_mxn = $1, tax_mxn = $2, total_mxn = $3 WHERE id = $4`,
    [subtotal * factor, tax * factor, (subtotal + tax) * factor, orderId]
  )
}

function createError(status, message) {
  const err = new Error(message)
  err.status = status
  return err
}

module.exports = {
  listOrders, getOrder,
  createOrder, updateOrder, confirmOrder, cancelOrder,
  addOrderLine, updateOrderLine, deleteOrderLine,
}
