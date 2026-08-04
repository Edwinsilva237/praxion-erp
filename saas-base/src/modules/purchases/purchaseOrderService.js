'use strict'

const { query, withTransaction } = require('../../db')
const { audit } = require('../../utils/audit')
const pushEvents = require('../push/pushEvents')
const { getRateForDate } = require('../exchange-rates/exchangeRateService')
const documentSeriesService = require('../document-series/documentSeriesService')
const supplierPriceService = require('./supplierPriceService')
const { buildOrderBy } = require('../../utils/sortOrder')
const { enqueueEmail } = require('../../queues/emailQueue')
const { purchaseOrderEmail } = require('../email/templates/sales')
const { generatePurchaseOrderPDF } = require('./purchaseOrderPdfService')
const { normalizeManualEmails, resolveIssuerName } = require('../../utils/emailBroadcast')

const PO_SORT_COLUMNS = {
  folio:     'po.order_number',
  fecha:     'po.created_at',
  proveedor: 'bp.name',
  esperada:  'po.expected_date',
  estatus:   'po.status',
  total:     'po.total_mxn',
}

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
async function listOrders({ tenantId, status, orderType, partnerId, search, from, to, sortBy, sortDir, page = 1, limit = 50 }) {
  const offset = (page - 1) * limit
  const params = [tenantId]
  const filters = []
  const orderBy = buildOrderBy({ sortBy, sortDir, columns: PO_SORT_COLUMNS, defaultKey: 'fecha', tiebreaker: 'po.id DESC' })

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
     ORDER BY ${orderBy}
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
            warehouse_id, line_number, notes, supplier_sku,
            supplier_description, show_internal_ref)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
        [order.id,
         line.itemType || null, line.itemId || null, line.description || null,
         line.quantity || 0, line.unit || 'kg', line.unitPrice || 0, resolvedCurrency,
         line.isEstimated || false, line.estimatedQty || null, line.estimatedPrice || null,
         line.isGeneric || false, line.genericCategory || null,
         line.warehouseId || null, i + 1, line.notes || null,
         (line.supplierSku && String(line.supplierSku).trim()) || null,
         (line.supplierDescription && String(line.supplierDescription).trim()) || null,
         line.showInternalRef !== false]
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
          supplierSku: l.supplierSku || null,
          supplierDescription: l.supplierDescription || null,
          showInternalRef: l.showInternalRef ?? null,
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

  // Push best-effort (post-commit): avisa a compras de la nueva OC (excl. quien la creó).
  pushEvents.purchaseOrderCreated(tenantId, { orderId: order.id, actorUserId: userId })

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
 * Cierra MANUALMENTE la recepción de una OC parcialmente recibida: la da por
 * COMPLETA aunque lo recibido no coincida con lo pedido. Pensado para OC de
 * cantidad estimada (materia prima a granel, ej. plástico) donde el embarque
 * real casi nunca cuadra al kilo y la OC quedaría "abierta" para siempre a la
 * espera de una diferencia que nunca va a llegar.
 *
 * NO mueve inventario ni toca las recepciones ya confirmadas — solo declara que
 * ya no llegará más mercancía contra esta OC (status → 'closed'). Reservado a
 * OC en 'partially_received' (si llegó todo, ya está en 'received'; si no llegó
 * nada, lo correcto es cancelarla).
 */
async function closeOrderReception({ tenantId, orderId, reason, userId, ipAddress, userAgent }) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `UPDATE purchase_orders SET status = 'closed'
       WHERE id = $1 AND tenant_id = $2 AND status = 'partially_received'
       RETURNING id, order_number, status`,
      [orderId, tenantId]
    )
    if (rows.length === 0) {
      throw createError(404, 'OC no encontrada o no está parcialmente recibida.')
    }

    await client.query(
      `INSERT INTO document_status_log
         (tenant_id, entity_type, entity_id, from_status, to_status, changed_by, notes)
       VALUES ($1, 'purchase_order', $2, 'partially_received', 'closed', $3, $4)`,
      [tenantId, orderId, userId, reason || null]
    )

    await audit({
      tenantId, userId, action: 'purchase_order.reception_closed',
      resource: 'purchase_orders', resourceId: orderId,
      payload: { reason }, ipAddress, userAgent,
    })

    return rows[0]
  })
}

/**
 * Edita una OC en draft. Dos modos según el body:
 *  - Parcial (sin `lines`): expectedDate / notes / genericSupplier con COALESCE.
 *  - Completo (con `lines`): el "Editar borrador" del formulario de OC —
 *    actualiza proveedor, moneda, IVA y REEMPLAZA todas las líneas (un draft
 *    no tiene recepciones ligadas, así que el reemplazo es seguro).
 */
async function updateOrder({
  tenantId, orderId,
  partnerId, isGeneric, genericSupplier,
  currency, taxRate, expectedDate, notes, lines,
  userId, ipAddress, userAgent,
}) {
  const fullEdit = Array.isArray(lines)
  if (fullEdit && lines.length === 0) throw createError(400, 'Se requiere al menos una línea.')

  return withTransaction(async (client) => {
    const { rows: existing } = await client.query(
      `SELECT * FROM purchase_orders
       WHERE id = $1 AND tenant_id = $2 AND status = 'draft'
       FOR UPDATE`,
      [orderId, tenantId]
    )
    if (existing.length === 0) throw createError(404, 'OC no encontrada o ya no está en borrador.')
    const prev = existing[0]

    if (!fullEdit) {
      const { rows } = await client.query(
        `UPDATE purchase_orders SET
           expected_date    = COALESCE($1, expected_date),
           notes            = COALESCE($2, notes),
           generic_supplier = COALESCE($3, generic_supplier)
         WHERE id = $4 AND tenant_id = $5
         RETURNING id, order_number, status, expected_date`,
        [expectedDate || null, notes || null, genericSupplier || null, orderId, tenantId]
      )

      await audit({
        tenantId, userId, action: 'purchase_order.updated',
        resource: 'purchase_orders', resourceId: orderId,
        payload: { expectedDate, genericSupplier },
        ipAddress, userAgent,
      })

      return rows[0]
    }

    // ── Edición completa ────────────────────────────────────────────────────
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i]
      if (!l.isGeneric && l.itemId && !l.warehouseId) {
        throw createError(400, `Línea ${i + 1}: falta seleccionar almacén destino.`)
      }
    }

    // Moneda y TC: al cambiar (o entrar) a USD se resuelve el TC oficial de hoy,
    // igual que en createOrder. Si ya estaba en USD se conserva el TC original.
    const resolvedCurrency = currency || prev.currency || 'MXN'
    let exchangeRateId = prev.exchange_rate_id
    let exchangeRateValue = parseFloat(prev.exchange_rate_value || 1)
    if (resolvedCurrency === 'USD') {
      if (prev.currency !== 'USD' || !prev.exchange_rate_id) {
        const today = new Date().toISOString().split('T')[0]
        const rate = await getRateForDate({ tenantId, date: today, currency: 'USD' })
        if (!rate) throw createError(400, 'No hay tipo de cambio disponible para hoy. Sincroniza el TC primero.')
        exchangeRateId = rate.id
        exchangeRateValue = parseFloat(rate.rate_mxn)
      }
    } else {
      exchangeRateId = null
      exchangeRateValue = 1
    }

    const resolvedTaxRate = (taxRate !== undefined && taxRate !== null)
      ? parseFloat(taxRate)
      : (parseFloat(prev.tax_mxn || 0) > 0 ? 0.16 : 0)

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
      `UPDATE purchase_orders SET
         partner_id          = $1,
         is_generic          = $2,
         generic_supplier    = $3,
         currency            = $4,
         exchange_rate_id    = $5,
         exchange_rate_value = $6,
         subtotal_mxn        = $7,
         tax_mxn             = $8,
         total_mxn           = $9,
         expected_date       = $10,
         notes               = $11
       WHERE id = $12 AND tenant_id = $13
       RETURNING *`,
      [partnerId !== undefined ? (partnerId || null) : prev.partner_id,
       isGeneric !== undefined ? !!isGeneric : prev.is_generic,
       genericSupplier !== undefined ? (genericSupplier || null) : prev.generic_supplier,
       resolvedCurrency, exchangeRateId, resolvedCurrency === 'USD' ? exchangeRateValue : null,
       subtotal * factor, tax * factor, total * factor,
       expectedDate !== undefined ? (expectedDate || null) : prev.expected_date,
       notes !== undefined ? (notes || null) : prev.notes,
       orderId, tenantId]
    )
    const order = rows[0]

    await client.query(
      `DELETE FROM purchase_order_lines WHERE purchase_order_id = $1`, [orderId]
    )
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      await client.query(
        `INSERT INTO purchase_order_lines
           (purchase_order_id, item_type, item_id, description,
            quantity, unit, unit_price, currency,
            is_estimated, estimated_qty, estimated_price,
            is_generic, generic_category,
            warehouse_id, line_number, notes, supplier_sku,
            supplier_description, show_internal_ref)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
        [orderId,
         line.itemType || null, line.itemId || null, line.description || null,
         line.quantity || 0, line.unit || 'kg', line.unitPrice || 0, resolvedCurrency,
         line.isEstimated || false, line.estimatedQty || null, line.estimatedPrice || null,
         line.isGeneric || false, line.genericCategory || null,
         line.warehouseId || null, i + 1, line.notes || null,
         (line.supplierSku && String(line.supplierSku).trim()) || null,
         (line.supplierDescription && String(line.supplierDescription).trim()) || null,
         line.showInternalRef !== false]
      )
    }

    // Re-aprender precios del proveedor con las líneas editadas (best-effort).
    if (order.partner_id) {
      await supplierPriceService.learnFromLines(client, {
        tenantId, supplierId: order.partner_id, currency: resolvedCurrency,
        source: 'po', userId,
        lines: lines.map(l => ({
          itemType:  l.itemType,
          itemId:    l.itemId,
          unitPrice: l.isEstimated ? (l.estimatedPrice || l.unitPrice) : l.unitPrice,
          isGeneric: l.isGeneric,
          supplierSku: l.supplierSku || null,
          supplierDescription: l.supplierDescription || null,
          showInternalRef: l.showInternalRef ?? null,
        })),
      })
    }

    await audit({
      tenantId, userId, action: 'purchase_order.updated',
      resource: 'purchase_orders', resourceId: orderId,
      payload: { orderNumber: order.order_number, fullEdit: true, total: total * factor },
      ipAddress, userAgent,
    })

    return order
  })
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
  warehouseId, notes, supplierSku, supplierDescription, showInternalRef,
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
          warehouse_id, line_number, notes, supplier_sku,
          supplier_description, show_internal_ref)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
       RETURNING *`,
      [orderId,
       itemType || null, itemId || null, description || null,
       quantity || 0, unit || 'kg', unitPrice || 0, order[0].currency,
       isEstimated || false, estimatedQty || null, estimatedPrice || null,
       isGeneric || false, genericCategory || null,
       warehouseId || null, maxLine[0].max + 1, notes || null,
       (supplierSku && String(supplierSku).trim()) || null,
       (supplierDescription && String(supplierDescription).trim()) || null,
       showInternalRef !== false]
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
  quantity, unitPrice, estimatedQty, estimatedPrice, notes, supplierSku,
  supplierDescription, showInternalRef,
}) {
  return withTransaction(async (client) => {
    const { rows: order } = await client.query(
      `SELECT id FROM purchase_orders WHERE id = $1 AND tenant_id = $2 AND status = 'draft'`,
      [orderId, tenantId]
    )
    if (order.length === 0) throw createError(404, 'OC no encontrada o ya no está en borrador.')

    // notes / supplier_sku / supplier_description / show_internal_ref usan un
    // centinela: undefined = no tocar; valor (incl. vacío) = fijar/limpiar. Así
    // editar la línea SÍ puede borrar una nota/clave, sin que COALESCE la
    // conserve para siempre.
    const { rows } = await client.query(
      `UPDATE purchase_order_lines SET
         quantity       = COALESCE($1, quantity),
         unit_price     = COALESCE($2, unit_price),
         estimated_qty  = COALESCE($3, estimated_qty),
         estimated_price= COALESCE($4, estimated_price),
         notes          = CASE WHEN $5::boolean THEN $6 ELSE notes END,
         supplier_sku   = CASE WHEN $7::boolean THEN $8 ELSE supplier_sku END,
         supplier_description = CASE WHEN $9::boolean  THEN $10 ELSE supplier_description END,
         show_internal_ref    = CASE WHEN $11::boolean THEN $12::boolean ELSE show_internal_ref END
       WHERE id = $13 AND purchase_order_id = $14 RETURNING *`,
      [quantity || null, unitPrice || null, estimatedQty || null, estimatedPrice || null,
       notes !== undefined, notes !== undefined ? (notes || null) : null,
       supplierSku !== undefined, supplierSku !== undefined ? ((supplierSku && String(supplierSku).trim()) || null) : null,
       supplierDescription !== undefined, supplierDescription !== undefined ? ((supplierDescription && String(supplierDescription).trim()) || null) : null,
       showInternalRef !== undefined && showInternalRef !== null, (showInternalRef !== undefined && showInternalRef !== null) ? showInternalRef !== false : null,
       lineId, orderId]
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

/**
 * Contactos del proveedor de la OC (para el modal "Enviar correo").
 * Devuelve null si la OC no existe; para OC genérica (sin proveedor del
 * catálogo) devuelve listas vacías — el operador captura correos manuales.
 */
async function listSupplierContacts({ tenantId, orderId }) {
  const { rows: o } = await query(
    `SELECT partner_id FROM purchase_orders WHERE id = $1 AND tenant_id = $2`,
    [orderId, tenantId]
  )
  if (!o[0]) return null
  if (!o[0].partner_id) return { contacts: [], defaultRecipients: [] }

  const { rows: contacts } = await query(
    `SELECT bpc.id, bpc.name, bpc.position, bpc.email, bpc.phone, bpc.is_primary
       FROM business_partner_contacts bpc
       JOIN business_partners bp ON bp.id = bpc.business_partner_id
      WHERE bpc.business_partner_id = $1 AND bp.tenant_id = $2
      ORDER BY bpc.is_primary DESC NULLS LAST, bpc.created_at ASC`,
    [o[0].partner_id, tenantId]
  )
  return { contacts, defaultRecipients: contacts.filter(c => c.email).map(c => c.email) }
}

/**
 * Envía la OC por correo al proveedor con el PDF adjunto.
 *
 * - `emails`: destinatarios elegidos por el operador. Si viene vacío, se usan
 *   todos los contactos con correo del proveedor.
 * - Una OC en BORRADOR se confirma antes de enviarse (mismo criterio que
 *   cotizaciones: lo que el proveedor ya recibió no debe seguir editable).
 *   Si después el correo falla, la confirmación se queda — el operador ve el
 *   error accionable y puede reenviar sin recapturar nada.
 * - BCC/reply-to al correo institucional del tenant (o del usuario) para que
 *   la respuesta del proveedor llegue a una bandeja real.
 */
async function sendOrderEmail({ tenantId, orderId, emails, userId, ipAddress, userAgent }) {
  const order = await getOrder({ tenantId, orderId })
  if (!order) throw createError(404, 'OC no encontrada.')
  if (order.status === 'cancelled') {
    throw createError(409, 'No se puede enviar por correo una OC cancelada.')
  }

  let recipients = normalizeManualEmails(emails)
  if (recipients.length === 0 && order.partner_id) {
    const res = await listSupplierContacts({ tenantId, orderId })
    recipients = res?.defaultRecipients || []
  }
  if (recipients.length === 0) {
    throw createError(400, 'No hay destinatarios: el proveedor no tiene contactos con correo. Escribe al menos un correo válido.')
  }

  if (order.status === 'draft') {
    await confirmOrder({ tenantId, orderId, userId, ipAddress, userAgent })
  }

  // BCC/reply-to: correo institucional del tenant, o el del usuario logueado.
  const { rows: trows } = await query(
    `SELECT notification_email, brand_color_primary FROM tenants WHERE id = $1`,
    [tenantId]
  )
  let senderEmail = trows[0]?.notification_email || null
  if (!senderEmail && userId) {
    const { rows: u } = await query(
      `SELECT email FROM users WHERE id = $1 AND tenant_id = $2`,
      [userId, tenantId]
    )
    senderEmail = u[0]?.email || null
  }
  if (senderEmail && recipients.includes(senderEmail.toLowerCase())) senderEmail = null

  const tenantName = await resolveIssuerName(tenantId)
  const pdfBuffer  = await generatePurchaseOrderPDF({ tenantId, orderId })
  const html = purchaseOrderEmail({
    tenantName,
    brandColor:   trows[0]?.brand_color_primary || null,
    supplierName: order.partner_name || order.generic_supplier || 'proveedor',
    docNumber:    order.order_number,
    total:        order.total_mxn,
    currency:     order.currency,
    issueDate:    order.created_at,
    expectedDate: order.expected_date,
    notes:        order.notes,
  })

  await enqueueEmail({
    tenantId, // habilita la alerta email_delivery_failed si rebota definitivo
    to:       recipients,
    bcc:      senderEmail || undefined,
    replyTo:  senderEmail || undefined,
    subject:  `Orden de compra ${order.order_number} — ${tenantName}`,
    html,
    fromName: tenantName,
    attachments: [{
      filename:    `${order.order_number}.pdf`,
      content:     pdfBuffer,
      contentType: 'application/pdf',
    }],
  })

  await audit({
    tenantId, userId, ipAddress, userAgent,
    action: 'purchase_order.emailed', resource: 'purchase_orders', resourceId: orderId,
    payload: { recipients, bcc: senderEmail || null },
  })

  const refreshed = await getOrder({ tenantId, orderId })
  return { ...refreshed, email: { sent: true, recipients, bcc: senderEmail } }
}

module.exports = {
  listOrders, getOrder,
  createOrder, updateOrder, confirmOrder, cancelOrder, closeOrderReception,
  addOrderLine, updateOrderLine, deleteOrderLine,
  listSupplierContacts, sendOrderEmail,
}
