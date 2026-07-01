'use strict'

const { query, withTransaction } = require('../../db')
const createError = require('http-errors')
const documentSeriesService = require('../document-series/documentSeriesService')

// ─── Helpers internos ─────────────────────────────────────────────────────────

/**
 * Devuelve el ID del almacén principal del tipo dado.
 *
 * Antes: LIMIT 1 sin orden — funcionaba con 1 almacén por tipo.
 * Ahora: prefiere el marcado como is_default. Si no hay default, cae al
 *        más antiguo activo (compatibilidad con tenants nuevos sin marcar).
 */
async function getWarehouseId(client, tenantId, type) {
  const { rows } = await client.query(
    `SELECT id FROM warehouses
     WHERE tenant_id = $1 AND type = $2 AND is_active = true
     ORDER BY is_default DESC, created_at ASC, id ASC
     LIMIT 1`,
    [tenantId, type]
  )
  if (!rows[0]) throw createError(500, `Almacén '${type}' no encontrado o inactivo. Configúralo en Almacenes.`)
  return rows[0].id
}

/**
 * Devuelve el almacén default según el `item_kind` de la materia prima.
 *
 * Reglas:
 *   - item_kind='packaging' → intenta `type='packaging'`; si el tenant no tiene
 *     almacén de embalaje configurado, cae a `type='raw_material'` (modo legacy
 *     en el que todo lo consumible vive en MP).
 *   - item_kind='raw_material' o 'additive' → `type='raw_material'`.
 *
 * Esto permite que tenants que separan físicamente bolsas/etiquetas tengan un
 * almacén dedicado, mientras que tenants que no lo necesitan operen con un
 * único almacén raw_material como hasta hoy.
 */
async function getWarehouseIdForItemKind(client, tenantId, itemKind) {
  if (itemKind === 'packaging') {
    const { rows } = await client.query(
      `SELECT id FROM warehouses
       WHERE tenant_id = $1 AND type = 'packaging' AND is_active = true
       ORDER BY is_default DESC, created_at ASC, id ASC
       LIMIT 1`,
      [tenantId]
    )
    if (rows[0]) return rows[0].id
    // Fallback: tenant sin almacén packaging → usar raw_material como antes
  }
  return getWarehouseId(client, tenantId, 'raw_material')
}

/**
 * Resuelve el warehouse default según el `item_kind` de un raw_material por ID.
 * Atajo para callers que solo tienen el rawMaterialId.
 */
async function getWarehouseIdForRawMaterial(client, tenantId, rawMaterialId) {
  const { rows } = await client.query(
    `SELECT item_kind FROM raw_materials WHERE id = $1 AND tenant_id = $2`,
    [rawMaterialId, tenantId]
  )
  const itemKind = rows[0]?.item_kind || 'raw_material'
  return getWarehouseIdForItemKind(client, tenantId, itemKind)
}

/**
 * Upsert en inventory_stock con costo promedio ponderado.
 *
 * Entradas (+): recalcula avg_cost.
 * Salidas (-):
 *   - Mantiene avg_cost.
 *   - Si validateStock=true y la cantidad excede el saldo → throw.
 *   - Si allowNegative=true → deja el saldo en negativo (bandera de "falta
 *     captura/validación"; lo usa la venta cuando el tenant tiene la opción
 *     allow_negative_stock activa, mig 193).
 *   - Si allowNegative=false (default — comportamiento histórico) → clampea a 0.
 *
 * Endurecimiento del costo (necesario para saldos negativos): el promedio
 * ponderado solo aplica cuando el saldo base es positivo. Si el saldo es <= 0
 * (caso negativo) una entrada ADOPTA su propio costo unitario en vez de
 * ponderar — así se evita la división por cero y los costos sin sentido que
 * darían `((curQty*curCost)+(delta*unitCost))/(curQty+delta)` con curQty ≤ 0.
 */
async function updateStock(client, {
  tenantId, warehouseId, itemType, itemId, unit,
  quantityDelta, unitCost = 0, status = 'available',
  validateStock = false, allowNegative = false,
}) {
  const { rows } = await client.query(
    `SELECT id, quantity, avg_cost FROM inventory_stock
     WHERE tenant_id=$1 AND warehouse_id=$2 AND item_type=$3 AND item_id=$4 AND status=$5
     FOR UPDATE`,
    [tenantId, warehouseId, itemType, itemId, status]
  )

  if (rows[0]) {
    const cur     = rows[0]
    const curQty  = parseFloat(cur.quantity)
    const curCost = parseFloat(cur.avg_cost)

    if (validateStock && quantityDelta < 0 && Math.abs(quantityDelta) > curQty + 0.0001) {
      throw createError(
        400,
        `Stock insuficiente: hay ${curQty.toFixed(4)} disponibles, intentas sacar ${Math.abs(quantityDelta).toFixed(4)}.`
      )
    }

    const rawQty = curQty + quantityDelta
    const newQty = allowNegative ? rawQty : Math.max(0, rawQty)

    let newCost = curCost
    if (quantityDelta > 0 && unitCost > 0) {
      const denom = curQty + quantityDelta
      newCost = (curQty > 0 && denom > 0)
        ? ((curQty * curCost) + (quantityDelta * unitCost)) / denom
        : unitCost
    }

    await client.query(
      `UPDATE inventory_stock SET quantity=$1, avg_cost=$2, last_movement_at=NOW(), updated_at=NOW() WHERE id=$3`,
      [newQty.toFixed(4), newCost.toFixed(6), cur.id]
    )
    return newQty
  } else {
    if (validateStock && quantityDelta < 0) {
      throw createError(400, `No existe stock previo de este artículo en el almacén — no se puede registrar una salida.`)
    }
    const qty = allowNegative ? quantityDelta : Math.max(0, quantityDelta)
    await client.query(
      `INSERT INTO inventory_stock
         (tenant_id, warehouse_id, item_type, item_id, status, quantity, unit, avg_cost, last_movement_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())`,
      [tenantId, warehouseId, itemType, itemId, status, qty.toFixed(4), unit || 'kg', (unitCost || 0).toFixed(6)]
    )
    return qty
  }
}

/** Registra un movimiento en kardex y actualiza saldo. */
async function recordMovement(client, {
  tenantId, warehouseId, itemType, itemId,
  movementType, quantity, unit = 'kg', unitCost = 0,
  statusTo = 'available',
  referenceType = null, referenceId = null,
  notes = null, createdBy = null,
  validateStock = false, allowNegative = false,
  rawMaterialLotId = null, productLotId = null,
}) {
  if (rawMaterialLotId && productLotId) {
    throw new Error('rawMaterialLotId y productLotId son mutuamente excluyentes (XOR im_lot_xor).')
  }

  const balanceAfter = await updateStock(client, {
    tenantId, warehouseId, itemType, itemId, unit,
    quantityDelta: quantity, unitCost, status: statusTo, validateStock, allowNegative,
  })

  const { rows } = await client.query(
    `INSERT INTO inventory_movements
       (tenant_id, warehouse_id, item_type, item_id, movement_type, quantity, unit,
        unit_cost, balance_after, status_to, reference_type, reference_id, notes, created_by,
        raw_material_lot_id, product_lot_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
     RETURNING *`,
    [
      tenantId, warehouseId, itemType, itemId,
      movementType, quantity.toFixed(4), unit,
      (unitCost || 0).toFixed(6), balanceAfter.toFixed(4),
      statusTo, referenceType, referenceId, notes, createdBy,
      rawMaterialLotId, productLotId,
    ]
  )
  return rows[0]
}

// ─── Hooks de producción ──────────────────────────────────────────────────────

// §6d: ptGoesToWipFirst=true (default) → producto a WIP provisional.
//       ptGoesToWipFirst=false → producto directo a finished_product con status='available'.
//       MP siempre va a WIP para tracking de consumo (se liquida en recordProductionValidation).
async function recordPackageCaptured(client, { tenantId, pkg, order, scrapFactor, userId, ptGoesToWipFirst = true }) {
  let warehouseWIP, warehousePT

  try {
    warehouseWIP = await getWarehouseId(client, tenantId, 'wip')
  } catch {
    if (ptGoesToWipFirst !== false) return  // WIP necesario para el flujo normal
  }

  if (ptGoesToWipFirst === false) {
    try {
      warehousePT = await getWarehouseId(client, tenantId, 'finished_product')
    } catch {
      return  // Sin almacén PT no podemos registrar
    }
  }

  const ref = { referenceType: 'shift_progress', referenceId: pkg.id }

  if (order?.product_id && parseFloat(pkg.quantity_units || 0) > 0) {
    if (ptGoesToWipFirst !== false) {
      // Flujo estándar: producto a WIP, supervisor valida luego.
      await recordMovement(client, {
        tenantId,
        warehouseId: warehouseWIP,
        itemType:    'product',
        itemId:      order.product_id,
        movementType:'production_wip_entry',
        quantity:    parseFloat(pkg.quantity_units),
        unit:        'pza',
        unitCost:    0,
        statusTo:    'wip',
        ...ref,
        notes:     `Captura paquete #${pkg.microlot_number}${pkg.is_second_quality ? ' (2da cal.)' : ''}`,
        createdBy: userId,
      })
    } else {
      // §6d: pt_goes_to_wip_first=false — producto directo a PT.
      const ptStatus = pkg.is_second_quality ? 'blocked' : 'available'
      await recordMovement(client, {
        tenantId,
        warehouseId: warehousePT,
        itemType:    'product',
        itemId:      order.product_id,
        movementType:'production_pt_entry',
        quantity:    parseFloat(pkg.quantity_units),
        unit:        'pza',
        unitCost:    0,
        statusTo:    ptStatus,
        ...ref,
        notes:     `Captura directa PT #${pkg.microlot_number}${pkg.is_second_quality ? ' (2da cal.)' : ''}`,
        createdBy: userId,
      })
    }
  }

  const realKg    = parseFloat(pkg.real_weight_kg || 0)
  const mpFormula = order?.mp_formula || []

  if (realKg > 0 && mpFormula.length > 0 && warehouseWIP) {
    // Modelo de costos vigente: la merma capturada NO se incluye aquí.
    // La MP que entra a WIP por cada paquete es EXACTAMENTE el peso del PT
    // multiplicado por el porcentaje de cada material en la fórmula.
    // El costo de reproceso de la merma capturada se aplica al validar el turno.
    const ptKg = realKg

    for (const mp of mpFormula) {
      const pct  = parseFloat(mp.percentage || 0)
      const mpKg = ptKg * (pct / 100)
      if (mpKg <= 0) continue

      await recordMovement(client, {
        tenantId,
        warehouseId: warehouseWIP,
        itemType:    'raw_material',
        itemId:      mp.raw_material_id,
        movementType:'production_wip_entry',
        quantity:    mpKg,
        unit:        'kg',
        unitCost:    parseFloat(mp.cost_per_kg || 0),
        statusTo:    'wip',
        ...ref,
        notes:     `MP paquete #${pkg.microlot_number} (${pct}%)`,
        createdBy: userId,
      })
    }
  }
}

/**
 * Modelo D Opción C — Entrada PROVISIONAL de merma al almacén REGRIND.
 *
 * Por cada material de la fórmula MP de la orden:
 *   - Calcula la cantidad: kg_merma × (% material / 100).
 *   - Registra entrada al almacén REGRIND con status='wip' y costo unitario embebido:
 *       unit_cost = avg_cost_MP × (1 + reprocessFactor)
 *
 * El stock queda como 'wip' (en proceso, pendiente). Cuando el supervisor valida
 * el turno, recordProductionValidation lo promueve de 'wip' a 'available'.
 *
 * Si el turno se cancela o no se valida, los movimientos 'wip' quedan
 * registrados pero NO afectan el stock disponible del regrind.
 */
async function recordScrapWipEntry(client, { tenantId, shift, scrapRecord, mpFormula, reprocessFactor, userId }) {
  let warehouseRegrind
  try {
    warehouseRegrind = await getWarehouseId(client, tenantId, 'regrind')
  } catch (e) {
    console.warn('[inventory] Almacén REGRIND no configurado:', e.message)
    return
  }

  const ref = { referenceType: 'shift_scrap', referenceId: scrapRecord.id }
  const totalKg = parseFloat(scrapRecord.kg || 0)
  const factor  = parseFloat(reprocessFactor || 0)
  if (totalKg <= 0 || mpFormula.length === 0) return

  for (const mp of mpFormula) {
    const pct = parseFloat(mp.percentage || 0)
    const kg  = totalKg * (pct / 100)
    if (kg <= 0) continue

    const baseCost     = parseFloat(mp.cost_per_kg || 0)
    const embeddedCost = baseCost * (1 + factor)

    await recordMovement(client, {
      tenantId,
      warehouseId: warehouseRegrind,
      itemType:    'raw_material',
      itemId:      mp.raw_material_id,
      movementType:'production_scrap_to_regrind',
      quantity:    kg,
      unit:        'kg',
      unitCost:    embeddedCost,
      statusTo:    'wip',
      ...ref,
      notes:     `Merma WIP turno #${shift.shift_number} (${pct}%) — pendiente validación — base $${baseCost.toFixed(2)} + ${(factor*100).toFixed(0)}% reproceso = $${embeddedCost.toFixed(2)}/kg`,
      createdBy: userId,
    })
  }
}

async function recordProductionValidation(client, { tenantId, shift, userId }) {
  // §P2 robusto (sesión 2026-05-29): si pt_goes_to_wip_first=true necesitamos WIP
  // obligatoriamente. Antes hacíamos warn silencioso y retornábamos sin generar
  // movimientos — el tenant quedaba con 0 filas en inventory_movements sin que
  // nadie se enterara (paopops). Ahora lanzamos error explícito para que la
  // validación falle y el supervisor sepa que falta configurar almacenes.
  const { rows: cfgPre } = await client.query(
    `SELECT pt_goes_to_wip_first FROM tenant_process_config WHERE tenant_id = $1`,
    [tenantId]
  )
  const wipRequired = cfgPre[0]?.pt_goes_to_wip_first !== false

  let warehouseWIP, warehousePT, warehouseMP
  try {
    warehouseWIP = await getWarehouseId(client, tenantId, 'wip')
    warehousePT  = await getWarehouseId(client, tenantId, 'finished_product')
    warehouseMP  = await getWarehouseId(client, tenantId, 'raw_material')
  } catch (e) {
    if (wipRequired) {
      const err = new Error(
        `Almacenes no configurados (${e.message}). El tenant tiene pt_goes_to_wip_first=true y necesita almacén tipo wip, finished_product y raw_material. Crea los almacenes faltantes en Configuración → Almacenes.`
      )
      err.status = 422
      err.code = 'WAREHOUSES_NOT_CONFIGURED'
      throw err
    }
    // Si el tenant tiene pt_goes_to_wip_first=false el flujo no requiere WIP;
    // se permite seguir y la captura habrá tocado PT directo en recordPackageCaptured.
    console.warn('[inventory] Almacenes parciales (pt_goes_to_wip_first=false):', e.message)
    return
  }

  // §6d: leer pt_goes_to_wip_first. Si es false, los productos ya están en PT
  // (los puso recordPackageCaptured) — saltamos los movimientos WIP→PT.
  const { rows: cfgRows } = await client.query(
    `SELECT pt_goes_to_wip_first FROM tenant_process_config WHERE tenant_id=$1`,
    [tenantId]
  )
  const ptGoesToWipFirst = cfgRows[0]?.pt_goes_to_wip_first !== false

  const ref = { referenceType: 'production_shift', referenceId: shift.id }

  // Grupos de PT producido en el turno (producto × calidad) con su costo unitario.
  // cal-1: usa el costo prorrateado POR MEDIDA (shift_product_costs) cuando existe
  // — así cada SKU entra al inventario con el costo real de su medida (mig 195).
  // Fallback al cost_per_unit del turno: turnos viejos sin prorrateo, 2da calidad,
  // o si la asignación por medida falló.
  const { rows: pkgGroups } = await client.query(
    `SELECT
       CASE
         WHEN sp.is_second_quality AND sp.second_quality_product_id IS NOT NULL
           THEN sp.second_quality_product_id
         ELSE po.product_id
       END AS product_id,
       sp.is_second_quality,
       SUM(sp.quantity_units) AS total_units,
       ps.cost_per_unit          AS shift_cost_per_unit,
       MAX(spc.cost_per_unit)    AS product_cost_per_unit
     FROM shift_progress sp
     JOIN production_orders po ON po.id = sp.production_order_id
     JOIN production_shifts  ps ON ps.id = sp.shift_id
     LEFT JOIN shift_product_costs spc
            ON spc.shift_id = sp.shift_id
           AND spc.product_id = po.product_id
           AND sp.is_second_quality = false
     WHERE sp.shift_id = $1
     GROUP BY
       CASE WHEN sp.is_second_quality AND sp.second_quality_product_id IS NOT NULL
            THEN sp.second_quality_product_id ELSE po.product_id END,
       sp.is_second_quality, ps.cost_per_unit`,
    [shift.id]
  )

  // Costo unitario efectivo de un grupo: el prorrateado por medida (cal-1) o, si
  // no hay, el promedio del turno (2da calidad / turnos previos a mig 195).
  // Defensa: un por-medida en 0 (o nulo) cae al promedio del turno — así un
  // prorrateo que salió $0 nunca valúa el PT en $0 si el turno sí tiene costo.
  const effectiveCostUnit = (grp) => {
    const perMeasure = parseFloat(grp.product_cost_per_unit || 0)
    if (!grp.is_second_quality && perMeasure > 0) return perMeasure
    return parseFloat(grp.shift_cost_per_unit || 0)
  }

  if (ptGoesToWipFirst) {
    for (const grp of pkgGroups) {
      if (!grp.product_id || !grp.total_units) continue
      const units    = parseFloat(grp.total_units)
      const costUnit = effectiveCostUnit(grp)
      const isSecond = grp.is_second_quality
      const label    = isSecond ? 'Calidad 2' : 'Calidad 1'
      const ptStatus = isSecond ? 'blocked' : 'available'

      await recordMovement(client, {
        tenantId,
        warehouseId: warehouseWIP,
        itemType:    'product',
        itemId:      grp.product_id,
        movementType:'production_wip_to_pt',
        quantity:    -units,
        unit:        'pza',
        unitCost:    costUnit,
        statusTo:    'wip',
        ...ref,
        notes:     `WIP→PT turno #${shift.shift_number} (${label})`,
        createdBy: userId,
      })

      await recordMovement(client, {
        tenantId,
        warehouseId: warehousePT,
        itemType:    'product',
        itemId:      grp.product_id,
        movementType:'production_pt_entry',
        quantity:    units,
        unit:        'pza',
        unitCost:    costUnit,
        statusTo:    ptStatus,
        ...ref,
        notes:     `Entrada PT turno #${shift.shift_number} (${label})${isSecond ? ' — bloqueada para venta' : ''}`,
        createdBy: userId,
      })
    }
  } else {
    // §6d fix (2026-05-29): flujo directo (pt_goes_to_wip_first=false). El PT ya
    // entró al almacén de producto terminado en la captura con costo 0 (el costo
    // del turno aún no se conocía). Ahora que validamos y tenemos cost_per_unit,
    // lo aplicamos. ANTES este caso se saltaba por completo → los lotes de PT
    // quedaban con costo 0 al validar.
    //
    // Idempotente: solo revalúa los movimientos de captura que siguen en costo 0,
    // así re-validar después de un revert no vuelve a inyectar el costo.
    // Nota: si parte del PT se vendió ANTES de validar (caso raro en este flujo),
    // el promedio resultante puede quedar ligeramente alto sobre el remanente.
    for (const grp of pkgGroups) {
      if (!grp.product_id || !grp.total_units) continue
      const costUnit = effectiveCostUnit(grp)
      if (costUnit <= 0) continue
      const ptStatus = grp.is_second_quality ? 'blocked' : 'available'

      // Movimientos de captura de PT de este turno (de CUALQUIER costo). En la 1ª
      // validación entraron a 0; tras un revert+revalidar conservan el costo VIEJO
      // (el revert no toca los movimientos con reference_type='shift_progress').
      // Por eso revaluamos con el DELTA (nuevo − actual), no solo cuando están en 0
      // — así re-validar con un cost_per_unit distinto SÍ actualiza el inventario.
      const { rows: capMovs } = await client.query(
        `SELECT COALESCE(SUM(quantity), 0)::numeric AS units,
                COALESCE(MAX(unit_cost), 0)::numeric AS cur_cost
           FROM inventory_movements
          WHERE tenant_id = $1 AND warehouse_id = $2 AND item_type = 'product'
            AND item_id = $3 AND movement_type = 'production_pt_entry'
            AND status_to = $4
            AND reference_type = 'shift_progress'
            AND reference_id IN (SELECT id FROM shift_progress WHERE shift_id = $5)`,
        [tenantId, warehousePT, grp.product_id, ptStatus, shift.id]
      )
      const capUnits = parseFloat(capMovs[0].units || 0)
      const curCost  = parseFloat(capMovs[0].cur_cost || 0)
      if (capUnits <= 0) continue
      if (Math.abs(curCost - costUnit) < 1e-6) continue  // ya tiene el costo correcto

      // Ajusta el avg_cost por el DELTA de valor de estas unidades (nuevo − viejo).
      const deltaValue = (costUnit - curCost) * capUnits
      await client.query(
        `UPDATE inventory_stock
            SET avg_cost = CASE WHEN quantity > 0
                 THEN ((quantity * avg_cost) + $1::numeric) / quantity
                 ELSE $2::numeric END,
                updated_at = NOW()
          WHERE tenant_id = $3 AND warehouse_id = $4 AND item_type = 'product'
            AND item_id = $5 AND status = $6`,
        [deltaValue, costUnit, tenantId, warehousePT, grp.product_id, ptStatus]
      )

      // Pone el costo nuevo en los movimientos de captura (valor del kardex).
      await client.query(
        `UPDATE inventory_movements
            SET unit_cost = $1::numeric
          WHERE tenant_id = $2 AND warehouse_id = $3 AND item_type = 'product'
            AND item_id = $4 AND movement_type = 'production_pt_entry'
            AND status_to = $5
            AND reference_type = 'shift_progress'
            AND reference_id IN (SELECT id FROM shift_progress WHERE shift_id = $6)`,
        [costUnit, tenantId, warehousePT, grp.product_id, ptStatus, shift.id]
      )
    }
  } // end if/else (ptGoesToWipFirst) — §6d

  const { rows: wipMp } = await client.query(
    `SELECT item_id, quantity, avg_cost
     FROM inventory_stock
     WHERE tenant_id=$1 AND warehouse_id=$2
       AND item_type='raw_material' AND status='wip' AND quantity > 0`,
    [tenantId, warehouseWIP]
  )

  for (const wip of wipMp) {
    const kg   = parseFloat(wip.quantity)
    const cost = parseFloat(wip.avg_cost)
    if (kg <= 0) continue

    await recordMovement(client, {
      tenantId,
      warehouseId: warehouseMP,
      itemType:    'raw_material',
      itemId:      wip.item_id,
      movementType:'production_mp_consumption',
      quantity:    -kg,
      unit:        'kg',
      unitCost:    cost,
      statusTo:    'available',
      ...ref,
      notes:     `Consumo MP turno #${shift.shift_number}`,
      createdBy: userId,
    })

    await recordMovement(client, {
      tenantId,
      warehouseId: warehouseWIP,
      itemType:    'raw_material',
      itemId:      wip.item_id,
      movementType:'production_mp_consumption',
      quantity:    -kg,
      unit:        'kg',
      unitCost:    cost,
      statusTo:    'wip',
      ...ref,
      notes:     `Cierre WIP turno #${shift.shift_number}`,
      createdBy: userId,
    })
  }

  // ── Modelo D Opción C: descuento MP virgen + promoción regrind WIP → available ──
  // Por cada registro de shift_scrap con orden vinculada:
  //   1. Descuenta MP virgen del almacén (consumo físico real, no se hizo al capturar).
  //   2. "Promueve" el stock del REGRIND de status='wip' a status='available'
  //      (la entrada wip ya se hizo al capturar la merma — ver recordScrapWipEntry).

  // Cargar el factor de reproceso (default 20% si no está configurado)
  const { rows: factorRows } = await client.query(
    `SELECT amount FROM production_cost_items
     WHERE tenant_id=$1 AND name='__scrap_factor__' AND is_active=true LIMIT 1`,
    [tenantId]
  )
  const reprocessFactor = factorRows[0] ? parseFloat(factorRows[0].amount)/100 : 0.20

  // Verificar si hay almacén REGRIND configurado
  let warehouseRegrind = null
  try {
    warehouseRegrind = await getWarehouseId(client, tenantId, 'regrind')
  } catch (e) {
    console.warn('[inventory] Almacén REGRIND no configurado, merma no se promoverá:', e.message)
  }

  // Iterar por cada registro de shift_scrap individualmente (no agrupado por orden)
  // para usar la fórmula MP que estaba VIGENTE al momento de captura (versionado).
  const { rows: scrapList } = await client.query(
    `SELECT id, production_order_id, kg, captured_at
     FROM shift_scrap
     WHERE shift_id = $1 AND production_order_id IS NOT NULL
     ORDER BY captured_at`,
    [shift.id]
  )

  for (const sc of scrapList) {
    const totalScrapKg = parseFloat(sc.kg)
    if (totalScrapKg <= 0) continue

    // Cargar la fórmula que estaba vigente al momento de captura de ESTA merma
    const { rows: formula } = await client.query(
      `SELECT omf.raw_material_id, omf.percentage, r.cost_per_kg
       FROM order_mp_formula omf
       JOIN raw_materials r ON r.id = omf.raw_material_id
       WHERE omf.production_order_id = $1
         AND omf.valid_from <= $2
         AND (omf.valid_until IS NULL OR omf.valid_until > $2)
       ORDER BY omf.sort_order`,
      [sc.production_order_id, sc.captured_at]
    )

    for (const mp of formula) {
      const pct = parseFloat(mp.percentage || 0)
      const kg  = totalScrapKg * (pct / 100)
      if (kg <= 0) continue
      const baseCost     = parseFloat(mp.cost_per_kg || 0)
      const embeddedCost = baseCost * (1 + reprocessFactor)

      // 1. Descontar MP virgen del almacén (consumo físico real)
      await recordMovement(client, {
        tenantId,
        warehouseId: warehouseMP,
        itemType:    'raw_material',
        itemId:      mp.raw_material_id,
        movementType:'production_mp_consumption',
        quantity:    -kg,
        unit:        'kg',
        unitCost:    baseCost,
        statusTo:    'available',
        ...ref,
        notes:     `MP virgen consumida por merma turno #${shift.shift_number} (${pct}%)`,
        createdBy: userId,
      })

      // 2. Promover REGRIND de wip → available (sale del wip, entra al available)
      if (warehouseRegrind) {
        // 2.a. Salida del WIP en regrind (cantidad negativa, status='wip')
        await recordMovement(client, {
          tenantId,
          warehouseId: warehouseRegrind,
          itemType:    'raw_material',
          itemId:      mp.raw_material_id,
          movementType:'production_scrap_to_regrind',
          quantity:    -kg,
          unit:        'kg',
          unitCost:    embeddedCost,
          statusTo:    'wip',
          ...ref,
          notes:     `Cierre WIP regrind turno #${shift.shift_number} (${pct}%) — promueve a disponible`,
          createdBy: userId,
        })

        // 2.b. Entrada al disponible en regrind (cantidad positiva, status='available')
        await recordMovement(client, {
          tenantId,
          warehouseId: warehouseRegrind,
          itemType:    'raw_material',
          itemId:      mp.raw_material_id,
          movementType:'production_scrap_to_regrind',
          quantity:    kg,
          unit:        'kg',
          unitCost:    embeddedCost,
          statusTo:    'available',
          ...ref,
          notes:     `Merma validada turno #${shift.shift_number} (${pct}%) — disponible para reproceso a $${embeddedCost.toFixed(2)}/kg`,
          createdBy: userId,
        })
      }
    }
  }
}

// ─── Consultas públicas ───────────────────────────────────────────────────────

async function getWarehouses({ tenantId }) {
  const { rows } = await query(
    `SELECT id, name, type, resin_type, description, is_active, is_default
     FROM warehouses WHERE tenant_id=$1 AND is_active=true
     ORDER BY CASE type
       WHEN 'raw_material'     THEN 1
       WHEN 'wip'              THEN 2
       WHEN 'finished_product' THEN 3
       WHEN 'regrind'          THEN 4
       WHEN 'resale'           THEN 5
       ELSE 6 END,
       is_default DESC, name`,
    [tenantId]
  )
  return rows
}

async function getInventorySummary({ tenantId }) {
  const { rows } = await query(
    `SELECT
       w.id AS warehouse_id, w.name AS warehouse_name, w.type AS warehouse_type,
       s.item_type,
       COUNT(DISTINCT s.item_id)              AS item_count,
       ROUND(SUM(s.quantity), 2)              AS total_quantity,
       ROUND(SUM(s.quantity * s.avg_cost), 2) AS total_value
     FROM inventory_stock s
     JOIN warehouses w ON w.id = s.warehouse_id
     WHERE s.tenant_id=$1 AND s.quantity <> 0 AND w.is_active=true
     GROUP BY w.id, w.name, w.type, s.item_type
     ORDER BY
       CASE w.type WHEN 'raw_material' THEN 1 WHEN 'wip' THEN 2 WHEN 'finished_product' THEN 3 ELSE 4 END,
       s.item_type`,
    [tenantId]
  )
  return rows
}

/**
 * Stock actual. Por default lista filas de inventory_stock con saldo distinto
 * de cero (incluye NEGATIVOS — ver mig 193 / allow_negative_stock).
 *
 * includeZero=true: además inyecta una fila sintética (cantidad 0, sin almacén)
 * por cada artículo ACTIVO del catálogo (productos + MP) que NO tenga existencia
 * distinta de cero que matchee el filtro de almacén. Sirve para el toggle
 * "incluir artículos en cero" de la pantalla de Inventario (ver TODO mi catálogo,
 * tenga o no existencia). El filtro de almacén, tipo y búsqueda se respetan.
 */
async function getStock({ tenantId, warehouseId, itemType, status, search, includeZero = false, page = 1, limit = 50 }) {
  const offset = (page - 1) * limit
  const conds  = ['s.tenant_id = $1', 's.quantity <> 0']
  const params = [tenantId]
  let i = 2

  let whIdx = null
  if (warehouseId) { whIdx = i; conds.push(`s.warehouse_id = $${i++}`); params.push(warehouseId) }
  if (itemType)    { conds.push(`s.item_type = $${i++}`);                params.push(itemType) }
  if (status)      { conds.push(`s.status = $${i++}`);                   params.push(status) }

  let searchIdx = null
  if (search) {
    searchIdx = i
    conds.push(`(rm.name ILIKE $${i} OR p.name ILIKE $${i})`)
    params.push(`%${search}%`)
    i++
  }

  const stockSelect = `
    SELECT
      s.id::text AS id, s.item_type::text AS item_type, s.item_id, s.warehouse_id, s.status::text AS status,
      s.quantity, s.unit, s.avg_cost,
      ROUND(s.quantity * s.avg_cost, 2) AS total_value,
      s.last_movement_at,
      w.name AS warehouse_name, w.type::text AS warehouse_type,
      CASE s.item_type
        WHEN 'raw_material' THEN rm.name
        WHEN 'product'      THEN p.name
        ELSE 'Desconocido'
      END AS item_name,
      rm.resin_type::text AS resin_type, rm.material_type::text AS material_type, p.sku
    FROM inventory_stock s
    JOIN warehouses w ON w.id = s.warehouse_id
    LEFT JOIN raw_materials rm ON rm.id = s.item_id AND s.item_type = 'raw_material'
    LEFT JOIN products p       ON p.id  = s.item_id AND s.item_type = 'product'
    WHERE ${conds.join(' AND ')}
  `

  const unionParts = [stockSelect]

  if (includeZero) {
    // El NOT EXISTS respeta el filtro de almacén (si se pidió) reusando $whIdx.
    const notExistsWh = whIdx ? `AND s2.warehouse_id = $${whIdx}` : ''
    // Filtro de búsqueda por nombre (reusa $searchIdx).
    const rmSearch = searchIdx ? `AND x.name ILIKE $${searchIdx}` : ''
    const pSearch  = searchIdx ? `AND (x.name ILIKE $${searchIdx} OR COALESCE(x.sku,'') ILIKE $${searchIdx})` : ''

    if (!itemType || itemType === 'raw_material') {
      unionParts.push(`
        SELECT
          'zero:raw_material:' || x.id::text AS id, 'raw_material' AS item_type, x.id AS item_id,
          NULL::uuid AS warehouse_id, 'available' AS status,
          0::numeric AS quantity, COALESCE(x.unit, 'kg') AS unit, 0::numeric AS avg_cost,
          0::numeric AS total_value, NULL::timestamptz AS last_movement_at,
          NULL::text AS warehouse_name, NULL::text AS warehouse_type,
          x.name AS item_name, x.resin_type::text AS resin_type, x.material_type::text AS material_type, NULL::text AS sku
        FROM raw_materials x
        WHERE x.tenant_id = $1 AND x.is_active = true ${rmSearch}
          AND NOT EXISTS (
            SELECT 1 FROM inventory_stock s2
            WHERE s2.tenant_id = $1 AND s2.item_type = 'raw_material'
              AND s2.item_id = x.id AND s2.quantity <> 0 ${notExistsWh}
          )
      `)
    }
    if (!itemType || itemType === 'product') {
      unionParts.push(`
        SELECT
          'zero:product:' || x.id::text AS id, 'product' AS item_type, x.id AS item_id,
          NULL::uuid AS warehouse_id, 'available' AS status,
          0::numeric AS quantity, 'pza' AS unit, 0::numeric AS avg_cost,
          0::numeric AS total_value, NULL::timestamptz AS last_movement_at,
          NULL::text AS warehouse_name, NULL::text AS warehouse_type,
          x.name AS item_name, NULL::text AS resin_type, NULL::text AS material_type, x.sku
        FROM products x
        WHERE x.tenant_id = $1 AND x.is_active = true ${pSearch}
          AND NOT EXISTS (
            SELECT 1 FROM inventory_stock s2
            WHERE s2.tenant_id = $1 AND s2.item_type = 'product'
              AND s2.item_id = x.id AND s2.quantity <> 0 ${notExistsWh}
          )
      `)
    }
  }

  const unionSql = unionParts.join('\n      UNION ALL\n')

  const sql = `
    SELECT * FROM (
      ${unionSql}
    ) q
    ORDER BY
      CASE q.warehouse_type WHEN 'raw_material' THEN 1 WHEN 'wip' THEN 2 WHEN 'finished_product' THEN 3 ELSE 5 END,
      q.item_type, q.item_name
    LIMIT $${i} OFFSET $${i + 1}
  `
  params.push(limit, offset)

  const countSql = `SELECT COUNT(*) AS total FROM (${unionSql}) q`

  const [stockRes, countRes] = await Promise.all([
    query(sql, params),
    query(countSql, params.slice(0, -2)),
  ])
  return { data: stockRes.rows, total: parseInt(countRes.rows[0].total), page, limit }
}

async function getMovements({ tenantId, itemType, itemId, warehouseId, movementType, dateFrom, dateTo, page = 1, limit = 50 }) {
  const offset = (page - 1) * limit
  const conds  = ['m.tenant_id = $1']
  const params = [tenantId]
  let i = 2

  if (itemType)     { conds.push(`m.item_type = $${i++}`);     params.push(itemType) }
  if (itemId)       { conds.push(`m.item_id = $${i++}`);       params.push(itemId) }
  if (warehouseId)  { conds.push(`m.warehouse_id = $${i++}`);  params.push(warehouseId) }
  if (movementType) { conds.push(`m.movement_type = $${i++}`); params.push(movementType) }
  if (dateFrom)     { conds.push(`m.created_at >= $${i++}`);   params.push(dateFrom) }
  if (dateTo) {
    const dateToFinal = /^\d{4}-\d{2}-\d{2}$/.test(dateTo)
      ? `${dateTo} 23:59:59.999`
      : dateTo
    conds.push(`m.created_at <= $${i++}`)
    params.push(dateToFinal)
  }

  const sql = `
    SELECT m.*,
      w.name AS warehouse_name,
      CASE m.item_type
        WHEN 'raw_material' THEN rm.name
        WHEN 'product'      THEN p.name
        ELSE 'Desconocido'
      END AS item_name,
      u.full_name AS created_by_name
    FROM inventory_movements m
    JOIN warehouses w ON w.id = m.warehouse_id
    LEFT JOIN raw_materials rm ON rm.id = m.item_id AND m.item_type = 'raw_material'
    LEFT JOIN products p       ON p.id  = m.item_id AND m.item_type = 'product'
    LEFT JOIN users u          ON u.id  = m.created_by
    WHERE ${conds.join(' AND ')}
    ORDER BY m.created_at DESC
    LIMIT $${i} OFFSET $${i + 1}
  `
  params.push(limit, offset)

  const countSql = `SELECT COUNT(*) AS total FROM inventory_movements m WHERE ${conds.join(' AND ')}`
  const [movRes, countRes] = await Promise.all([
    query(sql, params),
    query(countSql, params.slice(0, -2)),
  ])
  return { data: movRes.rows, total: parseInt(countRes.rows[0].total), page, limit }
}

// ─── Documentos de ajuste ─────────────────────────────────────────────────────

async function nextAdjustmentNumber(client, tenantId, opts = {}) {
  const result = await documentSeriesService.generateDocumentNumber({
    client, tenantId, entityType: 'inventory_adjustment', opts,
  })
  if (result) return result.docNumber

  const ym = new Date().toISOString().slice(0, 7).replace('-', '')
  const prefix = `AJ-${ym}-`
  const { rows } = await client.query(
    `SELECT adjustment_number FROM inventory_adjustments
     WHERE tenant_id = $1 AND adjustment_number LIKE $2
     ORDER BY adjustment_number DESC LIMIT 1`,
    [tenantId, `${prefix}%`]
  )
  const last = rows[0]?.adjustment_number
  const seq  = last ? parseInt(last.split('-')[2], 10) + 1 : 1
  return `${prefix}${String(seq).padStart(4, '0')}`
}

/**
 * Crea un documento de ajuste con varias líneas.
 *
 * Notas obligatorias: tanto `notes` (cabecera) como `notes` por línea son
 * obligatorias para garantizar trazabilidad completa.
 *
 * Bloqueo nuevo: rechaza ajustes contra almacenes tipo 'wip' (read-only).
 */
async function createAdjustmentDocument({
  tenantId, warehouseId, reason, notes, lines = [], userId,
}) {
  if (!warehouseId)              throw createError(400, 'warehouseId es requerido.')
  if (!reason || !reason.trim()) throw createError(400, 'reason (motivo) es requerido.')
  if (!notes  || !notes.trim())  throw createError(400, 'notes (notas adicionales) es obligatorio.')
  if (!Array.isArray(lines) || lines.length === 0) {
    throw createError(400, 'Se requiere al menos una línea.')
  }

  // Validación previa de cada línea
  lines.forEach((ln, idx) => {
    if (!ln.itemType || !['raw_material', 'product'].includes(ln.itemType)) {
      throw createError(400, `Línea ${idx + 1}: itemType inválido (debe ser raw_material o product).`)
    }
    if (!ln.itemId) throw createError(400, `Línea ${idx + 1}: itemId es requerido.`)
    if (!ln.direction || !['in', 'out'].includes(ln.direction)) {
      throw createError(400, `Línea ${idx + 1}: direction debe ser 'in' o 'out'.`)
    }
    const q = parseFloat(ln.quantity)
    if (isNaN(q) || q <= 0) {
      throw createError(400, `Línea ${idx + 1}: quantity debe ser un número positivo.`)
    }
    if (!ln.notes || !String(ln.notes).trim()) {
      throw createError(400, `Línea ${idx + 1}: las notas son obligatorias.`)
    }
  })

  return withTransaction(async (client) => {
    const { rows: whRows } = await client.query(
      `SELECT id, type FROM warehouses WHERE id=$1 AND tenant_id=$2 AND is_active=true`,
      [warehouseId, tenantId]
    )
    if (!whRows[0]) throw createError(404, 'Almacén no encontrado o inactivo.')
    if (whRows[0].type === 'wip') {
      throw createError(409,
        'Los almacenes WIP son de solo lectura. Solo los hooks de producción pueden moverlos.')
    }

    const adjustmentNumber = await nextAdjustmentNumber(client, tenantId)
    const { rows: hdrRows } = await client.query(
      `INSERT INTO inventory_adjustments
         (tenant_id, adjustment_number, warehouse_id, reason, notes,
          total_lines, total_in_value, total_out_value, status, created_by)
       VALUES ($1, $2, $3, $4, $5, 0, 0, 0, 'active', $6)
       RETURNING *`,
      [tenantId, adjustmentNumber, warehouseId, reason.trim(), notes.trim(), userId]
    )
    const header = hdrRows[0]

    let totalIn  = 0
    let totalOut = 0

    for (const ln of lines) {
      const qtyAbs   = parseFloat(ln.quantity)
      const isIn     = ln.direction === 'in'
      const signedQ  = isIn ? qtyAbs : -qtyAbs
      const unitCost = parseFloat(ln.unitCost || 0)
      const unit     = ln.unit || (ln.itemType === 'raw_material' ? 'kg' : 'pza')
      const lineVal  = qtyAbs * unitCost

      await recordMovement(client, {
        tenantId,
        warehouseId,
        itemType:     ln.itemType,
        itemId:       ln.itemId,
        movementType: isIn ? 'adjustment_in' : 'adjustment_out',
        quantity:     signedQ,
        unit,
        unitCost,
        statusTo:     'available',
        referenceType:'inventory_adjustment',
        referenceId:  header.id,
        notes:        String(ln.notes).trim(),
        createdBy:    userId,
        validateStock:true,
      })

      if (isIn) totalIn  += lineVal
      else      totalOut += lineVal
    }

    await client.query(
      `UPDATE inventory_adjustments
       SET total_lines = $1, total_in_value = $2, total_out_value = $3
       WHERE id = $4`,
      [lines.length, totalIn.toFixed(2), totalOut.toFixed(2), header.id]
    )

    const { rows: finalRows } = await client.query(
      `SELECT * FROM inventory_adjustments WHERE id = $1`, [header.id]
    )
    return finalRows[0]
  })
}

/**
 * Cancela un ajuste existente generando movimientos contrarios.
 */
async function cancelAdjustment({ tenantId, adjustmentId, reason, userId }) {
  if (!reason || !String(reason).trim()) {
    throw createError(400, 'reason (razón de la cancelación) es obligatorio.')
  }

  return withTransaction(async (client) => {
    const { rows: adjRows } = await client.query(
      `SELECT * FROM inventory_adjustments
       WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
      [adjustmentId, tenantId]
    )
    if (!adjRows.length) throw createError(404, 'Ajuste no encontrado.')
    const adj = adjRows[0]

    if (adj.status === 'cancelled') {
      throw createError(409, 'Este ajuste ya está cancelado.')
    }

    const { rows: origMovs } = await client.query(
      `SELECT * FROM inventory_movements
       WHERE reference_type = 'inventory_adjustment' AND reference_id = $1
       ORDER BY created_at ASC`,
      [adjustmentId]
    )

    if (!origMovs.length) {
      throw createError(409, 'No se encontraron movimientos para revertir.')
    }

    try {
      for (const m of origMovs) {
        const oppositeQty  = -parseFloat(m.quantity)
        const oppositeType = m.movement_type === 'adjustment_in'
          ? 'adjustment_out'
          : 'adjustment_in'

        await recordMovement(client, {
          tenantId,
          warehouseId:   m.warehouse_id,
          itemType:      m.item_type,
          itemId:        m.item_id,
          movementType:  oppositeType,
          quantity:      oppositeQty,
          unit:          m.unit,
          unitCost:      parseFloat(m.unit_cost || 0),
          statusTo:      m.status_to || 'available',
          referenceType: 'inventory_adjustment_reversal',
          referenceId:   adjustmentId,
          notes:         `Reversión por cancelación: ${String(reason).trim()}`,
          createdBy:     userId,
          validateStock: true,
        })
      }
    } catch (err) {
      if (err.status === 400 && /Stock insuficiente|No existe stock/i.test(err.message || '')) {
        throw createError(
          409,
          'No se puede cancelar este ajuste: parte del inventario que generó ya fue consumido o movido. Crea un ajuste nuevo para corregir manualmente.'
        )
      }
      throw err
    }

    await client.query(
      `UPDATE inventory_adjustments
       SET status='cancelled', cancelled_at=NOW(),
           cancelled_by=$1, cancellation_reason=$2
       WHERE id=$3`,
      [userId, String(reason).trim(), adjustmentId]
    )

    const { rows: final } = await client.query(
      `SELECT * FROM inventory_adjustments WHERE id=$1`, [adjustmentId]
    )
    return final[0]
  })
}

async function listAdjustments({
  tenantId, warehouseId, status, dateFrom, dateTo, search, page = 1, limit = 50,
}) {
  const offset = (page - 1) * limit
  const conds  = ['ia.tenant_id = $1']
  const params = [tenantId]
  let i = 2

  if (warehouseId) { conds.push(`ia.warehouse_id = $${i++}`); params.push(warehouseId) }
  if (status)      { conds.push(`ia.status = $${i++}`);       params.push(status) }
  if (dateFrom)    { conds.push(`ia.adjustment_date >= $${i++}`); params.push(dateFrom) }
  if (dateTo)      { conds.push(`ia.adjustment_date <= $${i++}`); params.push(dateTo) }
  if (search) {
    conds.push(`(ia.adjustment_number ILIKE $${i} OR ia.reason ILIKE $${i})`)
    params.push(`%${search}%`)
    i++
  }

  const sql = `
    SELECT ia.id, ia.adjustment_number, ia.adjustment_date, ia.reason, ia.notes,
           ia.total_lines, ia.total_in_value, ia.total_out_value, ia.net_value,
           ia.status, ia.cancelled_at, ia.cancellation_reason,
           ia.created_at,
           w.name AS warehouse_name, w.type AS warehouse_type,
           u.full_name  AS created_by_name,
           uc.full_name AS cancelled_by_name
    FROM inventory_adjustments ia
    JOIN warehouses w ON w.id = ia.warehouse_id
    LEFT JOIN users u  ON u.id = ia.created_by
    LEFT JOIN users uc ON uc.id = ia.cancelled_by
    WHERE ${conds.join(' AND ')}
    ORDER BY ia.adjustment_date DESC, ia.adjustment_number DESC
    LIMIT $${i} OFFSET $${i + 1}
  `
  params.push(limit, offset)

  const countSql = `SELECT COUNT(*) AS total FROM inventory_adjustments ia WHERE ${conds.join(' AND ')}`
  const [listRes, countRes] = await Promise.all([
    query(sql, params),
    query(countSql, params.slice(0, -2)),
  ])
  return { data: listRes.rows, total: parseInt(countRes.rows[0].total), page, limit }
}

async function getAdjustment({ tenantId, adjustmentId }) {
  const { rows } = await query(
    `SELECT ia.*,
            w.name AS warehouse_name, w.type AS warehouse_type,
            u.full_name  AS created_by_name,
            uc.full_name AS cancelled_by_name
     FROM inventory_adjustments ia
     JOIN warehouses w ON w.id = ia.warehouse_id
     LEFT JOIN users u  ON u.id = ia.created_by
     LEFT JOIN users uc ON uc.id = ia.cancelled_by
     WHERE ia.id = $1 AND ia.tenant_id = $2`,
    [adjustmentId, tenantId]
  )
  if (!rows.length) return null
  const header = rows[0]

  const { rows: lines } = await query(
    `SELECT m.id, m.item_type, m.item_id, m.movement_type,
            m.quantity, m.unit, m.unit_cost, m.balance_after, m.notes,
            m.created_at,
            CASE m.item_type
              WHEN 'raw_material' THEN rm.name
              WHEN 'product'      THEN p.name
              ELSE 'Desconocido'
            END AS item_name,
            rm.resin_type, rm.material_type, p.sku
     FROM inventory_movements m
     LEFT JOIN raw_materials rm ON rm.id = m.item_id AND m.item_type = 'raw_material'
     LEFT JOIN products p       ON p.id  = m.item_id AND m.item_type = 'product'
     WHERE m.reference_type = 'inventory_adjustment' AND m.reference_id = $1
     ORDER BY m.created_at ASC`,
    [adjustmentId]
  )

  const { rows: reversalLines } = await query(
    `SELECT m.id, m.item_type, m.item_id, m.movement_type,
            m.quantity, m.unit, m.unit_cost, m.balance_after, m.notes,
            m.created_at,
            CASE m.item_type
              WHEN 'raw_material' THEN rm.name
              WHEN 'product'      THEN p.name
              ELSE 'Desconocido'
            END AS item_name,
            rm.resin_type, rm.material_type, p.sku
     FROM inventory_movements m
     LEFT JOIN raw_materials rm ON rm.id = m.item_id AND m.item_type = 'raw_material'
     LEFT JOIN products p       ON p.id  = m.item_id AND m.item_type = 'product'
     WHERE m.reference_type = 'inventory_adjustment_reversal' AND m.reference_id = $1
     ORDER BY m.created_at ASC`,
    [adjustmentId]
  )

  return { ...header, lines, reversalLines }
}

/**
 * Recalcula el saldo de inventory_stock a partir de la SUMA del kardex
 * (inventory_movements) por (almacén, tipo, ítem, status).
 *
 * La cantidad de cada movimiento se guardó SIEMPRE con su signo real, incluso
 * cuando el saldo se clampaba a 0 históricamente (solo balance_after/quantity
 * se clampaban, no inventory_movements.quantity). Por eso la suma del kardex =
 * posición verdadera, y revela los negativos por sobreventas pasadas.
 *
 * apply=false → solo devuelve el diff (vista previa); NO escribe.
 * apply=true  → actualiza inventory_stock.quantity en las combinaciones que no
 *   cuadran (|actual − calculado| > 0.0001). NO toca avg_cost (un saldo negativo
 *   con costo positivo da valor negativo = "se debe inventario", la señal
 *   deseada). Solo considera combinaciones presentes en el kardex; no borra
 *   filas de stock sin movimientos.
 */
async function recomputeStockFromMovements({ tenantId, apply = false }) {
  const { rows: diffs } = await query(
    `WITH computed AS (
       SELECT m.warehouse_id, m.item_type, m.item_id,
              COALESCE(m.status_to, 'available') AS status,
              SUM(m.quantity)::numeric AS computed_qty
         FROM inventory_movements m
        WHERE m.tenant_id = $1
        GROUP BY m.warehouse_id, m.item_type, m.item_id, COALESCE(m.status_to, 'available')
     )
     SELECT c.warehouse_id, c.item_type::text AS item_type, c.item_id, c.status::text AS status,
            c.computed_qty,
            COALESCE(s.quantity, 0)::numeric AS current_qty,
            s.id AS stock_id,
            COALESCE(s.unit, CASE c.item_type WHEN 'raw_material'::inventory_item_type THEN 'kg' ELSE 'pza' END) AS unit,
            COALESCE(s.avg_cost, 0)::numeric AS avg_cost,
            w.name AS warehouse_name,
            CASE c.item_type
              WHEN 'raw_material'::inventory_item_type THEN rm.name
              WHEN 'product'::inventory_item_type      THEN p.name
            END AS item_name,
            p.sku
       FROM computed c
       JOIN warehouses w ON w.id = c.warehouse_id
       LEFT JOIN inventory_stock s ON s.tenant_id = $1 AND s.warehouse_id = c.warehouse_id
              AND s.item_type = c.item_type AND s.item_id = c.item_id AND s.status = c.status
       LEFT JOIN raw_materials rm ON rm.id = c.item_id AND c.item_type = 'raw_material'::inventory_item_type
       LEFT JOIN products p       ON p.id  = c.item_id AND c.item_type = 'product'::inventory_item_type
      WHERE ABS(COALESCE(s.quantity, 0) - c.computed_qty) > 0.0001
      ORDER BY w.name, item_name`,
    [tenantId]
  )

  const mapped = diffs.map(d => ({
    itemType:      d.item_type,
    itemId:        d.item_id,
    itemName:      d.item_name,
    sku:           d.sku,
    warehouseId:   d.warehouse_id,
    warehouseName: d.warehouse_name,
    status:        d.status,
    currentQty:    parseFloat(d.current_qty),
    computedQty:   parseFloat(d.computed_qty),
    delta:         parseFloat((parseFloat(d.computed_qty) - parseFloat(d.current_qty)).toFixed(4)),
  }))

  if (!apply || diffs.length === 0) {
    return { applied: false, count: mapped.length, diffs: mapped }
  }

  await withTransaction(async (client) => {
    for (const d of diffs) {
      if (d.stock_id) {
        await client.query(
          `UPDATE inventory_stock SET quantity = $1, updated_at = NOW() WHERE id = $2`,
          [parseFloat(d.computed_qty).toFixed(4), d.stock_id]
        )
      } else {
        await client.query(
          `INSERT INTO inventory_stock
             (tenant_id, warehouse_id, item_type, item_id, status, quantity, unit, avg_cost, last_movement_at)
           VALUES ($1, $2, $3::inventory_item_type, $4, $5, $6, $7, $8, NOW())`,
          [tenantId, d.warehouse_id, d.item_type, d.item_id, d.status,
           parseFloat(d.computed_qty).toFixed(4), d.unit, parseFloat(d.avg_cost).toFixed(6)]
        )
      }
    }
  })

  return { applied: true, count: mapped.length, diffs: mapped }
}

/**
 * Recalcula el COSTO PROMEDIO (avg_cost) de cada renglón de inventory_stock
 * REPRODUCIENDO el kardex cronológicamente con la misma regla de promedio
 * ponderado que updateStock. Útil cuando el avg_cost quedó "pegado" en un valor
 * que el kardex no justifica (importación/edición/saldo inicial fuera de kardex),
 * y las entradas a costo $0 no lo bajan por el endurecimiento de costo.
 *
 * apply=false → solo el diff (costo actual vs recalculado). apply=true → aplica.
 * Solo toca renglones que TIENEN historial en el kardex (para no borrar el costo
 * de saldos capturados sin movimientos; ésos se auditan con recompute de saldos).
 */
async function recomputeAvgCostFromMovements({ tenantId, apply = false }) {
  const { rows: cfg } = await query(
    `SELECT allow_negative_stock FROM tenant_process_config WHERE tenant_id = $1`, [tenantId])
  const allowNeg = cfg[0]?.allow_negative_stock === true

  // Movimientos ordenados por renglón y por tiempo (replay determinista).
  const { rows: movs } = await query(
    `SELECT m.warehouse_id, m.item_type::text AS item_type, m.item_id,
            COALESCE(m.status_to, 'available')::text AS status,
            m.quantity::numeric AS quantity, m.unit_cost::numeric AS unit_cost
       FROM inventory_movements m
      WHERE m.tenant_id = $1
      ORDER BY m.warehouse_id, m.item_type, m.item_id, COALESCE(m.status_to, 'available'),
               m.created_at, m.id`,
    [tenantId])

  // Replay del promedio ponderado REAL por renglón. A DIFERENCIA de updateStock,
  // aquí una entrada a costo $0 SÍ diluye el promedio (no se endurece): el
  // recálculo refleja el costo verdadero de TODO lo que entró, incluyendo el stock
  // sin costear (producción a $0, maquilador a $0). Ese endurecimiento es
  // justamente lo que dejaba el promedio "pegado" en un valor viejo alto.
  const groups = new Map()
  for (const m of movs) {
    const key = `${m.warehouse_id}|${m.item_type}|${m.item_id}|${m.status}`
    let g = groups.get(key)
    if (!g) { g = { qty: 0, cost: 0 }; groups.set(key, g) }
    const delta = parseFloat(m.quantity) || 0
    const uc    = parseFloat(m.unit_cost) || 0
    if (delta > 0) {  // toda ENTRADA promedia — incluso a $0 (diluye)
      const denom = g.qty + delta
      g.cost = (g.qty > 0 && denom > 0) ? ((g.qty * g.cost) + (delta * uc)) / denom : uc
    }
    const raw = g.qty + delta
    g.qty = allowNeg ? raw : Math.max(0, raw)
  }

  // Comparar contra el avg_cost actual (renglones con existencia).
  const { rows: stock } = await query(
    `SELECT s.id, s.warehouse_id, s.item_type::text AS item_type, s.item_id, s.status::text AS status,
            s.quantity::numeric AS quantity, s.avg_cost::numeric AS avg_cost,
            w.name AS warehouse_name,
            CASE s.item_type WHEN 'raw_material' THEN rm.name WHEN 'product' THEN p.name END AS item_name,
            CASE s.item_type WHEN 'product' THEN p.sku WHEN 'raw_material' THEN rm.code END AS code
       FROM inventory_stock s
       JOIN warehouses w ON w.id = s.warehouse_id
       LEFT JOIN raw_materials rm ON rm.id = s.item_id AND s.item_type = 'raw_material'
       LEFT JOIN products p       ON p.id  = s.item_id AND s.item_type = 'product'
      WHERE s.tenant_id = $1 AND s.quantity <> 0`,
    [tenantId])

  const diffs = []
  for (const s of stock) {
    const key = `${s.warehouse_id}|${s.item_type}|${s.item_id}|${s.status}`
    const g = groups.get(key)
    if (!g) continue  // sin historial en kardex → no se toca aquí
    const recomputed = parseFloat(g.cost.toFixed(6))
    const current    = parseFloat(s.avg_cost)
    if (Math.abs(recomputed - current) > 0.0001) {
      const qty = parseFloat(s.quantity)
      diffs.push({
        stockId: s.id, warehouseName: s.warehouse_name, itemName: s.item_name, code: s.code || '',
        quantity: qty,
        currentAvgCost: current, recomputedAvgCost: recomputed,
        valueBefore: qty * current, valueAfter: qty * recomputed,
        valueDelta: qty * (recomputed - current),
      })
    }
  }
  diffs.sort((a, b) => Math.abs(b.valueDelta) - Math.abs(a.valueDelta))

  if (!apply || diffs.length === 0) {
    return { applied: false, count: diffs.length, diffs }
  }

  await withTransaction(async (client) => {
    for (const d of diffs) {
      await client.query(
        `UPDATE inventory_stock SET avg_cost = $1, updated_at = NOW() WHERE id = $2`,
        [d.recomputedAvgCost.toFixed(6), d.stockId])
    }
  })
  return { applied: true, count: diffs.length, diffs }
}

async function searchItems({ tenantId, q = '', type = null, warehouseId = null, limit = 20 }) {
  const like = `%${q}%`
  const params = [tenantId, like]
  let stockJoinMP = ''
  let stockJoinPT = ''
  let stockColsMP = '0::numeric AS avg_cost, 0::numeric AS current_quantity'
  let stockColsPT = '0::numeric AS avg_cost, 0::numeric AS current_quantity'

  if (warehouseId) {
    params.push(warehouseId)
    stockJoinMP = `LEFT JOIN inventory_stock s
      ON s.tenant_id = rm.tenant_id AND s.item_id = rm.id
      AND s.item_type = 'raw_material' AND s.warehouse_id = $3
      AND s.status = 'available'`
    stockJoinPT = `LEFT JOIN inventory_stock s
      ON s.tenant_id = p.tenant_id AND s.item_id = p.id
      AND s.item_type = 'product' AND s.warehouse_id = $3
      AND s.status = 'available'`
    stockColsMP = `COALESCE(s.avg_cost, 0)::numeric AS avg_cost,
                   COALESCE(s.quantity, 0)::numeric AS current_quantity`
    stockColsPT = `COALESCE(s.avg_cost, 0)::numeric AS avg_cost,
                   COALESCE(s.quantity, 0)::numeric AS current_quantity`
  }

  const parts = []

  if (!type || type === 'raw_material') {
    parts.push(`
      SELECT rm.id, rm.name, NULL AS sku,
             'raw_material' AS item_type, 'kg' AS unit,
             ${stockColsMP}
      FROM raw_materials rm
      ${stockJoinMP}
      WHERE rm.tenant_id = $1 AND rm.is_active = true AND rm.name ILIKE $2
    `)
  }
  if (!type || type === 'product') {
    parts.push(`
      SELECT p.id, p.name, p.sku,
             'product' AS item_type, 'pza' AS unit,
             ${stockColsPT}
      FROM products p
      ${stockJoinPT}
      WHERE p.tenant_id = $1 AND p.is_active = true
        AND (p.name ILIKE $2 OR COALESCE(p.sku,'') ILIKE $2)
    `)
  }

  const sql = `${parts.join(' UNION ALL ')} ORDER BY name LIMIT ${parseInt(limit, 10)}`
  const { rows } = await query(sql, params)
  return rows
}

module.exports = {
  recordMovement,
  recordPackageCaptured,
  recordProductionValidation,
  recordScrapWipEntry,
  getStock,
  getWarehouses,
  getWarehouseId,
  getWarehouseIdForItemKind,
  getWarehouseIdForRawMaterial,
  getMovements,
  getInventorySummary,

  createAdjustmentDocument,
  cancelAdjustment,
  listAdjustments,
  getAdjustment,
  recomputeStockFromMovements,
  recomputeAvgCostFromMovements,

  searchItems,
}
