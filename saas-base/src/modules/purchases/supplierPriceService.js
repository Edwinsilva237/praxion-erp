'use strict'

const { query } = require('../../db')
const { getRateForDate } = require('../exchange-rates/exchangeRateService')

/**
 * Precios por proveedor (espejo de getSuggestedPrice en ventas, para COMPRAS).
 *
 * Sugerencia con prioridad: precio del proveedor (manual o aprendido) →
 * costo estándar del ítem → nulo. Conversión USD→MXN con trazabilidad.
 *
 * `recordLearnedSupplierPrice` lo alimenta automáticamente al crear una OC
 * ('po') o al recibir mercancía ('receipt'). El CRUD lo gestiona la pantalla
 * "Precios por proveedor" (source='manual').
 */

function createError(status, message) {
  const err = new Error(message); err.status = status; return err
}

// ── Sugerencia de precio para una línea de OC ──────────────────────────────
async function getSuggestedSupplierPrice({ tenantId, supplierId, itemType, itemId, currency = 'MXN' }) {
  if (!supplierId || !itemType || !itemId) return null

  // 1) Precio vigente del proveedor (la vista ya prioriza manual sobre aprendido).
  const { rows: sp } = await query(
    `SELECT unit_price, currency, source, supplier_sku, min_order_qty, lead_time_days
       FROM current_supplier_prices
      WHERE tenant_id = $1 AND business_partner_id = $2
        AND item_type = $3 AND item_id = $4`,
    [tenantId, supplierId, itemType, itemId]
  )

  let priceRaw = null, priceCurrency = null, source = null
  let supplierSku = null, minOrderQty = null, leadTimeDays = null
  if (sp.length) {
    priceRaw      = parseFloat(sp[0].unit_price)
    priceCurrency = sp[0].currency
    source        = sp[0].source            // 'manual' | 'po' | 'receipt'
    supplierSku   = sp[0].supplier_sku
    minOrderQty   = sp[0].min_order_qty != null ? parseFloat(sp[0].min_order_qty) : null
    leadTimeDays  = sp[0].lead_time_days
  } else if (itemType === 'raw_material') {
    // 2) Fallback: costo estándar de la MP (en MXN). Los productos de reventa no
    //    tienen un campo de costo de COMPRA, así que ahí se confía en el aprendido.
    const { rows: rm } = await query(
      `SELECT standard_cost FROM raw_materials
        WHERE id = $1 AND tenant_id = $2 AND standard_cost IS NOT NULL`,
      [itemId, tenantId]
    )
    if (rm.length && rm[0].standard_cost != null) {
      priceRaw = parseFloat(rm[0].standard_cost)
      priceCurrency = 'MXN'
      source = 'item_cost'
    }
  }

  // Sin precio: devolvemos al menos el SKU/MOQ del proveedor si existían.
  if (priceRaw == null) {
    return (supplierSku || minOrderQty || leadTimeDays)
      ? { supplierSku, minOrderQty, leadTimeDays }
      : null
  }

  const extra = { source, supplierSku, minOrderQty, leadTimeDays }

  if (priceCurrency === currency) {
    return { unit_price: priceRaw, currency: priceCurrency, ...extra }
  }

  // Conversión USD→MXN (lo común). Otras combinaciones se devuelven sin convertir.
  if (priceCurrency === 'USD' && currency === 'MXN') {
    const today = new Date().toISOString().split('T')[0]
    const rate  = await getRateForDate({ tenantId, date: today, currency: 'USD' })
    if (!rate) {
      return { unit_price: priceRaw, currency: priceCurrency, conversionFailed: true, ...extra }
    }
    const tc = parseFloat(rate.rate_mxn)
    const rateDate = rate.rate_date instanceof Date
      ? rate.rate_date.toISOString().split('T')[0]
      : String(rate.rate_date).slice(0, 10)
    return {
      unit_price:              +(priceRaw * tc).toFixed(4),
      currency,
      source:                  `${source}_converted`,
      originalUnitPrice:       priceRaw,
      originalCurrency:        priceCurrency,
      appliedExchangeRate:     tc,
      appliedExchangeRateDate: rateDate,
      ...extra,
    }
  }

  return { unit_price: priceRaw, currency: priceCurrency, ...extra }
}

// ── Auto-aprendizaje (corre dentro de una transacción → recibe client) ─────
async function recordLearnedSupplierPrice(client, { tenantId, supplierId, itemType, itemId, unitPrice, currency = 'MXN', source = 'po', userId = null }) {
  if (!tenantId || !supplierId || !itemType || !itemId) return
  if (!['po', 'receipt'].includes(source)) return
  const price = parseFloat(unitPrice)
  if (!Number.isFinite(price) || price <= 0) return // no aprender 0 ni inválidos

  await client.query(
    `INSERT INTO supplier_prices
       (tenant_id, business_partner_id, item_type, item_id, currency, unit_price,
        valid_from, source, created_by)
     VALUES ($1,$2,$3,$4,$5,$6, CURRENT_DATE, $7, $8)
     ON CONFLICT (tenant_id, business_partner_id, item_type, item_id, valid_from, source)
     DO UPDATE SET unit_price = EXCLUDED.unit_price,
                   currency   = EXCLUDED.currency,
                   updated_at = now()`,
    [tenantId, supplierId, itemType, itemId, currency, price, source, userId]
  )
}

// Aprende de TODAS las líneas elegibles de una OC/recepción en un solo lugar.
// lines: [{ itemType, itemId, unitPrice, isGeneric? }]
async function learnFromLines(client, { tenantId, supplierId, currency, source, userId, lines }) {
  if (!supplierId || !Array.isArray(lines)) return
  for (const l of lines) {
    if (l.isGeneric) continue
    await recordLearnedSupplierPrice(client, {
      tenantId, supplierId,
      itemType: l.itemType, itemId: l.itemId,
      unitPrice: l.unitPrice, currency, source, userId,
    })
  }
}

// ── Gestión manual (pantalla "Precios por proveedor") ──────────────────────
async function listSupplierPrices({ tenantId, supplierId = null, itemType = null, itemId = null }) {
  const params = [tenantId]
  const filt = []
  if (supplierId) { params.push(supplierId); filt.push(`csp.business_partner_id = $${params.length}`) }
  if (itemType)   { params.push(itemType);   filt.push(`csp.item_type = $${params.length}`) }
  if (itemId)     { params.push(itemId);     filt.push(`csp.item_id = $${params.length}`) }
  const where = filt.length ? `AND ${filt.join(' AND ')}` : ''

  const { rows } = await query(
    `SELECT csp.*, bp.name AS supplier_name,
            COALESCE(rm.name, p.name) AS item_name,
            p.sku AS item_sku
       FROM current_supplier_prices csp
       JOIN business_partners bp ON bp.id = csp.business_partner_id
       LEFT JOIN raw_materials rm ON rm.id = csp.item_id AND csp.item_type = 'raw_material'
       LEFT JOIN products      p  ON p.id  = csp.item_id AND csp.item_type = 'product'
      WHERE csp.tenant_id = $1 ${where}
      ORDER BY bp.name, item_name`,
    params
  )
  return rows
}

async function upsertManualSupplierPrice({
  tenantId, supplierId, itemType, itemId, unitPrice, currency = 'MXN',
  supplierSku = null, minOrderQty = null, leadTimeDays = null, notes = null, userId = null,
}) {
  if (!supplierId) throw createError(400, 'Falta el proveedor.')
  if (!['raw_material', 'product'].includes(itemType)) throw createError(400, 'item_type inválido.')
  if (!itemId) throw createError(400, 'Falta el ítem.')
  const price = parseFloat(unitPrice)
  if (!Number.isFinite(price) || price < 0) throw createError(400, 'Precio inválido.')

  const { rows } = await query(
    `INSERT INTO supplier_prices
       (tenant_id, business_partner_id, item_type, item_id, currency, unit_price,
        supplier_sku, min_order_qty, lead_time_days, valid_from, source, notes, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, CURRENT_DATE, 'manual', $10, $11)
     ON CONFLICT (tenant_id, business_partner_id, item_type, item_id, valid_from, source)
     DO UPDATE SET unit_price     = EXCLUDED.unit_price,
                   currency       = EXCLUDED.currency,
                   supplier_sku   = EXCLUDED.supplier_sku,
                   min_order_qty  = EXCLUDED.min_order_qty,
                   lead_time_days = EXCLUDED.lead_time_days,
                   notes          = EXCLUDED.notes,
                   updated_at     = now()
     RETURNING *`,
    [tenantId, supplierId, itemType, itemId, currency, price,
     supplierSku || null, minOrderQty ?? null, leadTimeDays ?? null, notes || null, userId]
  )
  return rows[0]
}

async function deleteSupplierPrice({ tenantId, id }) {
  const { rowCount } = await query(
    `DELETE FROM supplier_prices WHERE id = $1 AND tenant_id = $2`, [id, tenantId]
  )
  if (!rowCount) throw createError(404, 'Precio no encontrado.')
  return { id }
}

module.exports = {
  getSuggestedSupplierPrice,
  recordLearnedSupplierPrice,
  learnFromLines,
  listSupplierPrices,
  upsertManualSupplierPrice,
  deleteSupplierPrice,
}
