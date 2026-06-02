'use strict'

const { query, withTransaction } = require('../../db')
const { audit } = require('../../utils/audit')
const { getRateForDate } = require('../exchange-rates/exchangeRateService')
const documentSeriesService = require('../document-series/documentSeriesService')

/**
 * Genera el siguiente número de pedido de venta.
 *
 * Si el tenant tiene serie configurada en `tenant_document_series` para
 * entity_type='sales_order', usa esa (formato `{serie}-{folio_4}`).
 * Si NO, cae al patrón legacy `PV-YYYYMM-NNNN` con reset mensual implícito.
 */
async function nextOrderNumber(client, tenantId, opts = {}) {
  const result = await documentSeriesService.generateDocumentNumber({
    client, tenantId, entityType: 'sales_order', opts,
  })
  if (result) return result.docNumber

  // Legacy: PV-YYYYMM-NNNN con reset mensual
  const ym = new Date().toISOString().slice(0, 7).replace('-', '')
  const prefix = `PV-${ym}-`
  const { rows } = await client.query(
    `SELECT order_number FROM sales_orders
     WHERE tenant_id = $1 AND order_number LIKE $2
     ORDER BY order_number DESC LIMIT 1`,
    [tenantId, `${prefix}%`]
  )
  const last = rows[0]?.order_number
  const seq = last ? parseInt(last.split('-')[2], 10) + 1 : 1
  return `${prefix}${String(seq).padStart(4, '0')}`
}

/**
 * Lista pedidos con filtros.
 */
async function listOrders({ tenantId, status, partnerId, from, to, page = 1, limit = 50 }) {
  const offset = (page - 1) * limit
  const params = [tenantId]
  const filters = []

  if (status)    { params.push(status);    filters.push(`so.status = $${params.length}`) }
  if (partnerId) { params.push(partnerId); filters.push(`so.partner_id = $${params.length}`) }
  if (from)      { params.push(from);      filters.push(`so.created_at >= $${params.length}`) }
  if (to)        { params.push(to);        filters.push(`so.created_at <= $${params.length}`) }

  const where = filters.length ? `AND ${filters.join(' AND ')}` : ''
  params.push(limit, offset)

  const { rows } = await query(
    `SELECT so.id, so.order_number, so.status, so.currency,
            so.subtotal_mxn, so.tax_mxn, so.total_mxn,
            so.scheduled_date, so.direct_invoice, so.po_number,
            so.created_at, so.confirmed_at, so.partner_id,
            so.driver_id, so.pickup_in_warehouse,
            bp.name AS partner_name, bp.tax_name AS partner_tax_name, bp.rfc AS partner_rfc,
            bp.requires_po, bp.billing_notes,
            u.full_name AS created_by_name,
            udrv.full_name AS driver_name,
            COUNT(sol.id) AS line_count,
            COALESCE((
              SELECT SUM(dn.total_mxn)
                FROM delivery_notes dn
               WHERE dn.sales_order_id = so.id AND dn.status = 'delivered'
            ), 0) AS delivered_total_mxn,
            COALESCE((
              SELECT SUM(dn.total_mxn)
                FROM delivery_notes dn
               WHERE dn.sales_order_id = so.id AND dn.status <> 'cancelled'
            ), 0) AS remisioned_total_mxn,
            (SELECT MAX(dn.delivered_at)
               FROM delivery_notes dn
              WHERE dn.sales_order_id = so.id AND dn.status = 'delivered'
            ) AS last_delivered_at,
            COALESCE((
              SELECT COUNT(*)
                FROM delivery_notes dn
               WHERE dn.sales_order_id = so.id AND dn.status <> 'cancelled'
            ), 0) AS remisiones_count
     FROM sales_orders so
     JOIN business_partners bp ON bp.id = so.partner_id
     LEFT JOIN users u    ON u.id    = so.created_by
     LEFT JOIN users udrv ON udrv.id = so.driver_id
     LEFT JOIN sales_order_lines sol ON sol.sales_order_id = so.id
     WHERE so.tenant_id = $1 ${where}
     GROUP BY so.id, bp.id, u.id, udrv.id
     ORDER BY so.created_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  )

  const { rows: countRows } = await query(
    `SELECT COUNT(*) FROM sales_orders so WHERE so.tenant_id = $1 ${where}`,
    params.slice(0, params.length - 2)
  )

  return { data: rows, total: parseInt(countRows[0].count, 10), page, limit }
}

/**
 * Detalle de un pedido con sus líneas y preferencias del cliente.
 */
async function getOrder({ tenantId, orderId }) {
  const { rows } = await query(
    `SELECT so.*,
            bp.name AS partner_name, bp.rfc, bp.cfdi_use, bp.payment_method,
            bp.payment_form, bp.credit_type, bp.credit_days,
            bp.requires_po, bp.requires_quotation, bp.billing_notes,
            bp.preferred_currency,
            da.alias AS address_alias, da.address AS delivery_address,
            da.city AS delivery_city, da.state AS delivery_state,
            da.freight_included,
            uc.full_name AS created_by_name,
            uconf.full_name AS confirmed_by_name,
            udrv.full_name AS driver_name, udrv.email AS driver_email
     FROM sales_orders so
     JOIN business_partners bp ON bp.id = so.partner_id
     LEFT JOIN delivery_addresses da ON da.id = so.delivery_address_id
     LEFT JOIN users uc    ON uc.id = so.created_by
     LEFT JOIN users uconf ON uconf.id = so.confirmed_by
     LEFT JOIN users udrv  ON udrv.id = so.driver_id
     WHERE so.id = $1 AND so.tenant_id = $2`,
    [orderId, tenantId]
  )
  if (rows.length === 0) return null

  const order = rows[0]

  const { rows: lines } = await query(
    `SELECT sol.*, p.sku, p.name AS product_name, p.type AS product_type,
            p.units_per_package,
            (SELECT a.id FROM attachments a
              WHERE a.entity_type = 'product' AND a.entity_id = p.id
                AND a.category = 'image'
              ORDER BY a.created_at DESC LIMIT 1) AS image_attachment_id
     FROM sales_order_lines sol
     JOIN products p ON p.id = sol.product_id
     WHERE sol.sales_order_id = $1
     ORDER BY sol.line_number`,
    [orderId]
  )

  // Remisiones ligadas al pedido (resumen). Incluye las CONSOLIDADAS: una
  // remisión que cubre varios pedidos apunta en su header solo al principal,
  // pero referencia a los demás vía delivery_note_lines.sales_order_id. Sin
  // esto, los pedidos consolidados "no veían" su remisión en el detalle.
  const { rows: deliveryNotes } = await query(
    `SELECT DISTINCT dn.id, dn.document_number, dn.status, dn.currency, dn.total_mxn,
            dn.issue_date, dn.delivered_at, dn.receiver_name, dn.created_at
       FROM delivery_notes dn
      WHERE dn.tenant_id = $2
        AND ( dn.sales_order_id = $1
           OR EXISTS (SELECT 1 FROM delivery_note_lines dnl
                       WHERE dnl.delivery_note_id = dn.id AND dnl.sales_order_id = $1) )
      ORDER BY dn.issue_date DESC, dn.created_at DESC`,
    [orderId, tenantId]
  )

  return { ...order, lines, deliveryNotes }
}

/**
 * Obtiene el precio sugerido para un cliente+producto en una moneda dada.
 * Prioridad: customer_prices > products.base_price > null.
 *
 * Si la moneda del precio no coincide con `orderCurrency`, convierte usando
 * el TC del día y devuelve además los campos original_* para que el pedido
 * preserve la trazabilidad (revaluación al timbrar la factura).
 */
async function getSuggestedPrice({ tenantId, partnerId, productId, orderCurrency = 'MXN' }) {
  // 1) Precio negociado vigente
  const { rows: negotiated } = await query(
    `SELECT unit_price, currency FROM current_customer_prices
     WHERE tenant_id = $1 AND business_partner_id = $2 AND product_id = $3`,
    [tenantId, partnerId, productId]
  )

  let priceRaw      = null
  let priceCurrency = null
  let source        = null

  if (negotiated.length > 0) {
    priceRaw      = parseFloat(negotiated[0].unit_price)
    priceCurrency = negotiated[0].currency
    source        = 'negotiated'
  } else {
    // 2) Precio base del catálogo
    const { rows: prod } = await query(
      `SELECT base_price, base_currency FROM products
       WHERE id = $1 AND tenant_id = $2 AND base_price IS NOT NULL`,
      [productId, tenantId]
    )
    if (prod.length > 0 && prod[0].base_price != null) {
      priceRaw      = parseFloat(prod[0].base_price)
      priceCurrency = prod[0].base_currency || 'MXN'
      source        = 'base'
    }
  }

  if (priceRaw == null) return null

  // Sin conversión cuando ya coinciden las monedas
  if (priceCurrency === orderCurrency) {
    return { unit_price: priceRaw, currency: priceCurrency, source }
  }

  // Conversión: hoy solo soportamos USD→MXN (lo común en este negocio).
  // Si alguna vez se requiere MXN→USD se agrega aquí.
  if (priceCurrency === 'USD' && orderCurrency === 'MXN') {
    const today = new Date().toISOString().split('T')[0]
    const rate  = await getRateForDate({ tenantId, date: today, currency: 'USD' })
    if (!rate) {
      // Sin TC disponible: devolvemos el precio en su moneda original
      // marcándolo para que el frontend pueda alertar.
      return { unit_price: priceRaw, currency: priceCurrency, source, conversionFailed: true }
    }
    const tc = parseFloat(rate.rate_mxn)
    const converted = +(priceRaw * tc).toFixed(4)
    // rate_date puede ser anterior a `today` si hoy es fin de semana o
    // feriado — se arrastra el TC del último día hábil.
    const rateDate = rate.rate_date instanceof Date
      ? rate.rate_date.toISOString().split('T')[0]
      : String(rate.rate_date).slice(0, 10)
    return {
      unit_price:              converted,
      currency:                orderCurrency,
      source:                  `${source}_converted`,
      originalUnitPrice:       priceRaw,
      originalCurrency:        priceCurrency,
      appliedExchangeRate:     tc,
      appliedExchangeRateDate: rateDate,
    }
  }

  // Combinación no soportada — devolvemos el precio en su moneda y el
  // frontend mostrará una alerta para que el usuario capture manualmente.
  return { unit_price: priceRaw, currency: priceCurrency, source, conversionFailed: true }
}

/**
 * Crea un pedido de venta con pre-carga de preferencias del cliente.
 */
async function createOrder({
  tenantId, partnerId, deliveryAddressId, currency,
  lines = [], poNumber, scheduledDate, driverId, directInvoice, notes,
  force = false,
  userId, ipAddress, userAgent,
}) {
  return withTransaction(async (client) => {
    // Obtener preferencias del cliente
    const { rows: partnerRows } = await client.query(
      `SELECT requires_po, requires_quotation, billing_notes,
              preferred_currency, cfdi_use, payment_method, payment_form,
              credit_type, credit_days
       FROM business_partners WHERE id = $1 AND tenant_id = $2`,
      [partnerId, tenantId]
    )
    if (partnerRows.length === 0) throw createError(404, 'Cliente no encontrado.')
    const partner = partnerRows[0]

    // requires_po sólo aplica como bloqueo en facturación. En el pedido es advertencia
    // para que el operador pueda capturar OC después si el cliente aún no la entregó.
    // (No-op intencional aquí; el frontend del pedido muestra warning visual.)

    // Resolver domicilio de entrega: si no se especifica, usar el marcado como default
    // en delivery_addresses (is_default = true).
    let resolvedAddressId = deliveryAddressId
    if (!resolvedAddressId) {
      const { rows: defAddr } = await client.query(
        `SELECT id FROM delivery_addresses
          WHERE business_partner_id = $1 AND tenant_id = $2
            AND is_default = true AND is_active = true
          LIMIT 1`,
        [partnerId, tenantId]
      )
      resolvedAddressId = defAddr[0]?.id || null
    }

    // Resolver moneda
    const resolvedCurrency = currency || partner.preferred_currency || 'MXN'

    // Obtener TC si la moneda es USD
    let exchangeRateId = null
    let exchangeRateValue = 1
    if (resolvedCurrency === 'USD') {
      const today = new Date().toISOString().split('T')[0]
      const rate = await getRateForDate({ tenantId, date: today, currency: 'USD' })
      if (!rate) throw createError(400, 'No hay tipo de cambio disponible para hoy. Sincroniza el TC primero.')
      exchangeRateId = rate.id
      exchangeRateValue = parseFloat(rate.rate_mxn)
    }

    // Número de orden
    const orderNumber = await nextOrderNumber(client, tenantId)

    // Calcular totales
    //
    // NOTA FISCAL: los pedidos NO llevan IVA. El IVA se calcula al facturar
    // (en invoiceService.createDirect / createFromRemissions / createFromOrder).
    // Hay pedidos que nunca se facturan; mostrar IVA antes de facturar genera
    // expectativa errónea de cobro. Los campos tax_mxn/total_mxn se conservan
    // por compatibilidad con queries existentes, pero quedan en 0 / igual a
    // subtotal respectivamente.
    let subtotal = 0
    for (const line of lines) {
      const lineSubtotal = line.quantity * line.unitPrice * (1 - (line.discountPct || 0) / 100)
      subtotal += lineSubtotal
    }
    const tax = 0
    const total = subtotal
    const factor = resolvedCurrency === 'USD' ? exchangeRateValue : 1

    // Guard anti-duplicado (override con force): un pedido NO cancelado del
    // mismo cliente, con el mismo total, creado hace < 5 min, casi siempre es un
    // reintento por timeout (servidor lento marcó error pero el pedido SÍ se
    // creó). Pedimos confirmar antes de duplicar; force=true lo salta (pedido
    // legítimo repetido).
    if (!force) {
      const totalMxn = total * factor
      const { rows: dup } = await client.query(
        `SELECT order_number FROM sales_orders
          WHERE tenant_id = $1 AND partner_id = $2 AND status <> 'cancelled'
            AND created_at > NOW() - INTERVAL '5 minutes'
            AND ROUND(total_mxn, 2) = ROUND($3::numeric, 2)
          ORDER BY created_at DESC LIMIT 1`,
        [tenantId, partnerId, totalMxn]
      )
      if (dup.length) {
        const e = createError(409,
          `Parece un pedido duplicado: ya creaste el pedido ${dup[0].order_number} de este cliente con el mismo total hace unos minutos. Si es intencional, confirma para crearlo de todos modos.`)
        e.code = 'POSSIBLE_DUPLICATE_ORDER'
        e.details = { orderNumber: dup[0].order_number }
        throw e
      }
    }

    // Crear pedido
    const { rows } = await client.query(
      `INSERT INTO sales_orders
         (tenant_id, order_number, partner_id, delivery_address_id,
          currency, exchange_rate_id, exchange_rate_value,
          subtotal_mxn, tax_mxn, total_mxn, scheduled_date, driver_id,
          po_number, direct_invoice, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       RETURNING *`,
      [tenantId, orderNumber, partnerId, resolvedAddressId,
       resolvedCurrency, exchangeRateId, exchangeRateValue,
       subtotal * factor, tax * factor, total * factor,
       scheduledDate || null, driverId || null,
       poNumber || null, directInvoice || false,
       notes || null, userId]
    )
    const order = rows[0]

    // Insertar líneas
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      const packFactor   = line.packFactor != null ? parseFloat(line.packFactor) : 1
      const quantityBase = parseFloat(line.quantity) * packFactor
      await client.query(
        `INSERT INTO sales_order_lines
           (sales_order_id, product_id, quantity, unit, unit_price,
            currency, discount_pct, line_number, notes,
            original_unit_price, original_currency, applied_exchange_rate,
            applied_exchange_rate_date,
            pack_option_id, pack_factor, quantity_base)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
        [order.id, line.productId, line.quantity, line.unit || 'paquete',
         line.unitPrice, resolvedCurrency, line.discountPct || 0, i + 1,
         line.notes || null,
         line.originalUnitPrice != null ? line.originalUnitPrice : null,
         line.originalCurrency  || null,
         line.appliedExchangeRate != null ? line.appliedExchangeRate : null,
         line.appliedExchangeRateDate || null,
         line.packOptionId || null,
         packFactor,
         quantityBase]
      )
    }

    // Log de estatus
    await client.query(
      `INSERT INTO document_status_log
         (tenant_id, entity_type, entity_id, from_status, to_status, changed_by)
       VALUES ($1, 'sales_order', $2, NULL, 'draft', $3)`,
      [tenantId, order.id, userId]
    )

    await audit({
      tenantId, userId, action: 'sales_order.created',
      resource: 'sales_orders', resourceId: order.id,
      payload: { orderNumber, partnerId, total: total * factor, currency: resolvedCurrency },
      ipAddress, userAgent,
    })

    return order
  })
}

/**
 * Confirma un pedido — cambia estatus a confirmed.
 */
async function confirmOrder({ tenantId, orderId, userId, ipAddress, userAgent }) {
  return withTransaction(async (client) => {
    // Verificar que el pedido tenga al menos una línea antes de confirmar
    const { rows: lineCheck } = await client.query(
      `SELECT COUNT(*)::int AS line_count FROM sales_order_lines WHERE sales_order_id = $1`,
      [orderId]
    )
    if (lineCheck[0].line_count === 0) {
      throw createError(400, 'No se puede confirmar un pedido sin líneas. Agrega al menos un producto.')
    }

    const { rows } = await client.query(
      `UPDATE sales_orders SET status = 'confirmed', confirmed_by = $1, confirmed_at = NOW()
       WHERE id = $2 AND tenant_id = $3 AND status = 'draft'
       RETURNING id, order_number, status`,
      [userId, orderId, tenantId]
    )
    if (rows.length === 0) throw createError(404, 'Pedido no encontrado o ya no está en borrador.')

    await client.query(
      `INSERT INTO document_status_log
         (tenant_id, entity_type, entity_id, from_status, to_status, changed_by)
       VALUES ($1, 'sales_order', $2, 'draft', 'confirmed', $3)`,
      [tenantId, orderId, userId]
    )

    await audit({
      tenantId, userId, action: 'sales_order.confirmed',
      resource: 'sales_orders', resourceId: orderId,
      ipAddress, userAgent,
    })

    return rows[0]
  })
}

/**
 * Cancela un pedido.
 */
async function cancelOrder({ tenantId, orderId, reason, userId, ipAddress, userAgent }) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `UPDATE sales_orders SET status = 'cancelled'
       WHERE id = $1 AND tenant_id = $2 AND status IN ('draft','confirmed')
       RETURNING id, order_number`,
      [orderId, tenantId]
    )
    if (rows.length === 0) throw createError(404, 'Pedido no encontrado o no se puede cancelar.')

    await client.query(
      `INSERT INTO document_status_log
         (tenant_id, entity_type, entity_id, from_status, to_status, changed_by, notes)
       VALUES ($1, 'sales_order', $2, 'confirmed', 'cancelled', $3, $4)`,
      [tenantId, orderId, userId, reason || null]
    )

    await audit({
      tenantId, userId, action: 'sales_order.cancelled',
      resource: 'sales_orders', resourceId: orderId,
      payload: { reason }, ipAddress, userAgent,
    })

    return rows[0]
  })
}

/**
 * Elimina de raíz un pedido SIN documentos asociados (hard delete). Solo admin
 * (permiso sales:delete). Bloquea si tiene remisiones (incluidas las
 * consolidadas, vía delivery_note_lines.sales_order_id) o facturas que lo
 * referencian. El pedido nunca toca inventario, así que no hay nada que
 * revertir; las líneas cascadean (sales_order_lines FK ON DELETE CASCADE).
 */
async function deleteOrder({ tenantId, orderId, userId, ipAddress, userAgent }) {
  return withTransaction(async (client) => {
    const { rows: ord } = await client.query(
      `SELECT id, order_number FROM sales_orders WHERE id = $1 AND tenant_id = $2`,
      [orderId, tenantId]
    )
    if (!ord.length) throw createError(404, 'Pedido no encontrado.')

    const { rows: act } = await client.query(
      `SELECT
         EXISTS(SELECT 1 FROM delivery_notes      WHERE tenant_id=$2 AND sales_order_id=$1) AS rem_hdr,
         EXISTS(SELECT 1 FROM delivery_note_lines WHERE sales_order_id=$1)                  AS rem_ln,
         EXISTS(SELECT 1 FROM invoice_lines il
                  JOIN sales_order_lines sol ON sol.id = il.sales_order_line_id
                 WHERE sol.sales_order_id=$1)                                               AS facturas`,
      [orderId, tenantId]
    )
    const a = act[0]
    if (a.rem_hdr || a.rem_ln) {
      throw createError(409, 'No se puede eliminar: el pedido tiene remisiones asociadas. Cancélalo en su lugar.')
    }
    if (a.facturas) {
      throw createError(409, 'No se puede eliminar: el pedido tiene facturas asociadas. Cancélalo en su lugar.')
    }

    await client.query(`DELETE FROM sales_orders WHERE id = $1 AND tenant_id = $2`, [orderId, tenantId])

    await audit({
      tenantId, userId, action: 'sales_order.deleted',
      resource: 'sales_orders', resourceId: orderId,
      payload: { orderNumber: ord[0].order_number }, ipAddress, userAgent,
    })

    return { id: orderId, order_number: ord[0].order_number }
  })
}

/**
 * Edita datos generales de un pedido en estado draft.
 */
async function updateOrder({
  tenantId, orderId,
  deliveryAddressId, scheduledDate, driverId,
  poNumber, directInvoice, notes,
  userId, ipAddress, userAgent,
}) {
  const { rows } = await query(
    `UPDATE sales_orders SET
       delivery_address_id = COALESCE($1, delivery_address_id),
       scheduled_date      = COALESCE($2, scheduled_date),
       driver_id           = COALESCE($3, driver_id),
       po_number           = COALESCE($4, po_number),
       direct_invoice      = COALESCE($5, direct_invoice),
       notes               = COALESCE($6, notes)
     WHERE id = $7 AND tenant_id = $8 AND status = 'draft'
     RETURNING id, order_number, status, scheduled_date, driver_id, po_number`,
    [deliveryAddressId || null, scheduledDate || null, driverId || null,
     poNumber || null, directInvoice ?? null, notes || null,
     orderId, tenantId]
  )
  if (rows.length === 0) throw createError(404, 'Pedido no encontrado o ya no está en borrador.')

  await audit({
    tenantId, userId, action: 'sales_order.updated',
    resource: 'sales_orders', resourceId: orderId,
    payload: { scheduledDate, driverId, poNumber },
    ipAddress, userAgent,
  })

  return rows[0]
}

/**
 * Asigna o cambia el repartidor — permitido en draft, confirmed e in_delivery.
 *
 * Tres modos:
 *   - driverId + pickupInWarehouse=false  → repartidor asignado.
 *   - driverId=null + pickupInWarehouse=true → cliente recoge en bodega.
 *   - driverId=null + pickupInWarehouse=false → sin asignar (estado inicial).
 *
 * Cuando pickupInWarehouse=true, se fuerza driver_id=NULL automáticamente.
 */
async function assignDriver({
  tenantId, orderId,
  driverId, pickupInWarehouse = null, scheduledDate,
  userId, ipAddress, userAgent,
}) {
  const isPickup = pickupInWarehouse === true
  const finalDriverId = isPickup ? null : (driverId || null)

  const { rows } = await query(
    `UPDATE sales_orders SET
       driver_id            = $1,
       pickup_in_warehouse  = COALESCE($2, pickup_in_warehouse),
       scheduled_date       = COALESCE($3, scheduled_date)
     WHERE id = $4 AND tenant_id = $5
       AND status IN ('draft', 'confirmed', 'in_delivery')
     RETURNING id, order_number, status, driver_id, pickup_in_warehouse, scheduled_date`,
    [finalDriverId, pickupInWarehouse, scheduledDate || null, orderId, tenantId]
  )
  if (rows.length === 0) throw createError(404, 'Pedido no encontrado o no editable en este estado.')

  await audit({
    tenantId, userId, action: 'sales_order.driver_assigned',
    resource: 'sales_orders', resourceId: orderId,
    payload: { driverId: finalDriverId, pickupInWarehouse: isPickup, scheduledDate },
    ipAddress, userAgent,
  })

  return rows[0]
}

/**
 * Agrega una línea a un pedido en draft.
 */
async function addOrderLine({
  tenantId, orderId, productId, quantity, unitPrice, unit, discountPct, notes,
  originalUnitPrice, originalCurrency, appliedExchangeRate, appliedExchangeRateDate,
  packOptionId, packFactor,
}) {
  return withTransaction(async (client) => {
    const { rows: order } = await client.query(
      `SELECT id, currency FROM sales_orders WHERE id = $1 AND tenant_id = $2 AND status = 'draft'`,
      [orderId, tenantId]
    )
    if (order.length === 0) throw createError(404, 'Pedido no encontrado o ya no está en borrador.')

    const { rows: maxLine } = await client.query(
      `SELECT COALESCE(MAX(line_number), 0) AS max FROM sales_order_lines WHERE sales_order_id = $1`,
      [orderId]
    )

    const factor = packFactor != null ? parseFloat(packFactor) : 1
    const qtyBase = parseFloat(quantity) * factor
    const { rows } = await client.query(
      `INSERT INTO sales_order_lines
         (sales_order_id, product_id, quantity, unit, unit_price, currency,
          discount_pct, line_number, notes,
          original_unit_price, original_currency, applied_exchange_rate,
          applied_exchange_rate_date,
          pack_option_id, pack_factor, quantity_base)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
      [orderId, productId, quantity, unit || 'paquete', unitPrice,
       order[0].currency, discountPct || 0, maxLine[0].max + 1, notes || null,
       originalUnitPrice != null ? originalUnitPrice : null,
       originalCurrency  || null,
       appliedExchangeRate != null ? appliedExchangeRate : null,
       appliedExchangeRateDate || null,
       packOptionId || null, factor, qtyBase]
    )

    await recalcOrderTotals(client, orderId)
    return rows[0]
  })
}

/**
 * Edita una línea existente de un pedido en draft.
 */
async function updateOrderLine({
  tenantId, orderId, lineId, productId, quantity, unit, unitPrice, discountPct, notes,
  originalUnitPrice, originalCurrency, appliedExchangeRate, appliedExchangeRateDate,
  packOptionId, packFactor,
}) {
  return withTransaction(async (client) => {
    const { rows: order } = await client.query(
      `SELECT id FROM sales_orders WHERE id = $1 AND tenant_id = $2 AND status = 'draft'`,
      [orderId, tenantId]
    )
    if (order.length === 0) throw createError(404, 'Pedido no encontrado o ya no está en borrador.')

    // original_* puede llegar como null explícito (limpiar) o undefined (no tocar)
    const origPriceProvided    = originalUnitPrice       !== undefined
    const origCurrProvided     = originalCurrency        !== undefined
    const origRateProvided     = appliedExchangeRate     !== undefined
    const origRateDateProvided = appliedExchangeRateDate !== undefined
    const packOptProvided      = packOptionId            !== undefined
    const packFactorProvided   = packFactor              !== undefined

    // Si cambia packFactor o quantity, recalcular quantity_base
    const factor = packFactorProvided && packFactor != null
      ? parseFloat(packFactor) : null

    const { rows } = await client.query(
      `UPDATE sales_order_lines SET
         product_id                 = COALESCE($1,  product_id),
         quantity                   = COALESCE($2,  quantity),
         unit                       = COALESCE($3,  unit),
         unit_price                 = COALESCE($4,  unit_price),
         discount_pct               = COALESCE($5,  discount_pct),
         notes                      = COALESCE($6,  notes),
         original_unit_price        = CASE WHEN $9::boolean  THEN $7::numeric            ELSE original_unit_price        END,
         original_currency          = CASE WHEN $10::boolean THEN $8::document_currency  ELSE original_currency          END,
         applied_exchange_rate      = CASE WHEN $11::boolean THEN $12::numeric           ELSE applied_exchange_rate      END,
         applied_exchange_rate_date = CASE WHEN $13::boolean THEN $14::date              ELSE applied_exchange_rate_date END,
         pack_option_id             = CASE WHEN $15::boolean THEN $16::uuid              ELSE pack_option_id             END,
         pack_factor                = CASE WHEN $17::boolean THEN $18::numeric           ELSE pack_factor                END,
         quantity_base              = CASE
                                        WHEN $17::boolean OR $2::numeric IS NOT NULL THEN
                                          COALESCE($2::numeric, quantity) *
                                          COALESCE(CASE WHEN $17::boolean THEN $18::numeric END, pack_factor)
                                        ELSE quantity_base
                                      END
       WHERE id = $19 AND sales_order_id = $20 RETURNING *`,
      [productId || null, quantity || null, unit || null, unitPrice || null,
       discountPct ?? null, notes || null,
       origPriceProvided ? originalUnitPrice : null,
       origCurrProvided  ? (originalCurrency || null) : null,
       origPriceProvided, origCurrProvided, origRateProvided,
       origRateProvided  ? appliedExchangeRate : null,
       origRateDateProvided, origRateDateProvided ? (appliedExchangeRateDate || null) : null,
       packOptProvided,    packOptProvided    ? (packOptionId || null) : null,
       packFactorProvided, factor,
       lineId, orderId]
    )
    if (rows.length === 0) throw createError(404, 'Línea no encontrada.')

    await recalcOrderTotals(client, orderId)
    return rows[0]
  })
}

/**
 * Elimina una línea de un pedido en draft.
 */
async function deleteOrderLine({ tenantId, orderId, lineId }) {
  return withTransaction(async (client) => {
    const { rows: order } = await client.query(
      `SELECT id FROM sales_orders WHERE id = $1 AND tenant_id = $2 AND status = 'draft'`,
      [orderId, tenantId]
    )
    if (order.length === 0) throw createError(404, 'Pedido no encontrado o ya no está en borrador.')

    const { rows } = await client.query(
      `DELETE FROM sales_order_lines WHERE id = $1 AND sales_order_id = $2 RETURNING id`,
      [lineId, orderId]
    )
    if (rows.length === 0) throw createError(404, 'Línea no encontrada.')

    await recalcOrderTotals(client, orderId)
    return true
  })
}

async function recalcOrderTotals(client, orderId) {
  const { rows: order } = await client.query(
    `SELECT currency, exchange_rate_value FROM sales_orders WHERE id = $1`, [orderId]
  )
  const factor = order[0].currency === 'USD' ? parseFloat(order[0].exchange_rate_value) : 1
  const { rows } = await client.query(
    `SELECT COALESCE(SUM(subtotal), 0) AS subtotal FROM sales_order_lines WHERE sales_order_id = $1`,
    [orderId]
  )
  const subtotal = parseFloat(rows[0].subtotal)
  // Pedidos sin IVA — ver nota en createOrder. IVA se agrega al facturar.
  const tax = 0
  await client.query(
    `UPDATE sales_orders SET subtotal_mxn = $1, tax_mxn = $2, total_mxn = $3 WHERE id = $4`,
    [subtotal * factor, tax, subtotal * factor, orderId]
  )
}

function createError(status, message) {
  const err = new Error(message)
  err.status = status
  return err
}

/**
 * Calcula el saldo pendiente del pedido por producto/línea, considerando
 * todas las remisiones no canceladas.
 *
 * Devuelve un array por línea del pedido con:
 *   { lineId, productId, productName, sku, unit, unitPrice, discountPct, notes,
 *     qtyOrdered, qtyRemisioned, qtyPending }
 */
async function getOrderDeliveryBreakdown(client, { tenantId, orderId }) {
  const exec = client || { query: (...args) => query(...args) }

  // Validar pedido del tenant
  const { rows: orderRows } = await exec.query(
    `SELECT id FROM sales_orders WHERE id = $1 AND tenant_id = $2`,
    [orderId, tenantId]
  )
  if (orderRows.length === 0) throw createError(404, 'Pedido no encontrado.')

  // Líneas del pedido con qty remisionada (sumando todas las remisiones no
  // canceladas que cubran este pedido). El matching es por `dnl.sales_order_id`
  // (migración 077) — esto funciona para remisiones consolidadas donde
  // `dn.sales_order_id` solo apunta al pedido principal.
  //
  // Sub-matching de líneas:
  //   - Si `dnl.sales_order_line_id` está poblado (remisiones post-077),
  //     se cuenta exactamente esa línea (preciso aún con líneas duplicadas).
  //   - Si NO está poblado (remisiones legacy backfilleadas), se cae al
  //     match por `product_id` — riesgo conocido si el pedido tiene dos
  //     líneas del mismo producto, pero conservamos el comportamiento previo.
  const { rows } = await exec.query(
    `SELECT sol.id              AS line_id,
            sol.product_id,
            sol.quantity        AS qty_ordered,
            sol.unit,
            sol.unit_price,
            sol.discount_pct,
            sol.notes,
            p.name              AS product_name,
            p.sku,
            COALESCE(SUM(dnl.quantity_delivered) FILTER (
              WHERE dn.status <> 'cancelled'
            ), 0) AS qty_remisioned,
            -- Facturado: cantidad de invoice_lines no canceladas vinculadas a esta SOL.
            -- Usamos sub-query para no inflar con el JOIN de remisiones.
            COALESCE((
              SELECT SUM(il.quantity)
                FROM invoice_lines il
                JOIN invoices inv ON inv.id = il.invoice_id
               WHERE il.sales_order_line_id = sol.id
                 AND inv.status <> 'cancelled'
            ), 0) AS qty_invoiced
       FROM sales_order_lines sol
       JOIN products p ON p.id = sol.product_id
       LEFT JOIN delivery_note_lines dnl
              ON dnl.sales_order_id = sol.sales_order_id
             AND (
               dnl.sales_order_line_id = sol.id
               OR (dnl.sales_order_line_id IS NULL
                   AND dnl.product_id = sol.product_id)
             )
       LEFT JOIN delivery_notes dn ON dn.id = dnl.delivery_note_id
      WHERE sol.sales_order_id = $1
      GROUP BY sol.id, p.id
      ORDER BY sol.line_number`,
    [orderId]
  )

  return rows.map(r => {
    const qtyOrdered    = parseFloat(r.qty_ordered)
    const qtyRemisioned = parseFloat(r.qty_remisioned)
    const qtyInvoiced   = parseFloat(r.qty_invoiced)
    // Si hay facturación anticipada, el "techo" para entregar es lo facturado.
    // Si no, sigue siendo lo pedido.
    const cap = qtyInvoiced > 0 ? qtyInvoiced : qtyOrdered
    return {
      lineId:        r.line_id,
      productId:     r.product_id,
      productName:   r.product_name,
      sku:           r.sku,
      unit:          r.unit,
      unitPrice:     parseFloat(r.unit_price),
      discountPct:   parseFloat(r.discount_pct),
      notes:         r.notes,
      qtyOrdered,
      qtyInvoiced,
      qtyRemisioned,
      qtyPending:    Math.max(0, cap - qtyRemisioned),
      hasAdvanceInvoice: qtyInvoiced > 0,
    }
  })
}

/**
 * Recalcula el status del pedido en función de las remisiones existentes.
 *
 * Reglas:
 *   - Sin remisiones (o todas canceladas) y status era 'in_delivery'/'partially_delivered'
 *       → no toca el status (puede seguir confirmed/draft según venga de antes).
 *   - Hay al menos una remisión 'delivered' y todo el pedido está cubierto
 *       → 'delivered'.
 *   - Hay al menos una remisión 'delivered' pero falta saldo
 *       → 'partially_delivered'.
 *   - Hay remisiones pero ninguna entregada
 *       → 'in_delivery' (semánticamente "remisionado").
 *
 * Solo aplica si el pedido está en alguno de los estados de flujo
 * (confirmed/in_delivery/partially_delivered). NO toca 'delivered'
 * cancelado o draft retroactivamente.
 */
async function recalcOrderStatusFromDeliveries(client, { tenantId, orderId }) {
  const { rows: orderRows } = await client.query(
    `SELECT status FROM sales_orders WHERE id = $1 AND tenant_id = $2`,
    [orderId, tenantId]
  )
  if (orderRows.length === 0) return null
  const currentStatus = orderRows[0].status

  // No tocar estados terminales o pre-flujo. Incluimos 'invoiced' porque
  // con facturación anticipada el pedido puede entrar a este recálculo:
  //   - Si el pedido ya está 'invoiced' pero cancelan remisiones → vuelve a 'confirmed'.
  //   - Si el pedido está 'confirmed' (con factura adelantada) y cubren todo → 'invoiced'.
  if (!['confirmed', 'in_delivery', 'partially_delivered', 'delivered', 'invoiced'].includes(currentStatus)) {
    return currentStatus
  }

  const breakdown = await getOrderDeliveryBreakdown(client, { tenantId, orderId })

  // ¿Todas las líneas tienen qty_pending = 0?
  const fullyCovered = breakdown.length > 0 && breakdown.every(l => l.qtyPending <= 0)

  // ¿Hay alguna remisión entregada (delivered) que CUBRA este pedido?
  // Consultamos via delivery_note_lines.sales_order_id porque en remisiones
  // consolidadas `delivery_notes.sales_order_id` apunta solo al pedido principal.
  const { rows: delRows } = await client.query(
    `SELECT 1 FROM delivery_notes dn
       JOIN delivery_note_lines dnl ON dnl.delivery_note_id = dn.id
      WHERE dnl.sales_order_id = $1 AND dn.tenant_id = $2 AND dn.status = 'delivered'
      LIMIT 1`,
    [orderId, tenantId]
  )
  const hasDelivered = delRows.length > 0

  // ¿Hay alguna remisión activa (no cancelada) que cubra este pedido?
  const { rows: anyRows } = await client.query(
    `SELECT 1 FROM delivery_notes dn
       JOIN delivery_note_lines dnl ON dnl.delivery_note_id = dn.id
      WHERE dnl.sales_order_id = $1 AND dn.tenant_id = $2 AND dn.status <> 'cancelled'
      LIMIT 1`,
    [orderId, tenantId]
  )
  const hasActiveNote = anyRows.length > 0

  // ¿Hay factura anticipada activa contra este pedido?
  // Se identifica por invoice_lines.sales_order_line_id → sales_order_lines.sales_order_id
  const { rows: invRows } = await client.query(
    `SELECT 1
       FROM invoice_lines il
       JOIN invoices inv         ON inv.id = il.invoice_id
       JOIN sales_order_lines sol ON sol.id = il.sales_order_line_id
      WHERE sol.sales_order_id = $1 AND inv.tenant_id = $2 AND inv.status <> 'cancelled'
      LIMIT 1`,
    [orderId, tenantId]
  )
  const hasActiveInvoice = invRows.length > 0

  let nextStatus = currentStatus
  if (fullyCovered && hasDelivered && hasActiveInvoice) {
    // Todo entregado Y facturado → ciclo completo
    nextStatus = 'invoiced'
  } else if (fullyCovered && hasDelivered) {
    nextStatus = 'delivered'
  } else if (hasDelivered) {
    nextStatus = 'partially_delivered'
  } else if (hasActiveNote) {
    nextStatus = 'in_delivery'
  } else {
    // Sin remisiones activas. Si hay factura anticipada se queda en 'confirmed'
    // (eligible para nuevas remisiones). Sin factura, igual vuelve a 'confirmed'.
    if (currentStatus !== 'confirmed') nextStatus = 'confirmed'
  }

  if (nextStatus !== currentStatus) {
    await client.query(
      `UPDATE sales_orders SET status = $1 WHERE id = $2 AND tenant_id = $3`,
      [nextStatus, orderId, tenantId]
    )
    await client.query(
      `INSERT INTO document_status_log
         (tenant_id, entity_type, entity_id, from_status, to_status, changed_by, notes)
       VALUES ($1, 'sales_order', $2, $3, $4, NULL, 'Recalculado automáticamente desde remisiones')`,
      [tenantId, orderId, currentStatus, nextStatus]
    )
  }

  return nextStatus
}

/**
 * Recalcula y persiste el status de UN pedido desde sus remisiones actuales,
 * en su propia transacción. Sirve para auto-corregir status pegados (ej. un
 * pedido consolidado que quedó en "Remisionado" tras entregar la remisión).
 */
async function recalcOrderStatus({ tenantId, orderId }) {
  return withTransaction(client => recalcOrderStatusFromDeliveries(client, { tenantId, orderId }))
}

module.exports = {
  listOrders, getOrder, createOrder, updateOrder,
  confirmOrder, cancelOrder, deleteOrder, getSuggestedPrice,
  assignDriver,
  addOrderLine, updateOrderLine, deleteOrderLine,
  getOrderDeliveryBreakdown, recalcOrderStatusFromDeliveries, recalcOrderStatus,
  nextOrderNumber,
}
