'use strict'

// Reporte de inventario:
//   - Modo ACTUAL (sin countId): snapshot vivo de inventory_stock a la fecha de hoy.
//   - Modo CIERRE DE MES (countId): reconstruye el inventario tal como quedó en un
//     conteo (month_close/cyclic) usando la FOTO inmutable de inventory_count_lines
//     (system_qty/system_avg_cost congelados + captura física). El "inventario al
//     cierre" = cantidad final (física si se capturó, si no la del sistema) × costo.
// Valor = cantidad × costo promedio. Misma forma de salida en ambos modos para que
// los generadores de Excel/PDF se reusen tal cual (solo cambian los títulos vía meta).

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

// ── Ítems del inventario ACTUAL (inventory_stock vivo) ──
async function getCurrentItems(tenantId) {
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

  return rows.map(r => {
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
}

// ── Ítems del inventario AL CIERRE (foto de inventory_count_lines) ──
// Devuelve { items, meta } o lanza 404 si el conteo no existe.
async function getCountItems(tenantId, countId) {
  const { rows: hdr } = await query(
    `SELECT ic.id, ic.count_number, ic.count_type, ic.count_date, ic.status,
            ic.applied_at, ic.scope, ic.warehouse_id, w.name AS warehouse_name
       FROM inventory_counts ic
       LEFT JOIN warehouses w ON w.id = ic.warehouse_id
      WHERE ic.id = $1 AND ic.tenant_id = $2`,
    [countId, tenantId]
  )
  if (!hdr[0]) { const e = new Error('Conteo no encontrado.'); e.status = 404; throw e }
  const c = hdr[0]

  const { rows } = await query(`
    SELECT icl.item_type, icl.item_id, icl.warehouse_id, icl.status AS line_status, icl.unit,
           icl.system_qty::numeric      AS system_qty,
           icl.physical_qty::numeric    AS physical_qty,
           icl.system_avg_cost::numeric AS system_avg_cost,
           icl.captured_unit_cost::numeric AS captured_unit_cost,
           w.name AS warehouse_name, w.type AS warehouse_type,
           CASE icl.item_type WHEN 'raw_material' THEN rm.name WHEN 'product' THEN p.name END AS item_name,
           CASE icl.item_type WHEN 'product' THEN p.sku WHEN 'raw_material' THEN rm.code END AS code,
           COALESCE(rm.resin_type, p.resin_type) AS resin_type
      FROM inventory_count_lines icl
      JOIN warehouses w ON w.id = icl.warehouse_id
      LEFT JOIN raw_materials rm ON rm.id = icl.item_id AND icl.item_type = 'raw_material'
      LEFT JOIN products p       ON p.id  = icl.item_id AND icl.item_type = 'product'
     WHERE icl.count_id = $1
  `, [countId])

  const items = rows.map(r => {
    const physical = r.physical_qty == null ? null : parseFloat(r.physical_qty)
    const systemQty = parseFloat(r.system_qty) || 0
    // Inventario al cierre = física si se capturó; si la línea no se contó, la del sistema.
    const quantity = physical != null ? physical : systemQty
    // Costo endurecido igual que al aplicar el conteo: si el sistema estaba en $0 usa el
    // costo capturado a mano (mig 217).
    const sysCost = parseFloat(r.system_avg_cost) || 0
    const avgCost = sysCost > 0 ? sysCost : (parseFloat(r.captured_unit_cost) || 0)
    return {
      item_type: r.item_type, item_id: r.item_id,
      name: r.item_name || '(sin nombre)', code: r.code || '',
      warehouse_id: r.warehouse_id, warehouse_name: r.warehouse_name,
      warehouse_type: r.warehouse_type,
      warehouse_type_label: WH_TYPE_LABEL[r.warehouse_type] || r.warehouse_type,
      status: r.line_status,
      status_label: physical != null ? 'Contado' : 'No contado (sistema)',
      quantity, unit: r.unit, avg_cost: avgCost, value: quantity * avgCost,
      resin_type: r.resin_type,
    }
  }).filter(i => i.quantity !== 0)   // ignora renglones que quedaron en 0 al cierre

  const meta = {
    mode: 'month_close',
    count_id: c.id,
    count_number: c.count_number,
    count_type: c.count_type,
    count_date: c.count_date,
    count_status: c.status,
    applied_at: c.applied_at,
    scope: c.scope,
    // scope != 'all' → la valuación cubre solo los artículos incluidos en el conteo.
    partial_scope: c.scope !== 'all',
    warehouse_name: c.warehouse_name || null,
    as_of_label: `Al cierre ${c.count_number}${c.count_date ? ' · ' + new Date(c.count_date).toLocaleDateString('es-MX') : ''}`,
  }
  return { items, meta }
}

// ── Agregación común (idéntica en ambos modos) ──
function buildReport(items, meta) {
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
    meta,
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

async function getInventoryReport({ tenantId, countId = null }) {
  if (countId) {
    const { items, meta } = await getCountItems(tenantId, countId)
    return buildReport(items, meta)
  }
  const items = await getCurrentItems(tenantId)
  return buildReport(items, { mode: 'current', as_of_label: `Generado el ${new Date().toLocaleString('es-MX')}` })
}

module.exports = { getInventoryReport, WH_TYPE_LABEL, STATUS_LABEL }
