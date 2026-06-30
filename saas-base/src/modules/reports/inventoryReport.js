'use strict'

// Reporte de inventario a la fecha actual (snapshot de existencias y valor).
// Valor = cantidad × costo promedio (avg_cost) de inventory_stock. Incluye todos
// los estados con existencia (available/reserved/wip/blocked) en almacenes activos.

const { query } = require('../../db')

const WH_TYPE_LABEL = {
  raw_material:     'Materia prima',
  packaging:        'Embalaje',
  wip:              'En proceso',
  finished_product: 'Producto terminado',
  resale:           'Reventa',
  regrind:          'Reciclado',
}

const STATUS_LABEL = {
  available: 'Disponible', reserved: 'Reservado', wip: 'En proceso', blocked: 'Bloqueado',
}

async function getInventoryReport({ tenantId }) {
  const { rows } = await query(`
    SELECT s.item_type, s.item_id, s.warehouse_id, s.status,
           s.quantity::numeric AS quantity, s.unit, s.avg_cost::numeric AS avg_cost,
           w.name AS warehouse_name, w.type AS warehouse_type,
           CASE s.item_type WHEN 'raw_material' THEN rm.name WHEN 'product' THEN p.name END AS item_name,
           CASE s.item_type WHEN 'product' THEN p.sku WHEN 'raw_material' THEN rm.code END AS code,
           COALESCE(rm.resin_type, p.resin_type) AS resin_type
      FROM inventory_stock s
      JOIN warehouses w ON w.id = s.warehouse_id
      LEFT JOIN raw_materials rm ON rm.id = s.item_id AND s.item_type = 'raw_material'
      LEFT JOIN products p       ON p.id  = s.item_id AND s.item_type = 'product'
     WHERE s.tenant_id = $1 AND w.is_active = true AND s.quantity <> 0
  `, [tenantId])

  const items = rows.map(r => {
    const quantity = parseFloat(r.quantity) || 0
    const avgCost  = parseFloat(r.avg_cost) || 0
    return {
      item_type: r.item_type, item_id: r.item_id,
      name: r.item_name || '(sin nombre)', code: r.code || '',
      warehouse_id: r.warehouse_id, warehouse_name: r.warehouse_name,
      warehouse_type: r.warehouse_type,
      warehouse_type_label: WH_TYPE_LABEL[r.warehouse_type] || r.warehouse_type,
      status: r.status, status_label: STATUS_LABEL[r.status] || r.status,
      quantity, unit: r.unit, avg_cost: avgCost, value: quantity * avgCost,
      resin_type: r.resin_type,
    }
  })

  const totalValue = items.reduce((s, i) => s + i.value, 0)
  const itemKey = (i) => `${i.item_type}:${i.item_id}`

  // ── Por almacén ──
  const whMap = new Map()
  for (const it of items) {
    let w = whMap.get(it.warehouse_id)
    if (!w) w = whMap.set(it.warehouse_id, {
      warehouse_id: it.warehouse_id, name: it.warehouse_name,
      type: it.warehouse_type, label: it.warehouse_type_label,
      value: 0, items: new Set(),
    }).get(it.warehouse_id)
    w.value += it.value; w.items.add(itemKey(it))
  }
  const byWarehouse = [...whMap.values()]
    .map(w => ({ warehouse_id: w.warehouse_id, name: w.name, type: w.type, label: w.label,
                 value: w.value, items: w.items.size, pct: totalValue ? (w.value / totalValue) * 100 : 0 }))
    .sort((a, b) => b.value - a.value)

  // ── Por tipo de almacén (MP / PT / reventa / etc.) ──
  const wtMap = new Map()
  for (const it of items) {
    let g = wtMap.get(it.warehouse_type)
    if (!g) g = wtMap.set(it.warehouse_type, { type: it.warehouse_type, label: it.warehouse_type_label, value: 0, items: new Set() }).get(it.warehouse_type)
    g.value += it.value; g.items.add(itemKey(it))
  }
  const byWarehouseType = [...wtMap.values()]
    .map(g => ({ type: g.type, label: g.label, value: g.value, items: g.items.size, pct: totalValue ? (g.value / totalValue) * 100 : 0 }))
    .sort((a, b) => b.value - a.value)

  // ── Top artículos por valor (sumando almacenes) ──
  const itemAgg = new Map()
  for (const it of items) {
    const k = itemKey(it)
    let g = itemAgg.get(k)
    if (!g) g = itemAgg.set(k, { name: it.name, code: it.code, item_type: it.item_type, unit: it.unit, value: 0, quantity: 0 }).get(k)
    g.value += it.value; g.quantity += it.quantity
  }
  const topItems = [...itemAgg.values()].sort((a, b) => b.value - a.value).slice(0, 15)

  // ── Alertas ──
  const zeroCost = items.filter(i => i.avg_cost === 0 && i.quantity > 0)
    .sort((a, b) => b.quantity - a.quantity)
  const negative = items.filter(i => i.quantity < 0)
    .sort((a, b) => a.value - b.value)

  return {
    generated_at: new Date().toISOString(),
    totals: {
      total_value: totalValue,
      distinct_items: new Set(items.map(itemKey)).size,
      warehouses: byWarehouse.length,
      lines: items.length,
      zero_cost_count: zeroCost.length,
      negative_count: negative.length,
    },
    by_warehouse: byWarehouse,
    by_warehouse_type: byWarehouseType,
    items: items.sort((a, b) => b.value - a.value),
    top_items: topItems,
    alerts: { zero_cost: zeroCost, negative },
  }
}

module.exports = { getInventoryReport, WH_TYPE_LABEL, STATUS_LABEL }
