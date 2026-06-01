'use strict'

const path = require('path')
const { query, withTransaction } = require('../../db')
const { audit } = require('../../utils/audit')
const storage = require('../../utils/storage')
const { getRateForDate } = require('../exchange-rates/exchangeRateService')
const { recalcOrderStatusFromDeliveries } = require('./orderService')
const { recordMovement } = require('../inventory/inventoryService')
const { enqueueEmail } = require('../../queues/emailQueue')
const documentSeriesService = require('../document-series/documentSeriesService')
const { remisionEmail } = require('../email/templates/sales')
const { generateRemisionPDF } = require('./remisionPdfService')
const logger = require('../../config/logger')

/**
 * Resuelve el almacén origen para una línea de salida.
 * Prioridad: warehouseId explícito → almacén default del tipo del producto →
 * almacén del tipo alterno (finished_product ↔ resale) si el preferido no
 * está configurado activo.
 *
 * El fallback entre tipos es útil cuando el tenant no separa físicamente
 * productos propios y de reventa — ambos viven en el mismo almacén.
 */
async function resolveWarehouseForLine(client, tenantId, warehouseId, productType) {
  if (warehouseId) return warehouseId
  const preferred = productType === 'resale' ? 'resale' : 'finished_product'
  const fallback  = preferred === 'resale' ? 'finished_product' : 'resale'

  const { rows } = await client.query(
    `SELECT id, type FROM warehouses
      WHERE tenant_id = $1 AND type = ANY($2::warehouse_type[]) AND is_active = true
      ORDER BY (type = $3) DESC, is_default DESC, created_at ASC, id ASC LIMIT 1`,
    [tenantId, [preferred, fallback], preferred]
  )
  if (!rows[0]) {
    throw createError(500,
      `No hay almacén activo tipo '${preferred}' ni '${fallback}' para descontar la salida.`)
  }
  return rows[0].id
}

/**
 * Genera número de remisión automáticamente.
 *
 * Si el tenant tiene serie configurada para 'delivery_note' (venta) o
 * 'sales_return' (devolución), la usa. Si no, cae al legacy
 * `REM-YYYYMM-NNNN` / `REC-YYYYMM-NNNN`.
 */
async function nextNoteNumber(client, tenantId, type, opts = {}) {
  const entityType = type === 'sale' ? 'delivery_note' : 'sales_return'
  const result = await documentSeriesService.generateDocumentNumber({
    client, tenantId, entityType, opts,
  })
  if (result) return result.docNumber

  const prefix = type === 'sale' ? 'REM' : 'REC'
  const ym = new Date().toISOString().slice(0, 7).replace('-', '')
  const pref = `${prefix}-${ym}-`
  const { rows } = await client.query(
    `SELECT document_number FROM delivery_notes
     WHERE tenant_id = $1 AND document_number LIKE $2
     ORDER BY document_number DESC LIMIT 1`,
    [tenantId, `${pref}%`]
  )
  const last = rows[0]?.document_number
  const seq = last ? parseInt(last.split('-')[2], 10) + 1 : 1
  return `${pref}${String(seq).padStart(4, '0')}`
}

/**
 * Crea una remisión de venta. Acepta uno o varios pedidos del mismo cliente.
 *
 * Parámetros:
 *   - `salesOrderId`  (legacy single): conserva compat con clientes que mandan
 *     un solo pedido y `lines` opcional.
 *   - `salesOrderIds` (multi):         array de pedidos a consolidar.
 *   - `lines`: opcional. Si se pasa, cada línea debe declarar `salesOrderId`
 *     (a qué pedido pertenece) y opcionalmente `salesOrderLineId`. Si NO se
 *     pasa, debe ser single y se cargan automáticamente todas las líneas del
 *     pedido.
 *
 * Validaciones para multi:
 *   - Todos los pedidos deben pertenecer al mismo cliente.
 *   - Misma moneda.
 *   - Mismo `delivery_address_id`.
 *   - Todos en estado elegible (confirmed / in_delivery / partially_delivered).
 */
async function createDeliveryNote({ tenantId, salesOrderId, salesOrderIds, lines, notes, userId, ipAddress, userAgent }) {
  const orderIds = (Array.isArray(salesOrderIds) && salesOrderIds.length)
    ? [...new Set(salesOrderIds)]
    : (salesOrderId ? [salesOrderId] : [])
  if (!orderIds.length) throw createError(400, 'Se requiere al menos un pedido (salesOrderId o salesOrderIds).')

  return withTransaction(async (client) => {
    // Obtener todos los pedidos elegibles con preferencias del cliente.
    // Status 'invoiced' es válido para soportar facturación anticipada:
    // el pedido se factura completo y se entrega en remisiones parciales.
    const { rows: orderRows } = await client.query(
      `SELECT so.*, bp.credit_days, bp.credit_type, bp.requires_po,
              bp.billing_notes, bp.cfdi_use, bp.payment_method, bp.payment_form
       FROM sales_orders so
       JOIN business_partners bp ON bp.id = so.partner_id
       WHERE so.tenant_id = $1 AND so.id = ANY($2::uuid[])
         AND so.status IN ('confirmed', 'in_delivery', 'partially_delivered', 'invoiced')`,
      [tenantId, orderIds]
    )
    if (orderRows.length !== orderIds.length) {
      throw createError(404,
        'Uno o más pedidos no se encontraron o no son elegibles (debe estar confirmado, en reparto, parcial o facturado por adelantado).')
    }

    // Validaciones de consolidación (no-op para single)
    if (orderIds.length > 1) {
      const partnerIds = new Set(orderRows.map(o => o.partner_id))
      if (partnerIds.size > 1) throw createError(409, 'Los pedidos seleccionados son de clientes distintos.')

      const currencies = new Set(orderRows.map(o => o.currency))
      if (currencies.size > 1) throw createError(409, 'Los pedidos seleccionados tienen monedas distintas.')

      const addresses = new Set(orderRows.map(o => o.delivery_address_id || '__none__'))
      if (addresses.size > 1) {
        throw createError(409, 'Los pedidos seleccionados tienen domicilios de entrega distintos.')
      }
    }

    // El pedido "principal" (representativo) — primero por orden de creación
    // para que `delivery_notes.sales_order_id` apunte al más antiguo. Mantiene
    // compat con queries que JOIN por `dn.sales_order_id`.
    orderRows.sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
    const primary = orderRows[0]
    const orderById = Object.fromEntries(orderRows.map(o => [o.id, o]))

    // TC del día si es USD (un solo TC para toda la remisión consolidada)
    let exchangeRateId = primary.exchange_rate_id
    let exchangeRateValue = primary.exchange_rate_value || 1
    if (primary.currency === 'USD') {
      const today = new Date().toISOString().split('T')[0]
      const rate = await getRateForDate({ tenantId, date: today, currency: 'USD' })
      if (rate) { exchangeRateId = rate.id; exchangeRateValue = parseFloat(rate.rate_mxn) }
    }

    // Fecha de vencimiento desde la remisión (basada en credit_days del cliente)
    const issueDate = new Date().toISOString().split('T')[0]
    let dueDate = null
    if (primary.credit_type === 'credit' && primary.credit_days > 0) {
      const due = new Date()
      due.setDate(due.getDate() + primary.credit_days)
      dueDate = due.toISOString().split('T')[0]
    }

    // Resolver líneas a remisionar.
    let resolvedLines
    if (lines && lines.length) {
      resolvedLines = lines.map(l => ({
        ...l,
        salesOrderId: l.salesOrderId || (orderIds.length === 1 ? orderIds[0] : null),
      }))
      // En multi, exigir que cada línea diga de qué pedido viene
      if (orderIds.length > 1 && resolvedLines.some(l => !l.salesOrderId)) {
        throw createError(400, 'En remisión multi-pedido cada línea debe declarar salesOrderId.')
      }
      // Validar que todos los salesOrderId de líneas pertenezcan a los pedidos cargados
      for (const l of resolvedLines) {
        if (l.salesOrderId && !orderById[l.salesOrderId]) {
          throw createError(400, `La línea referencia un salesOrderId no incluido en la lista de pedidos.`)
        }
      }
    } else if (orderIds.length === 1) {
      const auto = await getOrderLines(client, orderIds[0])
      resolvedLines = auto.map(l => ({ ...l, salesOrderId: orderIds[0] }))
    } else {
      throw createError(400, 'En remisión multi-pedido las líneas son obligatorias.')
    }

    // Validación de saldo por línea de pedido.
    // Para cada (sales_order_line), calculamos:
    //   - facturado: SUM(invoice_lines.quantity) en facturas no canceladas.
    //   - entregado: SUM(delivery_note_lines.quantity_delivered) en remisiones
    //     no canceladas (excluye la actual que aún no existe).
    //
    // Si HAY factura por esa línea: el máximo a entregar = facturado - entregado.
    // Si NO hay factura (flujo tradicional): max = qty_pedida - entregado.
    const solIds = [...new Set(resolvedLines
      .map(l => l.salesOrderLineId)
      .filter(Boolean))]
    let balanceBySol = {}
    if (solIds.length) {
      const { rows: balRows } = await client.query(
        `SELECT sol.id,
                sol.quantity                              AS ordered,
                COALESCE(SUM(DISTINCT il.quantity) FILTER (
                  WHERE inv.status <> 'cancelled'
                ), 0)                                     AS invoiced,
                COALESCE((
                  SELECT SUM(dnl.quantity_delivered)
                    FROM delivery_note_lines dnl
                    JOIN delivery_notes dn ON dn.id = dnl.delivery_note_id
                   WHERE dnl.sales_order_line_id = sol.id
                     AND dn.status <> 'cancelled'
                ), 0)                                     AS delivered
           FROM sales_order_lines sol
           LEFT JOIN invoice_lines il ON il.sales_order_line_id = sol.id
           LEFT JOIN invoices inv     ON inv.id = il.invoice_id
          WHERE sol.id = ANY($1::uuid[])
          GROUP BY sol.id, sol.quantity`,
        [solIds]
      )
      balanceBySol = Object.fromEntries(balRows.map(r => [r.id, r]))
    }
    for (const line of resolvedLines) {
      if (!line.salesOrderLineId) continue
      const bal = balanceBySol[line.salesOrderLineId]
      if (!bal) continue
      const ordered  = parseFloat(bal.ordered)
      const invoiced = parseFloat(bal.invoiced)
      const delivered = parseFloat(bal.delivered)
      const newQty   = parseFloat(line.quantityDelivered)
      const cap      = invoiced > 0 ? invoiced : ordered
      const remaining = +(cap - delivered).toFixed(4)
      if (newQty - remaining > 0.0001) {
        const ctx = invoiced > 0 ? `facturado (${cap})` : `pedido (${cap})`
        throw createError(409,
          `Línea excede el saldo por entregar: pides ${newQty}, queda ${remaining} del ${ctx}.`)
      }
    }

    // Totales
    //
    // NOTA FISCAL: las remisiones NO llevan IVA (igual que los pedidos).
    // El IVA se calcula en `invoiceService` cuando la remisión se factura
    // (createFromRemissions). Convención B2B: precios "+ IVA" — el cliente
    // paga el IVA al recibir el CFDI, no la remisión.
    // Los campos tax_mxn / total_mxn se conservan: tax_mxn = 0, total_mxn = subtotal.
    let subtotal = 0
    for (const line of resolvedLines) {
      subtotal += line.quantityDelivered * line.unitPrice * (1 - (line.discountPct || 0) / 100)
    }
    const tax = 0
    const total = subtotal
    const factor = primary.currency === 'USD' ? exchangeRateValue : 1

    // Número de remisión
    const docNumber = await nextNoteNumber(client, tenantId, 'sale')

    // Crear remisión. `sales_order_id` apunta al pedido principal (compat).
    const { rows } = await client.query(
      `INSERT INTO delivery_notes
         (tenant_id, type, document_number, partner_id, sales_order_id,
          delivery_address_id, currency, exchange_rate_id, exchange_rate_value,
          subtotal_mxn, tax_mxn, total_mxn, issue_date, credit_due_date,
          notes, created_by)
       VALUES ($1,'sale',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       RETURNING *`,
      [tenantId, docNumber, primary.partner_id, primary.id,
       primary.delivery_address_id, primary.currency, exchangeRateId, exchangeRateValue,
       subtotal * factor, tax * factor, total * factor,
       issueDate, dueDate, notes || null, userId]
    )
    const note = rows[0]

    // Insertar líneas — cada una recuerda su pedido origen.
    for (let i = 0; i < resolvedLines.length; i++) {
      const line = resolvedLines[i]
      const packFactor = line.packFactor != null ? parseFloat(line.packFactor) : 1
      const qtyBase    = parseFloat(line.quantityDelivered) * packFactor
      await client.query(
        `INSERT INTO delivery_note_lines
           (delivery_note_id, product_id, quantity_ordered, quantity_delivered,
            unit, unit_price, currency, discount_pct, line_number, notes,
            original_unit_price, original_currency, applied_exchange_rate,
            applied_exchange_rate_date,
            pack_option_id, pack_factor, quantity_base,
            warehouse_id,
            sales_order_id, sales_order_line_id,
            product_lot_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`,
        [note.id, line.productId, line.quantityOrdered || line.quantityDelivered,
         line.quantityDelivered, line.unit || 'paquete', line.unitPrice,
         primary.currency, line.discountPct || 0, i + 1, line.notes || null,
         line.originalUnitPrice != null ? line.originalUnitPrice : null,
         line.originalCurrency  || null,
         line.appliedExchangeRate != null ? line.appliedExchangeRate : null,
         line.appliedExchangeRateDate || null,
         line.packOptionId || null, packFactor, qtyBase,
         line.warehouseId || null,
         line.salesOrderId || null,
         line.salesOrderLineId || null,
         line.productLotId || null]
      )
    }

    // Recalcular status de TODOS los pedidos afectados (no solo el principal).
    const affectedOrderIds = [...new Set(resolvedLines.map(l => l.salesOrderId).filter(Boolean))]
    for (const oid of affectedOrderIds) {
      await recalcOrderStatusFromDeliveries(client, { tenantId, orderId: oid })
    }

    // Log de estatus de la remisión
    await client.query(
      `INSERT INTO document_status_log
         (tenant_id, entity_type, entity_id, from_status, to_status, changed_by)
       VALUES ($1, 'delivery_note', $2, NULL, 'issued', $3)`,
      [tenantId, note.id, userId]
    )

    await audit({
      tenantId, userId, action: 'delivery_note.created',
      resource: 'delivery_notes', resourceId: note.id,
      payload: { docNumber, salesOrderIds: affectedOrderIds, total: total * factor },
      ipAddress, userAgent,
    })

    return note
  })
}

/**
 * Lista remisiones con filtros.
 */
async function listDeliveryNotes({ tenantId, type, status, partnerId, from, to, invoiceable, page = 1, limit = 50 }) {
  const offset = (page - 1) * limit
  const params = [tenantId]
  const filters = []

  if (type)      { params.push(type);      filters.push(`dn.type = $${params.length}`) }
  if (status)    { params.push(status);    filters.push(`dn.status = $${params.length}`) }
  if (partnerId) { params.push(partnerId); filters.push(`dn.partner_id = $${params.length}`) }
  if (from)      { params.push(from);      filters.push(`dn.issue_date >= $${params.length}`) }
  if (to)        { params.push(to);        filters.push(`dn.issue_date <= $${params.length}`) }

  // Filtro "facturable": entregada, sin marca de "no requiere factura"
  // y con al menos una línea sin facturar (permite split de remisiones donde
  // ya hay una factura activa cubriendo otras líneas).
  if (invoiceable) {
    filters.push(`dn.status = 'delivered'`)
    filters.push(`dn.no_invoice = false`)
    filters.push(`EXISTS (
      SELECT 1 FROM delivery_note_lines dnl
       WHERE dnl.delivery_note_id = dn.id
         AND NOT EXISTS (
           SELECT 1 FROM invoice_lines il
            JOIN invoices iv ON iv.id = il.invoice_id
            WHERE il.delivery_note_line_id = dnl.id AND iv.status <> 'cancelled'
         )
    )`)
  }

  const where = filters.length ? `AND ${filters.join(' AND ')}` : ''

  params.push(limit, offset)

  const { rows } = await query(
    `SELECT dn.id, dn.type, dn.document_number, dn.status, dn.currency,
            dn.total_mxn, dn.issue_date, dn.credit_due_date,
            dn.receiver_name, dn.delivered_at, dn.synced_at,
            dn.no_invoice, dn.partner_id,
            bp.name AS partner_name, bp.tax_name AS partner_tax_name,
            so.order_number,
            so.po_number AS sales_order_po,
            inv.id AS invoice_id,
            inv.document_number AS invoice_number,
            inv.status AS invoice_status
     FROM delivery_notes dn
     JOIN business_partners bp ON bp.id = dn.partner_id
     LEFT JOIN sales_orders so ON so.id = dn.sales_order_id
     LEFT JOIN invoices inv ON inv.delivery_note_id = dn.id AND inv.status <> 'cancelled'
     WHERE dn.tenant_id = $1 ${where}
     ORDER BY ${invoiceable ? 'bp.name ASC, dn.delivered_at DESC NULLS LAST,' : ''}
              dn.issue_date DESC, dn.document_number DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  )

  const { rows: countRows } = await query(
    `SELECT COUNT(*) FROM delivery_notes dn WHERE dn.tenant_id = $1 ${where}`,
    params.slice(0, params.length - 2)
  )

  return { data: rows, total: parseInt(countRows[0].count, 10), page, limit }
}

/**
 * Detalle de una remisión.
 */
async function getDeliveryNote({ tenantId, noteId }) {
  const { rows } = await query(
    `SELECT dn.*, bp.name AS partner_name, bp.rfc, bp.billing_notes,
            bp.cfdi_use, bp.payment_method, bp.payment_form,
            da.alias AS address_alias, da.address AS delivery_address,
            da.city AS delivery_city, da.state AS delivery_state,
            so.order_number,
            inv.id AS invoice_id,
            inv.document_number AS invoice_number,
            inv.status AS invoice_status
     FROM delivery_notes dn
     JOIN business_partners bp ON bp.id = dn.partner_id
     LEFT JOIN sales_orders so ON so.id = dn.sales_order_id
     LEFT JOIN delivery_addresses da ON da.id = dn.delivery_address_id
     LEFT JOIN invoices inv ON inv.delivery_note_id = dn.id AND inv.status <> 'cancelled'
     WHERE dn.id = $1 AND dn.tenant_id = $2`,
    [noteId, tenantId]
  )
  if (rows.length === 0) return null

  const note = rows[0]
  // Cada línea reporta si está facturada en alguna factura activa (split-aware).
  const { rows: lines } = await query(
    `SELECT dnl.*, p.sku, p.name AS product_name,
            (SELECT a.id FROM attachments a
              WHERE a.entity_type = 'product' AND a.entity_id = p.id
                AND a.category = 'image'
              ORDER BY a.created_at DESC LIMIT 1) AS image_attachment_id,
            iv.id              AS invoice_id,
            iv.document_number AS invoice_number,
            iv.status          AS invoice_status,
            iv.use_cfdi        AS invoice_use_cfdi
     FROM delivery_note_lines dnl
     JOIN products p ON p.id = dnl.product_id
     LEFT JOIN invoice_lines il ON il.delivery_note_line_id = dnl.id
     LEFT JOIN invoices iv ON iv.id = il.invoice_id AND iv.status <> 'cancelled'
     WHERE dnl.delivery_note_id = $1 ORDER BY dnl.line_number`,
    [noteId]
  )

  // Contactos del cliente con email (para prellenar destinatarios al enviar por correo)
  const { rows: contacts } = await query(
    `SELECT id, name, email, is_primary
       FROM business_partner_contacts
      WHERE business_partner_id = $1
      ORDER BY is_primary DESC NULLS LAST, id ASC`,
    [note.partner_id]
  )

  return { ...note, lines, contacts }
}

/**
 * Registra la entrega — captura foto del documento firmado y nombre del receptor.
 * Funciona offline: si no hay internet la foto se guarda localmente y synced_at queda NULL.
 */
async function recordDelivery({
  tenantId, noteId, receiverName, photoBuffer, photoFilename,
  userId, ipAddress, userAgent,
  // isComplete: legacy param. Si llega false desde un cliente viejo se ignora —
  // a partir de la simplificación de UX, registrar entrega = entrega completa.
}) {
  if (!receiverName) throw createError(400, 'El nombre del receptor es requerido.')

  // Guardar foto en object storage (R2) o disco local en dev.
  let photoPath = null
  if (photoBuffer) {
    const ext = path.extname(photoFilename || '.jpg') || '.jpg'
    const key = `delivery/${tenantId}/${noteId}${ext}`
    const mime = ext === '.png' ? 'image/png'
               : ext === '.webp' ? 'image/webp'
               : 'image/jpeg'
    await storage.put(key, photoBuffer, { contentType: mime })
    photoPath = key
  }

  const newStatus = 'delivered'
  const now = new Date().toISOString()

  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `UPDATE delivery_notes SET
         status             = $1,
         receiver_name      = $2,
         receiver_photo_path= $3,
         delivered_at       = $4,
         delivered_by       = $5,
         synced_at          = $4
       WHERE id = $6 AND tenant_id = $7
         AND status IN ('issued','sent_by_email','partially_delivered')
       RETURNING id, document_number, status, total_mxn, partner_id, credit_due_date, sales_order_id`,
      [newStatus, receiverName, photoPath, now, userId, noteId, tenantId]
    )
    if (rows.length === 0) throw createError(404, 'Remisión no encontrada o ya entregada.')
    const note = rows[0]

    // Log de estatus
    await client.query(
      `INSERT INTO document_status_log
         (tenant_id, entity_type, entity_id, from_status, to_status, changed_by, metadata)
       VALUES ($1, 'delivery_note', $2, 'issued', $3, $4, $5)`,
      [tenantId, noteId, newStatus, userId,
       JSON.stringify({ receiverName, hasPhoto: !!photoPath })]
    )

    // Descontar inventario por cada línea — usa quantity_base (unidad atómica
    // del producto, ver migración 074) y warehouse_id de la línea (default por
    // tipo de producto si no se especificó). validateStock=false permite
    // dejar negativo si falta entrada en captura.
    // Si la línea tiene product_lot_id (uses_lots=true), también descontamos
    // del saldo del lote para mantener trazabilidad.
    const { rows: linesForStock } = await client.query(
      `SELECT dnl.id, dnl.product_id, dnl.quantity_base, dnl.warehouse_id,
              dnl.product_lot_id,
              p.type AS product_type, p.base_unit
         FROM delivery_note_lines dnl
         JOIN products p ON p.id = dnl.product_id
        WHERE dnl.delivery_note_id = $1`,
      [noteId]
    )
    for (const line of linesForStock) {
      const qtyBase = parseFloat(line.quantity_base || 0)
      if (qtyBase <= 0) continue
      const warehouseId = await resolveWarehouseForLine(
        client, tenantId, line.warehouse_id, line.product_type
      )
      await recordMovement(client, {
        tenantId, warehouseId,
        itemType:      'product',
        itemId:         line.product_id,
        movementType:  'sale_exit',
        quantity:      -qtyBase,
        unit:           line.base_unit || 'unidad',
        referenceType: 'delivery_note',
        referenceId:    noteId,
        notes:         `Salida por remisión ${note.document_number}`,
        createdBy:      userId,
        validateStock: false,
      })

      // SaaS v2 §143: descontar del lote específico si está vinculado.
      // Esto mantiene `product_lots.quantity_remaining` consistente y permite
      // trazabilidad forward (lote → cliente).
      if (line.product_lot_id) {
        const { rows: lotRows } = await client.query(
          `UPDATE product_lots
              SET quantity_remaining = GREATEST(0, quantity_remaining - $1),
                  status = CASE
                    WHEN quantity_remaining - $1 <= 0 THEN 'depleted'
                    ELSE status
                  END
            WHERE id = $2 AND tenant_id = $3
            RETURNING quantity_remaining`,
          [qtyBase, line.product_lot_id, tenantId]
        )
        if (lotRows.length === 0) {
          // No fallar el despacho — solo loguear para diagnóstico.
          console.warn(`[deliverDeliveryNote] product_lot ${line.product_lot_id} no encontrado al descontar`)
        }
      }
    }

    // Generar CXC automáticamente: la entrega siempre completa la remisión.
    await generateCXC(client, { tenantId, note, userId })

    // Recalcular status del pedido en función del agregado de todas sus remisiones.
    // Una remisión completa NO necesariamente significa pedido completo (puede haber otras
    // remisiones pendientes con saldo). El helper decide entre delivered / partially_delivered / in_delivery.
    if (note.sales_order_id) {
      await recalcOrderStatusFromDeliveries(client, {
        tenantId, orderId: note.sales_order_id,
      })
    }

    await audit({
      tenantId, userId, action: 'delivery_note.delivered',
      resource: 'delivery_notes', resourceId: noteId,
      payload: { receiverName, hasPhoto: !!photoPath },
      ipAddress, userAgent,
    })

    return note
  })
}

/**
 * Cancela una remisión:
 *   - status → 'cancelled'
 *   - recalcula status del pedido
 *
 * Solo permitido cuando la remisión todavía NO se entregó y NO tiene factura
 * activa. Para revertir una remisión entregada hay que cancelar primero la
 * factura (si tiene) y manejar inventario por movimientos manuales — la
 * cancelación automática con reverso quedó deprecada por riesgo operativo.
 */
async function cancelDelivery({ tenantId, noteId, reason, userId, ipAddress, userAgent }) {
  return withTransaction(async (client) => {
    const { rows: noteRows } = await client.query(
      `SELECT id, document_number, status, sales_order_id, partner_id
         FROM delivery_notes
        WHERE id = $1 AND tenant_id = $2`,
      [noteId, tenantId]
    )
    if (!noteRows.length) throw createError(404, 'Remisión no encontrada.')
    const note = noteRows[0]
    if (note.status === 'cancelled') throw createError(409, 'La remisión ya está cancelada.')
    if (note.status === 'delivered' || note.status === 'invoiced') {
      throw createError(409,
        'No se puede cancelar una remisión que ya fue entregada. Si necesitas revertirla, ajusta el inventario manualmente.')
    }

    // Si tiene factura activa, bloquear (la cancelación de la factura debe ir
    // primero — al cancelar la factura el AR vuelve a la remisión).
    const { rows: invRows } = await client.query(
      `SELECT id, document_number, status FROM invoices
        WHERE tenant_id = $1 AND delivery_note_id = $2 AND status <> 'cancelled'`,
      [tenantId, noteId]
    )
    if (invRows.length) {
      throw createError(409,
        `Esta remisión tiene la factura ${invRows[0].document_number} activa. Cancela primero la factura.`)
    }

    // Marcar como cancelada
    await client.query(
      `UPDATE delivery_notes SET status = 'cancelled'
        WHERE id = $1 AND tenant_id = $2`,
      [noteId, tenantId]
    )

    // Log de estatus
    await client.query(
      `INSERT INTO document_status_log
         (tenant_id, entity_type, entity_id, from_status, to_status, changed_by, metadata)
       VALUES ($1, 'delivery_note', $2, $3, 'cancelled', $4, $5)`,
      [tenantId, noteId, note.status, userId,
       JSON.stringify({ reason: reason || null })]
    )

    // Recalcular status del pedido
    if (note.sales_order_id) {
      await recalcOrderStatusFromDeliveries(client, {
        tenantId, orderId: note.sales_order_id,
      })
    }

    await audit({
      tenantId, userId, action: 'delivery_note.cancelled',
      resource: 'delivery_notes', resourceId: noteId,
      payload: { reason },
      ipAddress, userAgent,
    })

    return { id: noteId, status: 'cancelled' }
  })
}

/**
 * Resuelve los destinatarios por defecto de una remisión:
 * el contacto principal del cliente, o cualquier contacto con email si no hay primario.
 */
async function defaultRecipientsForNote(tenantId, partnerId) {
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
 * Envía la remisión por correo al cliente con el PDF adjunto.
 *
 * - Si `emails` viene vacío, se toma el contacto principal del cliente.
 * - Actualiza el status a 'sent_by_email' solo si el envío fue exitoso
 *   y la remisión venía en estado 'issued'. Los estados posteriores
 *   ('delivered', 'invoiced', etc.) NO retroceden — solo se loguea el envío.
 * - Devuelve { id, document_number, status, sentTo }.
 */
async function markAsSentByEmail({ tenantId, noteId, emails, userId, ipAddress, userAgent }) {
  // Cargar contexto necesario para el correo (sin transacción — son lecturas
  // y un envío externo que no debe sostener locks).
  const { rows: noteRows } = await query(
    `SELECT dn.id, dn.document_number, dn.status, dn.partner_id,
            dn.currency, dn.total_mxn, dn.issue_date, dn.credit_due_date,
            dn.sales_order_id,
            bp.name AS partner_name, bp.tax_name AS partner_tax_name,
            so.order_number, so.po_number AS sales_order_po,
            tfi.razon_social AS emisor_nombre,
            t.name AS tenant_name
       FROM delivery_notes dn
       JOIN business_partners bp ON bp.id = dn.partner_id
       LEFT JOIN sales_orders so ON so.id = dn.sales_order_id
       LEFT JOIN tenant_fiscal_info tfi ON tfi.tenant_id = dn.tenant_id
       LEFT JOIN tenants t ON t.id = dn.tenant_id
      WHERE dn.id = $1 AND dn.tenant_id = $2`,
    [noteId, tenantId]
  )
  if (!noteRows.length) return null
  const note = noteRows[0]

  if (note.status === 'cancelled') {
    throw createError(409, 'No se puede enviar por correo una remisión cancelada.')
  }

  // Resolver destinatarios
  let recipients = Array.isArray(emails) ? emails.filter(Boolean) : []
  if (!recipients.length) {
    recipients = await defaultRecipientsForNote(tenantId, note.partner_id)
  }
  if (!recipients.length) {
    throw createError(400,
      'No se pudo determinar el destinatario: el cliente no tiene contactos con correo y no se especificaron correos en la solicitud.')
  }

  const tenantDisplayName = note.emisor_nombre || note.tenant_name || 'Emisor'
  const partnerDisplayName = note.partner_tax_name || note.partner_name || ''

  // Correo de copia: prioridad al notification_email del tenant; si no está,
  // fallback al correo del usuario logueado.
  let senderEmail = null
  const { rows: trows } = await query(
    `SELECT notification_email, brand_color_primary FROM tenants WHERE id = $1`,
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

  // Generar PDF como adjunto
  const pdfBuffer = await generateRemisionPDF({ tenantId, noteId })

  const html = remisionEmail({
    tenantName:   tenantDisplayName,
    brandColor:   trows[0]?.brand_color_primary || null,
    partnerName:  partnerDisplayName,
    docNumber:    note.document_number,
    total:        note.total_mxn,
    currency:     note.currency,
    issueDate:    note.issue_date,
    dueDate:      note.credit_due_date,
    orderNumber:  note.order_number,
    poNumber:     note.sales_order_po,
  })

  await enqueueEmail({
    to:        recipients,
    bcc:       senderEmail || undefined,
    replyTo:   senderEmail || undefined,
    subject:   `Remisión ${note.document_number} — ${tenantDisplayName}`,
    html,
    fromName:  tenantDisplayName,
    attachments: [{
      filename:    `${note.document_number}.pdf`,
      content:     pdfBuffer,
      contentType: 'application/pdf',
    }],
  })

  // Solo avanzar el status si la remisión todavía está en 'issued'.
  let finalStatus = note.status
  if (note.status === 'issued') {
    const { rows: upd } = await query(
      `UPDATE delivery_notes SET status = 'sent_by_email'
         WHERE id = $1 AND tenant_id = $2 AND status = 'issued'
         RETURNING status`,
      [noteId, tenantId]
    )
    if (upd[0]) {
      finalStatus = upd[0].status
      await query(
        `INSERT INTO document_status_log
           (tenant_id, entity_type, entity_id, from_status, to_status, changed_by)
         VALUES ($1, 'delivery_note', $2, 'issued', 'sent_by_email', $3)`,
        [tenantId, noteId, userId]
      )
    }
  }

  await audit({
    tenantId, userId, action: 'delivery_note.sent_by_email',
    resource: 'delivery_notes', resourceId: noteId,
    payload: { recipients, docNumber: note.document_number },
    ipAddress, userAgent,
  })

  return {
    id:              noteId,
    document_number: note.document_number,
    status:          finalStatus,
    sentTo:          recipients,
    bcc:             senderEmail,
  }
}

/**
 * Genera el registro CXC cuando la entrega es completa.
 */
async function generateCXC(client, { tenantId, note, userId }) {
  await client.query(
    `INSERT INTO accounts_receivable
       (tenant_id, partner_id, document_type, document_id, document_number,
        currency, exchange_rate, amount_total, issue_date, due_date, created_by)
     VALUES ($1,$2,'remission',$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (tenant_id, document_type, document_id) DO NOTHING`,
    [tenantId, note.partner_id, note.id, note.document_number,
     'MXN', 1, note.total_mxn,
     new Date().toISOString().split('T')[0],
     note.credit_due_date, userId]
  )
}

/**
 * Marca o desmarca una remisión como "no requiere factura".
 * Las remisiones con no_invoice=true se excluyen del modal de nueva factura.
 *
 * Validaciones:
 *   - La remisión debe existir y pertenecer al tenant
 *   - No se puede marcar como no_invoice si ya tiene factura activa
 */
async function setNoInvoice({ tenantId, noteId, noInvoice, userId, ipAddress, userAgent }) {
  return withTransaction(async (client) => {
    const { rows: noteRows } = await client.query(
      `SELECT id, document_number FROM delivery_notes WHERE id = $1 AND tenant_id = $2`,
      [noteId, tenantId]
    )
    if (!noteRows.length) throw createError(404, 'Remisión no encontrada.')

    if (noInvoice) {
      const { rows: invs } = await client.query(
        `SELECT 1 FROM invoices WHERE delivery_note_id = $1 AND status <> 'cancelled' LIMIT 1`,
        [noteId]
      )
      if (invs.length > 0) {
        throw createError(409, 'Esta remisión ya tiene una factura. No se puede marcar como sin factura.')
      }
    }

    const { rows } = await client.query(
      `UPDATE delivery_notes SET no_invoice = $1 WHERE id = $2 AND tenant_id = $3
       RETURNING id, document_number, no_invoice`,
      [!!noInvoice, noteId, tenantId]
    )

    await audit({
      tenantId, userId, action: 'delivery_note.no_invoice_changed',
      resource: 'delivery_notes', resourceId: noteId,
      payload: { noInvoice: !!noInvoice }, ipAddress, userAgent,
    })

    return rows[0]
  })
}

async function getOrderLines(client, salesOrderId) {
  const { rows } = await client.query(
    `SELECT product_id AS "productId", quantity AS "quantityOrdered",
            quantity AS "quantityDelivered", unit, unit_price AS "unitPrice",
            discount_pct AS "discountPct", notes,
            original_unit_price        AS "originalUnitPrice",
            original_currency          AS "originalCurrency",
            applied_exchange_rate      AS "appliedExchangeRate",
            applied_exchange_rate_date AS "appliedExchangeRateDate",
            pack_option_id             AS "packOptionId",
            pack_factor                AS "packFactor"
     FROM sales_order_lines WHERE sales_order_id = $1 ORDER BY line_number`,
    [salesOrderId]
  )
  return rows
}

function createError(status, message) {
  const err = new Error(message)
  err.status = status
  return err
}

module.exports = {
  createDeliveryNote, listDeliveryNotes, getDeliveryNote,
  recordDelivery, markAsSentByEmail, setNoInvoice, cancelDelivery,
}
