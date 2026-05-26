'use strict'

const { query } = require('../../db')
const createError = require('http-errors')

const VALID_TYPES = ['raw_material', 'product']

async function getLevelsByItem({ tenantId, itemType, itemId }) {
  if (!VALID_TYPES.includes(itemType)) {
    throw createError(400, 'itemType invalido.')
  }

  const itemTable = itemType === 'raw_material' ? 'raw_materials' : 'products'
  const { rows: itemRows } = await query(
    `SELECT id, name, lead_time_days,
            ${itemType === 'product' ? 'sku,' : ''}
            is_active
     FROM ${itemTable}
     WHERE id = $1 AND tenant_id = $2`,
    [itemId, tenantId]
  )
  if (!itemRows[0]) throw createError(404, 'Item no encontrado.')

  const { rows: levels } = await query(
    `SELECT
       il.*,
       w.name AS warehouse_name,
       w.type AS warehouse_type,
       COALESCE(s.quantity, 0)::numeric AS current_stock,
       COALESCE(s.unit, $4::text) AS unit,
       COALESCE(s.avg_cost, 0)::numeric AS avg_cost,
       u.full_name AS updated_by_name
     FROM inventory_levels il
     JOIN warehouses w ON w.id = il.warehouse_id
     LEFT JOIN inventory_stock s ON s.warehouse_id = il.warehouse_id
       AND s.item_type = il.item_type AND s.item_id = il.item_id
       AND s.status = 'available'
     LEFT JOIN users u ON u.id = il.updated_by
     WHERE il.tenant_id = $1
       AND il.item_type = $2::inventory_item_type
       AND il.item_id = $3
     ORDER BY w.type, w.name`,
    [tenantId, itemType, itemId, itemType === 'raw_material' ? 'kg' : 'pza']
  )

  return { item: itemRows[0], levels }
}

async function upsertLevel({
  tenantId, itemType, itemId, warehouseId,
  minStock, maxStock, reorderPoint, safetyStock,
  isManualReorderPoint, lastCalculatedAvg, notes, userId,
}) {
  if (!VALID_TYPES.includes(itemType)) throw createError(400, 'itemType invalido.')
  if (!warehouseId) throw createError(400, 'warehouseId es obligatorio.')

  const min   = parseFloat(minStock || 0)
  const max   = maxStock != null && maxStock !== '' ? parseFloat(maxStock) : null
  const reord = parseFloat(reorderPoint || 0)
  const safe  = parseFloat(safetyStock || 0)

  if (min < 0 || reord < 0 || safe < 0) {
    throw createError(400, 'Los valores no pueden ser negativos.')
  }
  if (max != null && max < min) {
    throw createError(400, 'El stock maximo debe ser mayor o igual al minimo.')
  }

  const { rows: whRows } = await query(
    `SELECT id, type FROM warehouses WHERE id = $1 AND tenant_id = $2 AND is_active = true`,
    [warehouseId, tenantId]
  )
  if (!whRows[0]) throw createError(404, 'Almacen no encontrado o inactivo.')

  const { rows } = await query(
    `INSERT INTO inventory_levels
       (tenant_id, item_type, item_id, warehouse_id,
        min_stock, max_stock, reorder_point, safety_stock,
        is_manual_reorder_point, last_calculated_avg, last_calculated_at,
        notes, updated_by)
     VALUES (
       $1::uuid,
       $2::inventory_item_type,
       $3::uuid,
       $4::uuid,
       $5::numeric,
       $6::numeric,
       $7::numeric,
       $8::numeric,
       $9::boolean,
       $10::numeric,
       CASE WHEN $10::numeric IS NOT NULL THEN NOW() ELSE NULL END,
       $11::text,
       $12::uuid
     )
     ON CONFLICT (tenant_id, item_type, item_id, warehouse_id) DO UPDATE SET
       min_stock                = EXCLUDED.min_stock,
       max_stock                = EXCLUDED.max_stock,
       reorder_point            = EXCLUDED.reorder_point,
       safety_stock             = EXCLUDED.safety_stock,
       is_manual_reorder_point  = EXCLUDED.is_manual_reorder_point,
       last_calculated_avg      = COALESCE(EXCLUDED.last_calculated_avg, inventory_levels.last_calculated_avg),
       last_calculated_at       = CASE
         WHEN EXCLUDED.last_calculated_avg IS NOT NULL THEN NOW()
         ELSE inventory_levels.last_calculated_at
       END,
       notes                    = EXCLUDED.notes,
       updated_by               = EXCLUDED.updated_by,
       updated_at               = NOW()
     RETURNING *`,
    [
      tenantId, itemType, itemId, warehouseId,
      min, max, reord, safe,
      !!isManualReorderPoint,
      lastCalculatedAvg != null ? parseFloat(lastCalculatedAvg) : null,
      notes || null,
      userId,
    ]
  )
  return rows[0]
}

async function removeLevel({ tenantId, itemType, itemId, warehouseId }) {
  const { rowCount } = await query(
    `DELETE FROM inventory_levels
     WHERE tenant_id = $1
       AND item_type = $2::inventory_item_type
       AND item_id = $3
       AND warehouse_id = $4`,
    [tenantId, itemType, itemId, warehouseId]
  )
  return { deleted: rowCount > 0 }
}

async function suggestReorderPoint({
  tenantId, itemType, itemId, warehouseId, leadTimeDays = 7, safetyStock = 0, days = 90,
}) {
  if (!VALID_TYPES.includes(itemType)) throw createError(400, 'itemType invalido.')

  const outflowTypes = [
    'sale_exit',
    'production_mp_consumption',
    'adjustment_out',
    'scrap_disposal',
    'transfer_out',
  ]

  const { rows: hist } = await query(
    `SELECT
       SUM(ABS(quantity))::float                      AS total_out,
       COUNT(DISTINCT DATE(created_at))::int          AS days_with_mov,
       MIN(created_at)                                 AS first_mov_at
     FROM inventory_movements
     WHERE tenant_id = $1
       AND item_type = $2::inventory_item_type
       AND item_id   = $3
       AND warehouse_id = $4
       AND movement_type = ANY($5)
       AND quantity < 0
       AND created_at >= NOW() - ($6 || ' days')::interval`,
    [tenantId, itemType, itemId, warehouseId, outflowTypes, days]
  )

  const row          = hist[0] || {}
  const totalOut     = parseFloat(row.total_out || 0)
  const daysWithMov  = parseInt(row.days_with_mov || 0)
  const dailyAvg     = days > 0 ? totalOut / days : 0
  const reliable     = daysWithMov >= 30

  const lead = parseInt(leadTimeDays || 0)
  const safe = parseFloat(safetyStock || 0)
  const suggested = (dailyAvg * lead) + safe

  return {
    daysAnalyzed:          days,
    totalOutflow:          parseFloat(totalOut.toFixed(4)),
    daysWithMovement:      daysWithMov,
    dailyAvg:              parseFloat(dailyAvg.toFixed(4)),
    leadTimeDays:          lead,
    safetyStock:           safe,
    suggestedReorderPoint: parseFloat(suggested.toFixed(4)),
    reliable,
  }
}

async function listWithStatus({ tenantId, status }) {
  const params = [tenantId]
  let statusFilter = ''
  if (status) {
    params.push(status)
    statusFilter = `WHERE (CASE
        WHEN current_stock < min_stock                            THEN 'below_min'
        WHEN current_stock < reorder_point                        THEN 'at_reorder'
        WHEN max_stock IS NOT NULL AND current_stock > max_stock  THEN 'overstock'
        ELSE 'normal'
      END) = $2::text`
  }

  const { rows } = await query(
    `WITH lvl AS (
      SELECT
        il.*,
        w.name AS warehouse_name,
        w.type AS warehouse_type,
        CASE il.item_type
          WHEN 'raw_material'::inventory_item_type THEN rm.name
          WHEN 'product'::inventory_item_type      THEN p.name
        END AS item_name,
        CASE il.item_type
          WHEN 'raw_material'::inventory_item_type THEN rm.is_active
          WHEN 'product'::inventory_item_type      THEN p.is_active
        END AS item_active,
        CASE il.item_type
          WHEN 'product'::inventory_item_type THEN p.sku
          ELSE NULL
        END AS sku,
        COALESCE(s.quantity, 0)::numeric AS current_stock,
        COALESCE(s.unit,
          CASE il.item_type
            WHEN 'raw_material'::inventory_item_type THEN 'kg'
            ELSE 'pza'
          END
        ) AS unit,
        COALESCE(s.avg_cost, 0)::numeric AS avg_cost,
        -- En tránsito = SUM(pol.quantity − lo recibido en recepciones confirmadas)
        -- sobre OCs activas (sent | partially_received) que entregan a este almacén.
        COALESCE((
          SELECT SUM(
            pol.quantity - COALESCE((
              SELECT SUM(srl.quantity_received)
                FROM supplier_receipt_lines srl
                JOIN supplier_receipts sr ON sr.id = srl.supplier_receipt_id
               WHERE srl.purchase_order_line_id = pol.id
                 AND sr.status = 'confirmed'
            ), 0)
          )
          FROM purchase_order_lines pol
          JOIN purchase_orders po ON po.id = pol.purchase_order_id
          WHERE po.tenant_id = il.tenant_id
            AND po.status IN ('sent', 'partially_received')
            AND pol.item_type = il.item_type
            AND pol.item_id   = il.item_id
            AND pol.warehouse_id = il.warehouse_id
        ), 0)::numeric AS in_transit
      FROM inventory_levels il
      JOIN warehouses w ON w.id = il.warehouse_id
      LEFT JOIN raw_materials rm ON rm.id = il.item_id AND il.item_type = 'raw_material'::inventory_item_type
      LEFT JOIN products p       ON p.id  = il.item_id AND il.item_type = 'product'::inventory_item_type
      LEFT JOIN inventory_stock s ON s.warehouse_id = il.warehouse_id
        AND s.item_type = il.item_type AND s.item_id = il.item_id
        AND s.status = 'available'
      WHERE il.tenant_id = $1
    )
    SELECT *,
      CASE
        WHEN current_stock < min_stock                            THEN 'below_min'
        WHEN current_stock < reorder_point                        THEN 'at_reorder'
        WHEN max_stock IS NOT NULL AND current_stock > max_stock  THEN 'overstock'
        ELSE 'normal'
      END AS status_calc
    FROM lvl
    ${statusFilter}
    ORDER BY
      CASE
        WHEN current_stock < min_stock THEN 1
        WHEN current_stock < reorder_point THEN 2
        WHEN max_stock IS NOT NULL AND current_stock > max_stock THEN 3
        ELSE 4
      END,
      item_name`,
    params
  )
  return rows
}

async function countByStatus({ tenantId }) {
  const { rows } = await query(
    `WITH lvl AS (
      SELECT
        il.id, il.min_stock, il.reorder_point, il.max_stock,
        COALESCE(s.quantity, 0)::numeric AS current_stock
      FROM inventory_levels il
      LEFT JOIN inventory_stock s ON s.warehouse_id = il.warehouse_id
        AND s.item_type = il.item_type AND s.item_id = il.item_id
        AND s.status = 'available'
      WHERE il.tenant_id = $1
    )
    SELECT
      COUNT(*) FILTER (WHERE current_stock < min_stock)                                                   AS below_min,
      COUNT(*) FILTER (WHERE current_stock >= min_stock AND current_stock < reorder_point)                AS at_reorder,
      COUNT(*) FILTER (WHERE current_stock >= reorder_point AND (max_stock IS NULL OR current_stock <= max_stock)) AS normal,
      COUNT(*) FILTER (WHERE max_stock IS NOT NULL AND current_stock > max_stock)                          AS overstock,
      COUNT(*)                                                                                              AS total_configured
    FROM lvl`,
    [tenantId]
  )
  const r = rows[0] || {}
  return {
    below_min:        parseInt(r.below_min || 0),
    at_reorder:       parseInt(r.at_reorder || 0),
    normal:           parseInt(r.normal || 0),
    overstock:        parseInt(r.overstock || 0),
    total_configured: parseInt(r.total_configured || 0),
  }
}

/**
 * Devuelve TODA la informacion de un (item x almacen) en una sola llamada:
 *   - item: datos del producto/MP (nombre, sku, lead_time)
 *   - stock: cantidad actual + costo promedio + valor + ultimo movimiento
 *   - level: niveles configurados (min/max/reorden/seguridad/status)
 *   - movements: ultimos 5 movimientos del kardex de ese item en ese almacen
 *
 * Usado por el panel lateral de detalle en Inventario.
 */
async function getItemDetail({ tenantId, itemType, itemId, warehouseId }) {
  if (!VALID_TYPES.includes(itemType)) throw createError(400, 'itemType invalido.')
  if (!itemId) throw createError(400, 'itemId es obligatorio.')
  if (!warehouseId) throw createError(400, 'warehouseId es obligatorio.')

  // 1. Datos del item
  const itemTable = itemType === 'raw_material' ? 'raw_materials' : 'products'
  const itemFields = itemType === 'raw_material'
    ? `id, name, lead_time_days, resin_type, material_type, unit, cost_per_kg, is_active`
    : `id, name, sku, lead_time_days, type, resin_type, sale_unit, units_per_package, is_active`

  const { rows: itemRows } = await query(
    `SELECT ${itemFields} FROM ${itemTable} WHERE id = $1 AND tenant_id = $2`,
    [itemId, tenantId]
  )
  if (!itemRows[0]) throw createError(404, 'Item no encontrado.')
  const item = itemRows[0]

  // 2. Datos del almacen
  const { rows: whRows } = await query(
    `SELECT id, name, type, is_default
     FROM warehouses WHERE id = $1 AND tenant_id = $2`,
    [warehouseId, tenantId]
  )
  if (!whRows[0]) throw createError(404, 'Almacen no encontrado.')
  const warehouse = whRows[0]

  // 3. Stock actual en ese almacen (puede no existir => stock = 0)
  const { rows: stockRows } = await query(
    `SELECT
       quantity::numeric AS quantity,
       unit,
       avg_cost::numeric AS avg_cost,
       (quantity * avg_cost)::numeric AS total_value,
       last_movement_at,
       status
     FROM inventory_stock
     WHERE tenant_id = $1
       AND warehouse_id = $2
       AND item_type = $3::inventory_item_type
       AND item_id = $4
       AND status = 'available'
     LIMIT 1`,
    [tenantId, warehouseId, itemType, itemId]
  )
  const defaultUnit = itemType === 'raw_material' ? (item.unit || 'kg') : 'pza'
  const stock = stockRows[0] || {
    quantity: 0,
    unit: defaultUnit,
    avg_cost: 0,
    total_value: 0,
    last_movement_at: null,
    status: 'available',
  }

  // 4. Nivel configurado para (item x almacen) con status calculado
  const { rows: levelRows } = await query(
    `SELECT
       il.*,
       CASE
         WHEN $5::numeric < il.min_stock                                     THEN 'below_min'
         WHEN $5::numeric < il.reorder_point                                 THEN 'at_reorder'
         WHEN il.max_stock IS NOT NULL AND $5::numeric > il.max_stock        THEN 'overstock'
         ELSE 'normal'
       END AS status_calc
     FROM inventory_levels il
     WHERE il.tenant_id = $1
       AND il.item_type = $2::inventory_item_type
       AND il.item_id = $3
       AND il.warehouse_id = $4`,
    [tenantId, itemType, itemId, warehouseId, parseFloat(stock.quantity || 0)]
  )
  const level = levelRows[0] || null

  // 5. Ultimos 5 movimientos
  const { rows: movements } = await query(
    `SELECT
       id, created_at, movement_type, quantity::numeric AS quantity, unit,
       unit_cost::numeric AS unit_cost,
       balance_after::numeric AS balance_after,
       reference_type, notes
     FROM inventory_movements
     WHERE tenant_id = $1
       AND warehouse_id = $2
       AND item_type = $3::inventory_item_type
       AND item_id = $4
     ORDER BY created_at DESC
     LIMIT 5`,
    [tenantId, warehouseId, itemType, itemId]
  )

  // 6. Sugerencia de reorden:
  //    - Si max_stock esta definido => max - current
  //    - Si NO => reorder_point + safety - current
  //    - Minimo 0
  let suggestedQty = 0
  if (level) {
    if (level.max_stock != null) {
      suggestedQty = parseFloat(level.max_stock) - parseFloat(stock.quantity || 0)
    } else {
      suggestedQty = parseFloat(level.reorder_point || 0) + parseFloat(level.safety_stock || 0) - parseFloat(stock.quantity || 0)
    }
    suggestedQty = Math.max(0, suggestedQty)
  }

  // 7. En tránsito: cantidad pendiente de recibir en OCs activas que entregan
  //    a este almacén específico. Calculado en runtime — no requiere tablas
  //    adicionales y siempre refleja el estado actual.
  const { rows: transitRows } = await query(
    `SELECT COALESCE(SUM(
        pol.quantity - COALESCE((
          SELECT SUM(srl.quantity_received)
            FROM supplier_receipt_lines srl
            JOIN supplier_receipts sr ON sr.id = srl.supplier_receipt_id
           WHERE srl.purchase_order_line_id = pol.id
             AND sr.status = 'confirmed'
        ), 0)
      ), 0)::numeric AS in_transit
     FROM purchase_order_lines pol
     JOIN purchase_orders po ON po.id = pol.purchase_order_id
     WHERE po.tenant_id = $1
       AND po.status IN ('sent', 'partially_received')
       AND pol.item_type    = $2::inventory_item_type
       AND pol.item_id      = $3
       AND pol.warehouse_id = $4`,
    [tenantId, itemType, itemId, warehouseId]
  )
  const inTransit = parseFloat(transitRows[0]?.in_transit || 0)

  // OCs activas pendientes (para el desglose en UI)
  const { rows: pendingOrders } = await query(
    `SELECT po.id, po.order_number, po.status, po.expected_date,
            bp.name AS partner_name,
            (pol.quantity - COALESCE((
              SELECT SUM(srl.quantity_received)
                FROM supplier_receipt_lines srl
                JOIN supplier_receipts sr ON sr.id = srl.supplier_receipt_id
               WHERE srl.purchase_order_line_id = pol.id
                 AND sr.status = 'confirmed'
            ), 0))::numeric AS qty_pending
       FROM purchase_order_lines pol
       JOIN purchase_orders po       ON po.id = pol.purchase_order_id
       LEFT JOIN business_partners bp ON bp.id = po.partner_id
      WHERE po.tenant_id = $1
        AND po.status IN ('sent', 'partially_received')
        AND pol.item_type    = $2::inventory_item_type
        AND pol.item_id      = $3
        AND pol.warehouse_id = $4
      ORDER BY po.expected_date NULLS LAST, po.created_at`,
    [tenantId, itemType, itemId, warehouseId]
  )
  const pendingOrdersActive = pendingOrders.filter(o => parseFloat(o.qty_pending) > 0.0001)

  return {
    item,
    warehouse,
    stock,
    level,
    movements,
    suggestedQty: parseFloat(suggestedQty.toFixed(4)),
    inTransit,
    pendingOrders: pendingOrdersActive,
  }
}

module.exports = {
  getLevelsByItem,
  upsertLevel,
  removeLevel,
  suggestReorderPoint,
  listWithStatus,
  countByStatus,
  getItemDetail,
}
