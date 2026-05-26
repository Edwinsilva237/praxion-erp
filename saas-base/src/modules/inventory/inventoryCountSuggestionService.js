'use strict'

const { query } = require('../../db')
const createError = require('http-errors')

/**
 * Sugerencia inteligente de items a contar.
 *
 * Calcula un score 0-100 por item × almacén combinando:
 *   - Rotación (clasificación ABC sobre últimos 90d): A=100, B=60, C=20
 *   - Diferencias históricas (últimos 12m): 0/50/100 según frecuencia
 *   - Tiempo sin contar: 0/30/60/80/100 escalonado
 *   - Valor del inventario actual: 100/60/20 según ranking
 *
 * El usuario configura los pesos (default 40/30/20/10).
 * Si la aleatoriedad está activa (default 15%), score_final = score_base * 0.85 + random * 0.15
 *
 * Retorna los N items con score más alto + breakdown explicativo.
 */

const OUTFLOW_TYPES = [
  'sale_exit',
  'production_mp_consumption',
  'adjustment_out',
  'scrap_disposal',
  'transfer_out',
]

async function suggestItemsToCount({
  tenantId, warehouseId, count = 25,
  weights = { rotation: 40, history: 30, time: 20, value: 10 },
  randomness = 15,
  excludeRecentlyCountedDays = null,
}) {
  if (!warehouseId) throw createError(400, 'warehouseId es requerido para sugerir items.')
  if (count < 1 || count > 500) throw createError(400, 'count debe estar entre 1 y 500.')

  // Normalizar pesos a porcentaje (suma = 100)
  const w = {
    rotation: parseFloat(weights.rotation || 0),
    history:  parseFloat(weights.history  || 0),
    time:     parseFloat(weights.time     || 0),
    value:    parseFloat(weights.value    || 0),
  }
  const sum = w.rotation + w.history + w.time + w.value
  if (sum <= 0) throw createError(400, 'Los pesos deben sumar más de 0.')

  const wRotation = w.rotation / sum
  const wHistory  = w.history  / sum
  const wTime     = w.time     / sum
  const wValue    = w.value    / sum

  const rnd = parseFloat(randomness || 0)
  if (rnd < 0 || rnd > 100) throw createError(400, 'randomness debe estar entre 0 y 100.')

  // ── Validar almacén ───────────────────────────────────────────────────────
  const { rows: whRows } = await query(
    `SELECT id, name, type FROM warehouses
     WHERE id = $1 AND tenant_id = $2 AND is_active = true`,
    [warehouseId, tenantId]
  )
  if (!whRows[0]) throw createError(404, 'Almacén no encontrado o inactivo.')

  // ── Query principal ───────────────────────────────────────────────────────
  // CTEs:
  //   1. universe       — items con stock O con niveles configurados (válidos para contar)
  //   2. rotation_stats — valor total movido en últimos 90d
  //   3. abc            — clasificación ABC (A=top 20%, B=siguiente 30%, C=resto)
  //   4. diff_history   — diferencias en conteos previos (12 meses)
  //   5. last_counted   — última fecha que el item fue contado (de conteos aplicados)
  //   6. value_rank     — ranking por valor de inventario actual
  //
  // Score final:
  //   base_score = (rot_score × wR + hist_score × wH + time_score × wT + val_score × wV)
  //   La aleatoriedad se aplica en JS después.

  const params = [tenantId, warehouseId]

  const sql = `
    WITH
    universe AS (
      SELECT
        COALESCE(s.item_type, il.item_type)::inventory_item_type AS item_type,
        COALESCE(s.item_id,   il.item_id)                         AS item_id,
        COALESCE(s.warehouse_id, il.warehouse_id)                 AS warehouse_id,
        COALESCE(s.quantity, 0)::numeric                          AS current_stock,
        COALESCE(s.avg_cost, 0)::numeric                          AS avg_cost,
        (COALESCE(s.quantity, 0) * COALESCE(s.avg_cost, 0))::numeric AS stock_value,
        COALESCE(s.unit,
          CASE COALESCE(s.item_type, il.item_type)
            WHEN 'raw_material' THEN 'kg' ELSE 'pza'
          END
        ) AS unit
      FROM inventory_stock s
      FULL OUTER JOIN inventory_levels il
        ON s.tenant_id = il.tenant_id
        AND s.warehouse_id = il.warehouse_id
        AND s.item_type = il.item_type
        AND s.item_id = il.item_id
      WHERE COALESCE(s.tenant_id, il.tenant_id) = $1
        AND COALESCE(s.warehouse_id, il.warehouse_id) = $2::uuid
        AND COALESCE(s.status, 'available') = 'available'
    ),
    rotation_stats AS (
      SELECT
        m.item_type, m.item_id, m.warehouse_id,
        SUM(ABS(m.quantity * COALESCE(m.unit_cost, 0)))::numeric AS movement_value
      FROM inventory_movements m
      WHERE m.tenant_id = $1
        AND m.warehouse_id = $2::uuid
        AND m.movement_type::text = ANY($3::text[])
        AND m.quantity < 0
        AND m.created_at >= NOW() - INTERVAL '90 days'
      GROUP BY m.item_type, m.item_id, m.warehouse_id
    ),
    abc AS (
      SELECT
        item_type, item_id, warehouse_id,
        movement_value,
        PERCENT_RANK() OVER (ORDER BY movement_value DESC) AS pct_rank,
        CASE
          WHEN PERCENT_RANK() OVER (ORDER BY movement_value DESC) <= 0.20 THEN 'A'
          WHEN PERCENT_RANK() OVER (ORDER BY movement_value DESC) <= 0.50 THEN 'B'
          ELSE 'C'
        END AS abc_class
      FROM rotation_stats
    ),
    diff_history AS (
      SELECT
        icl.item_type, icl.item_id, icl.warehouse_id,
        COUNT(*) FILTER (
          WHERE icl.physical_qty IS NOT NULL
            AND icl.physical_qty <> icl.system_qty
        )::int AS diff_count,
        COALESCE(SUM(
          ABS((icl.physical_qty - icl.system_qty) * icl.system_avg_cost)
        ) FILTER (
          WHERE icl.physical_qty IS NOT NULL
            AND icl.physical_qty <> icl.system_qty
        ), 0)::numeric AS abs_diff_value_total
      FROM inventory_count_lines icl
      JOIN inventory_counts ic ON ic.id = icl.count_id
      WHERE ic.tenant_id = $1
        AND ic.warehouse_id = $2::uuid
        AND ic.status = 'applied'
        AND ic.applied_at >= NOW() - INTERVAL '12 months'
      GROUP BY icl.item_type, icl.item_id, icl.warehouse_id
    ),
    last_counted AS (
      SELECT
        icl.item_type, icl.item_id, icl.warehouse_id,
        MAX(ic.applied_at) AS last_counted_at
      FROM inventory_count_lines icl
      JOIN inventory_counts ic ON ic.id = icl.count_id
      WHERE ic.tenant_id = $1
        AND ic.warehouse_id = $2::uuid
        AND ic.status = 'applied'
        AND icl.status = 'applied'
      GROUP BY icl.item_type, icl.item_id, icl.warehouse_id
    ),
    value_rank AS (
      SELECT
        item_type, item_id, warehouse_id, stock_value,
        PERCENT_RANK() OVER (ORDER BY stock_value DESC) AS value_pct_rank
      FROM universe
    ),
    scored AS (
      SELECT
        u.item_type, u.item_id, u.warehouse_id,
        u.current_stock, u.avg_cost, u.stock_value, u.unit,
        CASE u.item_type
          WHEN 'raw_material' THEN rm.name
          WHEN 'product'      THEN p.name
        END AS item_name,
        CASE u.item_type
          WHEN 'product' THEN p.sku
          ELSE NULL
        END AS sku,
        rm.resin_type,
        rm.material_type,
        COALESCE(abc.abc_class, 'C')                  AS abc_class,
        COALESCE(abc.movement_value, 0)::numeric      AS movement_value_90d,
        COALESCE(dh.diff_count, 0)                    AS diff_count_12m,
        COALESCE(dh.abs_diff_value_total, 0)::numeric AS abs_diff_value_12m,
        lc.last_counted_at,
        CASE
          WHEN lc.last_counted_at IS NULL THEN NULL
          ELSE EXTRACT(DAY FROM NOW() - lc.last_counted_at)::int
        END                                           AS days_since_count,
        -- Rotation score
        CASE COALESCE(abc.abc_class, 'C')
          WHEN 'A' THEN 100
          WHEN 'B' THEN 60
          ELSE 20
        END::numeric                                  AS rotation_score,
        -- History score
        CASE
          WHEN COALESCE(dh.diff_count, 0) = 0 THEN 0
          WHEN dh.diff_count <= 2 THEN LEAST(70, 50 + COALESCE(dh.abs_diff_value_total, 0) / 100.0)
          ELSE LEAST(100, 80 + COALESCE(dh.abs_diff_value_total, 0) / 100.0)
        END::numeric                                  AS history_score,
        -- Time score
        CASE
          WHEN lc.last_counted_at IS NULL                                       THEN 100
          WHEN lc.last_counted_at >= NOW() - INTERVAL '30 days'                THEN 0
          WHEN lc.last_counted_at >= NOW() - INTERVAL '60 days'                THEN 30
          WHEN lc.last_counted_at >= NOW() - INTERVAL '90 days'                THEN 60
          WHEN lc.last_counted_at >= NOW() - INTERVAL '180 days'               THEN 80
          ELSE 100
        END::numeric                                  AS time_score,
        -- Value score
        CASE
          WHEN vr.value_pct_rank <= 0.10 THEN 100
          WHEN vr.value_pct_rank <= 0.25 THEN 60
          ELSE 20
        END::numeric                                  AS value_score
      FROM universe u
      LEFT JOIN abc          ON abc.item_type = u.item_type AND abc.item_id = u.item_id AND abc.warehouse_id = u.warehouse_id
      LEFT JOIN diff_history dh ON dh.item_type = u.item_type AND dh.item_id = u.item_id AND dh.warehouse_id = u.warehouse_id
      LEFT JOIN last_counted lc ON lc.item_type = u.item_type AND lc.item_id = u.item_id AND lc.warehouse_id = u.warehouse_id
      LEFT JOIN value_rank   vr ON vr.item_type = u.item_type AND vr.item_id = u.item_id AND vr.warehouse_id = u.warehouse_id
      LEFT JOIN raw_materials rm ON rm.id = u.item_id AND u.item_type = 'raw_material'::inventory_item_type
      LEFT JOIN products p       ON p.id  = u.item_id AND u.item_type = 'product'::inventory_item_type
    )
    SELECT *,
      (rotation_score * $4::numeric +
       history_score  * $5::numeric +
       time_score     * $6::numeric +
       value_score    * $7::numeric) AS base_score
    FROM scored
    WHERE item_name IS NOT NULL
      ${excludeRecentlyCountedDays ? `AND (last_counted_at IS NULL OR last_counted_at < NOW() - $8 * INTERVAL '1 day')` : ''}
    ORDER BY base_score DESC, item_name
  `

  params.push(OUTFLOW_TYPES)
  params.push(wRotation, wHistory, wTime, wValue)
  if (excludeRecentlyCountedDays) {
    params.push(parseInt(excludeRecentlyCountedDays))
  }

  const { rows } = await query(sql, params)

  // ── Aplicar aleatoriedad y razones legibles ─────────────────────────────
  const rndFraction = rnd / 100
  const itemsScored = rows.map(r => {
    const base = parseFloat(r.base_score) || 0
    const rndVal = rndFraction > 0 ? Math.random() * 100 : 0
    const finalScore = base * (1 - rndFraction) + rndVal * rndFraction

    // Razones legibles (en orden de prioridad)
    const reasons = []
    if (r.abc_class === 'A')         reasons.push('Tipo A · Alta rotación')
    else if (r.abc_class === 'B')    reasons.push('Tipo B · Rotación media')
    else                              reasons.push('Tipo C · Baja rotación')

    if (r.diff_count_12m >= 3)       reasons.push(`${r.diff_count_12m} diferencias en 12m`)
    else if (r.diff_count_12m >= 1)  reasons.push(`${r.diff_count_12m} diferencia${r.diff_count_12m === 1 ? '' : 's'} previa${r.diff_count_12m === 1 ? '' : 's'}`)

    if (r.last_counted_at == null)   reasons.push('Nunca contado')
    else if (r.days_since_count > 90) reasons.push(`Sin contar hace ${r.days_since_count} días`)

    if (parseFloat(r.value_score) === 100) reasons.push('Alto valor')

    return {
      item_type: r.item_type,
      item_id:   r.item_id,
      warehouse_id: r.warehouse_id,
      item_name: r.item_name,
      sku: r.sku,
      resin_type: r.resin_type,
      material_type: r.material_type,
      current_stock: parseFloat(r.current_stock || 0),
      avg_cost: parseFloat(r.avg_cost || 0),
      stock_value: parseFloat(r.stock_value || 0),
      unit: r.unit,
      abc_class: r.abc_class,
      movement_value_90d: parseFloat(r.movement_value_90d || 0),
      diff_count_12m: r.diff_count_12m,
      abs_diff_value_12m: parseFloat(r.abs_diff_value_12m || 0),
      last_counted_at: r.last_counted_at,
      days_since_count: r.days_since_count,
      score: Math.round(finalScore),
      score_breakdown: {
        rotation: parseFloat(r.rotation_score),
        history:  parseFloat(r.history_score),
        time:     parseFloat(r.time_score),
        value:    parseFloat(r.value_score),
        random:   Math.round(rndVal),
        base:     Math.round(base),
      },
      reasons,
    }
  })

  // Ordenar por score final descendente y tomar top N
  itemsScored.sort((a, b) => b.score - a.score)
  const topN = itemsScored.slice(0, count)

  // Stats globales para mostrar en UI
  const totalUniverse = rows.length
  const totalSelectedValue = topN.reduce((sum, i) => sum + i.stock_value, 0)
  const abcDistribution = {
    A: topN.filter(i => i.abc_class === 'A').length,
    B: topN.filter(i => i.abc_class === 'B').length,
    C: topN.filter(i => i.abc_class === 'C').length,
  }

  return {
    items: topN,
    meta: {
      requested:        count,
      returned:         topN.length,
      universeSize:     totalUniverse,
      totalSelectedValue,
      abcDistribution,
      weightsApplied:   { rotation: wRotation, history: wHistory, time: wTime, value: wValue },
      randomnessApplied: rnd,
    },
  }
}

module.exports = {
  suggestItemsToCount,
}
