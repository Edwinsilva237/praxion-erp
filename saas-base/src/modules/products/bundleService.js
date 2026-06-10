'use strict'

/**
 * Paquetes de productos (bundles) — mig 203.
 *
 * Un paquete es un combo COMERCIAL de catálogo: productos + cantidades +
 * precio especial. Nunca existe en inventario. Al capturarse en un pedido se
 * "explota" (explodeBundle) en líneas componente con precio PRORRATEADO
 * proporcional al precio de lista — matemáticamente equivale a aplicar el
 * mismo % de descuento implícito a cada componente, así el reporte de
 * utilidad por producto funciona sin cambios.
 *
 * Reglas (acordadas con el usuario 2026-06-10):
 *   - Todos los componentes DEBEN tener precio de lista (base_price > 0):
 *     sin eso no hay base para prorratear.
 *   - El prorrateo usa el precio de LISTA, no precios negociados por cliente.
 *   - El residuo de redondeo (4 decimales) se ajusta en la última línea para
 *     que la suma cuadre con el precio del paquete.
 *   - Componente en USD dentro de paquete MXN (o viceversa): su precio de
 *     lista se convierte con el TC del día SOLO para calcular el peso del
 *     prorrateo. Las líneas emitidas son nativas de la moneda del paquete
 *     (sin original_currency → la factura NO las revalúa).
 */

const { query, withTransaction } = require('../../db')
const { audit } = require('../../utils/audit')
const { getRateForDate } = require('../exchange-rates/exchangeRateService')

function createError(status, message) {
  const err = new Error(message)
  err.status = status
  return err
}

/**
 * Lista paquetes del tenant con conteo de componentes.
 */
async function listBundles({ tenantId, search, isActive, page = 1, limit = 50 }) {
  const offset = (page - 1) * limit
  const params = [tenantId]
  const filters = []

  if (search) {
    params.push(`%${search}%`)
    filters.push(`pb.name ILIKE $${params.length}`)
  }
  if (isActive !== undefined) {
    params.push(isActive)
    filters.push(`pb.is_active = $${params.length}`)
  }

  const where = filters.length ? `AND ${filters.join(' AND ')}` : ''
  params.push(limit, offset)

  const { rows } = await query(
    `SELECT pb.*,
            COUNT(pbi.id)::int AS items_count,
            COALESCE(STRING_AGG(p.name, ' + ' ORDER BY pbi.line_number), '') AS items_summary
       FROM product_bundles pb
       LEFT JOIN product_bundle_items pbi ON pbi.bundle_id = pb.id
       LEFT JOIN products p ON p.id = pbi.product_id
      WHERE pb.tenant_id = $1 ${where}
      GROUP BY pb.id
      ORDER BY pb.is_active DESC, pb.name
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  )

  const { rows: countRows } = await query(
    `SELECT COUNT(*) FROM product_bundles pb WHERE pb.tenant_id = $1 ${where}`,
    params.slice(0, params.length - 2)
  )

  return { data: rows, total: parseInt(countRows[0].count, 10), page, limit }
}

/**
 * Detalle de un paquete con sus componentes (incluye datos del producto y la
 * presentación para que el frontend pueda mostrar la matemática del prorrateo).
 */
async function getBundle({ tenantId, bundleId }) {
  const { rows } = await query(
    `SELECT * FROM product_bundles WHERE id = $1 AND tenant_id = $2`,
    [bundleId, tenantId]
  )
  if (rows.length === 0) return null

  const { rows: items } = await query(
    `SELECT pbi.id, pbi.product_id, pbi.pack_option_id, pbi.quantity, pbi.line_number,
            p.sku, p.name AS product_name, p.base_price, p.base_currency,
            p.base_unit, p.is_active AS product_is_active,
            pko.pack_unit, pko.base_per_pack
       FROM product_bundle_items pbi
       JOIN products p ON p.id = pbi.product_id
       LEFT JOIN product_pack_options pko ON pko.id = pbi.pack_option_id
      WHERE pbi.bundle_id = $1
      ORDER BY pbi.line_number`,
    [bundleId]
  )

  return { ...rows[0], items }
}

/**
 * Valida los componentes contra el catálogo del tenant. Devuelve las filas de
 * producto/presentación necesarias para insertar. Reglas:
 *   - producto existe, está activo y tiene precio de lista > 0
 *   - la presentación (si viene) pertenece al producto
 *   - cantidad > 0
 */
async function validateItems(client, tenantId, items) {
  if (!Array.isArray(items) || items.length === 0) {
    throw createError(400, 'El paquete necesita al menos un producto.')
  }

  const seen = new Set()
  for (const it of items) {
    if (!it.productId) throw createError(400, 'Cada componente necesita un producto.')
    if (seen.has(it.productId)) {
      throw createError(400, 'Un producto no puede repetirse dentro del paquete.')
    }
    seen.add(it.productId)
    if (!(parseFloat(it.quantity) > 0)) {
      throw createError(400, 'Cada componente necesita una cantidad mayor a cero.')
    }
  }

  const productIds = items.map(i => i.productId)
  const { rows: products } = await client.query(
    `SELECT id, name, is_active, base_price, base_currency
       FROM products WHERE tenant_id = $1 AND id = ANY($2::uuid[])`,
    [tenantId, productIds]
  )
  const byId = Object.fromEntries(products.map(p => [p.id, p]))

  for (const it of items) {
    const p = byId[it.productId]
    if (!p) throw createError(404, 'Uno de los productos del paquete no existe.')
    if (!p.is_active) {
      throw createError(400, `El producto "${p.name}" está inactivo — no puede ir en un paquete.`)
    }
    if (p.base_price == null || !(parseFloat(p.base_price) > 0)) {
      throw createError(422,
        `El producto "${p.name}" no tiene precio de lista. Captura su precio en el catálogo antes de incluirlo en un paquete (es la base del prorrateo).`)
    }
  }

  // Presentaciones: deben pertenecer a su producto
  const packIds = items.map(i => i.packOptionId).filter(Boolean)
  if (packIds.length) {
    const { rows: packs } = await client.query(
      `SELECT id, product_id FROM product_pack_options
        WHERE tenant_id = $1 AND id = ANY($2::uuid[])`,
      [tenantId, packIds]
    )
    const packById = Object.fromEntries(packs.map(p => [p.id, p]))
    for (const it of items) {
      if (!it.packOptionId) continue
      const pk = packById[it.packOptionId]
      if (!pk || pk.product_id !== it.productId) {
        throw createError(400, 'La presentación elegida no pertenece al producto del componente.')
      }
    }
  }
}

/**
 * Crea un paquete con sus componentes.
 * items: [{ productId, packOptionId?, quantity }]
 */
async function createBundle({
  tenantId, name, description, bundlePrice, currency = 'MXN', items,
  userId, ipAddress, userAgent,
}) {
  if (!name || !String(name).trim()) throw createError(400, 'El paquete necesita un nombre.')
  if (!(parseFloat(bundlePrice) > 0)) throw createError(400, 'El precio del paquete debe ser mayor a cero.')
  if (!['MXN', 'USD'].includes(currency)) throw createError(400, 'Moneda no soportada.')

  return withTransaction(async (client) => {
    await validateItems(client, tenantId, items)

    const { rows } = await client.query(
      `INSERT INTO product_bundles (tenant_id, name, description, bundle_price, currency)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [tenantId, String(name).trim(), description || null, bundlePrice, currency]
    )
    const bundle = rows[0]

    for (let i = 0; i < items.length; i++) {
      const it = items[i]
      await client.query(
        `INSERT INTO product_bundle_items
           (tenant_id, bundle_id, product_id, pack_option_id, quantity, line_number)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [tenantId, bundle.id, it.productId, it.packOptionId || null, it.quantity, i + 1]
      )
    }

    await audit({
      tenantId, userId, action: 'product_bundle.created',
      resource: 'product_bundles', resourceId: bundle.id,
      payload: { name: bundle.name, bundlePrice, currency, items: items.length },
      ipAddress, userAgent,
    })

    return bundle
  })
}

/**
 * Actualiza un paquete. Si vienen `items`, REEMPLAZA todos los componentes
 * (la edición del paquete siempre manda la lista completa).
 */
async function updateBundle({
  tenantId, bundleId, name, description, bundlePrice, currency, isActive, items,
  userId, ipAddress, userAgent,
}) {
  if (bundlePrice !== undefined && !(parseFloat(bundlePrice) > 0)) {
    throw createError(400, 'El precio del paquete debe ser mayor a cero.')
  }
  if (currency !== undefined && !['MXN', 'USD'].includes(currency)) {
    throw createError(400, 'Moneda no soportada.')
  }

  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `UPDATE product_bundles SET
         name         = COALESCE($1, name),
         description  = COALESCE($2, description),
         bundle_price = COALESCE($3, bundle_price),
         currency     = COALESCE($4, currency),
         is_active    = COALESCE($5, is_active)
       WHERE id = $6 AND tenant_id = $7
       RETURNING *`,
      [name !== undefined ? String(name).trim() : null, description ?? null,
       bundlePrice ?? null, currency ?? null, isActive ?? null,
       bundleId, tenantId]
    )
    if (rows.length === 0) throw createError(404, 'Paquete no encontrado.')

    if (items !== undefined) {
      await validateItems(client, tenantId, items)
      await client.query(`DELETE FROM product_bundle_items WHERE bundle_id = $1`, [bundleId])
      for (let i = 0; i < items.length; i++) {
        const it = items[i]
        await client.query(
          `INSERT INTO product_bundle_items
             (tenant_id, bundle_id, product_id, pack_option_id, quantity, line_number)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [tenantId, bundleId, it.productId, it.packOptionId || null, it.quantity, i + 1]
        )
      }
    }

    await audit({
      tenantId, userId, action: 'product_bundle.updated',
      resource: 'product_bundles', resourceId: bundleId,
      payload: { name, bundlePrice, currency, isActive, itemsReplaced: items !== undefined },
      ipAddress, userAgent,
    })

    return rows[0]
  })
}

/**
 * Borra un paquete del catálogo. Los pedidos históricos NO se tocan: sus
 * líneas conservan bundle_name (snapshot) y bundle_id queda NULL (FK SET NULL).
 */
async function deleteBundle({ tenantId, bundleId, userId, ipAddress, userAgent }) {
  const { rows } = await query(
    `DELETE FROM product_bundles WHERE id = $1 AND tenant_id = $2 RETURNING id, name`,
    [bundleId, tenantId]
  )
  if (rows.length === 0) throw createError(404, 'Paquete no encontrado.')

  await audit({
    tenantId, userId, action: 'product_bundle.deleted',
    resource: 'product_bundles', resourceId: bundleId,
    payload: { name: rows[0].name }, ipAddress, userAgent,
  })

  return rows[0]
}

/**
 * "Explota" el paquete en líneas componente con precio prorrateado.
 *
 * Devuelve las líneas POR UN paquete — el que captura multiplica las
 * cantidades por el número de paquetes (los precios unitarios no cambian,
 * así N paquetes suman exactamente N × precio del paquete, módulo el residuo
 * de redondeo a 4 decimales ya ajustado en la última línea).
 *
 * Prorrateo:
 *   peso_i  = precio_lista_presentación_i × cantidad_i   (en moneda del paquete)
 *   parte_i = precio_paquete × peso_i / Σ pesos
 *   precio_unitario_i = round(parte_i / cantidad_i, 4)   (última línea ajusta residuo)
 */
async function explodeBundle({ tenantId, bundleId }) {
  const bundle = await getBundle({ tenantId, bundleId })
  if (!bundle) throw createError(404, 'Paquete no encontrado.')
  if (!bundle.is_active) throw createError(400, `El paquete "${bundle.name}" está inactivo.`)
  if (!bundle.items.length) throw createError(422, `El paquete "${bundle.name}" no tiene componentes.`)

  const inactive = bundle.items.find(it => !it.product_is_active)
  if (inactive) {
    throw createError(422,
      `El producto "${inactive.product_name}" del paquete está inactivo. Edita el paquete antes de venderlo.`)
  }

  // TC del día — solo si hay que convertir pesos entre monedas
  const needsRate = bundle.items.some(it => (it.base_currency || 'MXN') !== bundle.currency)
  let tc = null
  if (needsRate) {
    const today = new Date().toISOString().split('T')[0]
    const rate = await getRateForDate({ tenantId, date: today, currency: 'USD' })
    if (!rate) {
      throw createError(422,
        'El paquete mezcla monedas y no hay tipo de cambio del día. Sincroniza el TC primero.')
    }
    tc = parseFloat(rate.rate_mxn)
  }

  const bundlePrice = parseFloat(bundle.bundle_price)

  // 1) Peso de cada componente = precio de lista (por presentación) × cantidad
  const lines = bundle.items.map(it => {
    const factor = it.base_per_pack != null ? parseFloat(it.base_per_pack) : 1
    let listUnit = parseFloat(it.base_price) * factor // precio lista por unidad de presentación
    const prodCurrency = it.base_currency || 'MXN'
    if (prodCurrency !== bundle.currency) {
      // USD→MXN multiplica; MXN→USD divide (mismo TC del día)
      listUnit = prodCurrency === 'USD' ? listUnit * tc : listUnit / tc
    }
    const quantity = parseFloat(it.quantity)
    return {
      productId:     it.product_id,
      sku:           it.sku,
      productName:   it.product_name,
      quantity,
      unit:          it.pack_unit || it.base_unit || 'pieza',
      packOptionId:  it.pack_option_id,
      packFactor:    factor,
      baseUnit:      it.base_unit,
      listUnitPrice: +listUnit.toFixed(4),
      weight:        listUnit * quantity,
    }
  })

  const listTotal = lines.reduce((s, l) => s + l.weight, 0)
  if (!(listTotal > 0)) {
    throw createError(422, 'La suma de precios de lista del paquete es cero — revisa los precios de los componentes.')
  }

  // 2) Prorrateo con ajuste de residuo en la última línea
  let assigned = 0
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    if (i < lines.length - 1) {
      const share = bundlePrice * (l.weight / listTotal)
      l.unitPrice = +(share / l.quantity).toFixed(4)
      assigned += l.quantity * l.unitPrice
    } else {
      l.unitPrice = +((bundlePrice - assigned) / l.quantity).toFixed(4)
    }
    l.subtotal = +(l.quantity * l.unitPrice).toFixed(4)
    delete l.weight
  }

  const impliedDiscountPct = +((1 - bundlePrice / listTotal) * 100).toFixed(2)

  return {
    bundle: {
      id:          bundle.id,
      name:        bundle.name,
      bundlePrice,
      currency:    bundle.currency,
      description: bundle.description,
    },
    listTotal: +listTotal.toFixed(4),
    impliedDiscountPct,
    lines,
  }
}

module.exports = {
  listBundles, getBundle, createBundle, updateBundle, deleteBundle,
  explodeBundle,
}
