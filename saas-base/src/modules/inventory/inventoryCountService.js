'use strict'

const { query, withTransaction } = require('../../db')
const createError = require('http-errors')
const inventoryService = require('./inventoryService')

const VALID_TYPES  = ['raw_material', 'product']
const VALID_SCOPES = ['all', 'selected', 'with_stock', 'below_min']

// ─────────────────────────────────────────────────────────────────────────────
// Folios
// ─────────────────────────────────────────────────────────────────────────────
async function nextCountNumber(client, tenantId, type) {
  const now    = new Date()
  const yyyymm = now.toISOString().slice(0, 7).replace('-', '')
  const suffix = type === 'month_close' ? 'CM' : null

  // Para month_close: solo puede haber UNO por mes (folio CONT-YYYYMM-CM)
  if (suffix === 'CM') {
    return `CONT-${yyyymm}-CM`
  }

  // Para cyclic: contador incremental dentro del mes
  const { rows } = await client.query(
    `SELECT count_number FROM inventory_counts
     WHERE tenant_id = $1
       AND count_number LIKE $2
       AND count_type = 'cyclic'
     ORDER BY count_number DESC
     LIMIT 1`,
    [tenantId, `CONT-${yyyymm}-%`]
  )
  let next = 1
  if (rows[0]) {
    const last = rows[0].count_number.split('-').pop()
    if (/^\d+$/.test(last)) next = parseInt(last) + 1
  }
  return `CONT-${yyyymm}-${String(next).padStart(2, '0')}`
}

// ─────────────────────────────────────────────────────────────────────────────
// Crear conteo (toma snapshot del sistema)
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Crea un conteo físico nuevo y toma snapshot del sistema.
 *
 * params:
 *   - countType:  'cyclic' | 'month_close'
 *   - warehouseId: requerido para 'cyclic', NULL para 'month_close' (todos los almacenes)
 *   - scope:      'all' | 'selected' | 'with_stock' | 'below_min'
 *   - selectedItems: [{itemType, itemId, warehouseId}] — solo si scope='selected'
 *   - countDate, notes
 */
async function createCount({
  tenantId, countType, warehouseId,
  scope = 'all', selectedItems = [],
  countDate, notes, userId,
}) {
  if (!['cyclic', 'month_close'].includes(countType)) {
    throw createError(400, 'countType debe ser cyclic o month_close.')
  }
  if (!VALID_SCOPES.includes(scope)) {
    throw createError(400, 'scope inválido.')
  }

  // ── Validaciones por tipo ──────────────────────────────────────────────
  if (countType === 'cyclic') {
    if (!warehouseId) throw createError(400, 'warehouseId es requerido para conteo cíclico.')
    if (scope === 'selected' && (!Array.isArray(selectedItems) || selectedItems.length === 0)) {
      throw createError(400, 'Debe especificar al menos un item para scope=selected.')
    }
  } else {
    // month_close: forzar scope=all y warehouseId=null
    warehouseId = null
    scope = 'all'
  }

  return withTransaction(async (client) => {
    // Validar almacén si aplica
    let warehouseType = null
    if (warehouseId) {
      const { rows: whRows } = await client.query(
        `SELECT id, name, type FROM warehouses
         WHERE id = $1 AND tenant_id = $2 AND is_active = true`,
        [warehouseId, tenantId]
      )
      if (!whRows[0]) throw createError(404, 'Almacén no encontrado o inactivo.')
      warehouseType = whRows[0].type
    }

    // Validar que no haya otro cierre de mes activo este mes
    if (countType === 'month_close') {
      const { rows: existing } = await client.query(
        `SELECT id, count_number, status FROM inventory_counts
         WHERE tenant_id = $1
           AND count_type = 'month_close'
           AND status IN ('in_capture', 'reconciling')
           AND DATE_TRUNC('month', count_date) = DATE_TRUNC('month', $2::date)`,
        [tenantId, countDate || new Date()]
      )
      if (existing[0]) {
        throw createError(409, `Ya hay un cierre de mes en proceso: ${existing[0].count_number}`)
      }
    }

    // Generar folio
    const countNumber = await nextCountNumber(client, tenantId, countType)

    // ── Crear cabecera ────────────────────────────────────────────────────
    const { rows: hdrRows } = await client.query(
      `INSERT INTO inventory_counts
         (tenant_id, count_number, count_type, warehouse_id, scope,
          count_date, notes, status, started_by)
       VALUES ($1, $2, $3, $4, $5, COALESCE($6::date, CURRENT_DATE), $7, 'in_capture', $8)
       RETURNING *`,
      [
        tenantId, countNumber, countType, warehouseId, scope,
        countDate || null, notes || null, userId,
      ]
    )
    const header = hdrRows[0]

    // ── Tomar snapshot ────────────────────────────────────────────────────
    // Estrategia según scope:
    //   - all (cíclico, por almacén) => TODO el catálogo activo del tipo del almacén
    //       (incluye los que están en cero, sin stock ni nivel configurado).
    //   - month_close => todos los items con stock O con niveles configurados, en
    //       todos los almacenes (no expande catálogo: no hay almacén único a asignar).
    //   - with_stock => solo items con quantity > 0
    //   - below_min => solo items en estado below_min o at_reorder
    //   - selected => solo los items pasados explícitamente

    let lineRows = []

    if (scope === 'selected') {
      // Items específicos: tomar snapshot uno por uno
      for (const it of selectedItems) {
        if (!VALID_TYPES.includes(it.itemType)) {
          throw createError(400, `itemType inválido en selección: ${it.itemType}`)
        }
        const itWarehouseId = it.warehouseId || warehouseId
        if (!itWarehouseId) {
          throw createError(400, 'Cada item seleccionado debe tener warehouseId.')
        }
        const { rows } = await client.query(
          `SELECT
             $2::inventory_item_type AS item_type,
             $3::uuid AS item_id,
             $4::uuid AS warehouse_id,
             COALESCE(s.quantity, 0)::numeric AS system_qty,
             COALESCE(s.avg_cost, 0)::numeric AS system_avg_cost,
             COALESCE(s.unit,
               CASE WHEN $2::inventory_item_type = 'raw_material' THEN 'kg' ELSE 'pza' END
             ) AS unit
           FROM (SELECT 1) x
           LEFT JOIN inventory_stock s
             ON s.tenant_id = $1
             AND s.warehouse_id = $4::uuid
             AND s.item_type = $2::inventory_item_type
             AND s.item_id = $3::uuid
             AND s.status = 'available'`,
          [tenantId, it.itemType, it.itemId, itWarehouseId]
        )
        if (rows[0]) lineRows.push(rows[0])
      }
    } else {
      // scope: all / with_stock / below_min — query masiva
      const params = [tenantId]
      let pi = 2
      const conds = ['s.tenant_id = $1']

      // Filtro de almacén (cíclico tiene uno; month_close abarca todos los activos)
      if (warehouseId) {
        conds.push(`(s.warehouse_id = $${pi} OR il.warehouse_id = $${pi})`)
        params.push(warehouseId)
        pi++
      }

      // UNION de items con stock + items con niveles configurados
      // (para incluir los que tienen stock = 0 pero sí están registrados)
      let stockFilter = ''
      if (scope === 'with_stock') {
        stockFilter = 'AND COALESCE(s.quantity, 0) > 0'
      } else if (scope === 'below_min') {
        stockFilter = `AND il.id IS NOT NULL AND (
          COALESCE(s.quantity, 0) < il.min_stock OR
          COALESCE(s.quantity, 0) < il.reorder_point
        )`
      }

      // scope='all' en un conteo CÍCLICO (almacén único) = TODO el catálogo activo
      // del tipo del almacén, tenga o no existencia. Inyecta una fila en cero por cada
      // artículo activo que NO esté ya en `combined` (sin stock disponible ni nivel
      // configurado en este almacén). Espejo de getStock(includeZero) de la mig 193,
      // adaptado a que la línea de conteo SÍ requiere warehouse_id (NOT NULL).
      // month_close NO entra aquí (warehouseId = null → no se puede asignar almacén).
      let catalogUnion = ''
      if (scope === 'all' && warehouseId) {
        const isRawWarehouse = warehouseType === 'raw_material' || warehouseType === 'regrind'
        if (isRawWarehouse) {
          catalogUnion = `
            UNION ALL
            SELECT
              'raw_material'::inventory_item_type AS item_type,
              rm.id AS item_id,
              $2::uuid AS warehouse_id,
              0::numeric AS system_qty,
              0::numeric AS system_avg_cost,
              'kg'::text AS unit
            FROM raw_materials rm
            WHERE rm.tenant_id = $1 AND rm.is_active = true
              AND NOT EXISTS (
                SELECT 1 FROM inventory_stock s2
                WHERE s2.tenant_id = $1 AND s2.item_type = 'raw_material'
                  AND s2.item_id = rm.id AND s2.warehouse_id = $2::uuid
                  AND s2.status = 'available'
              )
              AND NOT EXISTS (
                SELECT 1 FROM inventory_levels il2
                WHERE il2.tenant_id = $1 AND il2.item_type = 'raw_material'
                  AND il2.item_id = rm.id AND il2.warehouse_id = $2::uuid
              )`
        } else {
          catalogUnion = `
            UNION ALL
            SELECT
              'product'::inventory_item_type AS item_type,
              p.id AS item_id,
              $2::uuid AS warehouse_id,
              0::numeric AS system_qty,
              0::numeric AS system_avg_cost,
              'pza'::text AS unit
            FROM products p
            WHERE p.tenant_id = $1 AND p.is_active = true
              AND NOT EXISTS (
                SELECT 1 FROM inventory_stock s2
                WHERE s2.tenant_id = $1 AND s2.item_type = 'product'
                  AND s2.item_id = p.id AND s2.warehouse_id = $2::uuid
                  AND s2.status = 'available'
              )
              AND NOT EXISTS (
                SELECT 1 FROM inventory_levels il2
                WHERE il2.tenant_id = $1 AND il2.item_type = 'product'
                  AND il2.item_id = p.id AND il2.warehouse_id = $2::uuid
              )`
        }
      }

      const sql = `
        WITH combined AS (
          SELECT
            COALESCE(s.item_type, il.item_type) AS item_type,
            COALESCE(s.item_id,   il.item_id)   AS item_id,
            COALESCE(s.warehouse_id, il.warehouse_id) AS warehouse_id,
            COALESCE(s.quantity, 0)::numeric  AS system_qty,
            COALESCE(s.avg_cost, 0)::numeric  AS system_avg_cost,
            COALESCE(s.unit,
              CASE
                WHEN COALESCE(s.item_type, il.item_type) = 'raw_material' THEN 'kg'
                ELSE 'pza'
              END
            ) AS unit
          FROM inventory_stock s
          FULL OUTER JOIN inventory_levels il
            ON s.tenant_id = il.tenant_id
            AND s.warehouse_id = il.warehouse_id
            AND s.item_type = il.item_type
            AND s.item_id = il.item_id
          WHERE COALESCE(s.tenant_id, il.tenant_id) = $1
            AND COALESCE(s.status, 'available') = 'available'
            ${warehouseId ? `AND COALESCE(s.warehouse_id, il.warehouse_id) = $2::uuid` : ''}
            ${stockFilter}
        )
        SELECT * FROM combined
        WHERE item_type IS NOT NULL
        ${catalogUnion}
        ORDER BY item_type, item_id`

      const result = await client.query(sql, params)
      lineRows = result.rows
    }

    if (lineRows.length === 0) {
      throw createError(400, 'No se encontraron items para incluir en el conteo. Ajusta los criterios.')
    }

    // ── Insertar líneas en lote (por CHUNKS) ──────────────────────────────
    // Cada línea ata 7 parámetros. Postgres/node-postgres limita un statement a
    // 65535 bind params (Int16) → con 7 por línea, una sola query revienta a
    // partir de ~9362 líneas con el error de protocolo 08P01 (se ve como
    // "Internal server error"). Un cierre de mes (TODOS los almacenes × TODOS
    // los items) supera ese tope fácil → insertamos en lotes seguros.
    const PARAMS_PER_LINE = 7
    const CHUNK_SIZE = 1000 // 1000 × 7 = 7000 params, holgado bajo 65535

    for (let off = 0; off < lineRows.length; off += CHUNK_SIZE) {
      const chunk = lineRows.slice(off, off + CHUNK_SIZE)
      const valuesSql = []
      const valuesParams = []
      let pIdx = 1

      for (const ln of chunk) {
        valuesSql.push(`($${pIdx}::uuid, $${pIdx+1}::inventory_item_type, $${pIdx+2}::uuid, $${pIdx+3}::uuid, $${pIdx+4}::numeric, $${pIdx+5}::numeric, $${pIdx+6}::text, 'pending')`)
        valuesParams.push(
          header.id, ln.item_type, ln.item_id, ln.warehouse_id,
          ln.system_qty, ln.system_avg_cost, ln.unit
        )
        pIdx += PARAMS_PER_LINE
      }

      await client.query(
        `INSERT INTO inventory_count_lines
           (count_id, item_type, item_id, warehouse_id,
            system_qty, system_avg_cost, unit, status)
         VALUES ${valuesSql.join(', ')}`,
        valuesParams
      )
    }

    await client.query(
      `UPDATE inventory_counts SET total_lines = $1 WHERE id = $2`,
      [lineRows.length, header.id]
    )

    // Devolver con líneas
    return getCountById({ tenantId, countId: header.id, client })
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Obtener conteo por ID (con líneas + nombres)
// ─────────────────────────────────────────────────────────────────────────────
async function getCountById({ tenantId, countId, client = null }) {
  const exec = client || { query }

  const { rows: hdrRows } = await exec.query(
    `SELECT
       ic.*,
       w.name AS warehouse_name,
       w.type AS warehouse_type,
       u_started.full_name   AS started_by_name,
       u_applied.full_name   AS applied_by_name,
       u_cancel.full_name    AS cancelled_by_name,
       ia.adjustment_number  AS adjustment_number
     FROM inventory_counts ic
     LEFT JOIN warehouses w           ON w.id = ic.warehouse_id
     LEFT JOIN users u_started        ON u_started.id = ic.started_by
     LEFT JOIN users u_applied        ON u_applied.id = ic.applied_by
     LEFT JOIN users u_cancel         ON u_cancel.id = ic.cancelled_by
     LEFT JOIN inventory_adjustments ia ON ia.id = ic.adjustment_id
     WHERE ic.id = $1 AND ic.tenant_id = $2`,
    [countId, tenantId]
  )
  if (!hdrRows[0]) return null

  const { rows: lines } = await exec.query(
    `SELECT
       icl.*,
       w.name AS warehouse_name,
       CASE icl.item_type
         WHEN 'raw_material' THEN rm.name
         WHEN 'product'      THEN p.name
       END AS item_name,
       CASE icl.item_type
         WHEN 'product' THEN p.sku
         ELSE NULL
       END AS sku,
       rm.resin_type,
       rm.material_type,
       u_cap.full_name AS captured_by_name,
       (icl.physical_qty - icl.system_qty) AS difference,
       (COALESCE(icl.physical_qty, icl.system_qty) - icl.system_qty) * icl.system_avg_cost AS difference_value
     FROM inventory_count_lines icl
     JOIN warehouses w ON w.id = icl.warehouse_id
     LEFT JOIN raw_materials rm ON rm.id = icl.item_id AND icl.item_type = 'raw_material'::inventory_item_type
     LEFT JOIN products p       ON p.id  = icl.item_id AND icl.item_type = 'product'::inventory_item_type
     LEFT JOIN users u_cap      ON u_cap.id = icl.captured_by
     WHERE icl.count_id = $1
     ORDER BY w.name, item_name`,
    [countId]
  )

  return { ...hdrRows[0], lines }
}

// ─────────────────────────────────────────────────────────────────────────────
// Listar conteos con filtros
// ─────────────────────────────────────────────────────────────────────────────
async function listCounts({
  tenantId, countType, status, warehouseId,
  dateFrom, dateTo, search, page = 1, limit = 50,
}) {
  const offset = (page - 1) * limit
  const conds  = ['ic.tenant_id = $1']
  const params = [tenantId]
  let i = 2

  if (countType)   { conds.push(`ic.count_type = $${i++}`);  params.push(countType) }
  if (status)      { conds.push(`ic.status = $${i++}`);      params.push(status) }
  if (warehouseId) { conds.push(`ic.warehouse_id = $${i++}`); params.push(warehouseId) }
  if (dateFrom)    { conds.push(`ic.count_date >= $${i++}`); params.push(dateFrom) }
  if (dateTo)      { conds.push(`ic.count_date <= $${i++}`); params.push(dateTo) }
  if (search) {
    conds.push(`(ic.count_number ILIKE $${i} OR ic.notes ILIKE $${i})`)
    params.push(`%${search}%`)
    i++
  }

  const { rows } = await query(
    `SELECT
       ic.id, ic.count_number, ic.count_type, ic.warehouse_id,
       ic.scope, ic.count_date, ic.status,
       ic.total_lines, ic.captured_lines, ic.diff_lines, ic.total_diff_value,
       ic.started_at, ic.applied_at, ic.cancelled_at,
       w.name AS warehouse_name,
       u.full_name AS started_by_name,
       ia.adjustment_number AS adjustment_number
     FROM inventory_counts ic
     LEFT JOIN warehouses w           ON w.id = ic.warehouse_id
     LEFT JOIN users u                ON u.id = ic.started_by
     LEFT JOIN inventory_adjustments ia ON ia.id = ic.adjustment_id
     WHERE ${conds.join(' AND ')}
     ORDER BY ic.started_at DESC
     LIMIT $${i} OFFSET $${i + 1}`,
    [...params, limit, offset]
  )

  const { rows: countRows } = await query(
    `SELECT COUNT(*) AS total FROM inventory_counts ic
     WHERE ${conds.join(' AND ')}`,
    params
  )

  return {
    data: rows,
    total: parseInt(countRows[0]?.total || 0),
    page, limit,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Capturar línea (cantidad física + notas)
// ─────────────────────────────────────────────────────────────────────────────
async function captureLine({
  tenantId, countId, lineId, physicalQty, notes, userId,
}) {
  // Validar que el conteo existe y está en captura
  const { rows: cnt } = await query(
    `SELECT id, status FROM inventory_counts
     WHERE id = $1 AND tenant_id = $2`,
    [countId, tenantId]
  )
  if (!cnt[0]) throw createError(404, 'Conteo no encontrado.')
  if (cnt[0].status !== 'in_capture') {
    throw createError(409, `No se puede capturar: el conteo está en estado ${cnt[0].status}.`)
  }

  // physicalQty puede ser 0, null (limpiar) o un número positivo
  let qty = null
  if (physicalQty !== null && physicalQty !== undefined && physicalQty !== '') {
    qty = parseFloat(physicalQty)
    if (isNaN(qty) || qty < 0) {
      throw createError(400, 'physicalQty debe ser un número >= 0.')
    }
  }

  const newStatus = qty === null ? 'pending' : 'captured'

  const { rows } = await query(
    `UPDATE inventory_count_lines
     SET physical_qty = $1::numeric,
         notes        = $2::text,
         captured_at  = CASE WHEN $1::numeric IS NULL THEN NULL ELSE NOW() END,
         captured_by  = CASE WHEN $1::numeric IS NULL THEN NULL ELSE $4::uuid END,
         status       = $5::text
     WHERE id = $3 AND count_id = $6
     RETURNING *`,
    [qty, notes || null, lineId, userId, newStatus, countId]
  )
  if (!rows[0]) throw createError(404, 'Línea no encontrada.')

  // Actualizar contador de líneas capturadas
  await query(
    `UPDATE inventory_counts ic
     SET captured_lines = (
       SELECT COUNT(*) FROM inventory_count_lines
       WHERE count_id = ic.id AND status IN ('captured','applied')
     )
     WHERE id = $1`,
    [countId]
  )

  return rows[0]
}

// ─────────────────────────────────────────────────────────────────────────────
// Marcar varias líneas como "sin diferencia" (físico = sistema)
// ─────────────────────────────────────────────────────────────────────────────
async function markLinesNoDiff({ tenantId, countId, lineIds, userId }) {
  if (!Array.isArray(lineIds) || lineIds.length === 0) {
    throw createError(400, 'lineIds debe ser un array no vacío.')
  }

  const { rows: cnt } = await query(
    `SELECT id, status FROM inventory_counts
     WHERE id = $1 AND tenant_id = $2`,
    [countId, tenantId]
  )
  if (!cnt[0]) throw createError(404, 'Conteo no encontrado.')
  if (cnt[0].status !== 'in_capture') {
    throw createError(409, `No se puede capturar: el conteo está en estado ${cnt[0].status}.`)
  }

  await query(
    `UPDATE inventory_count_lines
     SET physical_qty = system_qty,
         captured_at  = NOW(),
         captured_by  = $1::uuid,
         status       = 'captured'
     WHERE count_id = $2 AND id = ANY($3::uuid[])`,
    [userId, countId, lineIds]
  )

  await query(
    `UPDATE inventory_counts ic
     SET captured_lines = (
       SELECT COUNT(*) FROM inventory_count_lines
       WHERE count_id = ic.id AND status IN ('captured','applied')
     )
     WHERE id = $1`,
    [countId]
  )

  return { updated: lineIds.length }
}

// ─────────────────────────────────────────────────────────────────────────────
// Pasar a conciliación
// ─────────────────────────────────────────────────────────────────────────────
async function moveToReconcile({ tenantId, countId, userId }) {
  const { rows: cnt } = await query(
    `SELECT * FROM inventory_counts WHERE id = $1 AND tenant_id = $2`,
    [countId, tenantId]
  )
  if (!cnt[0]) throw createError(404, 'Conteo no encontrado.')
  if (cnt[0].status !== 'in_capture') {
    throw createError(409, `No se puede conciliar: estado actual ${cnt[0].status}.`)
  }

  // Calcular diff_lines y total_diff_value
  await query(
    `UPDATE inventory_counts ic
     SET status = 'reconciling',
         diff_lines = (
           SELECT COUNT(*) FROM inventory_count_lines
           WHERE count_id = ic.id
             AND status = 'captured'
             AND physical_qty IS NOT NULL
             AND physical_qty <> system_qty
         ),
         total_diff_value = (
           SELECT COALESCE(SUM((physical_qty - system_qty) * system_avg_cost), 0)
           FROM inventory_count_lines
           WHERE count_id = ic.id
             AND status = 'captured'
             AND physical_qty IS NOT NULL
         )
     WHERE id = $1`,
    [countId]
  )

  return getCountById({ tenantId, countId })
}

// ─────────────────────────────────────────────────────────────────────────────
// Aplicar conteo: genera ajuste contable automáticamente
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Aplica el conteo:
 *   1. Genera un inventory_adjustment con todas las líneas con diferencia.
 *   2. Las líneas pendientes (no capturadas) se marcan como 'skipped'.
 *   3. Las líneas sin diferencia se marcan 'applied' sin generar movimiento.
 *   4. El conteo pasa a estado 'applied'.
 *
 * Reusa createAdjustmentDocument del inventoryService para mantener
 * consistencia (folio AJ-YYYYMM-XXXX, validaciones, recordMovement, etc).
 */
async function applyCount({ tenantId, countId, closingNotes, userId }) {
  if (!closingNotes || !String(closingNotes).trim()) {
    throw createError(400, 'closingNotes (notas de cierre) son obligatorias para aplicar el conteo.')
  }

  return withTransaction(async (client) => {
    // 1. Validar estado
    const { rows: cnt } = await client.query(
      `SELECT * FROM inventory_counts WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
      [countId, tenantId]
    )
    if (!cnt[0]) throw createError(404, 'Conteo no encontrado.')
    const count = cnt[0]
    if (!['in_capture', 'reconciling'].includes(count.status)) {
      throw createError(409, `No se puede aplicar: estado actual ${count.status}.`)
    }

    // 2. Obtener líneas con diferencia
    const { rows: diffLines } = await client.query(
      `SELECT
         icl.*,
         (icl.physical_qty - icl.system_qty) AS difference
       FROM inventory_count_lines icl
       WHERE icl.count_id = $1
         AND icl.status = 'captured'
         AND icl.physical_qty IS NOT NULL
         AND icl.physical_qty <> icl.system_qty`,
      [countId]
    )

    let adjustmentId = null
    let totalDiffValue = 0

    if (diffLines.length > 0) {
      // 3. Generar ajuste contable.
      //    Como createAdjustmentDocument requiere warehouseId único, agrupamos
      //    por almacén y generamos un ajuste por cada almacén afectado.
      const linesByWarehouse = new Map()
      for (const ln of diffLines) {
        if (!linesByWarehouse.has(ln.warehouse_id)) {
          linesByWarehouse.set(ln.warehouse_id, [])
        }
        const diff = parseFloat(ln.difference)
        const isIn = diff > 0
        linesByWarehouse.get(ln.warehouse_id).push({
          itemType:  ln.item_type,
          itemId:    ln.item_id,
          direction: isIn ? 'in' : 'out',
          quantity:  Math.abs(diff),
          unit:      ln.unit,
          unitCost:  parseFloat(ln.system_avg_cost),
          notes:     ln.notes
            ? `Diferencia conteo ${count.count_number}: ${ln.notes}`
            : `Diferencia detectada en conteo ${count.count_number}`,
        })
        totalDiffValue += diff * parseFloat(ln.system_avg_cost)
      }

      // Si hay más de un almacén (sólo en cierre de mes), creamos varios
      // ajustes y guardamos el ID del primero como referencia principal.
      const warehouseIds = [...linesByWarehouse.keys()]
      const adjustmentIds = []

      for (const whId of warehouseIds) {
        const lines = linesByWarehouse.get(whId)
        const adj = await inventoryService.createAdjustmentDocument({
          tenantId,
          warehouseId: whId,
          reason:      `Conteo físico ${count.count_number}`,
          notes:       closingNotes.trim(),
          lines,
          userId,
        })
        adjustmentIds.push(adj.id)
      }
      adjustmentId = adjustmentIds[0]

      // Marcar líneas con diferencia como 'applied'
      await client.query(
        `UPDATE inventory_count_lines
         SET status = 'applied'
         WHERE count_id = $1
           AND status = 'captured'
           AND physical_qty IS NOT NULL
           AND physical_qty <> system_qty`,
        [countId]
      )
    }

    // 4. Marcar líneas sin diferencia como 'applied'
    await client.query(
      `UPDATE inventory_count_lines
       SET status = 'applied'
       WHERE count_id = $1
         AND status = 'captured'
         AND physical_qty IS NOT NULL
         AND physical_qty = system_qty`,
      [countId]
    )

    // 5. Marcar líneas pendientes como 'skipped'
    await client.query(
      `UPDATE inventory_count_lines
       SET status = 'skipped'
       WHERE count_id = $1 AND status = 'pending'`,
      [countId]
    )

    // 6. Actualizar cabecera
    await client.query(
      `UPDATE inventory_counts
       SET status            = 'applied',
           applied_at        = NOW(),
           applied_by        = $2::uuid,
           closing_notes     = $3::text,
           adjustment_id     = $4::uuid,
           total_diff_value  = $5::numeric,
           diff_lines        = $6::int
       WHERE id = $1`,
      [countId, userId, closingNotes.trim(), adjustmentId, totalDiffValue.toFixed(2), diffLines.length]
    )

    return getCountById({ tenantId, countId, client })
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Cancelar conteo (en captura o conciliación, NUNCA aplicado)
// ─────────────────────────────────────────────────────────────────────────────
async function cancelCount({ tenantId, countId, reason, userId }) {
  if (!reason || !String(reason).trim()) {
    throw createError(400, 'La razón de cancelación es obligatoria.')
  }

  const { rows } = await query(
    `SELECT id, status, count_number FROM inventory_counts
     WHERE id = $1 AND tenant_id = $2`,
    [countId, tenantId]
  )
  if (!rows[0]) throw createError(404, 'Conteo no encontrado.')
  if (rows[0].status === 'applied') {
    throw createError(409, 'No se puede cancelar un conteo ya aplicado. Si necesitas revertir, cancela el ajuste contable generado.')
  }
  if (rows[0].status === 'cancelled') {
    throw createError(409, 'El conteo ya está cancelado.')
  }

  await query(
    `UPDATE inventory_counts
     SET status              = 'cancelled',
         cancelled_at        = NOW(),
         cancelled_by        = $1::uuid,
         cancellation_reason = $2::text
     WHERE id = $3`,
    [userId, reason.trim(), countId]
  )

  return getCountById({ tenantId, countId })
}

module.exports = {
  createCount,
  getCountById,
  listCounts,
  captureLine,
  markLinesNoDiff,
  moveToReconcile,
  applyCount,
  cancelCount,
}
