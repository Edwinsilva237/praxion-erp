'use strict'

const { query, withTransaction } = require('../../db')
const { audit } = require('../../utils/audit')
const pushEvents = require('../push/pushEvents')
const { recordMovement, recordPackageCaptured, recordProductionValidation, recordScrapWipEntry,
        getWarehouseId, getWarehouseIdForRawMaterial } = require('../inventory/inventoryService')
const { resolveRecipeForOrder } = require('./recipeResolver')  // SaaS v2 refactor §5d
const { selectLotsForQuantity } = require('./lotSelector')     // SaaS v2 refactor §5f
const { ensureProductLotForPackage, distributeRawMaterialLotsToProductLots,
        validateAllergenConsistency } = require('./productLotMaintainer')  // §5g, §5h
const { resolveLotPattern } = require('./productLotResolver')  // §5g
const { resolveScrapType, legacyScrapTypeFor, legacyDestinationFor,
        DESTINATION_LEGACY_MAP } = require('./scrapTypeResolver')  // §6b
const { evaluateAbnormal } = require('./abnormalScrapEvaluator')  // §6b
const { fetchAndComputeScrapProductCost } = require('./scrapCosting')  // costeo de merma por tipo
const { allocateShiftCostByProduct } = require('./shiftCostAllocation')  // prorrateo costo por medida
const { resolveQualityGrade } = require('./qualityGradeResolver')  // §6f
const { userCanActOnShift, listShiftMembers, getHandoverResponsibleUserId } = require('./shiftAuthService')

// ─── Cola de órdenes ──────────────────────────────────────────────────────────

async function getOrdersQueue({ tenantId, lineId }) {
  const { rows } = await query(
    `SELECT po.*,
            p.name AS product_name, p.sku,
            r.resin_type, r.name AS raw_material_name,
            u.full_name AS created_by_name,
            -- Avance: piezas producidas en shift_progress para esta orden
            COALESCE(prog.units_produced, 0) AS units_produced,
            COALESCE(prog.packages_produced, 0) AS packages_produced,
            ROUND(
              CASE WHEN po.quantity_units > 0
                THEN COALESCE(prog.units_produced,0)::numeric / po.quantity_units * 100
                ELSE 0
              END, 1
            ) AS progress_pct
     FROM production_orders po
     JOIN products p       ON p.id = po.product_id
     LEFT JOIN raw_materials r  ON r.id = po.raw_material_id
     LEFT JOIN users u     ON u.id = po.created_by
     LEFT JOIN (
       SELECT production_order_id,
              SUM(quantity_units) AS units_produced,
              COUNT(*)            AS packages_produced
       FROM shift_progress
       WHERE is_second_quality = false
       GROUP BY production_order_id
     ) prog ON prog.production_order_id = po.id
     WHERE po.tenant_id = $1
       AND po.status IN ('released','in_progress')
       AND ($2::int IS NULL OR po.line_id = $2)
     ORDER BY po.priority ASC, po.sort_order, po.created_at`,
    [tenantId, lineId || null]
  )
  return rows
}

async function listOrders({ tenantId, status, lineId, page=1, limit=50 }) {
  const offset = (page-1)*limit
  const params = [tenantId]
  const filters = []

  if (status) { params.push(status); filters.push(`po.status=$${params.length}`) }
  if (lineId) { params.push(lineId); filters.push(`po.line_id=$${params.length}`) }

  const where = filters.length ? `AND ${filters.join(' AND ')}` : ''
  params.push(limit, offset)

  const { rows } = await query(
    `SELECT po.*,
            p.name AS product_name, p.sku,
            r.name AS raw_material_name, r.resin_type,
            COALESCE(prog.units_produced,0) AS units_produced,
            ROUND(
              CASE WHEN po.quantity_units > 0
                THEN COALESCE(prog.units_produced,0)::numeric / po.quantity_units * 100
                ELSE 0
              END, 1
            ) AS progress_pct
     FROM production_orders po
     JOIN products p      ON p.id = po.product_id
     LEFT JOIN raw_materials r ON r.id = po.raw_material_id
     LEFT JOIN (
       SELECT production_order_id, SUM(quantity_units) AS units_produced
       FROM shift_progress WHERE is_second_quality=false
       GROUP BY production_order_id
     ) prog ON prog.production_order_id = po.id
     WHERE po.tenant_id=$1 ${where}
     ORDER BY po.priority ASC, po.sort_order, po.created_at DESC
     LIMIT $${params.length-1} OFFSET $${params.length}`,
    params
  )

  const { rows: cnt } = await query(
    `SELECT COUNT(*) FROM production_orders po WHERE po.tenant_id=$1 ${where}`,
    params.slice(0, params.length-2)
  )

  return { data: rows, total: parseInt(cnt[0].count,10), page, limit }
}

async function getOrder({ tenantId, orderId }) {
  const { rows } = await query(
    `SELECT po.*,
            p.name AS product_name, p.sku,
            r.name AS raw_material_name, r.resin_type, r.cost_per_kg
     FROM production_orders po
     JOIN products p           ON p.id  = po.product_id
     LEFT JOIN raw_materials r ON r.id  = po.raw_material_id
     WHERE po.id=$1 AND po.tenant_id=$2`,
    [orderId, tenantId]
  )
  if (!rows[0]) return null

  const { rows: formula } = await query(
    `SELECT ompf.*, r.name AS material_name, r.resin_type, r.material_type, r.cost_per_kg
     FROM order_mp_formula ompf
     JOIN raw_materials r ON r.id = ompf.raw_material_id
     WHERE ompf.production_order_id=$1
       AND ompf.valid_until IS NULL
     ORDER BY ompf.sort_order`,
    [orderId]
  )

  return { ...rows[0], mpFormula: formula }
}

async function createOrder({
  tenantId, productId, rawMaterialId, lengthMm,
  quantityPackages, lineId, priority, deliveryDate, notes,
  mpFormula, recipeId,
  customAttributes, additionalCosts, additionalCostsNotes,
  userId, ipAddress, userAgent,
}) {
  // SaaS v2 refactor §5e: recipe_id es mutuamente excluyente con mpFormula.
  // Si recipeId se pasa, la orden usa la receta vigente del producto y
  // production_orders.recipe_version_at_creation se popula automáticamente
  // vía el trigger sync_production_order_recipe_version (migration 129).
  if (recipeId && mpFormula && mpFormula.length > 0) {
    throw createError(400, 'recipe_id y mp_formula son mutuamente excluyentes. Usa uno o el otro.')
  }
  if (recipeId) {
    // Validar que la receta existe en el tenant
    const { rows: rRows } = await query(
      `SELECT id, product_id, valid_until FROM recipes WHERE id = $1 AND tenant_id = $2`,
      [recipeId, tenantId]
    )
    if (rRows.length === 0) throw createError(400, 'recipe_id no existe en este tenant.')
    if (rRows[0].product_id !== productId) {
      throw createError(400, 'recipe_id no corresponde al producto seleccionado.')
    }
  }

  const orderNumber = `OF-${Date.now().toString().slice(-8)}`

  const { rows: maxRow } = await query(
    `SELECT COALESCE(MAX(sort_order),0) AS max_order FROM production_orders WHERE tenant_id=$1`,
    [tenantId]
  )
  const sortOrder = (maxRow[0].max_order || 0) + 10

  // Calcular costo promedio ponderado SOLO si se usa mp_formula legacy.
  // Para órdenes con recipe_id, el costo se calcula al cerrar el turno (usando
  // los lot_consumption reales) — no aplica precálculo aquí.
  let blendedCostPerKg = null
  if (!recipeId && mpFormula && mpFormula.length > 0) {
    const materialIds = mpFormula.map(f => f.rawMaterialId)
    const { rows: materials } = await query(
      `SELECT id, cost_per_kg, unit FROM raw_materials WHERE id = ANY($1)`,
      [materialIds]
    )
    // §P3 simple (mig 163 sesión 2026-05-29): solo entran al cálculo del costo
    // mezclado los materiales cuya unidad nativa sea masa (kg). Materiales por
    // pieza (bolsas, etiquetas) o por volumen (lt) NO se mezclan por porcentaje
    // de la masa total — se modelan como consumibles fijos del producto
    // (1 bolsa por paquete, X etiquetas por lote) y entran al costo del PT
    // por una vía distinta. Esto evita el bug donde una "bolsa de celofán a
    // $1 por pieza" contaminaba el blended_cost como si fuera $1/kg de mezcla.
    const costMap = Object.fromEntries(
      materials
        .filter(m => (m.unit || 'kg').toLowerCase() === 'kg')
        .map(m => [m.id, parseFloat(m.cost_per_kg||0)])
    )
    const massFormula = mpFormula.filter(f => costMap[f.rawMaterialId] !== undefined)
    if (massFormula.length > 0) {
      const massPctTotal = massFormula.reduce((s, f) => s + parseFloat(f.percentage), 0)
      if (massPctTotal > 0) {
        blendedCostPerKg = massFormula.reduce((sum, f) => {
          return sum + (parseFloat(f.percentage) / massPctTotal) * costMap[f.rawMaterialId]
        }, 0)
      }
    }
  }

  const created = await withTransaction(async (client) => {
    const caVal = customAttributes != null ? JSON.stringify(customAttributes) : null
    const { rows } = await client.query(
      `INSERT INTO production_orders
         (tenant_id, order_number, product_id, raw_material_id,
          length_mm, quantity_packages, line_id, priority,
          sort_order, delivery_date, notes, created_by, blended_cost_per_kg,
          recipe_id, custom_attributes, additional_costs, additional_costs_notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
       RETURNING *`,
      [tenantId, orderNumber, productId, rawMaterialId||null,
       lengthMm||null, quantityPackages, lineId||1,
       priority||'normal', sortOrder, deliveryDate||null, notes||null, userId,
       blendedCostPerKg ? blendedCostPerKg.toFixed(6) : null,
       recipeId || null,
       caVal, additionalCosts != null ? additionalCosts : null, additionalCostsNotes||null]
    )
    const order = rows[0]

    // Insertar fórmula de mezcla SOLO en modo legacy. Para recipe, los
    // componentes viven en recipe_components y se leen vía recipeResolver.
    if (!recipeId && mpFormula && mpFormula.length > 0) {
      for (let i = 0; i < mpFormula.length; i++) {
        const f = mpFormula[i]
        if (!f.rawMaterialId || !f.percentage) continue
        await client.query(
          `INSERT INTO order_mp_formula
             (production_order_id, raw_material_id, percentage, sort_order)
           VALUES ($1,$2,$3,$4)`,
          [order.id, f.rawMaterialId, f.percentage, i]
        )
      }
    }

    await audit({
      tenantId, userId, action:'production_order.created', resource:'production_orders',
      resourceId: order.id,
      payload: {
        orderNumber, priority, quantityPackages,
        recipeId: recipeId || null,
        formulaCount: mpFormula?.length || 0,
      },
      ipAddress, userAgent,
    })

    return { ...order, mpFormula: mpFormula || [] }
  })

  // Push best-effort post-commit: nueva orden de producción → piso (excl. quien la creó).
  pushEvents.productionOrderCreated(tenantId, { orderId: created.id, actorUserId: userId })

  return created
}

async function updateOrder({
  tenantId, orderId, name, notes, priority, deliveryDate, mpFormula, recipeId,
  customAttributes, additionalCosts, additionalCostsNotes,
  userId, ipAddress, userAgent,
}) {
  // SaaS v2 refactor §5e: recipeId puede llegar con UUID (asignar/cambiar),
  // null (limpiar y volver a legacy), o undefined (no tocar). Mutuamente
  // excluyente con mpFormula no-vacío.
  if (recipeId && mpFormula && mpFormula.length > 0) {
    throw createError(400, 'recipe_id y mp_formula son mutuamente excluyentes. Usa uno o el otro.')
  }
  if (recipeId) {
    const { rows: rRows } = await query(
      `SELECT id FROM recipes WHERE id = $1 AND tenant_id = $2`,
      [recipeId, tenantId]
    )
    if (rRows.length === 0) throw createError(400, 'recipe_id no existe en este tenant.')
  }

  return withTransaction(async (client) => {
    // Recalcular costo promedio si cambia la fórmula (solo modo legacy)
    let blendedCostPerKg = null
    if (mpFormula && mpFormula.length > 0) {
      const materialIds = mpFormula.map(f => f.rawMaterialId)
      const { rows: materials } = await client.query(
        `SELECT id, cost_per_kg FROM raw_materials WHERE id = ANY($1)`, [materialIds]
      )
      const costMap = Object.fromEntries(materials.map(m => [m.id, parseFloat(m.cost_per_kg||0)]))
      blendedCostPerKg = mpFormula.reduce((sum, f) =>
        sum + (parseFloat(f.percentage)/100) * (costMap[f.rawMaterialId]||0), 0
      )
    }

    // recipeId === undefined → no tocar. recipeId === null → limpiar a NULL.
    // recipeId === UUID → asignar (trigger popula recipe_version_at_creation).
    // customAttributes === undefined → no tocar; null → limpiar; object → setear.
    const updateRecipe = recipeId !== undefined
    const updateCa     = customAttributes !== undefined
    const caVal = updateCa && customAttributes != null ? JSON.stringify(customAttributes) : null
    const { rows } = await client.query(
      `UPDATE production_orders SET
         notes                  = COALESCE($1, notes),
         priority               = COALESCE($2, priority),
         delivery_date          = COALESCE($3, delivery_date),
         blended_cost_per_kg    = COALESCE($4, blended_cost_per_kg),
         recipe_id              = CASE WHEN $5::boolean THEN $6::uuid ELSE recipe_id END,
         custom_attributes      = CASE WHEN $9::boolean THEN $10::jsonb ELSE custom_attributes END,
         additional_costs       = COALESCE($11, additional_costs),
         additional_costs_notes = COALESCE($12, additional_costs_notes)
       WHERE id=$7 AND tenant_id=$8 AND status IN ('draft','released')
       RETURNING *`,
      [notes||null, priority||null, deliveryDate||null,
       blendedCostPerKg ? blendedCostPerKg.toFixed(6) : null,
       updateRecipe, recipeId || null,
       orderId, tenantId,
       updateCa, caVal,
       additionalCosts != null ? additionalCosts : null,
       additionalCostsNotes || null]
    )
    if (!rows[0]) throw createError(400, 'La orden no existe o ya no se puede editar.')

    // Si se está cambiando la receta o la fórmula, validar que NO haya capturas.
    if ((mpFormula !== undefined || updateRecipe)) {
      const { rows: hasCaptures } = await client.query(
        `SELECT
           (SELECT COUNT(*) FROM shift_progress WHERE production_order_id=$1) +
           (SELECT COUNT(*) FROM shift_scrap    WHERE production_order_id=$1) AS total`,
        [orderId]
      )
      if (parseInt(hasCaptures[0].total) > 0) {
        throw createError(400, 'La orden ya tiene capturas. Usa "Cambiar fórmula" para conservar el historial.')
      }
    }

    if (mpFormula !== undefined) {
      await client.query(
        `DELETE FROM order_mp_formula WHERE production_order_id=$1`, [orderId]
      )
      for (let i=0; i<mpFormula.length; i++) {
        const f = mpFormula[i]
        if (!f.rawMaterialId || !f.percentage) continue
        await client.query(
          `INSERT INTO order_mp_formula (production_order_id, raw_material_id, percentage, sort_order)
           VALUES ($1,$2,$3,$4)`,
          [orderId, f.rawMaterialId, f.percentage, i]
        )
      }
    }

    // Si se asigna recipeId, limpiar order_mp_formula viejo (modos exclusivos).
    if (recipeId) {
      await client.query(
        `DELETE FROM order_mp_formula WHERE production_order_id=$1`, [orderId]
      )
    }

    await audit({ tenantId, userId, action:'production_order.updated', resource:'production_orders',
      resourceId: orderId, payload: { priority, recipeId: recipeId || null }, ipAddress, userAgent })

    return rows[0]
  })
}

async function cancelOrder({ tenantId, orderId, userId, ipAddress, userAgent }) {
  const { rows } = await query(
    `UPDATE production_orders SET
       status='cancelled', cancelled_at=NOW(), cancelled_by=$1
     WHERE id=$2 AND tenant_id=$3 AND status IN ('draft','released')
     RETURNING *`,
    [userId, orderId, tenantId]
  )
  if (!rows[0]) throw createError(400, 'La orden no se puede cancelar en su estado actual.')
  await audit({ tenantId, userId, action:'production_order.cancelled',
    resource:'production_orders', resourceId: orderId, payload:{}, ipAddress, userAgent })
  return rows[0]
}

/**
 * Calcula la disponibilidad de stock de MP para una orden:
 *   - kg requerido por cada material según fórmula × cantidad × peso teórico × (1 + reprocessFactor)
 *   - kg disponible en almacén MP (status='available')
 *   - faltante si aplica
 *
 * Devuelve { ok, items: [{rawMaterialId, name, percentage, requiredKg, availableKg, missingKg, ok}],
 *            totals: {requiredKg, availableKg, missingKg} }.
 *
 * Si la orden no tiene fórmula MP, retorna ok=true con items vacíos.
 * Si no existe almacén MP, treats availableKg=0.
 */
// ═══════════════════════════════════════════════════════════════════════════
// ⚠ STOCK PREVIEW / AVAILABILITY — NO ELIMINAR ESTAS DOS FUNCIONES
// ═══════════════════════════════════════════════════════════════════════════
// Estas funciones alimentan dos endpoints que consume el frontend al crear
// y liberar órdenes de producción. Sin ellas, el formulario muestra
// "Route not found" mientras se llena la fórmula MP y la liberación falla.
//
// previewStockForNewOrder (POST /orders/preview-stock):
//   Se llama mientras el usuario llena el formulario de nueva orden.
//   NO requiere que la orden exista. Recibe directamente los datos del form.
//
// getOrderStockAvailability (GET /orders/:id/stock-availability):
//   Se llama cuando la orden ya existe (vista de detalle, cola, antes de
//   liberar). También se usa internamente por releaseOrder() para validar
//   stock antes de cambiar status a 'released'.
//
// Frontend consumidores:
//   - src/api/production.js → productionApi.previewStock
//                            → productionApi.getStockAvailability
//   - src/pages/Produccion/ (formulario de nueva orden y detalle)
//
// Historial de incidentes (agregar al final cada vez que se rompa):
//   - 2026-05-13 sesión 5: ruta /preview-stock ausente en routes.js.
//     Síntoma: banner "Route not found" en formulario de creación.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Disponibilidad de MP para una orden que TODAVÍA NO EXISTE.
 * Recibe los datos del formulario y calcula igual que getOrderStockAvailability.
 *
 * Body esperado:
 *   productId        — uuid del producto
 *   lengthMm         — número (largo del producto en mm)
 *   quantityPackages — número de paquetes
 *   mpFormula        — array [{ rawMaterialId, percentage }]
 */
async function previewStockForRecipe({ tenantId, recipeId, totalPtKg }) {
  // SaaS v2 §5d-2: preview de stock usando una receta + total de PT objetivo.
  // totalPtKg debe expresarse en la misma unidad que recipes.yield_unit_id.
  if (!recipeId) {
    return {
      ok: true, items: [],
      totals: { requiredKg: 0, availableKg: 0, missingKg: 0 },
      meta: { ptKgEstimado: 0, reprocessFactor: 0.20, totalRequiredMpKg: 0 },
    }
  }
  const ptKg = parseFloat(totalPtKg || 0)
  if (!Number.isFinite(ptKg) || ptKg <= 0) {
    throw createError(400, 'totalPtKg es requerido y debe ser número positivo cuando se pasa recipeId.')
  }

  // Cargar receta + componentes
  const { rows: recipeRows } = await query(
    `SELECT id, yield_quantity, yield_unit_id, expected_scrap_pct
     FROM recipes WHERE id = $1 AND tenant_id = $2`,
    [recipeId, tenantId]
  )
  if (recipeRows.length === 0) throw createError(404, 'recipe_id no existe en este tenant.')
  const recipe = recipeRows[0]
  const yieldQty = parseFloat(recipe.yield_quantity)

  const { rows: compRows } = await query(
    `SELECT rc.raw_material_id, rm.name AS material_name,
            rc.quantity, rc.unit_id, rc.is_optional, rc.sort_order
     FROM recipe_components rc
     JOIN raw_materials rm ON rm.id = rc.raw_material_id
     WHERE rc.recipe_id = $1
     ORDER BY rc.sort_order, rm.name`,
    [recipeId]
  )

  // Factor de reproceso: preferir el de la receta si está, si no el tenant_cost_items
  let reprocessFactor
  if (recipe.expected_scrap_pct !== null) {
    reprocessFactor = parseFloat(recipe.expected_scrap_pct) / 100
  } else {
    const { rows: factorRows } = await query(
      `SELECT amount FROM production_cost_items
       WHERE tenant_id=$1 AND name='__scrap_factor__' AND is_active=true LIMIT 1`,
      [tenantId]
    )
    reprocessFactor = factorRows[0] ? parseFloat(factorRows[0].amount)/100 : 0.20
  }

  const factorCorridas = yieldQty > 0 ? ptKg / yieldQty : 0
  const totalRequiredMpKg = ptKg * (1 + reprocessFactor)  // estimación agregada (suma de componentes)

  if (compRows.length === 0 || factorCorridas <= 0) {
    return {
      ok: true, items: [],
      totals: { requiredKg: 0, availableKg: 0, missingKg: 0 },
      meta: { ptKgEstimado: ptKg, reprocessFactor, totalRequiredMpKg: 0 },
    }
  }

  // Stock por componente. Suma de almacenes raw_material + packaging — los
  // tenants que separan bolsas/etiquetas en almacén dedicado (type='packaging')
  // ven el stock total correctamente. Tenants sin almacén packaging operan igual.
  const materialIds = compRows.map(c => c.raw_material_id)
  const { rows: stockRows } = await query(
    `SELECT s.item_id, COALESCE(SUM(s.quantity), 0) AS available_kg
     FROM inventory_stock s
     JOIN warehouses w ON w.id = s.warehouse_id
     WHERE s.tenant_id = $1 AND s.item_type = 'raw_material'
       AND s.item_id = ANY($2::uuid[]) AND s.status = 'available'
       AND w.type IN ('raw_material','packaging') AND w.is_active = true
     GROUP BY s.item_id`,
    [tenantId, materialIds]
  )
  const stockMap = Object.fromEntries(stockRows.map(r => [r.item_id, parseFloat(r.available_kg)]))

  const items = compRows.map(c => {
    const requiredKg  = parseFloat(c.quantity) * factorCorridas * (1 + reprocessFactor)
    const availableKg = parseFloat(stockMap[c.raw_material_id] || 0)
    const missingKg   = Math.max(0, requiredKg - availableKg)
    return {
      rawMaterialId: c.raw_material_id,
      name:          c.material_name,
      percentage:    0,  // no aplica en modo recipe
      sortOrder:     c.sort_order,
      requiredKg:    parseFloat(requiredKg.toFixed(3)),
      availableKg:   parseFloat(availableKg.toFixed(3)),
      missingKg:     parseFloat(missingKg.toFixed(3)),
      ok:            missingKg <= 0.001,
      isOptional:    c.is_optional,
    }
  })

  const totals = items.reduce((acc, it) => ({
    requiredKg:  acc.requiredKg  + it.requiredKg,
    availableKg: acc.availableKg + it.availableKg,
    missingKg:   acc.missingKg   + it.missingKg,
  }), { requiredKg: 0, availableKg: 0, missingKg: 0 })

  return {
    ok: items.every(it => it.ok || it.isOptional),  // opcionales no bloquean ok
    items,
    totals: {
      requiredKg:  parseFloat(totals.requiredKg.toFixed(3)),
      availableKg: parseFloat(totals.availableKg.toFixed(3)),
      missingKg:   parseFloat(totals.missingKg.toFixed(3)),
    },
    meta: {
      ptKgEstimado:     parseFloat(ptKg.toFixed(3)),
      reprocessFactor,
      totalRequiredMpKg: parseFloat(totalRequiredMpKg.toFixed(3)),
    },
  }
}

async function previewStockForNewOrder({ tenantId, productId, lengthMm, quantityPackages, mpFormula, recipeId, totalPtKg }) {
  // SaaS v2 refactor §5d-2: dos modos de invocación:
  //   - Legacy: productId + lengthMm + quantityPackages + mpFormula. Sin cambios.
  //   - Recipe: recipeId + totalPtKg (ambos requeridos). Path nuevo que lee
  //     componentes de recipe_components y deriva requiredKg como
  //     (totalPtKg / yield_quantity) × component.quantity × (1 + reproceso).
  //     mpFormula/lengthMm ignorados en este modo.
  if (recipeId) {
    return previewStockForRecipe({ tenantId, recipeId, totalPtKg })
  }

  // Validaciones tempranas — si falta algo crítico, devolver respuesta vacía
  // sin reventar (el formulario llama esto en cada keystroke).
  if (!productId || !lengthMm || !quantityPackages || !Array.isArray(mpFormula) || mpFormula.length === 0) {
    return {
      ok: true,
      items: [],
      totals: { requiredKg: 0, availableKg: 0, missingKg: 0 },
      meta: { ptKgEstimado: 0, reprocessFactor: 0.20, totalRequiredMpKg: 0 },
    }
  }

  // Spec activa de calidad del producto (g/m, units_per_package)
  const { rows: specRows } = await query(
    `SELECT grams_per_linear_meter, units_per_package
     FROM product_quality_specs
     WHERE product_id=$1 AND valid_until IS NULL
     ORDER BY valid_from DESC
     LIMIT 1`,
    [productId]
  )
  const grams_per_m   = parseFloat(specRows[0]?.grams_per_linear_meter || 0)
  const units_per_pkg = parseInt(specRows[0]?.units_per_package || 0)

  // Factor de reproceso del tenant
  const { rows: factorRows } = await query(
    `SELECT amount FROM production_cost_items
     WHERE tenant_id=$1 AND name='__scrap_factor__' AND is_active=true LIMIT 1`,
    [tenantId]
  )
  const reprocessFactor = factorRows[0] ? parseFloat(factorRows[0].amount)/100 : 0.20

  // Cálculo de MP requerida total (mismo método que getOrderStockAvailability)
  const length_m  = parseFloat(lengthMm || 0) / 1000
  const total_pcs = parseInt(quantityPackages || 0) * units_per_pkg
  const ptKgEstimado = (grams_per_m * length_m * total_pcs) / 1000
  const totalRequiredMpKg = ptKgEstimado * (1 + reprocessFactor)

  if (totalRequiredMpKg <= 0) {
    return {
      ok: true,
      items: [],
      totals: { requiredKg: 0, availableKg: 0, missingKg: 0 },
      meta: { ptKgEstimado: 0, reprocessFactor, totalRequiredMpKg: 0 },
    }
  }

  // Cargar info de los materiales de la fórmula propuesta
  const materialIds = mpFormula
    .map(f => f.rawMaterialId)
    .filter(id => !!id)
  if (materialIds.length === 0) {
    return {
      ok: true,
      items: [],
      totals: { requiredKg: 0, availableKg: 0, missingKg: 0 },
      meta: { ptKgEstimado, reprocessFactor, totalRequiredMpKg },
    }
  }

  const { rows: matRows } = await query(
    `SELECT id, name FROM raw_materials WHERE id = ANY($1::uuid[])`,
    [materialIds]
  )
  const matMap = Object.fromEntries(matRows.map(m => [m.id, m.name]))

  // Stock disponible por material en almacenes consumibles (MP + embalaje)
  const { rows: stockRows } = await query(
    `SELECT s.item_id, COALESCE(SUM(s.quantity), 0) AS available_kg
     FROM inventory_stock s
     JOIN warehouses w ON w.id = s.warehouse_id
     WHERE s.tenant_id = $1
       AND s.item_type = 'raw_material'
       AND s.item_id   = ANY($2::uuid[])
       AND s.status    = 'available'
       AND w.type IN ('raw_material','packaging')
       AND w.is_active = true
     GROUP BY s.item_id`,
    [tenantId, materialIds]
  )
  const stockMap = Object.fromEntries(
    stockRows.map(r => [r.item_id, parseFloat(r.available_kg)])
  )

  const items = mpFormula.map(f => {
    const pct = parseFloat(f.percentage || 0)
    const requiredKg  = totalRequiredMpKg * (pct / 100)
    const availableKg = parseFloat(stockMap[f.rawMaterialId] || 0)
    const missingKg   = Math.max(0, requiredKg - availableKg)
    return {
      rawMaterialId: f.rawMaterialId,
      name:          matMap[f.rawMaterialId] || '—',
      percentage:    pct,
      requiredKg:    parseFloat(requiredKg.toFixed(3)),
      availableKg:   parseFloat(availableKg.toFixed(3)),
      missingKg:     parseFloat(missingKg.toFixed(3)),
      ok:            missingKg <= 0.001,
    }
  })

  const totals = items.reduce((acc, it) => ({
    requiredKg:  acc.requiredKg  + it.requiredKg,
    availableKg: acc.availableKg + it.availableKg,
    missingKg:   acc.missingKg   + it.missingKg,
  }), { requiredKg: 0, availableKg: 0, missingKg: 0 })

  return {
    ok: items.every(it => it.ok),
    items,
    totals: {
      requiredKg:  parseFloat(totals.requiredKg.toFixed(3)),
      availableKg: parseFloat(totals.availableKg.toFixed(3)),
      missingKg:   parseFloat(totals.missingKg.toFixed(3)),
    },
    meta: {
      ptKgEstimado:     parseFloat(ptKgEstimado.toFixed(3)),
      reprocessFactor,
      totalRequiredMpKg: parseFloat(totalRequiredMpKg.toFixed(3)),
    },
  }
}

async function getOrderStockAvailability({ tenantId, orderId }) {
  // SaaS v2 refactor §5d: la lectura de "qué MP consume esta orden" pasa por
  // recipeResolver, que abstrae los 4 modos (recipe / legacy_formula /
  // legacy_single / none). Para órdenes legacy el shape externo es idéntico
  // al original — el cambio es invisible para callers actuales.

  const { rows: orderRows } = await query(
    `SELECT po.id, po.length_mm, po.quantity_packages, po.product_id
     FROM production_orders po
     WHERE po.id=$1 AND po.tenant_id=$2`,
    [orderId, tenantId]
  )
  if (!orderRows[0]) {
    const err = new Error('Orden no encontrada.')
    err.status = 404
    throw err
  }
  const order = orderRows[0]

  // Resolver: devuelve { mode, components: [{rawMaterialId, percentage?, quantity?, ...}], yieldQuantity?, ... }
  const resolved = await resolveRecipeForOrder({ tenantId, orderId })

  // Spec activa de calidad del producto (g/m, units_per_package) — modelo viejo
  // de cálculo de PT estimado. Solo aplica para órdenes legacy. Para recipe,
  // el ptKgEstimado se deriva del yield_quantity (ver más abajo).
  const { rows: specRows } = await query(
    `SELECT grams_per_linear_meter, units_per_package
     FROM product_quality_specs
     WHERE product_id=$1 AND valid_until IS NULL
     ORDER BY valid_from DESC
     LIMIT 1`,
    [order.product_id]
  )
  const grams_per_m    = parseFloat(specRows[0]?.grams_per_linear_meter || 0)
  const units_per_pkg  = parseInt(specRows[0]?.units_per_package || 0)

  // Factor de reproceso del tenant
  const { rows: factorRows } = await query(
    `SELECT amount FROM production_cost_items
     WHERE tenant_id=$1 AND name='__scrap_factor__' AND is_active=true LIMIT 1`,
    [tenantId]
  )
  const reprocessFactor = factorRows[0] ? parseFloat(factorRows[0].amount)/100 : 0.20

  // Calcular requiredKg por componente según modo del resolver.
  // Para órdenes legacy mantenemos exactamente la fórmula vieja (golden masters
  // dependen de esto). Para órdenes con recipe_id ya, la lógica es distinta
  // (factor_corridas × component.quantity).
  let ptKgEstimado, totalRequiredMpKg, requiredByMaterial
  if (resolved.mode === 'recipe') {
    // Modo recipe: ptKgEstimado deriva de quantity_packages × kg_por_paquete
    // (asumiendo que units_per_package del product spec todavía aplica para
    // packaging count, y que yield_unit_id de la receta es la unidad del PT).
    // Para el MVP simplificamos: ptKgEstimado = quantity_packages × yield_quantity / 1
    //   (asume 1 paquete = 1 yield_quantity). Esto es una aproximación;
    //   el modelo definitivo de "cuánto PT requiere la orden" se decide en 5d-2.
    ptKgEstimado = (resolved.yieldQuantity || 0) * parseInt(order.quantity_packages || 0)
    totalRequiredMpKg = ptKgEstimado * (1 + reprocessFactor)
    const factorCorridas = (resolved.yieldQuantity && resolved.yieldQuantity > 0)
      ? ptKgEstimado / resolved.yieldQuantity
      : 0
    requiredByMaterial = resolved.components.map(c => ({
      ...c,
      requiredKg: (c.quantity || 0) * factorCorridas * (1 + reprocessFactor),
    }))
  } else {
    // Modo legacy_formula / legacy_single / none: fórmula original
    const length_m = parseFloat(order.length_mm || 0) / 1000
    const total_pcs = parseInt(order.quantity_packages || 0) * units_per_pkg
    ptKgEstimado = (grams_per_m * length_m * total_pcs) / 1000
    totalRequiredMpKg = ptKgEstimado * (1 + reprocessFactor)
    requiredByMaterial = resolved.components.map(c => ({
      ...c,
      requiredKg: totalRequiredMpKg * ((c.percentage || 0) / 100),
    }))
  }

  if (resolved.components.length === 0 || totalRequiredMpKg <= 0) {
    return {
      ok: true,
      items: [],
      totals: { requiredKg: 0, availableKg: 0, missingKg: 0 },
      meta: { ptKgEstimado: 0, reprocessFactor, totalRequiredMpKg: 0 },
    }
  }

  // Stock disponible por material en almacenes consumibles (MP + embalaje, status='available')
  const materialIds = requiredByMaterial.map(c => c.rawMaterialId)
  const { rows: stockRows } = await query(
    `SELECT s.item_id, COALESCE(SUM(s.quantity), 0) AS available_kg
     FROM inventory_stock s
     JOIN warehouses w ON w.id = s.warehouse_id
     WHERE s.tenant_id = $1
       AND s.item_type = 'raw_material'
       AND s.item_id   = ANY($2::uuid[])
       AND s.status    = 'available'
       AND w.type IN ('raw_material','packaging')
       AND w.is_active = true
     GROUP BY s.item_id`,
    [tenantId, materialIds]
  )
  const stockMap = Object.fromEntries(
    stockRows.map(r => [r.item_id, parseFloat(r.available_kg)])
  )

  const items = requiredByMaterial.map(c => {
    const requiredKg  = c.requiredKg
    const availableKg = parseFloat(stockMap[c.rawMaterialId] || 0)
    const missingKg   = Math.max(0, requiredKg - availableKg)
    return {
      rawMaterialId: c.rawMaterialId,
      name:          c.rawMaterialName,
      percentage:    c.percentage !== null ? c.percentage : 0,
      sortOrder:     c.sortOrder,
      requiredKg:    parseFloat(requiredKg.toFixed(3)),
      availableKg:   parseFloat(availableKg.toFixed(3)),
      missingKg:     parseFloat(missingKg.toFixed(3)),
      ok:            missingKg <= 0.001,
    }
  })

  const totals = items.reduce((acc, it) => ({
    requiredKg:  acc.requiredKg  + it.requiredKg,
    availableKg: acc.availableKg + it.availableKg,
    missingKg:   acc.missingKg   + it.missingKg,
  }), { requiredKg: 0, availableKg: 0, missingKg: 0 })

  return {
    ok: items.every(it => it.ok),
    items,
    totals: {
      requiredKg:  parseFloat(totals.requiredKg.toFixed(3)),
      availableKg: parseFloat(totals.availableKg.toFixed(3)),
      missingKg:   parseFloat(totals.missingKg.toFixed(3)),
    },
    meta: {
      ptKgEstimado:     parseFloat(ptKgEstimado.toFixed(3)),
      reprocessFactor,
      totalRequiredMpKg: parseFloat(totalRequiredMpKg.toFixed(3)),
    },
  }
}

async function releaseOrder({ tenantId, orderId, userId, ipAddress, userAgent, lowStockOverrideReason }) {
  // Si NO viene una razón de override, validamos stock antes de liberar.
  if (!lowStockOverrideReason) {
    let availability
    try {
      availability = await getOrderStockAvailability({ tenantId, orderId })
    } catch (err) {
      // Si la orden no existe el siguiente UPDATE devolverá error coherente.
      // Si falló por otra causa, dejamos que el flujo siga y lo retomamos.
      availability = null
    }
    if (availability && !availability.ok) {
      const err = new Error('Stock insuficiente para liberar la orden.')
      err.status = 400
      err.code   = 'LOW_STOCK'
      err.details = availability
      throw err
    }
  }

  const { rows } = await query(
    `UPDATE production_orders SET status='released', released_by=$1, released_at=NOW()
     WHERE id=$2 AND tenant_id=$3 AND status='draft' RETURNING *`,
    [userId, orderId, tenantId]
  )
  if (!rows[0]) throw createError(400, 'La orden no está en estado borrador.')

  // Si fue liberada con override, registrar como evento auditable distinto.
  if (lowStockOverrideReason) {
    let availability = null
    try { availability = await getOrderStockAvailability({ tenantId, orderId }) } catch {}
    await audit({
      tenantId, userId,
      action: 'production_order.released_with_low_stock',
      resource: 'production_orders',
      resourceId: orderId,
      payload: {
        reason: lowStockOverrideReason,
        missing: availability?.items?.filter(it => !it.ok).map(it => ({
          name: it.name, missingKg: it.missingKg,
        })) || [],
      },
      ipAddress, userAgent,
    })
  } else {
    await audit({
      tenantId, userId,
      action: 'production_order.released',
      resource: 'production_orders',
      resourceId: orderId,
      payload: {},
      ipAddress, userAgent,
    })
  }
  return rows[0]
}

async function updateOrderPriority({ tenantId, orderId, priority, deliveryDate, userId }) {
  const { rows } = await query(
    `UPDATE production_orders SET
       priority=$1,
       delivery_date=COALESCE($2, delivery_date),
       priority_changed_at=NOW(),
       updated_at=NOW()
     WHERE id=$3 AND tenant_id=$4 RETURNING *`,
    [priority, deliveryDate||null, orderId, tenantId]
  )
  if (!rows[0]) throw createError(404, 'Orden no encontrada.')
  return rows[0]
}

async function reorderQueue({ tenantId, orderedIds }) {
  for (let i=0; i<orderedIds.length; i++) {
    await query(
      `UPDATE production_orders SET sort_order=$1 WHERE id=$2 AND tenant_id=$3`,
      [i*10, orderedIds[i], tenantId]
    )
  }
  return { ok: true }
}

// ─── Turnos ───────────────────────────────────────────────────────────────────

async function getActiveShifts({ tenantId }) {
  const { rows } = await query(
    `SELECT ps.*,
            u.full_name AS operator_name,
            s.full_name AS supervisor_name,
            -- Resumen de lo producido en este turno
            COALESCE(prog.total_units,0) AS pt_units_produced,
            COALESCE(prog.active_order_id, ps.production_order_id) AS active_order_id
     FROM production_shifts ps
     JOIN users u ON u.id = ps.operator_id
     JOIN users s ON s.id = ps.supervisor_id
     LEFT JOIN (
       SELECT shift_id,
              SUM(quantity_units) FILTER (WHERE is_second_quality=false) AS total_units,
              (SELECT production_order_id FROM shift_progress sp2
               WHERE sp2.shift_id=shift_progress.shift_id
               ORDER BY sp2.microlot_number DESC LIMIT 1) AS active_order_id
       FROM shift_progress
       GROUP BY shift_id
     ) prog ON prog.shift_id = ps.id
     WHERE ps.tenant_id=$1 AND ps.status IN ('active','pending_handover')
     ORDER BY ps.started_at`,
    [tenantId]
  )
  return rows
}

async function getShift({ tenantId, shiftId }) {
  const { rows } = await query(
    `SELECT ps.*,
            u.full_name AS operator_name,
            s.full_name AS supervisor_name,
            fc.full_name AS force_closed_by_name
     FROM production_shifts ps
     JOIN users u ON u.id = ps.operator_id
     JOIN users s ON s.id = ps.supervisor_id
     LEFT JOIN users fc ON fc.id = ps.force_closed_by
     WHERE ps.id=$1 AND ps.tenant_id=$2`,
    [shiftId, tenantId]
  )
  if (!rows[0]) return null

  const [progress, mpLoads, scrap, incidents, costs, reception] = await Promise.all([
    query(`SELECT sp.*, po.order_number, po.status AS order_status,
                  p.name AS product_name,
                  COALESCE(p2.expected_sale_price, p.expected_sale_price) AS expected_sale_price
           FROM shift_progress sp
           LEFT JOIN production_orders po ON po.id = sp.production_order_id
           LEFT JOIN products p  ON p.id  = po.product_id
           LEFT JOIN products p2 ON p2.id = sp.second_quality_product_id
           WHERE sp.shift_id=$1 ORDER BY sp.microlot_number`, [shiftId]),
    query(`SELECT sml.*, r.name AS material_name FROM shift_mp_loads sml
           JOIN raw_materials r ON r.id=sml.raw_material_id
           WHERE sml.shift_id=$1 ORDER BY sml.loaded_at`, [shiftId]),
    query(`SELECT ss.*, po.order_number, po.status AS order_status
           FROM shift_scrap ss
           LEFT JOIN production_orders po ON po.id = ss.production_order_id
           WHERE ss.shift_id=$1 ORDER BY ss.captured_at`, [shiftId]),
    query(`SELECT si.*, u.full_name AS reported_by_name FROM shift_incidents si
           LEFT JOIN users u ON u.id=si.reported_by
           WHERE si.shift_id=$1 ORDER BY si.created_at`, [shiftId]),
    query(`SELECT * FROM shift_cost_snapshot WHERE shift_id=$1 ORDER BY name`, [shiftId]),
    query(`SELECT sr.accepted, sr.issue_description, sr.received_at,
                  u.full_name AS received_by_name,
                  ps_in.status        AS incoming_status,
                  ps_in.shift_number  AS incoming_shift_number,
                  op_in.full_name     AS incoming_operator_name
           FROM shift_receptions sr
           LEFT JOIN users u ON u.id = sr.received_by
           LEFT JOIN production_shifts ps_in ON ps_in.id = sr.incoming_shift_id
           LEFT JOIN users op_in ON op_in.id = ps_in.operator_id
           WHERE sr.outgoing_shift_id = $1
           LIMIT 1`, [shiftId]),
  ])

  return { ...rows[0], progress: progress.rows, mpLoads: mpLoads.rows,
           scrap: scrap.rows, incidents: incidents.rows, costs: costs.rows,
           reception: reception.rows[0] || null }
}

async function openShift({
  tenantId, lineId, shiftNumber, shiftDate,
  operatorId, supervisorId, userId, ipAddress, userAgent,
}) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO production_shifts
         (tenant_id, line_id, shift_number, shift_date,
          operator_id, supervisor_id, status, started_at)
       VALUES ($1,$2,$3,$4,$5,$6,'active',NOW())
       RETURNING *`,
      [tenantId, lineId||1, shiftNumber, shiftDate, operatorId, supervisorId]
    )
    await audit({ tenantId, userId, action:'shift.opened', resource:'production_shifts',
      resourceId: rows[0].id, payload: { shiftNumber, shiftDate, lineId },
      ipAddress, userAgent })
    return rows[0]
  })
}

// Micro pyme: el capturista inicia su propio turno SIN programación previa.
// Requiere el flag tenant_process_config.allow_self_start_shift. Crea el
// production_shift activo con el usuario como operador (y miembro capturista),
// fecha local de operación, sin orden (la elige de la cola al capturar).
// Idempotente: si el usuario ya tiene un turno activo, lo devuelve.
async function selfStartShift({ tenantId, userId, ipAddress, userAgent }) {
  const { rows: cfg } = await query(
    `SELECT allow_self_start_shift FROM tenant_process_config WHERE tenant_id = $1`,
    [tenantId]
  )
  if (!cfg[0]?.allow_self_start_shift) {
    throw createError(403, 'El inicio de turno directo no está habilitado para esta empresa.')
  }

  // ¿Ya tiene un turno activo? → devolverlo (no duplicar).
  const { rows: existing } = await query(
    `SELECT * FROM production_shifts
      WHERE tenant_id = $1 AND operator_id = $2 AND status = 'active'
      ORDER BY started_at DESC LIMIT 1`,
    [tenantId, userId]
  )
  if (existing[0]) return existing[0]

  // Fecha LOCAL de operación.
  const { rows: dr } = await query(
    `SELECT (NOW() AT TIME ZONE 'America/Mexico_City')::date::text AS today`
  )
  const shiftDate = dr[0].today

  // Número de turno SIN colisión con el unique (tenant, line, shift_number,
  // shift_date). Esto permite iniciar un 2º turno el mismo día tras cerrar el
  // anterior (micro pyme): tomamos el primer turno configurado que NO se haya
  // usado hoy; si todos están usados, seguimos incrementando.
  const { rows: used } = await query(
    `SELECT shift_number FROM production_shifts
      WHERE tenant_id = $1 AND line_id = 1 AND shift_date = $2`,
    [tenantId, shiftDate]
  )
  const usedSet = new Set(used.map(r => String(r.shift_number)))
  const { rows: cfgNums } = await query(
    `SELECT shift_number FROM tenant_shift_config WHERE tenant_id = $1 ORDER BY shift_number`,
    [tenantId]
  )
  const configNums = cfgNums.map(r => String(r.shift_number))
  let shiftNumber = configNums.find(n => !usedSet.has(n))
  if (!shiftNumber) {
    const maxUsed = Math.max(0, ...[...usedSet].map(n => parseInt(n, 10)).filter(n => !isNaN(n)))
    shiftNumber = String(maxUsed + 1)
  }

  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO production_shifts
         (tenant_id, line_id, shift_number, shift_date,
          operator_id, supervisor_id, status, started_at)
       VALUES ($1, 1, $2, $3, $4, $4, 'active', NOW())
       RETURNING *`,
      [tenantId, shiftNumber, shiftDate, userId]
    )
    const shift = rows[0]

    // Miembro capturista (si el catálogo lo tiene) para que el runtime
    // dinámico opere sin depender solo del fallback legacy de operator_id.
    const { rows: role } = await client.query(
      `SELECT id FROM tenant_shift_roles
        WHERE tenant_id = $1 AND code = 'capturista' AND is_active = true LIMIT 1`,
      [tenantId]
    )
    if (role[0]) {
      await client.query(
        `INSERT INTO production_shift_members (shift_id, user_id, role_id)
         VALUES ($1, $2, $3)`,
        [shift.id, userId, role[0].id]
      )
    }

    await audit({
      tenantId, userId, action: 'shift.self_started', resource: 'production_shifts',
      resourceId: shift.id, payload: { shiftNumber, shiftDate },
      ipAddress, userAgent,
    })
    return shift
  })
}

// Micro pyme — "Inicio rápido": crea una orden mínima (producto + cantidad), la
// libera, inicia el turno y la deja como orden activa, todo en una llamada. Para
// producir al vuelo sin crear la orden por separado. Reusa createOrder /
// releaseOrder / selfStartShift / setShiftActiveOrder, así el costeo y el
// inventario funcionan igual que con una orden normal.
async function selfQuickStart({ tenantId, userId, productId, quantityPackages, lengthMm, ipAddress, userAgent }) {
  const { rows: cfg } = await query(
    `SELECT allow_self_start_shift, allow_quick_order FROM tenant_process_config WHERE tenant_id = $1`, [tenantId]
  )
  if (!cfg[0]?.allow_self_start_shift) {
    throw createError(403, 'El inicio de turno directo no está habilitado para esta empresa.')
  }
  if (!cfg[0]?.allow_quick_order) {
    throw createError(403, 'El inicio rápido no está habilitado. El operador debe elegir una orden ya creada.')
  }
  if (!productId) throw createError(400, 'Selecciona un producto.')
  const qty = parseInt(quantityPackages, 10)
  if (!qty || qty <= 0) throw createError(400, 'La cantidad de paquetes debe ser mayor a 0.')

  // Receta vigente del producto — necesaria para que el costeo salga bien.
  const { rows: rec } = await query(
    `SELECT id FROM recipes WHERE tenant_id = $1 AND product_id = $2 AND valid_until IS NULL
      ORDER BY created_at DESC LIMIT 1`,
    [tenantId, productId]
  )
  const recipeId = rec[0]?.id || null
  if (!recipeId) {
    throw createError(400, 'El producto no tiene una receta vigente. Configúrala antes de usar el inicio rápido.')
  }

  // 1) Crear la orden (queda en 'draft').
  const order = await createOrder({
    tenantId, productId, quantityPackages: qty, lengthMm: lengthMm || null, recipeId,
    notes: 'Inicio rápido (micro pyme)', userId, ipAddress, userAgent,
  })
  // 2) Liberarla. En micro pyme no bloqueamos el arranque por inventario; si
  //    falta MP, el cierre/validación lo reflejará.
  await releaseOrder({
    tenantId, orderId: order.id, userId, ipAddress, userAgent,
    lowStockOverrideReason: 'Inicio rápido (micro pyme)',
  })
  // 3) Iniciar el turno y 4) dejar la orden activa (released → in_progress).
  const shift = await selfStartShift({ tenantId, userId, ipAddress, userAgent })
  await setShiftActiveOrder({ tenantId, shiftId: shift.id, orderId: order.id, userId })

  return { shift, order }
}

async function capturePackage({
  tenantId, shiftId, productionOrderId,
  quantityUnits, realWeightKg, theoreticalWeightKg,
  lengthMm, isSecondQuality, secondQualityProductId, notes, userId,
  qualityGradeId,   // §6f: path SaaS v2 (UUID) — opcional
  gradeNumber,      // §6f: path SaaS v2 (1-5) — opcional
  dynamicAttributes, // §C: atributos custom según product_kind.capture_schema
}) {
  // Validación liviana: si vienen atributos dinámicos, debe ser un objeto JSON.
  // El backend NO valida contra el schema (eso lo hace el frontend); aquí solo
  // garantizamos el shape básico para no romper queries posteriores.
  if (dynamicAttributes !== undefined && dynamicAttributes !== null) {
    if (typeof dynamicAttributes !== 'object' || Array.isArray(dynamicAttributes)) {
      throw createError(400, 'dynamicAttributes debe ser un objeto JSON.')
    }
  }

  const { rows: shift } = await query(
    `SELECT id, status FROM production_shifts WHERE id=$1 AND tenant_id=$2`,
    [shiftId, tenantId]
  )
  if (!shift[0]) throw createError(404, 'Turno no encontrado.')
  if (shift[0].status !== 'active') throw createError(400, 'El turno no está activo.')

  const { rows: last } = await query(
    `SELECT COALESCE(MAX(microlot_number),0) AS last FROM shift_progress WHERE shift_id=$1`,
    [shiftId]
  )
  const nextNum = last[0].last + 1

  // ── Calcular peso teórico si el frontend no lo mandó válido ───────────────
  // El frontend actualmente manda theoreticalWeightKg: 0 hardcoded. Para que
  // deviation_pct y weight_ok (columnas generadas en BD) se calculen bien,
  // necesitamos un teórico > 0. Lo derivamos de current_quality_specs.
  // Si no hay spec, fallback al real_weight para evitar weight_ok=false falso.
  let theoreticalFinal = parseFloat(theoreticalWeightKg || 0)
  if (theoreticalFinal <= 0 && productionOrderId) {
    const { rows: specRows } = await query(
      `SELECT cqs.grams_per_linear_meter, cqs.units_per_package, po.length_mm
       FROM production_orders po
       LEFT JOIN current_quality_specs cqs ON cqs.product_id = po.product_id
       WHERE po.id = $1`,
      [productionOrderId]
    )
    if (specRows[0]) {
      const gpm    = parseFloat(specRows[0].grams_per_linear_meter || 0)
      const upp    = parseInt(specRows[0].units_per_package || 0)
      const lenMm  = parseInt(specRows[0].length_mm || 0)
      const useQty = parseInt(quantityUnits || upp || 50)
      if (gpm > 0 && lenMm > 0 && useQty > 0) {
        theoreticalFinal = gpm * (lenMm / 1000) * useQty / 1000
      }
    }
    if (theoreticalFinal <= 0) {
      // Sin spec disponible — usar el real para que el % salga 0 (verde)
      // en lugar de mostrar falso "fuera de tolerancia".
      theoreticalFinal = parseFloat(realWeightKg)
    }
  }

  return withTransaction(async (client) => {
    // §6f: resolver quality_grade contra el catálogo. Cualquier path (id,
    // gradeNumber, isSecondQuality) converge en un único qualityGrade row.
    // Si nada se pasa, default = grade del producto o grade 1 activo.
    let productDefaultGradeId = null
    if (productionOrderId) {
      const { rows: pdef } = await client.query(
        `SELECT p.default_quality_grade_id
         FROM production_orders po
         JOIN products p ON p.id = po.product_id
         WHERE po.id = $1`,
        [productionOrderId]
      )
      productDefaultGradeId = pdef[0]?.default_quality_grade_id || null
    }
    const qualityGrade = await resolveQualityGrade(client, {
      tenantId,
      qualityGradeId,
      gradeNumber,
      productDefaultId: productDefaultGradeId,
      isSecondQuality,
    })
    // is_second_quality derivado: cualquier grade > 1 cuenta como segunda
    // (backward compat con el flag binario).
    const isSqDerived = qualityGrade.grade_number > 1

    const dynAttrs = dynamicAttributes && Object.keys(dynamicAttributes).length > 0
      ? JSON.stringify(dynamicAttributes)
      : null

    const { rows } = await client.query(
      `INSERT INTO shift_progress
         (shift_id, production_order_id, microlot_number, quantity_units,
          real_weight_kg, theoretical_weight_kg, length_mm, is_second_quality,
          second_quality_product_id, notes, quality_grade_id,
          dynamic_attributes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)
       RETURNING *`,
      [shiftId, productionOrderId||null, nextNum, quantityUnits||50,
       realWeightKg, theoreticalFinal, lengthMm||null,
       isSqDerived,
       (isSqDerived && secondQualityProductId) ? secondQualityProductId : null,
       notes||null,
       qualityGrade.id,
       dynAttrs]
    )

    // Marcar la orden como in_progress o completed según avance
    if (productionOrderId) {
      // Primero asegurar que esté in_progress
      await client.query(
        `UPDATE production_orders SET status='in_progress'
         WHERE id=$1 AND status='released'`,
        [productionOrderId]
      )

      // Calcular paquetes producidos (sin segunda calidad) vs objetivo
      const { rows: progress } = await client.query(
        `SELECT
           po.quantity_packages AS target,
           COALESCE(COUNT(sp.id) FILTER (WHERE sp.is_second_quality = false), 0) AS produced
         FROM production_orders po
         LEFT JOIN shift_progress sp ON sp.production_order_id = po.id
         WHERE po.id = $1
         GROUP BY po.id`,
        [productionOrderId]
      )
      if (progress[0]) {
        const target   = parseInt(progress[0].target || 0)
        const produced = parseInt(progress[0].produced || 0)
        if (target > 0 && produced >= target) {
          // Pasa a 'fulfilled' (al 100%+) pero NO a 'completed' — el supervisor
          // debe cerrar explícitamente. La orden sigue editable y capturable.
          await client.query(
            `UPDATE production_orders SET status='fulfilled'
             WHERE id=$1 AND status='in_progress'`,
            [productionOrderId]
          )
        }
      }
    }

    // Actualizar contador en el turno
    await client.query(
      `UPDATE production_shifts
       SET pt_units_produced = (
         SELECT COALESCE(SUM(quantity_units),0)
         FROM shift_progress
         WHERE shift_id=$1 AND is_second_quality=false
       )
       WHERE id=$1`,
      [shiftId]
    )

    // ── Movimiento WIP en tiempo real ────────────────────────────────────────
    if (productionOrderId) {
      // Leer Process Template para decidir flujo lot-mode vs legacy.
      const { rows: cfgRows } = await client.query(
        `SELECT uses_lots, product_lot_granularity, pt_goes_to_wip_first
         FROM tenant_process_config WHERE tenant_id = $1`,
        [tenantId]
      )
      const cfg = cfgRows[0] || { uses_lots: false, product_lot_granularity: 'per_shift', pt_goes_to_wip_first: true }

      if (cfg.uses_lots) {
        // SaaS v2 §5g: lot-mode. La MP ya salió a producción en loadMp (5f).
        // Solo creamos product_lot + movimiento PT→WIP con product_lot_id.
        // Nota §6d: lot-mode siempre pasa por WIP (pt_goes_to_wip_first ignorado en este path).
        const lotResult = await captureLotModeInventory(client, {
          tenantId, shift: { id: shiftId, shift_number: null, line_id: null },
          shiftProgressRow: rows[0], productionOrderId,
          granularity: cfg.product_lot_granularity, userId,
        })
        // captureLotModeInventory hace UPDATE shift_progress.lot_id; reflejar en
        // el row de respuesta para que el caller vea el lote.
        rows[0].lot_id = lotResult.productLotId
      } else {
        try {
          // Legacy: obtener fórmula MP + factor merma + recordPackageCaptured.
          const { rows: orderRows } = await client.query(
            `SELECT po.product_id, po.blended_cost_per_kg,
                    json_agg(json_build_object(
                      'raw_material_id', omf.raw_material_id,
                      'percentage', omf.percentage,
                      'cost_per_kg', r.cost_per_kg
                    )) FILTER (WHERE omf.id IS NOT NULL) AS mp_formula
             FROM production_orders po
             LEFT JOIN order_mp_formula omf ON omf.production_order_id = po.id AND omf.valid_until IS NULL
             LEFT JOIN raw_materials r ON r.id = omf.raw_material_id
             WHERE po.id = $1
             GROUP BY po.id`,
            [productionOrderId]
          )
          const { rows: factorRows } = await client.query(
            `SELECT amount FROM production_cost_items
             WHERE tenant_id=$1 AND name='__scrap_factor__' AND is_active=true LIMIT 1`,
            [tenantId]
          )
          const scrapFactor = factorRows[0] ? parseFloat(factorRows[0].amount) / 100 : 0.20
          await recordPackageCaptured(client, {
            tenantId,
            pkg:   { ...rows[0], microlot_number: nextNum },
            order: orderRows[0] || {},
            scrapFactor,
            userId,
            ptGoesToWipFirst: cfg.pt_goes_to_wip_first !== false,
          })
        } catch (invErr) {
          console.error('[inventory] WIP capture FAILED en capturePackage:', invErr.stack || invErr)
          try {
            await audit({
              tenantId, userId,
              action: 'inventory.capture_failed',
              resource: 'shift_progress',
              resourceId: rows[0].id,
              payload: {
                shiftId,
                productionOrderId: productionOrderId || null,
                microlotNumber: nextNum,
                error: invErr.message,
              },
            })
          } catch (auditErr) {
            console.error('[audit] Error al registrar inventory.capture_failed:', auditErr.message)
          }
        }
      }
    }

    return rows[0]
  })
}

/**
 * SaaS v2 §5g: para tenants con uses_lots=true, captura el paquete generando
 * (o aumentando) un product_lot y registrando el movimiento PT→WIP con
 * product_lot_id. NO toca MP — el consumo ya quedó registrado en loadMp.
 *
 * NOTA: este flujo NO está envuelto en try/catch como el legacy; si falla,
 * propaga el error. Razón: lot-mode requiere consistencia trazable, no es
 * aceptable que un paquete quede sin lote por un fallo silencioso.
 */
async function captureLotModeInventory(client, {
  tenantId, shift, shiftProgressRow, productionOrderId, granularity, userId,
}) {
  // 1. Cargar metadata del shift (number, line, date) si vino incompleta.
  let shiftFull = shift
  if (!shift.shift_number || shift.line_id == null) {
    const { rows: sRows } = await client.query(
      `SELECT id, shift_number, line_id, shift_date FROM production_shifts WHERE id = $1`,
      [shift.id]
    )
    if (!sRows[0]) throw createError(404, 'Turno no encontrado al generar lote.')
    shiftFull = sRows[0]
  }

  // 2. Cargar product_id + sku desde la orden.
  const { rows: orderRows } = await client.query(
    `SELECT po.product_id, p.sku
     FROM production_orders po
     JOIN products p ON p.id = po.product_id
     WHERE po.id = $1`,
    [productionOrderId]
  )
  if (!orderRows[0]) throw createError(404, 'Orden de producción no encontrada al generar lote.')
  const orderInfo = orderRows[0]

  // 3. quality_grade_id ya viene resuelto en shift_progress.quality_grade_id
  //    (capturePackage / addPackage lo resuelven y persisten antes de invocar
  //    a este helper). §6f.
  const qualityGradeId = shiftProgressRow.quality_grade_id
  if (!qualityGradeId) {
    throw createError(500, 'shift_progress.quality_grade_id ausente al generar lote.')
  }

  // 4. Warehouse WIP (donde nace el lote de PT producido).
  const warehouseWip = await getWarehouseId(client, tenantId, 'wip')

  // 5. Resolver pattern y crear/aumentar product_lot.
  const pattern = await resolveLotPattern(client, { tenantId, productId: orderInfo.product_id })
  const result = await ensureProductLotForPackage(client, {
    tenantId, shift: shiftFull,
    productId: orderInfo.product_id,
    qualityGradeId,
    warehouseId: warehouseWip,
    realWeightKg: shiftProgressRow.real_weight_kg,
    productionDate: shiftFull.shift_date,
    productionOrderId, userId,
    granularity,
    productSku: orderInfo.sku,
    productLotPattern: pattern,
  })

  // 6. Vincular shift_progress.lot_id.
  await client.query(
    `UPDATE shift_progress SET lot_id = $1 WHERE id = $2`,
    [result.productLotId, shiftProgressRow.id]
  )

  // 7. Movimiento PT→WIP con product_lot_id (XOR con raw_material_lot_id).
  await recordMovement(client, {
    tenantId,
    warehouseId: warehouseWip,
    itemType:    'product',
    itemId:      orderInfo.product_id,
    movementType:'production_wip_entry',
    quantity:    parseFloat(shiftProgressRow.real_weight_kg),
    unit:        'kg',
    unitCost:    0,
    statusTo:    'wip',
    referenceType: 'shift_progress',
    referenceId:   shiftProgressRow.id,
    notes:       `Captura paquete${shiftProgressRow.is_second_quality ? ' (2da cal.)' : ''} → lote ${result.productLotId}`,
    createdBy:   userId,
    productLotId: result.productLotId,
  })

  return result
}

async function loadMp({ tenantId, shiftId, rawMaterialId, kg, isReplacement, notes, userId,
                        lotId = null, unitId = null, quantity = null }) {
  const kgNum = parseFloat(kg)
  if (!(kgNum > 0)) throw createError(400, 'kg debe ser un número positivo.')

  return withTransaction(async (client) => {
    // 1. Validar que el turno existe y pertenece al tenant.
    const { rows: shiftRows } = await client.query(
      `SELECT id FROM production_shifts WHERE id = $1 AND tenant_id = $2`,
      [shiftId, tenantId]
    )
    if (!shiftRows[0]) throw createError(404, 'Turno no encontrado.')

    // 2. Leer Process Template del tenant (uses_lots, uses_expiry, uses_fefo, cost_method).
    const { rows: cfgRows } = await client.query(
      `SELECT uses_lots, uses_expiry, uses_fefo, cost_method
       FROM tenant_process_config WHERE tenant_id = $1`,
      [tenantId]
    )
    const cfg = cfgRows[0] || { uses_lots: false }

    // 3. Resolver lote (si el tenant los usa). Lock FOR UPDATE para evitar race conditions.
    let resolvedLot = null
    if (cfg.uses_lots) {
      if (lotId) {
        // Selección manual del operador.
        const { rows: lotRows } = await client.query(
          `SELECT id, raw_material_id, status, quantity_remaining, warehouse_id, unit_cost
           FROM raw_material_lots
           WHERE id = $1 AND tenant_id = $2
           FOR UPDATE`,
          [lotId, tenantId]
        )
        if (!lotRows[0]) throw createError(404, 'Lote no encontrado.')
        const lot = lotRows[0]
        if (lot.raw_material_id !== rawMaterialId) {
          throw createError(400, 'El lote indicado no corresponde a la materia prima.')
        }
        if (lot.status !== 'active') {
          throw createError(400, `El lote está en estado '${lot.status}' y no puede consumirse.`)
        }
        if (parseFloat(lot.quantity_remaining) + 1e-6 < kgNum) {
          throw createError(400,
            `El lote solo tiene ${lot.quantity_remaining} disponibles, no alcanza para ${kgNum}.`)
        }
        resolvedLot = lot
      } else {
        // Auto-selección vía lotSelector (FEFO/FIFO según config).
        let costMethod = cfg.cost_method || 'weighted_avg'
        if (cfg.uses_fefo && cfg.uses_expiry) costMethod = 'fefo'

        const result = await selectLotsForQuantity({
          tenantId, rawMaterialId, costMethod,
          usesLots: true, usesExpiry: !!cfg.uses_expiry,
          qty: kgNum, client,
        })

        if (result.shortfall > 0) {
          throw createError(409,
            `Lotes disponibles cubren solo ${result.totalAllocated}kg de los ${kgNum}kg solicitados. ` +
            `Falta ${result.shortfall}kg. Reciba más MP o seleccione un lote manualmente.`)
        }
        if (result.plan.length > 1) {
          throw createError(409,
            `Los lotes disponibles requieren combinar ${result.plan.length} fuentes para cubrir ${kgNum}kg. ` +
            `Por favor cargue un lote a la vez o seleccione el lote manualmente.`)
        }
        if (result.plan.length === 0) {
          throw createError(409, `Sin lotes activos disponibles para esta materia prima.`)
        }

        // Lock el lote single-plan para la actualización.
        const { rows: lotRows } = await client.query(
          `SELECT id, raw_material_id, status, quantity_remaining, warehouse_id, unit_cost
           FROM raw_material_lots WHERE id = $1 FOR UPDATE`,
          [result.plan[0].lotId]
        )
        // Re-validar después del lock (defensa contra carrera con otro loadMp).
        const lot = lotRows[0]
        if (!lot || lot.status !== 'active' || parseFloat(lot.quantity_remaining) + 1e-6 < kgNum) {
          throw createError(409, 'El lote seleccionado cambió de estado durante la operación. Reintenta.')
        }
        resolvedLot = lot
      }
    }

    // 4. Insertar shift_mp_loads (con lot_id/unit_id/quantity si aplica).
    const { rows: insertRows } = await client.query(
      `INSERT INTO shift_mp_loads
         (shift_id, raw_material_id, kg, is_replacement, notes, lot_id, unit_id, quantity)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [shiftId, rawMaterialId, kgNum, isReplacement || false, notes || null,
       resolvedLot ? resolvedLot.id : null, unitId || null, quantity != null ? quantity : null]
    )
    const insertedLoad = insertRows[0]

    // 5. Decrementar quantity_remaining del lote; marcar depleted si llega a 0.
    if (resolvedLot) {
      const { rows: updRows } = await client.query(
        `UPDATE raw_material_lots
         SET quantity_remaining = quantity_remaining - $1
         WHERE id = $2
         RETURNING quantity_remaining`,
        [kgNum, resolvedLot.id]
      )
      const remaining = parseFloat(updRows[0].quantity_remaining)
      if (remaining <= 1e-6) {
        await client.query(
          `UPDATE raw_material_lots SET status = 'depleted' WHERE id = $1`,
          [resolvedLot.id]
        )
      }

      // 6. Movimiento de inventario: salida del almacén del lote con raw_material_lot_id set.
      //    Diverge del flujo legacy (MP→WIP en capturePackage): con lotes, la salida
      //    física ocurre al cargar, no al producir. Decisión sesión 2026-05-23.
      await recordMovement(client, {
        tenantId,
        warehouseId: resolvedLot.warehouse_id,
        itemType:    'raw_material',
        itemId:      rawMaterialId,
        movementType:'production_mp_consumption',
        quantity:    -kgNum,
        unit:        'kg',
        unitCost:    parseFloat(resolvedLot.unit_cost || 0),
        statusTo:    'available',
        referenceType: 'shift_mp_load',
        referenceId:   insertedLoad.id,
        notes:       `Carga MP en turno (lote ${resolvedLot.id})`,
        createdBy:   userId,
        rawMaterialLotId: resolvedLot.id,
      })
    }

    // 7. Actualizar mp_real_kg del turno.
    await client.query(
      `UPDATE production_shifts SET mp_real_kg = (
         SELECT COALESCE(SUM(kg),0) FROM shift_mp_loads WHERE shift_id = $1
       ) WHERE id = $1`,
      [shiftId]
    )

    return insertedLoad
  })
}

async function recordScrap({ tenantId, shiftId, scrapType, scrapTypeId, destination, kg, notes, productionOrderId, userId }) {
  // Modelo D Opción C: la merma capturada genera ENTRADA al almacén REGRIND
  // con status='wip' (provisional, pendiente de validación). El supervisor ve
  // el stock pendiente en el regrind antes de validar. Al validar, se promueve
  // de 'wip' a 'available'.
  //
  // SaaS v2 (§6b): si viene scrapTypeId o un scrapType que matchea un row del
  // catálogo tenant_scrap_types, populamos scrap_type_id + recovery_value_pct
  // y evaluamos is_abnormal. Fallback al comportamiento legacy si no se
  // encuentra el catálogo (e.g. scrapType='desecho' antes de la migración 122
  // o tenants sin scrap-types personalizados).
  return withTransaction(async (client) => {
    // 0. Resolver contra el catálogo SaaS v2 (silencioso si solo viene code legacy)
    const catalog = await resolveScrapType(client, {
      tenantId,
      scrapTypeId,
      scrapTypeCode: scrapTypeId ? null : scrapType,
    })

    // 1. Determinar valores para columnas legacy NOT NULL (compat)
    const legacyType = catalog ? legacyScrapTypeFor(catalog) : scrapType
    // destination: si viene en formato catálogo SaaS v2 (sell/reprocess/discard),
    // mapear al enum legacy (venta/regrind/desecho). Si viene en formato legacy
    // o no viene, usar tal cual / default del catálogo.
    const mappedDest = destination && DESTINATION_LEGACY_MAP[destination]
      ? DESTINATION_LEGACY_MAP[destination]
      : destination
    const legacyDest = mappedDest || (catalog ? legacyDestinationFor(catalog) : null)
    const catalogId  = catalog ? catalog.id : null
    const recoveryPct = catalog ? parseFloat(catalog.default_recovery_value_pct) : null

    // 2. Evaluar si la merma es anormal (solo si hay orden vinculada)
    const evaluation = await evaluateAbnormal(client, {
      tenantId, shiftId, productionOrderId,
      candidateKg: kg,
    })

    // 3. Insertar el registro con catálogo poblado y is_abnormal
    const { rows } = await client.query(
      `INSERT INTO shift_scrap
         (shift_id, scrap_type, destination, kg, notes, production_order_id,
          scrap_type_id, recovery_value_pct, is_abnormal)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [shiftId, legacyType, legacyDest, kg, notes||null, productionOrderId||null,
       catalogId, recoveryPct, evaluation.isAbnormal]
    )
    const scrapRecord = rows[0]

    // 4. SaaS v2 §6c: destination=reprocess + linked_raw_material_id →
    //    incrementar stock de la RM recuperada (papas rotas → MP-PAPAS-ROTAS, etc.)
    if (catalog?.linked_raw_material_id &&
        (legacyDest === 'regrind' || legacyDest === 'mezcla') &&
        recoveryPct != null && recoveryPct > 0) {
      const recoveredKg = parseFloat(kg) * (recoveryPct / 100)
      if (recoveredKg > 0) {
        try {
          const { rows: cfgRows } = await client.query(
            `SELECT uses_lots FROM tenant_process_config WHERE tenant_id = $1`,
            [tenantId]
          )
          const usesLots = cfgRows[0]?.uses_lots

          // Rutea por item_kind del linked_raw_material: si la MP recuperada
          // es de tipo 'packaging', escribe en el almacén de embalaje del tenant
          // (si lo tiene configurado); si no, cae al default raw_material.
          let rmWarehouseId = null
          try {
            rmWarehouseId = await getWarehouseIdForRawMaterial(client, tenantId, catalog.linked_raw_material_id)
          } catch (_) {
            rmWarehouseId = null
          }
          if (rmWarehouseId) {

            if (usesLots) {
              const lotNum = `REP-${scrapRecord.id.slice(0, 8).toUpperCase()}`
              await client.query(
                `INSERT INTO raw_material_lots
                   (tenant_id, raw_material_id, lot_number, warehouse_id,
                    quantity_received, quantity_remaining, status, unit_cost, received_at)
                 VALUES ($1, $2, $3, $4, $5, $5, 'active', 0, NOW())`,
                [tenantId, catalog.linked_raw_material_id, lotNum, rmWarehouseId, recoveredKg]
              )
            }

            await recordMovement(client, {
              tenantId,
              warehouseId: rmWarehouseId,
              itemType:    'raw_material',
              itemId:      catalog.linked_raw_material_id,
              movementType:'adjustment_in',
              quantity:    recoveredKg,
              unit:        'kg',
              unitCost:    0,
              statusTo:    'available',
              referenceType: 'shift_scrap',
              referenceId:   scrapRecord.id,
              notes:       `Reproceso merma '${catalog.code}': ${recoveredKg}kg recuperado`,
              createdBy:   userId,
            })
          }
        } catch (err) {
          console.error('[inventory] Error en linked_raw_material_id reprocess:', err.stack || err)
        }
      }
    }

    // 2. Si hay orden vinculada, generar entrada provisional al REGRIND con status='wip'
    if (productionOrderId) {
      try {
        const { rows: formula } = await client.query(
          `SELECT omf.raw_material_id, omf.percentage, r.cost_per_kg, r.name AS material_name
           FROM order_mp_formula omf
           JOIN raw_materials r ON r.id = omf.raw_material_id
           WHERE omf.production_order_id = $1
             AND omf.valid_until IS NULL
           ORDER BY omf.sort_order`,
          [productionOrderId]
        )
        if (formula.length > 0) {
          const { rows: shiftRows } = await client.query(
            `SELECT id, shift_number FROM production_shifts WHERE id = $1`,
            [shiftId]
          )
          const { rows: factorRows } = await client.query(
            `SELECT amount FROM production_cost_items
             WHERE tenant_id=$1 AND name='__scrap_factor__' AND is_active=true LIMIT 1`,
            [tenantId]
          )
          const reprocessFactor = factorRows[0] ? parseFloat(factorRows[0].amount)/100 : 0.20

          await recordScrapWipEntry(client, {
            tenantId,
            shift: shiftRows[0],
            scrapRecord,
            mpFormula: formula,
            reprocessFactor,
            userId,
          })
        }
      } catch (invErr) {
        console.error('[inventory] Error registrando merma WIP → REGRIND:', invErr.stack || invErr)
        try {
          await audit({
            tenantId, userId,
            action: 'inventory.scrap_to_regrind_wip_failed',
            resource: 'shift_scrap',
            resourceId: scrapRecord.id,
            payload: { shiftId, productionOrderId, kg, error: invErr.message },
          })
        } catch (_) { /* no bloquear */ }
      }
    }

    return scrapRecord
  })
}

async function reportIncident({ tenantId, shiftId, category, description, durationMin, userId }) {
  const { rows } = await query(
    `INSERT INTO shift_incidents (shift_id, category, description, duration_min, reported_by)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [shiftId, category, description, durationMin||null, userId]
  )
  return rows[0]
}

// ═══════════════════════════════════════════════════════════════════════════
//  CORRECCIONES DEL SUPERVISOR (pending_handover only)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Verifica que el usuario tenga permiso para corregir el turno.
 *   - Debe ser el supervisor asignado al turno, O
 *   - Debe tener rol 'admin' o 'super_admin'
 *   - El turno debe estar en status 'pending_handover'
 * Retorna el row del turno si todo OK, lanza error si no.
 */
async function assertCorrectionPermission(client, { tenantId, shiftId, userId }) {
  const { rows: shifts } = await client.query(
    `SELECT id, status, supervisor_id, shift_number FROM production_shifts
     WHERE id = $1 AND tenant_id = $2`,
    [shiftId, tenantId]
  )
  if (!shifts[0]) throw createError(404, 'Turno no encontrado.')
  const shift = shifts[0]

  if (shift.status !== 'pending_handover') {
    throw createError(400, `Las correcciones solo se permiten en turnos pendientes de validación. Estado actual: ${shift.status}.`)
  }

  // Permiso: supervisor del turno o admin/super_admin
  if (shift.supervisor_id !== userId) {
    const { rows: roles } = await client.query(
      `SELECT r.name FROM user_roles ur
       JOIN roles r ON r.id = ur.role_id
       WHERE ur.user_id = $1 AND r.name IN ('admin','super_admin')`,
      [userId]
    )
    if (roles.length === 0) {
      throw createError(403, 'Solo el supervisor del turno o un admin pueden corregir.')
    }
  }

  return shift
}

// ─────────────────────────────────────────────────────────────────────────────
// Modo edición operador (turno activo, dueño del turno).
//   - Convive con assertCorrectionPermission (supervisor en pending_handover).
//   - El operador puede EDITAR sus registros sin razón mientras el turno está
//     activo. Sólo puede ELIMINAR si el registro tiene < OPERATOR_DELETE_WINDOW_MIN.
//   - No se registra en shift_corrections (acuerdo de sesión 6, 2026-05-13).
// ─────────────────────────────────────────────────────────────────────────────
const OPERATOR_DELETE_WINDOW_MIN = 30

/**
 * Resuelve el modo de edición/eliminación:
 *   - 'operator'  → turno active + caller es operator_id
 *   - 'supervisor'→ turno pending_handover + caller supervisor/admin (delega a assertCorrectionPermission)
 * Lanza 400/403 si no aplica ninguno.
 */
async function resolveEditMode(client, { tenantId, shiftId, userId }) {
  const { rows } = await client.query(
    `SELECT id, status, operator_id, supervisor_id, shift_number
     FROM production_shifts
     WHERE id = $1 AND tenant_id = $2`,
    [shiftId, tenantId]
  )
  if (!rows[0]) throw createError(404, 'Turno no encontrado.')
  const shift = rows[0]

  if (shift.status === 'active' && await userCanActOnShift({ shiftId, userId, capability: 'capture', client })) {
    return { mode: 'operator', shift }
  }
  if (shift.status === 'pending_handover') {
    await assertCorrectionPermission(client, { tenantId, shiftId, userId })
    return { mode: 'supervisor', shift }
  }
  // Active pero el caller no es operador → no permitido
  if (shift.status === 'active') {
    throw createError(403, 'Solo los miembros del turno con permiso de captura pueden editar sus registros mientras está activo.')
  }
  throw createError(400, `No se pueden editar registros en este estado del turno: ${shift.status}.`)
}

/**
 * Verifica que un registro creado en `createdAt` aún esté dentro de la ventana
 * de eliminación del operador (30 min). Lanza 400 si ya venció.
 */
function assertDeletableByOperator(createdAt) {
  if (!createdAt) throw createError(400, 'Registro sin fecha de captura; no se puede determinar la ventana de eliminación.')
  const ageMs = Date.now() - new Date(createdAt).getTime()
  const limitMs = OPERATOR_DELETE_WINDOW_MIN * 60 * 1000
  if (ageMs > limitMs) {
    throw createError(400, `Solo se puede eliminar dentro de los primeros ${OPERATOR_DELETE_WINDOW_MIN} minutos desde la captura.`)
  }
}

function assertSupervisorReason(reason) {
  if (!reason || !String(reason).trim()) {
    throw createError(400, 'La razón de la corrección es obligatoria.')
  }
}

/**
 * Verifica que una orden esté editable (no 'completed' ni 'cancelled').
 * Si la orden está cerrada, no se permiten más cambios.
 */
async function assertOrderEditable(client, { orderId }) {
  if (!orderId) return // sin orden vinculada, no aplica
  const { rows } = await client.query(
    `SELECT id, status, order_number FROM production_orders WHERE id = $1`,
    [orderId]
  )
  if (!rows[0]) throw createError(404, 'Orden no encontrada.')
  const order = rows[0]
  if (order.status === 'completed') {
    throw createError(400, `La orden ${order.order_number} ya fue cerrada por el supervisor y no admite cambios.`)
  }
  if (order.status === 'cancelled') {
    throw createError(400, `La orden ${order.order_number} fue cancelada y no admite cambios.`)
  }
  return order
}
/** Helper: insertar fila en shift_corrections */
async function insertCorrection(client, { tenantId, shiftId, targetType, targetId, action, originalValue, newValue, reason, userId }) {
  if (!reason || !String(reason).trim()) {
    throw createError(400, 'La razón de la corrección es obligatoria.')
  }
  await client.query(
    `INSERT INTO shift_corrections
       (tenant_id, shift_id, target_type, target_id, action, original_value, new_value, correction_reason, corrected_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [tenantId, shiftId, targetType, targetId, action,
     originalValue ? JSON.stringify(originalValue) : null,
     newValue ? JSON.stringify(newValue) : null,
     reason.trim(), userId]
  )
}

/** Helper: revertir movimientos de inventario asociados a un registro */
async function revertInventoryMovements(client, { tenantId, referenceType, referenceId }) {
  // Las funciones de captura crean movimientos con reference_type/reference_id.
  // Para revertir: generamos el movimiento opuesto y ajustamos el stock.
  //
  // IMPORTANTE: si al revertir el stock quedaría negativo (porque el stock
  // actual del almacén es menor a lo que estamos reversando), aplicamos
  // GREATEST(0, ...) para mantener el constraint stock_quantity_positive
  // y emitimos un WARNING que se propaga al frontend como aviso.
  //
  // Esto cubre el caso típico de un sistema en pruebas o sin MP cargada en
  // el almacén raw_material: la captura sintetizó stock "de la nada" en WIP,
  // y al revertir intentaría dejarlo en negativo. Con esta lógica el sistema
  // se mantiene consistente y el supervisor recibe un aviso visible.
  const { rows: movs } = await client.query(
    `SELECT id, warehouse_id, item_type, item_id, movement_type,
            quantity, unit, unit_cost, status_to
     FROM inventory_movements
     WHERE tenant_id = $1 AND reference_type = $2 AND reference_id = $3
     ORDER BY created_at DESC`,
    [tenantId, referenceType, referenceId]
  )

  const warnings = []

  for (const m of movs) {
    const reverseQty = -parseFloat(m.quantity)

    // Leer stock actual ANTES de ajustar, para detectar si se truncará a 0.
    const { rows: currentRows } = await client.query(
      `SELECT quantity FROM inventory_stock
       WHERE tenant_id = $1 AND warehouse_id = $2
         AND item_type = $3 AND item_id = $4 AND status = $5`,
      [tenantId, m.warehouse_id, m.item_type, m.item_id, m.status_to]
    )
    const currentQty   = parseFloat(currentRows[0]?.quantity || 0)
    const expectedQty  = currentQty + reverseQty
    const wouldGoNegative = expectedQty < 0

    if (wouldGoNegative) {
      // Recuperar nombre del item y almacén para el warning
      const { rows: meta } = await client.query(
        `SELECT w.name AS warehouse_name,
                COALESCE(r.name, p.name) AS item_name
         FROM warehouses w
         LEFT JOIN raw_materials r ON r.id = $2::uuid AND $3 = 'raw_material'
         LEFT JOIN products      p ON p.id = $2::uuid AND $3 = 'product'
         WHERE w.id = $1`,
        [m.warehouse_id, m.item_id, m.item_type]
      )
      warnings.push({
        code:          'STOCK_FLOORED_TO_ZERO',
        warehouseName: meta[0]?.warehouse_name || 'almacén desconocido',
        itemName:      meta[0]?.item_name      || 'item desconocido',
        attempted:     parseFloat(expectedQty.toFixed(4)),
        adjusted:      0,
      })
    }

    // Ajustar stock con piso en 0 (preserva el CHECK constraint).
    await client.query(
      `INSERT INTO inventory_stock
         (tenant_id, warehouse_id, item_type, item_id, status,
          quantity, unit, avg_cost, last_movement_at)
       VALUES ($1, $2, $3, $4, $5, GREATEST(0, $6::numeric), $7, $8, NOW())
       ON CONFLICT (tenant_id, warehouse_id, item_type, item_id, status) DO UPDATE
         SET quantity         = GREATEST(0, inventory_stock.quantity + EXCLUDED.quantity),
             updated_at       = NOW(),
             last_movement_at = NOW()`,
      [tenantId, m.warehouse_id, m.item_type, m.item_id, m.status_to, reverseQty, m.unit, m.unit_cost]
    )
  }

  // Borrar los movimientos originales (la auditoría queda en shift_corrections)
  await client.query(
    `DELETE FROM inventory_movements
     WHERE tenant_id = $1 AND reference_type = $2 AND reference_id = $3`,
    [tenantId, referenceType, referenceId]
  )

  return { warnings }
}

/**
 * Editar un paquete capturado (shift_progress).
 * Snapshot original → revertir movimientos → actualizar registro → regenerar movimientos.
 */
async function editPackage({ tenantId, shiftId, packageId, updates, reason, userId }) {
  return withTransaction(async (client) => {
    const { mode } = await resolveEditMode(client, { tenantId, shiftId, userId })
    if (mode === 'supervisor') assertSupervisorReason(reason)

    // Snapshot original
    const { rows: orig } = await client.query(
      `SELECT * FROM shift_progress WHERE id = $1 AND shift_id = $2`,
      [packageId, shiftId]
    )
    if (!orig[0]) throw createError(404, 'Paquete no encontrado.')
    const originalValue = orig[0]

    // §6f: si el caller manda qualityGradeId/gradeNumber, lo resolvemos contra
    // el catálogo. El path legacy (isSecondQuality boolean) sigue funcionando.
    let newQualityGradeId = originalValue.quality_grade_id
    let newSecondQ = originalValue.is_second_quality
    if (updates.qualityGradeId !== undefined || updates.gradeNumber !== undefined) {
      const qg = await resolveQualityGrade(client, {
        tenantId,
        qualityGradeId: updates.qualityGradeId,
        gradeNumber:    updates.gradeNumber,
      })
      newQualityGradeId = qg.id
      newSecondQ = qg.grade_number > 1
    } else if (updates.isSecondQuality !== undefined) {
      // Legacy path: bool → resolver al grade del catálogo
      const qg = await resolveQualityGrade(client, {
        tenantId, isSecondQuality: !!updates.isSecondQuality,
      })
      newQualityGradeId = qg.id
      newSecondQ = qg.grade_number > 1
    }

    // SaaS v2 §5g.1: si el paquete está vinculado a un product_lot, restringir
    // qué updates aceptamos. Mover entre lotes (cambio de calidad) requiere
    // crear lote nuevo y eliminar el viejo si quedó vacío — deferido a futuro.
    if (originalValue.lot_id && newSecondQ !== originalValue.is_second_quality) {
      throw createError(400,
        'Cambiar la calidad en un paquete con lote requiere reasignar el lote. ' +
        'Elimina el paquete y captúralo de nuevo con la calidad correcta.')
    }

    // Bloquear si la orden vinculada ya está cerrada/cancelada
    await assertOrderEditable(client, { orderId: originalValue.production_order_id })

    // Aplicar updates permitidos
    const newWeight = updates.realWeightKg !== undefined ? parseFloat(updates.realWeightKg) : parseFloat(originalValue.real_weight_kg)
    const newQuantity = updates.quantityUnits !== undefined ? parseInt(updates.quantityUnits) : originalValue.quantity_units
    const newNotes = updates.notes !== undefined ? updates.notes : originalValue.notes

    let revertResult = { warnings: [] }

    if (originalValue.lot_id) {
      // === SaaS v2 §5g.1: flujo lot-mode ===
      // No reversamos el movimiento original; en su lugar generamos uno compensatorio.
      const oldWeight = parseFloat(originalValue.real_weight_kg)
      const delta = newWeight - oldWeight
      if (Math.abs(delta) > 1e-9) {
        await applyProductLotDelta(client, {
          tenantId, packageId, lotId: originalValue.lot_id, delta, userId,
          notes: `Edición de paquete (${oldWeight}→${newWeight} kg)`,
        })
      }

      const { rows: updated } = await client.query(
        `UPDATE shift_progress
         SET real_weight_kg = $1, is_second_quality = $2, quantity_units = $3,
             notes = $4, quality_grade_id = $5
         WHERE id = $6 RETURNING *`,
        [newWeight, newSecondQ, newQuantity, newNotes, newQualityGradeId, packageId]
      )
      const newValue = updated[0]

      // Si el shift ya está pending_handover (closeShift ya corrió), re-distribuir
      // lot_consumption para reflejar el nuevo peso del lote.
      const { rows: shiftRow } = await client.query(
        `SELECT status FROM production_shifts WHERE id = $1`, [shiftId]
      )
      if (shiftRow[0]?.status === 'pending_handover') {
        await distributeRawMaterialLotsToProductLots(client, { tenantId, shiftId })
      }

      if (mode === 'supervisor') {
        await insertCorrection(client, {
          tenantId, shiftId,
          targetType: 'shift_progress', targetId: packageId, action: 'update',
          originalValue, newValue,
          reason, userId,
        })
      }

      return { data: newValue, warnings: [] }
    }

    // === Flujo legacy (uses_lots=false) ===
    // Revertir movimientos provisionales asociados al paquete
    revertResult = await revertInventoryMovements(client, {
      tenantId, referenceType: 'shift_progress', referenceId: packageId
    })

    // Actualizar el registro (incluye quality_grade_id refactor §6f)
    const { rows: updated } = await client.query(
      `UPDATE shift_progress
       SET real_weight_kg = $1, is_second_quality = $2, quantity_units = $3,
           notes = $4, quality_grade_id = $5
       WHERE id = $6 RETURNING *`,
      [newWeight, newSecondQ, newQuantity, newNotes, newQualityGradeId, packageId]
    )
    const newValue = updated[0]

    // Regenerar movimientos provisionales con los nuevos valores
    // Importante: usar la fórmula MP que estaba VIGENTE al momento de captura
    // original del paquete (no la fórmula actual), para preservar el costeo.
    const capturedAt = originalValue.captured_at
    const { rows: orderRows } = await client.query(
      `SELECT po.id, po.length_mm, po.product_id,
              (SELECT json_agg(json_build_object(
                'raw_material_id', omf.raw_material_id,
                'percentage', omf.percentage,
                'cost_per_kg', r.cost_per_kg
              )) FROM order_mp_formula omf
              JOIN raw_materials r ON r.id = omf.raw_material_id
              WHERE omf.production_order_id = po.id
                AND omf.valid_from <= $2
                AND (omf.valid_until IS NULL OR omf.valid_until > $2)) AS mp_formula
       FROM production_orders po
       WHERE po.id = $1`,
      [originalValue.production_order_id || newValue.production_order_id, capturedAt]
    )
    if (orderRows[0]?.mp_formula) {
      const { rows: factorRows } = await client.query(
        `SELECT amount FROM production_cost_items
         WHERE tenant_id=$1 AND name='__scrap_factor__' AND is_active=true LIMIT 1`,
        [tenantId]
      )
      const scrapFactor = factorRows[0] ? parseFloat(factorRows[0].amount)/100 : 0.20

      await recordPackageCaptured(client, {
        tenantId,
        pkg: newValue,
        order: {
          id: orderRows[0].id,
          length_mm: orderRows[0].length_mm,
          product_id: orderRows[0].product_id,
          mp_formula: orderRows[0].mp_formula,
        },
        scrapFactor,
        userId,
      })
    }

    // Bitácora solo en modo supervisor
    if (mode === 'supervisor') {
      await insertCorrection(client, {
        tenantId, shiftId,
        targetType: 'shift_progress', targetId: packageId, action: 'update',
        originalValue, newValue,
        reason, userId,
      })
    }

    return { data: newValue, warnings: revertResult.warnings || [] }
  })
}

/**
 * SaaS v2 §5g.1: ajusta el saldo de un product_lot por una variación en uno
 * de sus paquetes (editPackage/deletePackage).
 *
 *   delta > 0  → aumenta quantity_produced/remaining (paquete se hizo más pesado).
 *   delta < 0  → reduce (paquete bajó de peso o se eliminó).
 *
 * Si delta deja quantity_produced en 0 → DELETE el lote (CASCADE limpia
 * lot_consumption). Genera movimiento compensatorio PT→WIP.
 *
 * @returns {Promise<{ lotDeleted: boolean }>}
 */
async function applyProductLotDelta(client, {
  tenantId, packageId, lotId, delta, userId, notes,
}) {
  const { rows: lotRows } = await client.query(
    `SELECT id, product_id, quantity_produced, quantity_remaining, warehouse_id
     FROM product_lots WHERE id = $1 AND tenant_id = $2
     FOR UPDATE`,
    [lotId, tenantId]
  )
  if (!lotRows[0]) throw createError(404, 'Lote de producto no encontrado al ajustar paquete.')
  const lot = lotRows[0]
  const curProduced = parseFloat(lot.quantity_produced)
  const curRemaining = parseFloat(lot.quantity_remaining)

  const newProduced = curProduced + delta
  const newRemaining = curRemaining + delta

  if (newProduced < -1e-6) {
    throw createError(400,
      `Ajuste invalida el lote: quantity_produced quedaría negativa (${newProduced.toFixed(4)}).`)
  }
  if (newRemaining < -1e-6) {
    throw createError(400,
      `Ajuste invalida el lote: parte del lote ya fue consumida externamente y no se puede reducir más (remaining=${curRemaining}, delta=${delta}).`)
  }

  let lotDeleted = false
  if (newProduced <= 1e-6) {
    // Lote vacío → DELETE. CASCADE en lot_consumption.
    await client.query(`DELETE FROM product_lots WHERE id = $1`, [lot.id])
    lotDeleted = true
  } else {
    await client.query(
      `UPDATE product_lots
       SET quantity_produced = $1, quantity_remaining = $2
       WHERE id = $3`,
      [newProduced, newRemaining, lot.id]
    )
  }

  // Movimiento compensatorio PT→WIP: quantity = +delta (positivo si paquete creció, negativo si menguó).
  await recordMovement(client, {
    tenantId,
    warehouseId: lot.warehouse_id,
    itemType:    'product',
    itemId:      lot.product_id,
    movementType:'production_wip_entry',
    quantity:    delta,
    unit:        'kg',
    unitCost:    0,
    statusTo:    'wip',
    referenceType: 'shift_progress',
    referenceId:   packageId,
    notes:       notes || `Ajuste de paquete (lote ${lot.id}${lotDeleted ? ', eliminado' : ''})`,
    createdBy:   userId,
    productLotId: lotDeleted ? null : lot.id,
  })

  return { lotDeleted }
}

/** Eliminar un paquete capturado. */
async function deletePackage({ tenantId, shiftId, packageId, reason, userId }) {
  return withTransaction(async (client) => {
    const { mode } = await resolveEditMode(client, { tenantId, shiftId, userId })
    if (mode === 'supervisor') assertSupervisorReason(reason)

    const { rows: orig } = await client.query(
      `SELECT * FROM shift_progress WHERE id = $1 AND shift_id = $2`,
      [packageId, shiftId]
    )
    if (!orig[0]) throw createError(404, 'Paquete no encontrado.')
    const originalValue = orig[0]

    if (mode === 'operator') assertDeletableByOperator(originalValue.captured_at)

    // Bloquear si la orden vinculada ya está cerrada/cancelada
    await assertOrderEditable(client, { orderId: originalValue.production_order_id })

    let warnings = []
    if (originalValue.lot_id) {
      // === SaaS v2 §5g.1: flujo lot-mode ===
      // Refundar weight al product_lot (puede eliminarlo si era el único paquete).
      const oldWeight = parseFloat(originalValue.real_weight_kg)
      await applyProductLotDelta(client, {
        tenantId, packageId, lotId: originalValue.lot_id, delta: -oldWeight, userId,
        notes: `Eliminación de paquete (refund ${oldWeight} kg del lote)`,
      })

      await client.query(`DELETE FROM shift_progress WHERE id = $1`, [packageId])

      // Re-distribuir lot_consumption si el shift ya está pending_handover
      const { rows: shiftRow } = await client.query(
        `SELECT status FROM production_shifts WHERE id = $1`, [shiftId]
      )
      if (shiftRow[0]?.status === 'pending_handover') {
        await distributeRawMaterialLotsToProductLots(client, { tenantId, shiftId })
      }
    } else {
      // === Flujo legacy ===
      const revertResult = await revertInventoryMovements(client, {
        tenantId, referenceType: 'shift_progress', referenceId: packageId
      })
      warnings = revertResult.warnings || []
      await client.query(`DELETE FROM shift_progress WHERE id = $1`, [packageId])
    }

    if (mode === 'supervisor') {
      await insertCorrection(client, {
        tenantId, shiftId,
        targetType: 'shift_progress', targetId: packageId, action: 'delete',
        originalValue, newValue: null,
        reason, userId,
      })
    }

    return { deleted: true, packageId, warnings }
  })
}

/** Editar un registro de merma. */
async function editScrap({ tenantId, shiftId, scrapId, updates, reason, userId }) {
  return withTransaction(async (client) => {
    const { mode } = await resolveEditMode(client, { tenantId, shiftId, userId })
    if (mode === 'supervisor') assertSupervisorReason(reason)

    const { rows: orig } = await client.query(
      `SELECT * FROM shift_scrap WHERE id = $1 AND shift_id = $2`,
      [scrapId, shiftId]
    )
    if (!orig[0]) throw createError(404, 'Registro de merma no encontrado.')
    const originalValue = orig[0]

    // Bloquear si la orden vinculada ya está cerrada/cancelada
    await assertOrderEditable(client, { orderId: originalValue.production_order_id })

    const newKg = updates.kg !== undefined ? parseFloat(updates.kg) : parseFloat(originalValue.kg)
    const newType = updates.scrapType !== undefined ? updates.scrapType : originalValue.scrap_type
    const newDest = updates.destination !== undefined ? updates.destination : originalValue.destination
    const newNotes = updates.notes !== undefined ? updates.notes : originalValue.notes

    // Revertir movimientos al regrind WIP
    const revertResult = await revertInventoryMovements(client, {
      tenantId, referenceType: 'shift_scrap', referenceId: scrapId
    })

    const { rows: updated } = await client.query(
      `UPDATE shift_scrap
       SET kg = $1, scrap_type = $2, destination = $3, notes = $4
       WHERE id = $5 RETURNING *`,
      [newKg, newType, newDest, newNotes, scrapId]
    )
    const newValue = updated[0]

    // Regenerar movimiento WIP al regrind si tiene production_order_id
    // Usar la fórmula que estaba vigente al momento de captura de la merma.
    if (newValue.production_order_id) {
      const capturedAt = originalValue.captured_at
      const { rows: formula } = await client.query(
        `SELECT omf.raw_material_id, omf.percentage, r.cost_per_kg
         FROM order_mp_formula omf
         JOIN raw_materials r ON r.id = omf.raw_material_id
         WHERE omf.production_order_id = $1
           AND omf.valid_from <= $2
           AND (omf.valid_until IS NULL OR omf.valid_until > $2)
         ORDER BY omf.sort_order`,
        [newValue.production_order_id, capturedAt]
      )
      if (formula.length > 0) {
        const { rows: shiftRows } = await client.query(
          `SELECT id, shift_number FROM production_shifts WHERE id = $1`, [shiftId]
        )
        const { rows: factorRows } = await client.query(
          `SELECT amount FROM production_cost_items
           WHERE tenant_id=$1 AND name='__scrap_factor__' AND is_active=true LIMIT 1`,
          [tenantId]
        )
        const reprocessFactor = factorRows[0] ? parseFloat(factorRows[0].amount)/100 : 0.20

        await recordScrapWipEntry(client, {
          tenantId,
          shift: shiftRows[0],
          scrapRecord: newValue,
          mpFormula: formula,
          reprocessFactor,
          userId,
        })
      }
    }

    if (mode === 'supervisor') {
      await insertCorrection(client, {
        tenantId, shiftId,
        targetType: 'shift_scrap', targetId: scrapId, action: 'update',
        originalValue, newValue,
        reason, userId,
      })
    }

    return { data: newValue, warnings: revertResult.warnings || [] }
  })
}

/** Eliminar un registro de merma. */
async function deleteScrap({ tenantId, shiftId, scrapId, reason, userId }) {
  return withTransaction(async (client) => {
    const { mode } = await resolveEditMode(client, { tenantId, shiftId, userId })
    if (mode === 'supervisor') assertSupervisorReason(reason)

    const { rows: orig } = await client.query(
      `SELECT * FROM shift_scrap WHERE id = $1 AND shift_id = $2`,
      [scrapId, shiftId]
    )
    if (!orig[0]) throw createError(404, 'Registro de merma no encontrado.')
    const originalValue = orig[0]

    if (mode === 'operator') assertDeletableByOperator(originalValue.captured_at)

    // Bloquear si la orden vinculada ya está cerrada/cancelada
    await assertOrderEditable(client, { orderId: originalValue.production_order_id })

    const revertResult = await revertInventoryMovements(client, {
      tenantId, referenceType: 'shift_scrap', referenceId: scrapId
    })

    await client.query(`DELETE FROM shift_scrap WHERE id = $1`, [scrapId])

    if (mode === 'supervisor') {
      await insertCorrection(client, {
        tenantId, shiftId,
        targetType: 'shift_scrap', targetId: scrapId, action: 'delete',
        originalValue, newValue: null,
        reason, userId,
      })
    }

    return { deleted: true, scrapId, warnings: revertResult.warnings || [] }
  })
}

/** Editar incidencia. */
async function editIncident({ tenantId, shiftId, incidentId, updates, reason, userId }) {
  return withTransaction(async (client) => {
    const { mode } = await resolveEditMode(client, { tenantId, shiftId, userId })
    if (mode === 'supervisor') assertSupervisorReason(reason)

    const { rows: orig } = await client.query(
      `SELECT * FROM shift_incidents WHERE id = $1 AND shift_id = $2`,
      [incidentId, shiftId]
    )
    if (!orig[0]) throw createError(404, 'Incidencia no encontrada.')
    const originalValue = orig[0]

    const newCategory = updates.category !== undefined ? updates.category : originalValue.category
    const newDesc = updates.description !== undefined ? updates.description : originalValue.description
    const newDuration = updates.durationMin !== undefined ? (updates.durationMin === null ? null : parseInt(updates.durationMin)) : originalValue.duration_min

    const { rows: updated } = await client.query(
      `UPDATE shift_incidents
       SET category = $1, description = $2, duration_min = $3
       WHERE id = $4 RETURNING *`,
      [newCategory, newDesc, newDuration, incidentId]
    )
    const newValue = updated[0]

    if (mode === 'supervisor') {
      await insertCorrection(client, {
        tenantId, shiftId,
        targetType: 'shift_incidents', targetId: incidentId, action: 'update',
        originalValue, newValue,
        reason, userId,
      })
    }

    return newValue
  })
}

/** Eliminar incidencia. */
async function deleteIncident({ tenantId, shiftId, incidentId, reason, userId }) {
  return withTransaction(async (client) => {
    const { mode } = await resolveEditMode(client, { tenantId, shiftId, userId })
    if (mode === 'supervisor') assertSupervisorReason(reason)

    const { rows: orig } = await client.query(
      `SELECT * FROM shift_incidents WHERE id = $1 AND shift_id = $2`,
      [incidentId, shiftId]
    )
    if (!orig[0]) throw createError(404, 'Incidencia no encontrada.')
    const originalValue = orig[0]

    if (mode === 'operator') assertDeletableByOperator(originalValue.created_at)

    await client.query(`DELETE FROM shift_incidents WHERE id = $1`, [incidentId])

    if (mode === 'supervisor') {
      await insertCorrection(client, {
        tenantId, shiftId,
        targetType: 'shift_incidents', targetId: incidentId, action: 'delete',
        originalValue, newValue: null,
        reason, userId,
      })
    }

    return { deleted: true, incidentId }
  })
}

/**
 * Editar carga de MP. Solo modo operador (no existe contraparte supervisor).
 * Actualiza kg/notes/isReplacement y recalcula production_shifts.mp_real_kg.
 */
async function editMpLoad({ tenantId, shiftId, mpLoadId, updates, userId }) {
  return withTransaction(async (client) => {
    const { mode } = await resolveEditMode(client, { tenantId, shiftId, userId })
    if (mode !== 'operator') {
      throw createError(400, 'La edición de cargas de MP solo está disponible para el operador con el turno activo.')
    }

    const { rows: orig } = await client.query(
      `SELECT * FROM shift_mp_loads WHERE id = $1 AND shift_id = $2`,
      [mpLoadId, shiftId]
    )
    if (!orig[0]) throw createError(404, 'Carga de MP no encontrada.')
    const originalValue = orig[0]

    const newKg = updates.kg !== undefined ? parseFloat(updates.kg) : parseFloat(originalValue.kg)
    if (!(newKg > 0)) throw createError(400, 'Los kg deben ser mayores a 0.')
    const newIsReplacement = updates.isReplacement !== undefined ? !!updates.isReplacement : originalValue.is_replacement
    const newNotes = updates.notes !== undefined ? updates.notes : originalValue.notes

    // SaaS v2 §5f.1: si la carga tiene lote, ajustar quantity_remaining del
    // lote, transicionar status active↔depleted, y registrar movimiento
    // compensatorio. Si delta=0 (solo cambió notes/isReplacement), saltamos.
    if (originalValue.lot_id) {
      const oldKg = parseFloat(originalValue.kg)
      const delta = newKg - oldKg
      if (Math.abs(delta) > 1e-9) {
        await applyLotConsumptionDelta(client, {
          tenantId, mpLoadId, lotId: originalValue.lot_id, delta, userId,
          notes: `Edición de carga (${oldKg}→${newKg} kg)`,
        })
      }
    }

    const { rows: updated } = await client.query(
      `UPDATE shift_mp_loads
       SET kg = $1, is_replacement = $2, notes = $3
       WHERE id = $4 RETURNING *`,
      [newKg, newIsReplacement, newNotes, mpLoadId]
    )

    await client.query(
      `UPDATE production_shifts SET mp_real_kg = (
         SELECT COALESCE(SUM(kg),0) FROM shift_mp_loads WHERE shift_id = $1
       ) WHERE id = $1`,
      [shiftId]
    )

    return updated[0]
  })
}

/**
 * SaaS v2 §5f.1: ajusta el saldo del lote de MP por una variación en una carga.
 *
 *   delta > 0  → consume más del lote (operador subió la kg).
 *   delta < 0  → refunda al lote (operador bajó la kg o eliminó la carga).
 *
 * Aplica:
 *   - Lock FOR UPDATE.
 *   - Si delta > qty disponible → 400.
 *   - quantity_remaining -= delta.
 *   - Transición status: si llega a 0 → 'depleted'; si era 'depleted' y vuelve
 *     > 0 → 'active' (reactivación automática, decisión sesión 2026-05-23).
 *   - Crea inventory_movement compensatorio con cantidad = -delta.
 */
async function applyLotConsumptionDelta(client, {
  tenantId, mpLoadId, lotId, delta, userId, notes,
}) {
  const { rows: lotRows } = await client.query(
    `SELECT id, status, quantity_remaining, warehouse_id, unit_cost, raw_material_id
     FROM raw_material_lots WHERE id = $1 AND tenant_id = $2
     FOR UPDATE`,
    [lotId, tenantId]
  )
  if (!lotRows[0]) throw createError(404, 'Lote no encontrado al ajustar carga.')
  const lot = lotRows[0]

  if (delta > 0 && parseFloat(lot.quantity_remaining) + 1e-6 < delta) {
    throw createError(400,
      `El lote solo tiene ${lot.quantity_remaining} adicionales disponibles, ` +
      `no alcanza para incrementar la carga en ${delta}.`)
  }

  const { rows: upd } = await client.query(
    `UPDATE raw_material_lots
     SET quantity_remaining = quantity_remaining - $1
     WHERE id = $2 RETURNING quantity_remaining, status`,
    [delta, lot.id]
  )
  const newRemaining = parseFloat(upd[0].quantity_remaining)
  const curStatus = upd[0].status

  if (newRemaining <= 1e-6 && curStatus === 'active') {
    await client.query(
      `UPDATE raw_material_lots SET status = 'depleted' WHERE id = $1`,
      [lot.id]
    )
  } else if (newRemaining > 1e-6 && curStatus === 'depleted') {
    await client.query(
      `UPDATE raw_material_lots SET status = 'active' WHERE id = $1`,
      [lot.id]
    )
  }

  // Movimiento compensatorio. quantity = -delta: negativo si consume más,
  // positivo si refunda.
  await recordMovement(client, {
    tenantId,
    warehouseId: lot.warehouse_id,
    itemType:    'raw_material',
    itemId:      lot.raw_material_id,
    movementType:'production_mp_consumption',
    quantity:    -delta,
    unit:        'kg',
    unitCost:    parseFloat(lot.unit_cost || 0),
    statusTo:    'available',
    referenceType: 'shift_mp_load',
    referenceId:   mpLoadId,
    notes:       notes || `Ajuste de carga (lote ${lot.id})`,
    createdBy:   userId,
    rawMaterialLotId: lot.id,
  })
}

/**
 * Eliminar carga de MP. Solo modo operador, dentro de ventana 30 min.
 */
async function deleteMpLoad({ tenantId, shiftId, mpLoadId, userId }) {
  return withTransaction(async (client) => {
    const { mode } = await resolveEditMode(client, { tenantId, shiftId, userId })
    if (mode !== 'operator') {
      throw createError(400, 'La eliminación de cargas de MP solo está disponible para el operador con el turno activo.')
    }

    const { rows: orig } = await client.query(
      `SELECT * FROM shift_mp_loads WHERE id = $1 AND shift_id = $2`,
      [mpLoadId, shiftId]
    )
    if (!orig[0]) throw createError(404, 'Carga de MP no encontrada.')
    const originalValue = orig[0]
    assertDeletableByOperator(originalValue.loaded_at)

    // SaaS v2 §5f.1: si la carga tiene lote, refundar TODO el kg al lote
    // antes de borrar la fila. Movimiento compensatorio + reactivación
    // depleted→active si aplica.
    if (originalValue.lot_id) {
      const oldKg = parseFloat(originalValue.kg)
      await applyLotConsumptionDelta(client, {
        tenantId, mpLoadId, lotId: originalValue.lot_id, delta: -oldKg, userId,
        notes: `Eliminación de carga (refund ${oldKg} kg)`,
      })
    }

    await client.query(`DELETE FROM shift_mp_loads WHERE id = $1`, [mpLoadId])
    await client.query(
      `UPDATE production_shifts SET mp_real_kg = (
         SELECT COALESCE(SUM(kg),0) FROM shift_mp_loads WHERE shift_id = $1
       ) WHERE id = $1`,
      [shiftId]
    )

    return { deleted: true, mpLoadId }
  })
}

/** Listar correcciones de un turno (para ver historial). */
async function listCorrections({ tenantId, shiftId }) {
  const { rows } = await query(
    `SELECT sc.id, sc.target_type, sc.target_id, sc.action,
            sc.original_value, sc.new_value, sc.correction_reason,
            sc.corrected_at, sc.corrected_by,
            u.full_name AS corrected_by_name
     FROM shift_corrections sc
     LEFT JOIN users u ON u.id = sc.corrected_by
     WHERE sc.tenant_id = $1 AND sc.shift_id = $2
     ORDER BY sc.corrected_at DESC`,
    [tenantId, shiftId]
  )
  return rows
}

// ═══════════════════════════════════════════════════════════════════════════
//  AGREGAR registros (paquete/merma/incidencia) por el supervisor
//  Se usan en validación pre-cierre, cuando el operador olvidó capturar algo.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Agregar un paquete que el operador olvidó capturar.
 *   - Valida permiso supervisor + status pending_handover
 *   - Valida que la orden esté editable (no completed/cancelled)
 *   - Inserta en shift_progress, registra movimiento WIP, audita en shift_corrections
 *   - Si la orden estaba 'fulfilled', sigue 'fulfilled' (no se mueve a in_progress
 *     porque ya está al 100%+); si estaba 'in_progress' y este paquete la lleva
 *     al 100%, pasa a 'fulfilled'.
 */
async function addPackage({ tenantId, shiftId, productionOrderId, realWeightKg, isSecondQuality, quantityUnits, notes, reason, userId, qualityGradeId, gradeNumber }) {
  return withTransaction(async (client) => {
    await assertCorrectionPermission(client, { tenantId, shiftId, userId })

    if (!productionOrderId) throw createError(400, 'productionOrderId es obligatorio.')
    if (!realWeightKg || parseFloat(realWeightKg) <= 0) {
      throw createError(400, 'El peso debe ser mayor a 0.')
    }

    // Validar orden editable y obtener metadata
    const order = await assertOrderEditable(client, { orderId: productionOrderId })

    // Cargar product spec para calcular theoretical_weight_kg y quantity_units default
    const { rows: orderRows } = await client.query(
      `SELECT po.id, po.length_mm, po.product_id
       FROM production_orders po
       WHERE po.id = $1`,
      [productionOrderId]
    )
    if (!orderRows[0]) throw createError(404, 'Orden no encontrada.')

    const { rows: specRows } = await client.query(
      `SELECT grams_per_linear_meter, units_per_package
       FROM product_quality_specs
       WHERE product_id=$1 AND valid_until IS NULL
       ORDER BY valid_from DESC LIMIT 1`,
      [orderRows[0].product_id]
    )
    const gramsPerM   = parseFloat(specRows[0]?.grams_per_linear_meter || 0)
    const unitsPerPkg = parseInt(specRows[0]?.units_per_package || 0)
    const lengthMm    = parseInt(orderRows[0].length_mm || 0)
    const finalQty    = quantityUnits ? parseInt(quantityUnits) : unitsPerPkg
    // peso teórico: gramos/m × longitud(m) × piezas / 1000 = kg
    const theoreticalWeightKg = lengthMm > 0 && gramsPerM > 0 && finalQty > 0
      ? (gramsPerM * (lengthMm / 1000) * finalQty / 1000)
      : parseFloat(realWeightKg)  // fallback si no hay spec

    // Calcular siguiente microlot_number del turno
    const { rows: nextRows } = await client.query(
      `SELECT COALESCE(MAX(microlot_number), 0) + 1 AS next_num
       FROM shift_progress WHERE shift_id = $1`,
      [shiftId]
    )
    const microlotNumber = nextRows[0].next_num

    // §6f: resolver quality grade desde catálogo
    const { rows: pdef } = await client.query(
      `SELECT p.default_quality_grade_id
       FROM production_orders po
       JOIN products p ON p.id = po.product_id
       WHERE po.id = $1`,
      [productionOrderId]
    )
    const productDefaultGradeId = pdef[0]?.default_quality_grade_id || null
    const qualityGrade = await resolveQualityGrade(client, {
      tenantId,
      qualityGradeId,
      gradeNumber,
      productDefaultId: productDefaultGradeId,
      isSecondQuality,
    })
    const isSqDerived = qualityGrade.grade_number > 1

    // Insertar paquete
    const { rows: ins } = await client.query(
      `INSERT INTO shift_progress
         (shift_id, production_order_id, microlot_number, quantity_units,
          real_weight_kg, theoretical_weight_kg, is_second_quality, notes, quality_grade_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING *`,
      [shiftId, productionOrderId, microlotNumber, finalQty,
       parseFloat(realWeightKg), theoreticalWeightKg, isSqDerived, notes||null, qualityGrade.id]
    )
    const newPkg = ins[0]

    // SaaS v2 §5g: ramificar legacy vs lot-mode según tenant_process_config.
    const { rows: cfgRows } = await client.query(
      `SELECT uses_lots, product_lot_granularity, pt_goes_to_wip_first
       FROM tenant_process_config WHERE tenant_id = $1`,
      [tenantId]
    )
    const cfg = cfgRows[0] || { uses_lots: false, product_lot_granularity: 'per_shift', pt_goes_to_wip_first: true }

    if (cfg.uses_lots) {
      // Mismo flujo que capturePackage: product_lot + movement PT→WIP. La MP
      // ya salió en loadMp; nada que descontar aquí.
      const lotResult = await captureLotModeInventory(client, {
        tenantId,
        shift: { id: shiftId, shift_number: null, line_id: null },
        shiftProgressRow: newPkg,
        productionOrderId,
        granularity: cfg.product_lot_granularity,
        userId,
      })
      newPkg.lot_id = lotResult.productLotId
    } else {
      // Legacy: movimiento WIP via recordPackageCaptured
      try {
        const { rows: factorRows } = await client.query(
          `SELECT amount FROM production_cost_items
           WHERE tenant_id=$1 AND name='__scrap_factor__' AND is_active=true LIMIT 1`,
          [tenantId]
        )
        const scrapFactor = factorRows[0] ? parseFloat(factorRows[0].amount)/100 : 0.20

        const { rows: formRows } = await client.query(
          `SELECT json_agg(json_build_object(
             'raw_material_id', omf.raw_material_id,
             'percentage', omf.percentage,
             'cost_per_kg', r.cost_per_kg
           )) AS mp_formula
           FROM order_mp_formula omf
           JOIN raw_materials r ON r.id = omf.raw_material_id
           WHERE omf.production_order_id = $1 AND omf.valid_until IS NULL`,
          [productionOrderId]
        )
        if (formRows[0]?.mp_formula) {
          await recordPackageCaptured(client, {
            tenantId,
            pkg: newPkg,
            order: {
              id: orderRows[0].id,
              length_mm: orderRows[0].length_mm,
              product_id: orderRows[0].product_id,
              mp_formula: formRows[0].mp_formula,
            },
            scrapFactor,
            userId,
            ptGoesToWipFirst: cfg.pt_goes_to_wip_first !== false,
          })
        }
      } catch (invErr) {
        console.error('[inventory] Error generando movimiento WIP en addPackage:', invErr.stack || invErr)
      }
    }

    // Actualizar contador en el turno
    await client.query(
      `UPDATE production_shifts
       SET pt_units_produced = (
         SELECT COALESCE(SUM(quantity_units),0) FROM shift_progress
         WHERE shift_id=$1 AND is_second_quality=false
       )
       WHERE id=$1`,
      [shiftId]
    )

    // Si la orden estaba in_progress y llega al 100%, pasa a fulfilled
    if (order.status === 'in_progress') {
      const { rows: prog } = await client.query(
        `SELECT po.quantity_packages AS target,
                COALESCE(COUNT(sp.id) FILTER (WHERE sp.is_second_quality = false), 0) AS produced
         FROM production_orders po
         LEFT JOIN shift_progress sp ON sp.production_order_id = po.id
         WHERE po.id = $1
         GROUP BY po.id`,
        [productionOrderId]
      )
      if (prog[0]) {
        const target   = parseInt(prog[0].target || 0)
        const produced = parseInt(prog[0].produced || 0)
        if (target > 0 && produced >= target) {
          await client.query(
            `UPDATE production_orders SET status='fulfilled'
             WHERE id=$1 AND status='in_progress'`,
            [productionOrderId]
          )
        }
      }
    }

    // Bitácora
    await insertCorrection(client, {
      tenantId, shiftId,
      targetType: 'shift_progress', targetId: newPkg.id, action: 'create',
      originalValue: null, newValue: newPkg,
      reason, userId,
    })

    return newPkg
  })
}

/** Agregar una merma que el operador olvidó capturar. */
async function addScrap({ tenantId, shiftId, productionOrderId, scrapType, scrapTypeId, destination, kg, notes, reason, userId }) {
  return withTransaction(async (client) => {
    await assertCorrectionPermission(client, { tenantId, shiftId, userId })

    if (!productionOrderId) throw createError(400, 'productionOrderId es obligatorio.')
    if (!kg || parseFloat(kg) <= 0) throw createError(400, 'El peso de merma debe ser mayor a 0.')
    if (!scrapType && !scrapTypeId) throw createError(400, 'scrapType o scrapTypeId es obligatorio.')

    await assertOrderEditable(client, { orderId: productionOrderId })

    // SaaS v2 §6b: misma resolución que recordScrap.
    const catalog = await resolveScrapType(client, {
      tenantId,
      scrapTypeId,
      scrapTypeCode: scrapTypeId ? null : scrapType,
    })
    const legacyType = catalog ? legacyScrapTypeFor(catalog) : scrapType
    const mappedDest = destination && DESTINATION_LEGACY_MAP[destination]
      ? DESTINATION_LEGACY_MAP[destination]
      : destination
    const legacyDest = mappedDest || (catalog ? legacyDestinationFor(catalog) : null)
    const catalogId  = catalog ? catalog.id : null
    const recoveryPct = catalog ? parseFloat(catalog.default_recovery_value_pct) : null

    const evaluation = await evaluateAbnormal(client, {
      tenantId, shiftId, productionOrderId,
      candidateKg: kg,
    })

    const { rows: ins } = await client.query(
      `INSERT INTO shift_scrap
         (shift_id, scrap_type, destination, kg, notes, production_order_id,
          scrap_type_id, recovery_value_pct, is_abnormal)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [shiftId, legacyType, legacyDest, parseFloat(kg), notes||null, productionOrderId,
       catalogId, recoveryPct, evaluation.isAbnormal]
    )
    const newScrap = ins[0]

    // Registrar movimiento WIP al regrind (igual que en recordScrap normal)
    try {
      const { rows: formula } = await client.query(
        `SELECT omf.raw_material_id, omf.percentage, r.cost_per_kg, r.name AS material_name
         FROM order_mp_formula omf
         JOIN raw_materials r ON r.id = omf.raw_material_id
         WHERE omf.production_order_id = $1 AND omf.valid_until IS NULL
         ORDER BY omf.sort_order`,
        [productionOrderId]
      )
      if (formula.length > 0) {
        const { rows: shiftRows } = await client.query(
          `SELECT id, shift_number FROM production_shifts WHERE id = $1`, [shiftId]
        )
        const { rows: factorRows } = await client.query(
          `SELECT amount FROM production_cost_items
           WHERE tenant_id=$1 AND name='__scrap_factor__' AND is_active=true LIMIT 1`,
          [tenantId]
        )
        const reprocessFactor = factorRows[0] ? parseFloat(factorRows[0].amount)/100 : 0.20
        await recordScrapWipEntry(client, {
          tenantId, shift: shiftRows[0], scrapRecord: newScrap,
          mpFormula: formula, reprocessFactor, userId,
        })
      }
    } catch (invErr) {
      console.error('[inventory] Error generando movimiento WIP al regrind en addScrap:', invErr.stack || invErr)
    }

    await insertCorrection(client, {
      tenantId, shiftId,
      targetType: 'shift_scrap', targetId: newScrap.id, action: 'create',
      originalValue: null, newValue: newScrap,
      reason, userId,
    })

    return newScrap
  })
}

/** Agregar una incidencia que el operador olvidó capturar. */
async function addIncident({ tenantId, shiftId, category, description, durationMin, reason, userId }) {
  return withTransaction(async (client) => {
    await assertCorrectionPermission(client, { tenantId, shiftId, userId })

    if (!category)    throw createError(400, 'category es obligatorio.')
    if (!description) throw createError(400, 'description es obligatorio.')

    const { rows: ins } = await client.query(
      `INSERT INTO shift_incidents (shift_id, category, description, duration_min, reported_by)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [shiftId, category, description, durationMin ? parseInt(durationMin) : null, userId]
    )
    const newInc = ins[0]

    await insertCorrection(client, {
      tenantId, shiftId,
      targetType: 'shift_incidents', targetId: newInc.id, action: 'create',
      originalValue: null, newValue: newInc,
      reason, userId,
    })

    return newInc
  })
}

// ═══════════════════════════════════════════════════════════════════════════
//  CIERRE EXPLÍCITO DE ÓRDENES (por el supervisor / admin)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Cerrar una orden de producción.
 *   - Permitido en estados: 'in_progress', 'fulfilled' (también 'released' por flexibilidad)
 *   - Si la orden está incompleta (produced < target), razón obligatoria
 *   - Marca la orden como 'completed', registra closed_by_user_id, close_reason, close_was_partial
 *   - INMUTABLE desde este punto
 *
 * Permisos: solo supervisor o admin/super_admin.
 */
async function closeOrder({ tenantId, orderId, reason, userId, ipAddress, userAgent }) {
  let pushMeta = null
  const closed = await withTransaction(async (client) => {
    // 1. Cargar orden
    const { rows: orderRows } = await client.query(
      `SELECT po.id, po.status, po.order_number, po.quantity_packages AS target,
              COALESCE((SELECT COUNT(*) FROM shift_progress sp
                        WHERE sp.production_order_id = po.id AND sp.is_second_quality = false), 0) AS produced
       FROM production_orders po
       WHERE po.id = $1 AND po.tenant_id = $2`,
      [orderId, tenantId]
    )
    if (!orderRows[0]) throw createError(404, 'Orden no encontrada.')
    const order = orderRows[0]

    if (!['released', 'in_progress', 'fulfilled'].includes(order.status)) {
      throw createError(400, `No se puede cerrar una orden en estado '${order.status}'.`)
    }

    // 2. Verificar permisos (solo supervisor o admin/super_admin del tenant)
    const { rows: roleRows } = await client.query(
      `SELECT r.name FROM user_roles ur
       JOIN roles r ON r.id = ur.role_id
       WHERE ur.user_id = $1 AND r.name IN ('admin','super_admin')`,
      [userId]
    )
    const isAdmin = roleRows.length > 0

    if (!isAdmin) {
      // Debe ser supervisor de algún turno (no necesariamente activo) de esta orden
      const { rows: supRows } = await client.query(
        `SELECT id FROM production_shifts
         WHERE tenant_id = $1 AND supervisor_id = $2 AND production_order_id = $3
         LIMIT 1`,
        [tenantId, userId, orderId]
      )
      if (supRows.length === 0) {
        throw createError(403, 'Solo el supervisor de la orden o un admin pueden cerrarla.')
      }
    }

    // 3. Determinar si el cierre es parcial
    const target   = parseInt(order.target || 0)
    const produced = parseInt(order.produced || 0)
    const isPartial = target > 0 && produced < target

    // 4. Si es parcial, razón obligatoria
    if (isPartial && (!reason || !String(reason).trim())) {
      throw createError(400, `La orden está incompleta (${produced}/${target}). Razón obligatoria.`)
    }

    // 5. Marcar como completed
    const { rows: updated } = await client.query(
      `UPDATE production_orders
       SET status = 'completed',
           closed_by_user_id = $1,
           close_reason = $2,
           close_was_partial = $3,
           completed_at = NOW()
       WHERE id = $4
       RETURNING id, status, close_was_partial, close_reason, completed_at`,
      [userId, reason ? reason.trim() : null, isPartial, orderId]
    )

    // 6. Audit log
    await audit({
      tenantId, userId,
      action: 'production_order.closed',
      resource: 'production_orders',
      resourceId: orderId,
      payload: {
        orderNumber: order.order_number,
        target, produced,
        isPartial,
        reason: reason ? reason.trim() : null,
      },
      ipAddress, userAgent,
    })

    pushMeta = { produced, target, isPartial }
    return updated[0]
  })

  // Push best-effort post-commit: orden de producción completada → piso.
  pushEvents.productionOrderCompleted(tenantId, { orderId, ...(pushMeta || {}), actorUserId: userId })

  return closed
}

/** Reabrir una orden cerrada (solo admin, para casos excepcionales). */
async function reopenOrder({ tenantId, orderId, reason, userId, ipAddress, userAgent }) {
  return withTransaction(async (client) => {
    // Solo admin/super_admin
    const { rows: roleRows } = await client.query(
      `SELECT r.name FROM user_roles ur
       JOIN roles r ON r.id = ur.role_id
       WHERE ur.user_id = $1 AND r.name IN ('admin','super_admin')`,
      [userId]
    )
    if (roleRows.length === 0) {
      throw createError(403, 'Solo un admin puede reabrir una orden cerrada.')
    }

    if (!reason || !String(reason).trim()) {
      throw createError(400, 'La razón es obligatoria al reabrir una orden.')
    }

    const { rows: orderRows } = await client.query(
      `SELECT id, status, order_number, quantity_packages AS target,
              COALESCE((SELECT COUNT(*) FROM shift_progress sp
                        WHERE sp.production_order_id = production_orders.id AND sp.is_second_quality = false), 0) AS produced
       FROM production_orders
       WHERE id = $1 AND tenant_id = $2`,
      [orderId, tenantId]
    )
    if (!orderRows[0]) throw createError(404, 'Orden no encontrada.')
    if (orderRows[0].status !== 'completed') {
      throw createError(400, `Solo se pueden reabrir órdenes en estado 'completed'. Estado actual: ${orderRows[0].status}.`)
    }

    const produced = parseInt(orderRows[0].produced || 0)
    const target   = parseInt(orderRows[0].target || 0)
    const newStatus = (target > 0 && produced >= target) ? 'fulfilled' : 'in_progress'

    await client.query(
      `UPDATE production_orders
       SET status = $1, closed_by_user_id = NULL, close_reason = NULL, close_was_partial = false,
           completed_at = NULL
       WHERE id = $2`,
      [newStatus, orderId]
    )

    await audit({
      tenantId, userId,
      action: 'production_order.reopened',
      resource: 'production_orders',
      resourceId: orderId,
      payload: {
        orderNumber: orderRows[0].order_number,
        reason: reason.trim(),
        newStatus,
      },
      ipAddress, userAgent,
    })

    return { id: orderId, status: newStatus }
  })
}

/**
 * Cambiar la fórmula MP vigente de una orden durante la producción.
 *
 * - Cierra la versión anterior (UPDATE valid_until = NOW())
 * - Inserta la nueva versión (valid_from = NOW(), valid_until = NULL)
 * - Audit log con la razón del cambio
 *
 * Reglas:
 *   - Solo el supervisor del turno activo asignado a esta orden, O admin/super_admin.
 *   - La orden debe estar en 'released' o 'in_progress'.
 *   - La nueva fórmula debe sumar 100% y tener al menos 1 material.
 *
 * Los paquetes y la merma capturados antes de NOW() quedan asociados (por
 * captured_at) a la fórmula vieja; los capturados después, a la nueva.
 */
async function changeOrderFormula({ tenantId, orderId, newFormula, reason, userId, ipAddress, userAgent }) {
  if (!reason || !String(reason).trim()) {
    throw createError(400, 'La razón del cambio de fórmula es obligatoria.')
  }
  if (!Array.isArray(newFormula) || newFormula.length === 0) {
    throw createError(400, 'La nueva fórmula debe tener al menos un material.')
  }
  const totalPct = newFormula.reduce((s, f) => s + parseFloat(f.percentage || 0), 0)
  if (Math.abs(totalPct - 100) > 0.01) {
    throw createError(400, `La fórmula debe sumar 100% (suma actual: ${totalPct.toFixed(2)}%).`)
  }
  for (const f of newFormula) {
    if (!f.rawMaterialId) throw createError(400, 'Cada material requiere rawMaterialId.')
    const pct = parseFloat(f.percentage)
    if (!(pct > 0 && pct <= 100)) throw createError(400, `Porcentaje inválido: ${f.percentage}.`)
  }

  return withTransaction(async (client) => {
    // 1. Verificar que la orden existe y está en estado correcto
    const { rows: orderRows } = await client.query(
      `SELECT id, status, order_number FROM production_orders
       WHERE id = $1 AND tenant_id = $2`,
      [orderId, tenantId]
    )
    if (!orderRows[0]) throw createError(404, 'Orden no encontrada.')
    const order = orderRows[0]
    if (!['released', 'in_progress', 'fulfilled'].includes(order.status)) {
      throw createError(400, `No se puede cambiar la fórmula en estado '${order.status}'. Solo en 'released', 'in_progress' o 'fulfilled'.`)
    }

    // 2. Verificar permiso: supervisor de turno activo de la orden, o admin/super_admin
    const { rows: roleRows } = await client.query(
      `SELECT r.name FROM user_roles ur
       JOIN roles r ON r.id = ur.role_id
       WHERE ur.user_id = $1 AND r.name IN ('admin','super_admin')`,
      [userId]
    )
    const isAdmin = roleRows.length > 0

    if (!isAdmin) {
      // Verificar que el usuario es supervisor U OPERADOR de un turno activo
      // de esta orden. Permitimos al operador porque en turnos nocturnos
      // puede no haber supervisor disponible y debe poder ajustar fórmula
      // (con razón obligatoria para auditoría).
      const { rows: shiftRows } = await client.query(
        `SELECT id, operator_id, supervisor_id FROM production_shifts
         WHERE tenant_id = $1
           AND (supervisor_id = $2 OR operator_id = $2)
           AND status = 'active'
           AND production_order_id = $3
         LIMIT 1`,
        [tenantId, userId, orderId]
      )
      if (shiftRows.length === 0) {
        throw createError(403, 'Solo el operador o supervisor del turno activo, o un admin, pueden cambiar la fórmula.')
      }
    }

    // 3. Snapshot de la fórmula vigente actual (para audit)
    const { rows: originalFormula } = await client.query(
      `SELECT omf.raw_material_id, omf.percentage, omf.sort_order,
              r.name AS material_name
       FROM order_mp_formula omf
       JOIN raw_materials r ON r.id = omf.raw_material_id
       WHERE omf.production_order_id = $1
         AND omf.valid_until IS NULL
       ORDER BY omf.sort_order`,
      [orderId]
    )

    // 4. Cerrar la versión vigente (UPDATE valid_until = NOW())
    const changeTimestamp = await client.query(`SELECT NOW() AS now`)
    const now = changeTimestamp.rows[0].now

    await client.query(
      `UPDATE order_mp_formula
       SET valid_until = $1
       WHERE production_order_id = $2 AND valid_until IS NULL`,
      [now, orderId]
    )

    // 5. Insertar la nueva versión
    const insertedRows = []
    for (let i = 0; i < newFormula.length; i++) {
      const f = newFormula[i]
      const { rows: ins } = await client.query(
        `INSERT INTO order_mp_formula
          (production_order_id, raw_material_id, percentage, sort_order, valid_from, valid_until)
         VALUES ($1, $2, $3, $4, $5, NULL)
         RETURNING *`,
        [orderId, f.rawMaterialId, parseFloat(f.percentage), i, now]
      )
      insertedRows.push(ins[0])
    }

    // 6. Recalcular blended_cost_per_kg con la nueva fórmula
    const materialIds = newFormula.map(f => f.rawMaterialId)
    const { rows: costRows } = await client.query(
      `SELECT id, cost_per_kg FROM raw_materials WHERE id = ANY($1::uuid[])`,
      [materialIds]
    )
    const costMap = Object.fromEntries(costRows.map(r => [r.id, parseFloat(r.cost_per_kg || 0)]))
    const blendedCost = newFormula.reduce((s, f) =>
      s + (parseFloat(f.percentage) / 100) * (costMap[f.rawMaterialId] || 0), 0
    )
    await client.query(
      `UPDATE production_orders SET blended_cost_per_kg = $1 WHERE id = $2`,
      [blendedCost.toFixed(6), orderId]
    )

    // 7. Cargar nombres de materiales para devolver/auditar
    const { rows: newFormulaFull } = await client.query(
      `SELECT omf.raw_material_id, omf.percentage, omf.sort_order,
              r.name AS material_name, r.cost_per_kg
       FROM order_mp_formula omf
       JOIN raw_materials r ON r.id = omf.raw_material_id
       WHERE omf.production_order_id = $1 AND omf.valid_until IS NULL
       ORDER BY omf.sort_order`,
      [orderId]
    )

    // 8. Audit log
    await audit({
      tenantId, userId,
      action: 'order_mp_formula.changed',
      resource: 'production_orders',
      resourceId: orderId,
      payload: {
        orderNumber: order.order_number,
        reason: reason.trim(),
        originalFormula: originalFormula.map(f => ({
          material: f.material_name,
          percentage: parseFloat(f.percentage),
        })),
        newFormula: newFormulaFull.map(f => ({
          material: f.material_name,
          percentage: parseFloat(f.percentage),
        })),
        newBlendedCostPerKg: parseFloat(blendedCost.toFixed(6)),
        changedAt: now,
      },
      ipAddress, userAgent,
    })

    return {
      orderId,
      changedAt: now,
      newFormula: newFormulaFull,
      blendedCostPerKg: parseFloat(blendedCost.toFixed(6)),
      reason: reason.trim(),
    }
  })
}

/**
 * Listar el historial completo de versiones de la fórmula MP de una orden.
 * Útil para el supervisor: ver cuándo cambió, qué fue, quién lo hizo (vía audit_logs).
 */
async function getOrderFormulaHistory({ tenantId, orderId }) {
  // Verificar orden pertenece al tenant
  const { rows: o } = await query(
    `SELECT id FROM production_orders WHERE id = $1 AND tenant_id = $2`,
    [orderId, tenantId]
  )
  if (!o[0]) throw createError(404, 'Orden no encontrada.')

  // Agrupar por (valid_from, valid_until) y traer materiales de cada versión
  const { rows: versions } = await query(
    `SELECT omf.valid_from, omf.valid_until,
            json_agg(json_build_object(
              'rawMaterialId', omf.raw_material_id,
              'percentage',    omf.percentage,
              'sortOrder',     omf.sort_order,
              'materialName',  r.name,
              'costPerKg',     r.cost_per_kg
            ) ORDER BY omf.sort_order) AS materials
     FROM order_mp_formula omf
     JOIN raw_materials r ON r.id = omf.raw_material_id
     WHERE omf.production_order_id = $1
     GROUP BY omf.valid_from, omf.valid_until
     ORDER BY omf.valid_from DESC`,
    [orderId]
  )

  // También traer los cambios desde audit_logs (con razón y usuario)
  const { rows: changes } = await query(
    `SELECT al.created_at, al.payload, u.full_name AS changed_by_name
     FROM audit_logs al
     LEFT JOIN users u ON u.id = al.user_id
     WHERE al.tenant_id = $1
       AND al.resource = 'production_orders'
       AND al.resource_id = $2
       AND al.action = 'order_mp_formula.changed'
     ORDER BY al.created_at DESC`,
    [tenantId, orderId]
  )

  return {
    versions: versions.map(v => ({
      validFrom:   v.valid_from,
      validUntil:  v.valid_until,
      isCurrent:   v.valid_until === null,
      materials:   v.materials,
    })),
    changes: changes.map(c => ({
      changedAt:    c.created_at,
      changedBy:    c.changed_by_name,
      reason:       c.payload?.reason || '',
      originalForm: c.payload?.originalFormula || [],
      newForm:      c.payload?.newFormula || [],
    })),
  }
}

/**
 * Devuelve el resumen del turno saliente que le corresponde al shift entrante.
 * El entrante se identifica por `incomingShiftId`.
 * El saliente es aquel cuyo `handover_waiting_shift_id` = incomingShiftId.
 *
 * Lanza 404 si no hay saliente.
 * Lanza 409 si el saliente aún está en `active` (no ha cerrado todavía).
 */
async function getHandoverSummary({ tenantId, incomingShiftId, userId }) {
  // 1. Verificar que el incoming pertenece al tenant y al usuario
  const { rows: inc } = await query(
    `SELECT id, operator_id, status FROM production_shifts
     WHERE id = $1 AND tenant_id = $2`,
    [incomingShiftId, tenantId]
  )
  if (!inc[0]) throw createError(404, 'Turno entrante no encontrado.')
  if (inc[0].operator_id !== userId) {
    throw createError(403, 'Solo el operador del turno entrante puede ver este resumen.')
  }
  if (inc[0].status !== 'pending_handover') {
    throw createError(400, 'Este turno ya está activo o no requiere recepción.')
  }

  // 2. Buscar el shift saliente (apunta al entrante)
  const { rows: out } = await query(
    `SELECT ps.id, ps.shift_number, ps.status, ps.started_at, ps.closed_at,
            ps.mp_real_kg, ps.pt_units_produced, ps.scrap_estimated_kg,
            ps.production_order_id,
            u.full_name AS operator_name
     FROM production_shifts ps
     JOIN users u ON u.id = ps.operator_id
     WHERE ps.handover_waiting_shift_id = $1 AND ps.tenant_id = $2`,
    [incomingShiftId, tenantId]
  )
  if (!out[0]) throw createError(404, 'No hay turno saliente asociado.')

  const outgoing = out[0]

  // 3. Si el saliente todavía está activo, no se puede recibir aún
  if (outgoing.status === 'active') {
    return {
      outgoing_status: 'active',
      outgoing_operator_name: outgoing.operator_name,
      message: 'El turno saliente aún no ha cerrado.',
    }
  }

  // 4. Calcular duración legible
  let durationText = '—'
  if (outgoing.started_at && outgoing.closed_at) {
    const ms = new Date(outgoing.closed_at) - new Date(outgoing.started_at)
    const totalMin = Math.floor(ms / 60000)
    const h = Math.floor(totalMin / 60)
    const m = totalMin % 60
    durationText = `${h}h ${m}min`
  }

  // 5. Contar paquetes y desviaciones
  const { rows: pkgStats } = await query(
    `SELECT COUNT(*)::int AS packages_count,
            COUNT(*) FILTER (WHERE weight_ok = FALSE)::int AS deviation_count
     FROM shift_progress
     WHERE shift_id = $1`,
    [outgoing.id]
  )

  // 6. Información de la orden activa (si existe)
  let activeOrder = null
  if (outgoing.production_order_id) {
    const { rows: ord } = await query(
      `SELECT po.id, po.order_number,
              p.sku  AS product_code,
              p.name AS product_name,
              po.quantity_units AS units_target,
              COALESCE(SUM(sp.quantity_units) FILTER (WHERE sp.is_second_quality = false), 0)::int AS units_produced
       FROM production_orders po
       JOIN products p ON p.id = po.product_id
       LEFT JOIN shift_progress sp ON sp.production_order_id = po.id
       WHERE po.id = $1 AND po.tenant_id = $2
       GROUP BY po.id, p.sku, p.name`,
      [outgoing.production_order_id, tenantId]
    )
    if (ord[0]) {
      const target = Number(ord[0].units_target) || 0
      const produced = Number(ord[0].units_produced) || 0
   activeOrder = {
        order_id: ord[0].id,
        order_number: ord[0].order_number,
        product_code: ord[0].product_code,
        product_name: ord[0].product_name,
        units_target: target,
        units_produced: produced,
        progress_pct: target > 0 ? (produced / target) * 100 : 0,
      }
    }
  }

 // MP consumida en vivo: paquetes (1ª+2ª) + scrap. El campo mp_real_kg
  // en production_shifts no se está actualizando (deuda técnica conocida).
  const { rows: mpRows } = await query(
    `SELECT
       COALESCE((SELECT SUM(real_weight_kg) FROM shift_progress WHERE shift_id = $1), 0) AS mp_packages_kg,
       COALESCE((SELECT SUM(kg)             FROM shift_scrap    WHERE shift_id = $1), 0) AS mp_scrap_kg`,
    [outgoing.id]
  )
  const mpPackagesKg = parseFloat(mpRows[0].mp_packages_kg)
  const mpScrapKg    = parseFloat(mpRows[0].mp_scrap_kg)

  return {
    outgoing_shift_id: outgoing.id,
    outgoing_shift_number: outgoing.shift_number,
    outgoing_operator_name: outgoing.operator_name,
    outgoing_status: outgoing.status,
    duration_text: durationText,
    packages_count: pkgStats[0].packages_count,
    deviation_count: pkgStats[0].deviation_count,
    units_produced: outgoing.pt_units_produced,
    mp_consumed_kg: mpPackagesKg + mpScrapKg,
    scrap_kg: mpScrapKg,
    active_order: activeOrder,
  }
}

/**
 * El operador entrante acepta la recepción (con o sin observaciones).
 * Activa su turno y registra la entrada en shift_receptions.
 *
 * Body:
 *   accepted: boolean (requerido)
 *   issue_description: string (requerido si accepted=false, mínimo 20 chars)
 */
async function acceptHandover({
  tenantId, incomingShiftId, userId, accepted, issueDescription,
  ipAddress, userAgent
}) {
  // Validaciones tempranas
  if (typeof accepted !== 'boolean') {
    throw createError(400, 'El campo "accepted" es requerido.')
  }
  if (!accepted) {
    const desc = (issueDescription || '').trim()
    if (desc.length < 20) {
      throw createError(400, 'La descripción de observaciones debe tener al menos 20 caracteres.')
    }
  }

  return withTransaction(async (client) => {
    // 1. Validar que el incoming es del usuario, del tenant, y está en pending_handover
    const { rows: inc } = await client.query(
      `SELECT id, operator_id, status FROM production_shifts
       WHERE id = $1 AND tenant_id = $2`,
      [incomingShiftId, tenantId]
    )
    if (!inc[0]) throw createError(404, 'Turno entrante no encontrado.')
    // Si el turno entrante tiene un responsable designado, solo ese puede
    // recibir. Sin designado → fallback a cualquier miembro con can_handover.
    const designated = await getHandoverResponsibleUserId({ shiftId: incomingShiftId, client })
    if (designated) {
      if (designated !== userId) {
        throw createError(403, 'Este turno entrante tiene un responsable designado de la recepción. Solo esa persona puede recibirlo.')
      }
    } else if (!(await userCanActOnShift({ shiftId: incomingShiftId, userId, capability: 'handover', client }))) {
      throw createError(403, 'Solo los miembros del turno entrante con permiso de handover pueden recibirlo.')
    }
    if (inc[0].status !== 'pending_handover') {
      throw createError(409, 'Este turno ya no está en estado de recepción.')
    }

    // 2. Buscar el shift saliente y validar que ya cerró
    const { rows: out } = await client.query(
      `SELECT id, status, production_order_id FROM production_shifts
       WHERE handover_waiting_shift_id = $1 AND tenant_id = $2`,
      [incomingShiftId, tenantId]
    )
    if (!out[0]) throw createError(404, 'No hay turno saliente asociado.')
    if (out[0].status === 'active') {
      throw createError(409, 'El turno saliente aún no ha cerrado.')
    }

    // 3. Verificar que no exista ya una recepción para este incoming
    const { rows: existing } = await client.query(
      `SELECT id FROM shift_receptions WHERE incoming_shift_id = $1`,
      [incomingShiftId]
    )
    if (existing[0]) {
      throw createError(409, 'Esta recepción ya fue registrada.')
    }

    // 4. Insertar recepción
    await client.query(
      `INSERT INTO shift_receptions
        (tenant_id, outgoing_shift_id, incoming_shift_id, accepted, issue_description, received_by)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [tenantId, out[0].id, incomingShiftId, accepted,
       accepted ? null : (issueDescription || '').trim(), userId]
    )

    // 5. Activar el shift entrante y heredar la orden activa
    const { rows: activated } = await client.query(
      `UPDATE production_shifts
       SET status = 'active',
           started_at = NOW(),
           production_order_id = COALESCE(production_order_id, $2)
       WHERE id = $1
       RETURNING *`,
      [incomingShiftId, out[0].production_order_id]
    )

    await audit({
      tenantId, userId,
      action: accepted ? 'shift.handover_accepted' : 'shift.handover_with_issues',
      resource: 'production_shifts',
      resourceId: incomingShiftId,
      payload: {
        outgoing_shift_id: out[0].id,
        accepted,
        issue_description: accepted ? null : (issueDescription || '').trim(),
      },
      ipAddress, userAgent,
    })

    return activated[0]
  })
}

/**
 * Resumen del turno recién cerrado, para mostrárselo al operador.
 * Se accede cuando production_shift está en `pending_handover` o `reviewed`.
 * Solo el operador del turno (o un supervisor) puede consultarlo.
 *
 * MP calculada en vivo (paquetes + scrap), no depende de mp_real_kg.
 */
async function getClosedShiftSummary({ tenantId, shiftId, userId }) {
  // 1. Cargar el shift + nombre del operador
  const { rows: shifts } = await query(
    `SELECT ps.id, ps.shift_number, ps.shift_date, ps.line_id,
            ps.operator_id, ps.supervisor_id, ps.status,
            ps.started_at, ps.closed_at, ps.production_order_id,
            ps.pt_units_produced,
            u.full_name AS operator_name
     FROM production_shifts ps
     JOIN users u ON u.id = ps.operator_id
     WHERE ps.id = $1 AND ps.tenant_id = $2`,
    [shiftId, tenantId]
  )
  if (!shifts[0]) throw createError(404, 'Turno no encontrado.')

  const shift = shifts[0]

  // Validación de permisos: el operador o el supervisor del turno
  if (shift.operator_id !== userId && shift.supervisor_id !== userId) {
    throw createError(403, 'No tienes permiso para ver este resumen.')
  }

  // Solo turnos cerrados (esperando validación o ya validados)
  if (!['pending_handover', 'reviewed'].includes(shift.status)) {
    throw createError(400, 'Este turno aún no está cerrado.')
  }

  // 2. Duración legible
  let durationText = '—'
  if (shift.started_at && shift.closed_at) {
    const ms = new Date(shift.closed_at) - new Date(shift.started_at)
    const totalMin = Math.max(0, Math.floor(ms / 60000))
    const h = Math.floor(totalMin / 60)
    const m = totalMin % 60
    durationText = h > 0 ? `${h}h ${m}min` : `${m}min`
  }

  // 3. Conteo de paquetes 1ª/2ª y suma de pesos
  const { rows: pkgRows } = await query(
    `SELECT
       COUNT(*)::int                                                AS packages_total,
       COUNT(*) FILTER (WHERE is_second_quality = false)::int       AS packages_first,
       COUNT(*) FILTER (WHERE is_second_quality = true)::int        AS packages_second,
       COALESCE(SUM(real_weight_kg), 0)                             AS mp_packages_kg
     FROM shift_progress
     WHERE shift_id = $1`,
    [shiftId]
  )
  const pkg = pkgRows[0]

  // 4. Scrap (todos los tipos)
  const { rows: scrapRows } = await query(
    `SELECT COALESCE(SUM(kg), 0) AS mp_scrap_kg
     FROM shift_scrap
     WHERE shift_id = $1`,
    [shiftId]
  )
  const mpScrapKg = parseFloat(scrapRows[0].mp_scrap_kg)
  const mpPackagesKg = parseFloat(pkg.mp_packages_kg)

  // 5. Incidentes agrupados por categoría
  const CATEGORY_LABELS = {
    paro_maquina:     'Paro de máquina',
    falla_calidad:    'Falla de calidad',
    falla_material:   'Falla de material',
    cambio_molde:     'Cambio de molde',
    mantenimiento:    'Mantenimiento',
    otro:             'Otro',
  }
  const { rows: incRows } = await query(
    `SELECT category,
            COUNT(*)::int                       AS count,
            COALESCE(SUM(duration_min), 0)::int AS total_minutes
     FROM shift_incidents
     WHERE shift_id = $1
     GROUP BY category
     ORDER BY total_minutes DESC, count DESC`,
    [shiftId]
  )
  const incidentsByCategory = incRows.map(r => ({
    category: r.category,
    category_label: CATEGORY_LABELS[r.category] || r.category,
    count: r.count,
    total_minutes: r.total_minutes,
  }))

  // 6. Orden activa al cerrar (si tenía)
  let activeOrder = null
  if (shift.production_order_id) {
    const { rows: ord } = await query(
      `SELECT po.id, po.order_number,
              p.sku  AS product_code,
              p.name AS product_name,
              po.quantity_units AS units_target,
              COALESCE(SUM(sp.quantity_units) FILTER (WHERE sp.is_second_quality = false), 0)::int AS units_produced
       FROM production_orders po
       JOIN products p ON p.id = po.product_id
       LEFT JOIN shift_progress sp ON sp.production_order_id = po.id
       WHERE po.id = $1 AND po.tenant_id = $2
       GROUP BY po.id, p.sku, p.name`,
      [shift.production_order_id, tenantId]
    )
    if (ord[0]) {
      const target = Number(ord[0].units_target) || 0
      const produced = Number(ord[0].units_produced) || 0
      activeOrder = {
        order_id: ord[0].id,
        order_number: ord[0].order_number,
        product_code: ord[0].product_code,
        product_name: ord[0].product_name,
        units_target: target,
        units_produced: produced,
        progress_pct: target > 0 ? (produced / target) * 100 : 0,
      }
    }
  }

  // 7. Fecha legible
  let shiftDateFormatted = null
  try {
    const d = new Date(shift.shift_date)
    shiftDateFormatted = d.toLocaleDateString('es-MX', {
      weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
    })
  } catch (_) { /* fallback */ }

  return {
    shift_id: shift.id,
    operator_name: shift.operator_name,
    shift_number: shift.shift_number,
    shift_date: shift.shift_date,
    shift_date_formatted: shiftDateFormatted,
    line_id: shift.line_id,
    status: shift.status,
    started_at: shift.started_at,
    closed_at: shift.closed_at,
    duration_text: durationText,

    packages_total:  pkg.packages_total,
    packages_first:  pkg.packages_first,
    packages_second: pkg.packages_second,
    units_produced:  parseInt(shift.pt_units_produced || 0),

    mp_packages_kg: mpPackagesKg,
    mp_scrap_kg:    mpScrapKg,
    mp_total_kg:    mpPackagesKg + mpScrapKg,

    incidents_by_category: incidentsByCategory,
    active_order: activeOrder,
  }
}

async function closeShift({ tenantId, shiftId, userId, ipAddress, userAgent, skipAuth = false }) {
  // Verificar que el usuario es el operador asignado o el supervisor
  const { rows: check } = await query(
    `SELECT id, operator_id, supervisor_id FROM production_shifts
     WHERE id=$1 AND tenant_id=$2 AND status='active'`,
    [shiftId, tenantId]
  )
  if (!check[0]) throw createError(400, 'El turno no está activo.')
  // skipAuth lo usa SOLO la herramienta admin de recálculo de costo (re-cierre
  // tras revertir): el turno ya fue cerrado/validado antes por quien correspondía.
  if (!skipAuth) {
    // Si el turno tiene un responsable de handover designado, solo ese puede
    // cerrar (firmar la entrega). Sin designado → fallback a cualquier miembro
    // con can_validate (comportamiento previo).
    const designatedHandover = await getHandoverResponsibleUserId({ shiftId })
    if (designatedHandover) {
      if (designatedHandover !== userId) {
        throw createError(403, 'Este turno tiene un responsable designado de la entrega. Solo esa persona puede cerrarlo.')
      }
    } else if (!(await userCanActOnShift({ shiftId, userId, capability: 'validate' }))) {
      throw createError(403, 'Solo los miembros del turno con permiso de validación pueden cerrarlo.')
    }
  }

  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `UPDATE production_shifts SET status='pending_handover', closed_at=NOW()
       WHERE id=$1 AND tenant_id=$2 AND status='active' RETURNING *`,
      [shiftId, tenantId]
    )
    if (!rows[0]) throw createError(400, 'El turno no está activo.')

    // NOTA: ya no se activa al entrante aquí.
    // El entrante decide activar su turno mediante la pantalla de recepción
    // (endpoint POST /shifts/:id/accept-handover).
    const closedShift = rows[0]

    // SaaS v2 §5g: si el tenant usa lotes, generar lot_consumption distribuyendo
    // raw_material_lots consumidos en el turno entre los product_lots producidos.
    // Idempotente (DELETE + INSERT). No bloquea el cierre si no hay datos que
    // distribuir (caso típico: turno sin captura ni carga con lote).
    const { rows: cfgRows } = await client.query(
      `SELECT uses_lots FROM tenant_process_config WHERE tenant_id = $1`,
      [tenantId]
    )
    if (cfgRows[0]?.uses_lots) {
      const dist = await distributeRawMaterialLotsToProductLots(client, { tenantId, shiftId })
      if (dist.skipped) {
        console.warn(`[closeShift] lot_consumption skipped: ${dist.skipped} (shift ${shiftId})`)
      }
      // SaaS v2 §5h: validar alérgenos. Si lanza, la transacción rueda atrás y
      // el shift NO queda pending_handover — comportamiento correcto para modo
      // strict / priority_only.
      await validateAllergenConsistency(client, { tenantId, shiftId })
    }

    await audit({ tenantId, userId, action:'shift.closed', resource:'production_shifts',
      resourceId: shiftId, payload:{}, ipAddress, userAgent })
    return closedShift
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// SaaS v2 §Fase3: se re-exporta closeShift con hook de overhead.
// El wrapper captura el resultado de la transacción y aplica overhead
// FUERA de la transacción para que nunca bloquee el cierre del turno.
// ─────────────────────────────────────────────────────────────────────────────
const _closeShiftCore = closeShift

async function closeShiftWithOverhead({ tenantId, shiftId, userId, ipAddress, userAgent, skipAuth = false }) {
  const closedShift = await _closeShiftCore({ tenantId, shiftId, userId, ipAddress, userAgent, skipAuth })

  // SaaS v2: apply overhead from tenant_overhead_periods
  try {
    const { applyOverheadToShift } = require('../overhead-costing/overheadApplicationService')
    await applyOverheadToShift(shiftId, tenantId, {
      startedAt:        closedShift.started_at,
      endedAt:          closedShift.closed_at || new Date(),
      totalKgProduced:  parseFloat(closedShift.mp_real_kg     || 0),
      totalUnitsProduced: parseInt(closedShift.pt_units_produced || 0),
    })
  } catch (err) {
    console.warn('[overhead] applyOverheadToShift failed gracefully:', err.message)
    // Never block shift close due to overhead failure
  }

  return closedShift
}

// ──────────────────────────────────────────────────────────────────────────
// Forzar el cierre / finalización de un turno atorado.
//
// Permiso: production:update (supervisor) O production:force_close (admin) — la
// verificación de rol se hace en el middleware del endpoint, NO se exige ser el
// supervisor del turno (mig 200, pedido 2026-06-09).
//
// Acepta turnos en `active` Y `pending_handover`:
//   - active           → lo cierra (force_closed) como antes.
//   - pending_handover → turno ya cerrado pero atorado en el tablero (cerró bien
//                        pero nadie lo validó). Solo registra quién forzó.
//
// Después del cierre, si NADIE toma el relevo (no hay un entrante esperando), el
// turno se FINALIZA validándolo (validateShift approved=true): registra
// inventario + costos → status 'reviewed' → sale del tablero y libera la línea.
// Si hay relevo esperando, se activa al entrante y el saliente queda en cola de
// validación (comportamiento de relevo original, intacto).
//
// La finalización corre FUERA de la transacción de cierre (igual que el overhead
// en closeShiftWithOverhead): validateShift abre su propia transacción y nunca
// debe anidarse. Si la validación falla (turno con datos incompletos), el cierre
// NO se revierte — el turno queda en pending_handover para validarse a mano.
// ──────────────────────────────────────────────────────────────────────────
async function forceCloseShift({ tenantId, shiftId, reason, userId, ipAddress, userAgent }) {
  const phase1 = await withTransaction(async (client) => {
    const { rows: shiftRows } = await client.query(
      `SELECT ps.*, u.full_name AS operator_name
       FROM production_shifts ps
       JOIN users u ON u.id = ps.operator_id
       WHERE ps.id = $1 AND ps.tenant_id = $2 AND ps.status IN ('active','pending_handover')`,
      [shiftId, tenantId]
    )
    if (!shiftRows[0]) throw createError(404, 'Turno no encontrado o ya no está en curso.')

    const shift = shiftRows[0]

    // Espera de 5 min SOLO cuando hay un relevo esperando (handover_requested_at):
    // protege el relevo cortés. Para un turno atorado sin relevo no aplica.
    if (shift.status === 'active' && shift.handover_requested_at) {
      const minsPassed = (Date.now() - new Date(shift.handover_requested_at).getTime()) / 60000
      if (minsPassed < 5) {
        const remaining = Math.ceil(5 - minsPassed)
        throw createError(400, `Debes esperar ${remaining} min más antes de forzar el cierre.`)
      }
    }

    let closedRow
    if (shift.status === 'active') {
      const { rows } = await client.query(
        `UPDATE production_shifts
         SET status = 'pending_handover',
             closed_at = NOW(),
             force_closed_by = $1,
             force_close_reason = $2,
             force_closed_at = NOW()
         WHERE id = $3 RETURNING *`,
        [userId, reason || null, shiftId]
      )
      closedRow = rows[0]
    } else {
      // Ya estaba pending_handover (cerrado pero atorado): NO tocar closed_at;
      // solo dejar constancia de quién forzó (sin pisar un force-close previo).
      const { rows } = await client.query(
        `UPDATE production_shifts
         SET force_closed_by    = $1,
             force_close_reason = COALESCE(force_close_reason, $2),
             force_closed_at    = COALESCE(force_closed_at, NOW())
         WHERE id = $3 RETURNING *`,
        [userId, reason || null, shiftId]
      )
      closedRow = rows[0]
    }

    // Activar el turno entrante asociado al saliente que se está force-cerrando.
    // El entrante es exactamente el shift apuntado por handover_waiting_shift_id
    // del saliente (no es "cualquier shift en pending_handover").
    //
    // Bug histórico (corregido 2026-05-13 sesión 5): la versión anterior buscaba
    // shifts con handover_waiting_shift_id IS NOT NULL, lo cual filtraba a los
    // SALIENTES cerrados (ellos son los que apuntan a un entrante), no a los
    // entrantes esperando. Resultado: se podía reactivar un saliente cerrado
    // por error en cascada.
    let activatedShift = null
    if (shift.handover_waiting_shift_id) {
      const { rows: activated } = await client.query(
        `UPDATE production_shifts
         SET status = 'active', started_at = NOW()
         WHERE id = $1
           AND tenant_id = $2
           AND status = 'pending_handover'
           AND closed_at IS NULL
         RETURNING *`,
        [shift.handover_waiting_shift_id, tenantId]
      )
      activatedShift = activated[0] || null
    }

    await audit({
      tenantId, userId,
      action: 'shift.force_closed',
      resource: 'production_shifts',
      resourceId: shiftId,
      payload: { reason, operatorName: shift.operator_name, prevStatus: shift.status, activatedShift: activatedShift?.id },
      ipAddress, userAgent,
    })

    return { shift, closedRow, activatedShift }
  })

  // Si NADIE tomó el relevo, finalizar el turno para que salga del tablero y
  // libere la línea. validateShift corre su propia transacción → fuera de la de
  // arriba. Best-effort: si falla (datos incompletos), el turno queda cerrado
  // (pending_handover) para validarse a mano; no revertimos el cierre.
  let finalized = false
  if (!phase1.activatedShift) {
    try {
      await validateShift({
        tenantId,
        shiftId,
        approved: true,
        supervisorNotes: `Finalizado por cierre forzado (admin).${reason ? ' Motivo: ' + reason : ''}`,
        userId, ipAddress, userAgent,
      })
      finalized = true
    } catch (err) {
      console.warn(`[forceClose] finalización (validateShift) falló; turno ${shiftId} queda pending_handover:`, err.message)
    }
  }

  return {
    closed: phase1.closedRow,
    activated_shift_id: phase1.activatedShift?.id || null,
    finalized,
    operator_name: phase1.shift.operator_name,
  }
}


// ──────────────────────────────────────────────────────────────────────────
// Costo de empaque del turno
//
// El modelo de recetas (mig 127) permite que un componente sea item_kind
// 'packaging' (bolsa, etiqueta, caja). Hasta ahora ese costo NO llegaba al costo
// por unidad: sólo entraban MP (kg) y overhead. Esta función cierra ese hueco:
// por cada orden producida en el turno calcula cuánto empaque se consumió según
// la receta vigente del producto, escalado por la producción real del turno.
//
// Escalado: consumo = (producido / yield_quantity) × component.quantity, donde
// `producido` se mide en la unidad de rendimiento de la receta (count → piezas;
// cualquier otra → kg). cost_per_kg en raw_materials se usa como precio por
// unidad del empaque (convención del sistema para ítems no-kg).
//
// Sin receta vigente con componentes de empaque devuelve 0 (compat. legacy).
// `queryFn` es client.query (transacción) o el query del módulo.
// ──────────────────────────────────────────────────────────────────────────
async function computeShiftPackagingCost(queryFn, { shiftId, tenantId }) {
  const { rows } = await queryFn(
    `WITH order_prod AS (
       SELECT sp.production_order_id,
              po.product_id,
              SUM(COALESCE(sp.quantity_units, 0)) AS units,
              SUM(COALESCE(sp.real_weight_kg, 0)) AS kg
       FROM shift_progress sp
       JOIN production_orders po ON po.id = sp.production_order_id
       WHERE sp.shift_id = $1
       GROUP BY sp.production_order_id, po.product_id
     )
     SELECT COALESCE(SUM(
        (CASE WHEN yu.unit_type = 'count' THEN op.units ELSE op.kg END)
        / NULLIF(r.yield_quantity, 0)
        * rc.quantity
        * COALESCE(rm.cost_per_kg, 0)
     ), 0) AS packaging_cost
     FROM order_prod op
     JOIN recipes r           ON r.product_id = op.product_id
                             AND r.tenant_id = $2
                             AND r.valid_until IS NULL
     JOIN tenant_units yu      ON yu.id = r.yield_unit_id
     JOIN recipe_components rc ON rc.recipe_id = r.id
     JOIN raw_materials rm     ON rm.id = rc.raw_material_id
                             AND rm.item_kind = 'packaging'`,
    [shiftId, tenantId]
  )
  return parseFloat(rows[0]?.packaging_cost || 0)
}

async function validateShift({ tenantId, shiftId, approved, supervisorNotes, userId, ipAddress, userAgent }) {
  if (!approved) {
    // ─────────────────────────────────────────────────────────────────────
    // Bloquear "regresar turno" si el relevo ya tomó la línea.
    //
    // El botón "regresar" tiene sentido en la ventana entre que el saliente
    // cierra y el entrante acepta. Pero si el entrante ya aceptó formalmente
    // (existe fila en shift_receptions Y su turno está activo), reactivar al
    // saliente dejaría DOS production_shifts en `active` simultáneos sobre la
    // misma línea física — captura duplicada, inventario inconsistente.
    //
    // Solución: rechazar la operación y dirigir al supervisor a las
    // funciones de corrección (editPackage, deletePackage, addPackage)
    // que SÍ están pensadas para operar sobre turnos en pending_handover.
    //
    // Anotado el 2026-05-13 sesión 5. Bug histórico no documentado antes.
    // ─────────────────────────────────────────────────────────────────────
    const { rows: relayCheck } = await query(
      `SELECT ps.id, ps.shift_number, u.full_name AS relay_operator_name
       FROM shift_receptions sr
       JOIN production_shifts ps ON ps.id = sr.incoming_shift_id
       JOIN users u ON u.id = ps.operator_id
       WHERE sr.outgoing_shift_id = $1
         AND sr.tenant_id = $2
         AND ps.status = 'active'
       LIMIT 1`,
      [shiftId, tenantId]
    )

    if (relayCheck[0]) {
      const err = new Error(
        `No se puede regresar este turno: el relevo (${relayCheck[0].relay_operator_name}, ` +
        `Turno ${relayCheck[0].shift_number}) ya tomó la línea. ` +
        `Usa las herramientas de corrección del supervisor para ajustar este turno sin reactivarlo.`
      )
      err.status = 409
      err.code = 'RELAY_ALREADY_ACTIVE'
      throw err
    }

    const { rows } = await query(
      `UPDATE production_shifts SET status='active', closed_at=NULL
       WHERE id=$1 AND tenant_id=$2 AND status='pending_handover' RETURNING *`,
      [shiftId, tenantId]
    )
    if (!rows[0]) throw createError(400, 'El turno no está pendiente de validación.')
    return rows[0]
  }

  // SaaS v2 §Fase3 (fix 2026-05-30): re-aplicar overhead al VALIDAR.
  //
  // El overhead se aplica al CERRAR (closeShiftWithOverhead), tomando una "foto"
  // de los períodos de costo que existían en ese instante. Pero el costeo real
  // (cost_per_unit) se calcula aquí, al validar — que suele ocurrir después.
  //
  // Si el dueño captura los montos de gastos indirectos DESPUÉS de cerrar pero
  // ANTES de validar (flujo natural en micro pyme: "cierro, luego capturo costos,
  // luego valido"), el cierre ya había tomado la foto vacía y el turno quedaba
  // sin overhead. Re-aplicarlo aquí refresca estimated_overhead_total con los
  // períodos vigentes para que el costo del turno SÍ los incluya.
  //
  // Idempotente (upsert en shift_overhead_application). No bloquea la validación.
  try {
    const { rows: pre } = await query(
      `SELECT started_at, closed_at, mp_real_kg, pt_units_produced
       FROM production_shifts WHERE id=$1 AND tenant_id=$2`,
      [shiftId, tenantId]
    )
    if (pre[0]) {
      const { applyOverheadToShift } = require('../overhead-costing/overheadApplicationService')
      await applyOverheadToShift(shiftId, tenantId, {
        startedAt:          pre[0].started_at,
        endedAt:            pre[0].closed_at || new Date(),
        totalKgProduced:    parseFloat(pre[0].mp_real_kg || 0),
        totalUnitsProduced: parseInt(pre[0].pt_units_produced || 0),
      })
    }
  } catch (err) {
    console.warn('[overhead] re-aplicación al validar falló (no bloquea):', err.message)
  }

  return withTransaction(async (client) => {
    const { rows: shiftRows } = await client.query(
      `SELECT ps.* FROM production_shifts ps WHERE ps.id=$1 AND ps.tenant_id=$2`,
      [shiftId, tenantId]
    )
    const shift = shiftRows[0]
    if (!shift) throw createError(404, 'Turno no encontrado.')

    // Costo total MP — suma de todas las cargas × costo/kg (no se usa para cálculo final; lo dejamos por trazabilidad)
    const { rows: mpRows } = await client.query(
      `SELECT COALESCE(SUM(sml.kg * r.cost_per_kg),0) AS mp_cost
       FROM shift_mp_loads sml
       JOIN raw_materials r ON r.id=sml.raw_material_id
       WHERE sml.shift_id=$1`,
      [shiftId]
    )
    const mpCostRaw = parseFloat(mpRows[0].mp_cost)

    // Factor de reproceso configurable: % del costo MP que se imputa al turno
    // por cada kg de merma capturada (representa el costo de reprocesarla).
    const { rows: factorRows } = await client.query(
      `SELECT amount FROM production_cost_items
       WHERE tenant_id=$1 AND name='__scrap_factor__' AND is_active=true LIMIT 1`,
      [tenantId]
    )
    const reprocessFactor = factorRows[0] ? parseFloat(factorRows[0].amount)/100 : 0.20

    // Peso PT producido y peso de merma capturada
    const { rows: wtRows } = await client.query(
      `SELECT COALESCE(SUM(real_weight_kg),0) AS total_kg
       FROM shift_progress WHERE shift_id=$1`,
      [shiftId]
    )
    const totalProducedKg = parseFloat(wtRows[0].total_kg)

    const { rows: scrapRows } = await client.query(
      `SELECT COALESCE(SUM(kg),0) AS total_scrap_kg
       FROM shift_scrap WHERE shift_id=$1`,
      [shiftId]
    )
    const totalScrapKg = parseFloat(scrapRows[0].total_scrap_kg)

    // Costo/kg: cargas reales > fórmula de orden (blended) > promedio de la fórmula
    // de MP de la orden (order_mp_formula) > 0.
    // ⚠️ DEBE coincidir EXACTO con la cadena de getShiftSummary (mismo COALESCE de
    // 3 fallbacks). Si no, el turno se valida con avgCostPerKg distinto al que el
    // resumen recalcula → shift_product_costs (y el inventario PT) quedan en $0
    // mientras el resumen muestra un promedio no-cero. (Bug reportado 2026-06-09:
    // turnos SIN carga de MP y SIN blended_cost_per_kg pero CON order_mp_formula).
    const { rows: avgCostRows } = await client.query(
      `SELECT COALESCE(
         (SELECT SUM(sml.kg * r.cost_per_kg) / NULLIF(SUM(sml.kg),0)
          FROM shift_mp_loads sml JOIN raw_materials r ON r.id=sml.raw_material_id
          WHERE sml.shift_id=$1),
         (SELECT po.blended_cost_per_kg
          FROM shift_progress sp JOIN production_orders po ON po.id=sp.production_order_id
          WHERE sp.shift_id=$1 AND po.blended_cost_per_kg IS NOT NULL
          ORDER BY sp.microlot_number DESC LIMIT 1),
         (SELECT AVG(r.cost_per_kg)
          FROM shift_progress sp
          JOIN production_orders po ON po.id = sp.production_order_id
          JOIN order_mp_formula ompf ON ompf.production_order_id = po.id AND ompf.valid_until IS NULL
          JOIN raw_materials r ON r.id = ompf.raw_material_id
          WHERE sp.shift_id = $1),
         0
       ) AS avg_cost_per_kg`,
      [shiftId]
    )
    const avgCostPerKg = parseFloat(avgCostRows[0]?.avg_cost_per_kg || 0)

    // Costo MP del turno generador:
    //  • Peso PT producido al 100% del costo de la MP virgen.
    //  • Merma: ya NO es 0 fijo — se costea por TIPO según tenant_scrap_types
    //    (is_normal / recovery_value_pct) + shift_scrap.is_abnormal + flag
    //    treat_abnormal_scrap_as_loss. Merma normal desechada carga al producto
    //    (corrige sub-costeo en alimentos); anormal va a pérdida del período;
    //    recuperable descuenta su % (plástico puede poner recovery=100 → 0).
    //  • La descontamos del almacén MP virgen (en recordProductionValidation) por
    //    peso_PT + merma, reflejando el consumo físico real.
    const mpCostPT      = totalProducedKg * avgCostPerKg

    const { rows: scrapCfgRows } = await client.query(
      `SELECT treat_abnormal_scrap_as_loss FROM tenant_process_config WHERE tenant_id = $1`,
      [tenantId]
    )
    const treatAbnormalAsLoss = scrapCfgRows[0]?.treat_abnormal_scrap_as_loss !== false
    const scrapCost = await fetchAndComputeScrapProductCost(
      (text, params) => client.query(text, params),
      { shiftId, avgCostPerKg, treatAbnormalAsLoss }
    )
    const mpCostScrap   = scrapCost.productCost
    const mpCost        = mpCostPT + mpCostScrap

    // Overhead estimado — ya aplicado por overheadApplicationService en closeShift
    // (production_shifts.estimated_overhead_total). El módulo legacy de costos
    // fijos (production_cost_items) fue deprecado en favor del módulo Costeo
    // (tenant_overhead_items + tenant_overhead_periods). Para historicidad,
    // shift_cost_snapshot queda como tabla read-only de turnos antiguos.
    const overheadCost = parseFloat(shift.estimated_overhead_total || 0)

    // Empaque (bolsa/etiqueta/caja) desde la receta vigente, escalado por la
    // producción real del turno. 0 si el producto no tiene receta con empaque.
    const packagingCost = await computeShiftPackagingCost(
      (text, params) => client.query(text, params),
      { shiftId, tenantId }
    )

    const totalCost    = mpCost + overheadCost + packagingCost

    // §6c: NRV multi-calidad — calidades inferiores (is_second_quality=true) se
    // valúan a su expected_sale_price × kg; cal-1 absorbe el costo restante.
    const { rows: lowerGradeRows } = await client.query(
      `SELECT sp.real_weight_kg,
              COALESCE(p2.expected_sale_price, p.expected_sale_price, 0) AS sale_price
       FROM shift_progress sp
       LEFT JOIN production_orders po ON po.id = sp.production_order_id
       LEFT JOIN products p  ON p.id  = po.product_id
       LEFT JOIN products p2 ON p2.id = sp.second_quality_product_id
       WHERE sp.shift_id = $1 AND sp.is_second_quality = true`,
      [shiftId]
    )
    let nrvLowerGrades = 0
    for (const row of lowerGradeRows) {
      const kg    = parseFloat(row.real_weight_kg || 0)
      const price = parseFloat(row.sale_price || 0)
      if (kg > 0 && price > 0) nrvLowerGrades += price * kg
    }

    // Edge case: si NRV supera el costo total, se reporta como anomalía y se
    // asigna el costo sin descontar (evita negativo en cal-1).
    let nrvWarning = false
    let costGrade1 = totalCost
    if (nrvLowerGrades > 0) {
      if (nrvLowerGrades >= totalCost) {
        nrvWarning = true
        console.warn(`[closeShift/NRV] NRV de calidades inferiores ($${nrvLowerGrades.toFixed(2)}) >= costo total ($${totalCost.toFixed(2)}) en turno ${shiftId}. Asignando costo sin descontar.`)
      } else {
        costGrade1 = totalCost - nrvLowerGrades
      }
    }

    // Si no hay producción, costPerUnit se queda en 0 (no dividir entre 1 falso).
    const goodUnits   = parseInt(shift.pt_units_produced || 0)
    const costPerUnit = goodUnits > 0 ? costGrade1 / goodUnits : 0

    const { rows: closed } = await client.query(
      `UPDATE production_shifts SET status='reviewed', cost_per_unit=$1
       WHERE id=$2 RETURNING *`,
      [costPerUnit.toFixed(6), shiftId]
    )

    // Sincronizar el turno PROGRAMADO ligado. Al confirmar presencia el
    // scheduled_shift pasa a 'active'; nunca tenía transición terminal, así que
    // tras validar el turno real seguía mostrándose "activo" en Programación para
    // siempre (bug reportado 2026-06-09). Al validar lo marcamos 'completed'.
    // (Los registros viejos atorados los repara la mig 201.)
    await client.query(
      `UPDATE scheduled_shifts SET status = 'completed'
        WHERE shift_id = $1 AND tenant_id = $2 AND status = 'active'`,
      [shiftId, tenantId]
    )

    await client.query(
      `INSERT INTO shift_handovers
         (shift_id, mp_received_kg, pt_produced_units, reviewed_by, reviewed_at, supervisor_notes, submitted_by)
       VALUES ($1,$2,$3,$4,NOW(),$5,$4)
       ON CONFLICT (shift_id) DO UPDATE SET
         reviewed_by=EXCLUDED.reviewed_by, reviewed_at=EXCLUDED.reviewed_at,
         supervisor_notes=EXCLUDED.supervisor_notes`,
      [shiftId, shift.mp_real_kg, goodUnits, userId, supervisorNotes||null]
    )

    // ── Prorrateo del costo por PRODUCTO (medida) — modelo mixto ──────────────
    // Un turno puede fabricar varias medidas. Reparte el costo entre ellas: MP por
    // peso, overhead por piezas, empaque por receta (ver shiftCostAllocation.js) y
    // persiste el costo por SKU en shift_product_costs. Lo consume
    // recordProductionValidation (abajo) para valuar cada entrada PT con el costo
    // real de su medida. `cost_per_unit` del turno se conserva como promedio
    // (2da calidad, retrocompat, turnos de un solo producto). No bloquea: si algo
    // falla, el inventario cae al cost_per_unit del turno como antes.
    try {
      const { rows: prodGroups } = await client.query(
        `WITH grp AS (
           SELECT po.product_id,
                  SUM(sp.quantity_units) AS units,
                  SUM(sp.real_weight_kg) AS kg
           FROM shift_progress sp
           JOIN production_orders po ON po.id = sp.production_order_id
           WHERE sp.shift_id = $1 AND sp.is_second_quality = false
             AND po.product_id IS NOT NULL
           GROUP BY po.product_id
         )
         SELECT g.product_id, g.units, g.kg,
                COALESCE((
                  SELECT SUM(
                    (CASE WHEN yu.unit_type = 'count' THEN g.units ELSE g.kg END)
                    / NULLIF(r.yield_quantity, 0) * rc.quantity * COALESCE(rm.cost_per_kg, 0))
                  FROM recipes r
                  JOIN tenant_units yu      ON yu.id = r.yield_unit_id
                  JOIN recipe_components rc ON rc.recipe_id = r.id
                  JOIN raw_materials rm     ON rm.id = rc.raw_material_id AND rm.item_kind = 'packaging'
                  WHERE r.product_id = g.product_id AND r.tenant_id = $2 AND r.valid_until IS NULL
                ), 0) AS packaging_cost
         FROM grp g`,
        [shiftId, tenantId]
      )

      const productCosts = allocateShiftCostByProduct(
        prodGroups.map(r => ({
          productId: r.product_id, units: r.units, kg: r.kg, packagingCost: r.packaging_cost,
        })),
        { avgCostPerKg, overheadCost, costGrade1 }
      )

      await client.query(`DELETE FROM shift_product_costs WHERE shift_id = $1`, [shiftId])
      for (const pc of productCosts) {
        if (!pc.productId) continue
        await client.query(
          `INSERT INTO shift_product_costs
             (tenant_id, shift_id, product_id, units, total_kg, mp_cost, overhead_cost,
              packaging_cost, total_cost, cost_per_unit)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [tenantId, shiftId, pc.productId, pc.units, pc.totalKg,
           pc.mpCost.toFixed(4), pc.overheadCost.toFixed(4), pc.packagingCost.toFixed(4),
           pc.totalCost.toFixed(4), pc.costPerUnit.toFixed(6)]
        )
      }
    } catch (allocErr) {
      console.warn('[costeo] prorrateo de costo por medida falló (no bloquea, inventario usa cost_per_unit del turno):', allocErr.message)
    }

    // ── Movimientos de inventario automáticos ────────────────────────────────
    // MP consumida sale del almacén MP; PT producido entra al almacén PT
    try {
      await recordProductionValidation(client, { tenantId, shift: closed[0], userId })
    } catch (invErr) {
      console.error('[inventory] Error registrando movimientos automáticos en validateShift:', invErr.stack || invErr)
      try {
        await audit({
          tenantId, userId,
          action: 'inventory.validation_failed',
          resource: 'production_shifts',
          resourceId: shiftId,
          payload: {
            shiftNumber: closed[0]?.shift_number,
            error: invErr.message,
          },
        })
      } catch (auditErr) {
        console.error('[audit] Error al registrar inventory.validation_failed:', auditErr.message)
      }
    }

    await audit({ tenantId, userId, action:'shift.validated', resource:'production_shifts',
      resourceId: shiftId, payload:{ costPerUnit, totalCost, goodUnits, nrvLowerGrades, nrvWarning, packagingCost }, ipAddress, userAgent })

    return closed[0]
  })
}


async function getShiftSummary({ tenantId, shiftId }) {
  const shift = await getShift({ tenantId, shiftId })
  if (!shift) return null

  const progress   = shift.progress   || []
  const mpLoads    = shift.mpLoads    || []
  const incidents  = shift.incidents  || []
  const costs      = shift.costs      || []

  // Piezas buenas y 2da calidad
  const goodPkgs   = progress.filter(p => !p.is_second_quality)
  const secondPkgs = progress.filter(p =>  p.is_second_quality)

  const goodUnits   = goodPkgs.reduce((s,p)  => s + (p.quantity_units  || 0), 0)
  const secondUnits = secondPkgs.reduce((s,p) => s + (p.quantity_units || 0), 0)

  // Pesos
  const goodKg      = goodPkgs.reduce((s,p)   => s + parseFloat(p.real_weight_kg  || 0), 0)
  const secondKg    = secondPkgs.reduce((s,p)  => s + parseFloat(p.real_weight_kg || 0), 0)
  const totalMpKg   = mpLoads.reduce((s,m)     => s + parseFloat(m.kg || 0), 0)
  // Suma real de merma capturada (shift_scrap), no estimada por diferencia.
  const scrapCapturedKg = (shift.scrap || []).reduce((s, sc) => s + parseFloat(sc.kg || 0), 0)
  // scrapKg "histórico" — diferencia con cargas reales (cuando sí hay loadMp).
  const scrapKg     = Math.max(0, totalMpKg - goodKg - secondKg)

  // Split operador vs supervisor: la merma "agregada" por el supervisor queda
  // registrada en shift_corrections (action='create', target_type='shift_scrap').
  // El resto de la merma capturada es del operador. Lo consume el resumen para
  // mostrar el desglose ("├ Operador / └ Supervisor agregada").
  const { rows: supScrapRows } = await query(
    `SELECT target_id FROM shift_corrections
     WHERE shift_id = $1 AND target_type = 'shift_scrap' AND action = 'create'`,
    [shiftId]
  )
  const supScrapIds = new Set(supScrapRows.map(r => r.target_id))
  let scrapByOperatorKg = 0, scrapBySupervisorKg = 0
  let scrapOperatorCount = 0, scrapSupervisorCount = 0
  for (const sc of (shift.scrap || [])) {
    const kg = parseFloat(sc.kg || 0)
    if (supScrapIds.has(sc.id)) { scrapBySupervisorKg += kg; scrapSupervisorCount++ }
    else                         { scrapByOperatorKg  += kg; scrapOperatorCount++ }
  }

  // Metros por orden
  const orderMap = {}
  for (const pkg of goodPkgs) {
    const ordId = pkg.production_order_id
    if (!ordId) continue
    if (!orderMap[ordId]) {
      orderMap[ordId] = {
        orderId:     ordId,
        orderNumber: pkg.order_number,
        productName: pkg.product_name,
        units:       0,
        meters:      0,
        packages:    0,
      }
    }
    const lengthM = parseFloat(pkg.length_mm || 0) / 1000
    orderMap[ordId].units    += (pkg.quantity_units || 0)
    orderMap[ordId].meters   += (pkg.quantity_units || 0) * lengthM
    orderMap[ordId].packages += 1
  }
  const orderSummary = Object.values(orderMap)

  // Metros totales (suma de todas las órdenes)
  const totalMeters = orderSummary.reduce((s, o) => s + o.meters, 0)

  // Factor de reproceso configurable: % del costo MP imputado al turno por
  // cada kg de merma capturada (representa el costo de reprocesarla).
  // El nombre interno '__scrap_factor__' se mantiene por compatibilidad histórica.
  const scrapFactorItem = costs.find(c => c.name === '__scrap_factor__')
  const reprocessFactor = scrapFactorItem ? parseFloat(scrapFactorItem.amount) / 100 : 0.20

  // Peso PT producido (1ra + 2da calidad)
  const totalProducedKg = goodKg + secondKg

  // Costo promedio: cargas reales > fórmula de orden > promedio materiales del tenant
  const { rows: mpCostRows } = await query(
    `SELECT
       COALESCE(
         (SELECT SUM(sml.kg * r.cost_per_kg) / NULLIF(SUM(sml.kg),0)
          FROM shift_mp_loads sml
          JOIN raw_materials r ON r.id = sml.raw_material_id
          WHERE sml.shift_id = $1),
         (SELECT po.blended_cost_per_kg
          FROM shift_progress sp
          JOIN production_orders po ON po.id = sp.production_order_id
          WHERE sp.shift_id = $1 AND po.blended_cost_per_kg IS NOT NULL
          ORDER BY sp.microlot_number DESC LIMIT 1),
         (SELECT AVG(r.cost_per_kg)
          FROM shift_progress sp
          JOIN production_orders po ON po.id = sp.production_order_id
          JOIN order_mp_formula ompf ON ompf.production_order_id = po.id AND ompf.valid_until IS NULL
          JOIN raw_materials r ON r.id = ompf.raw_material_id
          WHERE sp.shift_id = $1),
         0
       ) AS avg_cost_per_kg,
       CASE
         WHEN EXISTS(SELECT 1 FROM shift_mp_loads WHERE shift_id=$1) THEN 'cargas_registradas'
         WHEN EXISTS(SELECT 1 FROM shift_progress sp JOIN production_orders po ON po.id=sp.production_order_id WHERE sp.shift_id=$1 AND po.blended_cost_per_kg IS NOT NULL) THEN 'formula_orden'
         ELSE 'promedio_materiales'
       END AS cost_source`,
    [shiftId]
  )
  const avgCostPerKg = parseFloat(mpCostRows[0]?.avg_cost_per_kg || 0)
  const costSource   = mpCostRows[0]?.cost_source || 'sin_datos'

  // Costo MP del turno generador:
  //  • PT al 100% del costo MP virgen.
  //  • Merma costeada por TIPO (tenant_scrap_types: is_normal / recovery_value_pct)
  //    + shift_scrap.is_abnormal + flag treat_abnormal_scrap_as_loss. Mismo
  //    cálculo que validateShift (módulo scrapCosting) para que el histórico
  //    coincida con el cost_per_unit guardado.
  //  • `mpCostScrapInfo` = valor informativo del regrind generado.
  const { rows: scrapCfgSumRows } = await query(
    `SELECT treat_abnormal_scrap_as_loss FROM tenant_process_config WHERE tenant_id = $1`,
    [tenantId]
  )
  const treatAbnormalAsLoss = scrapCfgSumRows[0]?.treat_abnormal_scrap_as_loss !== false
  const scrapCost = await fetchAndComputeScrapProductCost(query, { shiftId, avgCostPerKg, treatAbnormalAsLoss })

  const mpCostPT          = totalProducedKg  * avgCostPerKg
  const mpCostScrap       = scrapCost.productCost                        // merma normal no recuperable
  const mpCostScrapLoss   = scrapCost.lossValue                          // merma a pérdida (no producto)
  const mpCostScrapInfo   = scrapCapturedKg * avgCostPerKg * (1 + reprocessFactor)  // valor del regrind generado
  const mpCostTotal       = mpCostPT + mpCostScrap

  // Costos fijos LEGACY (shift_cost_snapshot). Vacío para tenants nuevos —
  // se mantiene por historicidad de turnos viejos. Excluye el factor de
  // reproceso que es config interna.
  const fixedCosts  = costs.filter(c => c.name !== '__scrap_factor__')
  const fixedTotal  = fixedCosts.reduce((s, c) => s + parseFloat(c.amount || 0), 0)

  // Gastos indirectos (overhead) del módulo NUEVO de Costeo
  // (tenant_overhead_items + shift_overhead_application). Estas filas se crean
  // al validar el turno (applyOverheadToShift) y son las que de verdad alimentan
  // el costeo hoy. Antes el histórico NO las leía → mostraba overhead $0.
  const { rows: ovhRows } = await query(
    `SELECT i.id, i.name, i.allocation_base, soa.basis_value, soa.estimated_amount
       FROM shift_overhead_application soa
       JOIN tenant_overhead_items i ON i.id = soa.overhead_item_id
      WHERE soa.shift_id = $1
      ORDER BY i.name`,
    [shiftId]
  )
  const overheadItems = ovhRows.map(r => ({
    id:             r.id,
    name:           r.name,
    allocationBase: r.allocation_base,
    basisValue:     parseFloat(r.basis_value || 0),
    amount:         parseFloat(r.estimated_amount || 0),
  }))
  const overheadTotal = overheadItems.reduce((s, o) => s + o.amount, 0)

  // Costo prorrateado por PRODUCTO (medida) — modelo mixto (mig 195). Permite ver
  // el costo real por SKU cuando el turno fabricó varias medidas. Una fila por
  // producto cal-1; vacío para turnos previos a la migración.
  const { rows: prodCostRows } = await query(
    `SELECT spc.product_id, p.name AS product_name, p.sku,
            spc.units, spc.total_kg, spc.mp_cost, spc.overhead_cost,
            spc.packaging_cost, spc.total_cost, spc.cost_per_unit
       FROM shift_product_costs spc
       JOIN products p ON p.id = spc.product_id
      WHERE spc.shift_id = $1
      ORDER BY p.name`,
    [shiftId]
  )
  const productCosts = prodCostRows.map(r => ({
    productId:     r.product_id,
    productName:   r.product_name,
    sku:           r.sku,
    units:         parseFloat(r.units || 0),
    totalKg:       parseFloat(parseFloat(r.total_kg || 0).toFixed(3)),
    mpCost:        parseFloat(parseFloat(r.mp_cost || 0).toFixed(4)),
    overheadCost:  parseFloat(parseFloat(r.overhead_cost || 0).toFixed(4)),
    packagingCost: parseFloat(parseFloat(r.packaging_cost || 0).toFixed(4)),
    totalCost:     parseFloat(parseFloat(r.total_cost || 0).toFixed(4)),
    costPerUnit:   parseFloat(parseFloat(r.cost_per_unit || 0).toFixed(4)),
  }))

  // Empaque (bolsa/etiqueta/caja) desde la receta vigente, escalado por la
  // producción real del turno. 0 si el producto no tiene receta con empaque.
  const packagingCost = await computeShiftPackagingCost(query, { shiftId, tenantId })

  const totalCost   = mpCostTotal + fixedTotal + overheadTotal + packagingCost

  // §6c: NRV multi-calidad — calidades inferiores valoradas a expected_sale_price × kg
  let nrvLowerGrades = 0
  for (const p of secondPkgs) {
    const kg    = parseFloat(p.real_weight_kg || 0)
    const price = parseFloat(p.expected_sale_price || 0)
    if (kg > 0 && price > 0) nrvLowerGrades += price * kg
  }
  let nrvWarning = false
  let costGrade1  = totalCost
  if (nrvLowerGrades > 0) {
    if (nrvLowerGrades >= totalCost) {
      nrvWarning = true
    } else {
      costGrade1 = totalCost - nrvLowerGrades
    }
  }
  const costPerUnit = goodUnits > 0 ? costGrade1 / goodUnits : 0
  const costPerMeter= totalMeters > 0 ? costGrade1 / totalMeters : 0

  // Costo por ORDEN para "Producción por orden": usa el costo de la MEDIDA de la
  // orden (shift_product_costs), no el promedio del turno. Antes el objeto de
  // orden NO traía costPerUnit (solo costPerMeter global) → cuando las piezas no
  // tenían largo (metros=0) el frontend caía a o.costPerUnit inexistente y
  // mostraba $0.0000/pza (bug reportado 2026-06-09). Fallback al promedio del
  // turno si la orden no tiene fila por medida (turno de 1 sola medida).
  const orderIdsForCost = orderSummary.map(o => o.orderId)
  const orderProductMap = {}
  if (orderIdsForCost.length) {
    const { rows: opr } = await query(
      `SELECT id, product_id FROM production_orders WHERE id = ANY($1::uuid[])`,
      [orderIdsForCost]
    )
    for (const r of opr) orderProductMap[r.id] = r.product_id
  }
  const pcByProduct = {}
  for (const pc of productCosts) pcByProduct[pc.productId] = pc

  // Paquetes fuera de rango
  const outOfRange  = goodPkgs.filter(p => p.weight_ok === false).length

  // Duración del turno
  const startedAt = shift.started_at ? new Date(shift.started_at) : null
  const closedAt  = shift.closed_at  ? new Date(shift.closed_at)  : null
  const durationMin = startedAt && closedAt
    ? Math.round((closedAt - startedAt) / 60000)
    : null

  // Cambios de fórmula que ocurrieron DURANTE este turno
  // (rango: started_at hasta closed_at, o NOW() si aún activo)
  const periodEnd = shift.closed_at || new Date().toISOString()
  const distinctOrderIds = [...new Set(goodPkgs.concat(secondPkgs)
                                .map(p => p.production_order_id)
                                .filter(Boolean))]
  let formulaChanges = []
  if (distinctOrderIds.length > 0 && shift.started_at) {
    const { rows: fcRows } = await query(
      `SELECT al.id, al.created_at, al.user_id, al.payload,
              u.full_name AS changed_by_name,
              po.order_number
       FROM audit_logs al
       LEFT JOIN users u ON u.id = al.user_id
       LEFT JOIN production_orders po ON po.id = al.resource_id
       WHERE al.tenant_id = $1
         AND al.action = 'order_mp_formula.changed'
         AND al.resource = 'production_orders'
         AND al.resource_id = ANY($2::uuid[])
         AND al.created_at >= $3
         AND al.created_at <= $4
       ORDER BY al.created_at`,
      [tenantId, distinctOrderIds, shift.started_at, periodEnd]
    )
    formulaChanges = fcRows.map(fc => ({
      id:              fc.id,
      changedAt:       fc.created_at,
      changedByName:   fc.changed_by_name || 'Usuario',
      orderNumber:     fc.order_number || fc.payload?.orderNumber || '',
      reason:          fc.payload?.reason || '',
      originalFormula: fc.payload?.originalFormula || [],
      newFormula:      fc.payload?.newFormula || [],
    }))
  }

  // Correcciones del supervisor en este turno
  const { rows: correctionsRows } = await query(
    `SELECT sc.id, sc.target_type, sc.action,
            sc.original_value, sc.new_value, sc.correction_reason,
            sc.corrected_at, u.full_name AS corrected_by_name
     FROM shift_corrections sc
     LEFT JOIN users u ON u.id = sc.corrected_by
     WHERE sc.tenant_id = $1 AND sc.shift_id = $2
     ORDER BY sc.corrected_at`,
    [tenantId, shiftId]
  )
  const corrections = correctionsRows.map(c => ({
    id:              c.id,
    targetType:      c.target_type,
    action:          c.action,
    originalValue:   c.original_value,
    newValue:        c.new_value,
    reason:          c.correction_reason,
    correctedAt:     c.corrected_at,
    correctedByName: c.corrected_by_name || 'Usuario',
  }))

  return {
    shift: {
      id:           shift.id,
      status:       shift.status,
      shiftNumber:  shift.shift_number,
      shiftDate:    shift.shift_date,
      lineId:       shift.line_id,
      operatorName: shift.operator_name,
      supervisorName:shift.supervisor_name,
      startedAt:    shift.started_at,
      closedAt:     shift.closed_at,
      durationMin,
    },
    production: {
      goodUnits,
      secondUnits,
      totalPackages:    goodPkgs.length,
      outOfRangePackages: outOfRange,
      totalMeters:      parseFloat(totalMeters.toFixed(2)),
      orderSummary:     orderSummary.map(o => {
        // Costo de la MEDIDA de esta orden (o promedio del turno si no hay fila).
        const pc  = pcByProduct[orderProductMap[o.orderId]]
        const cpu = (pc && pc.costPerUnit > 0) ? pc.costPerUnit : costPerUnit
        const cpm = o.meters > 0 ? (cpu * o.units) / o.meters : costPerMeter
        return {
          ...o,
          meters:       parseFloat(o.meters.toFixed(2)),
          costPerUnit:  parseFloat(cpu.toFixed(4)),
          costPerMeter: parseFloat(cpm.toFixed(4)),
        }
      }),
    },
    materials: {
      totalMpKg:        parseFloat(totalMpKg.toFixed(3)),
      goodKg:           parseFloat(goodKg.toFixed(3)),
      secondKg:         parseFloat(secondKg.toFixed(3)),
      scrapKg:          parseFloat(scrapKg.toFixed(3)),
      scrapCapturedKg:  parseFloat(scrapCapturedKg.toFixed(3)),
      scrapPct:         totalMpKg > 0 ? parseFloat((scrapKg/totalMpKg*100).toFixed(2)) : 0,
      // Merma REPORTADA = la realmente capturada (shift_scrap), distinta de la
      // implícita por diferencia de pesos (scrapKg). El frontend del resumen las
      // muestra por separado: la reportada y la "diferencia de balance".
      scrapReportedKg:    parseFloat(scrapCapturedKg.toFixed(3)),
      scrapPctReported:   totalMpKg > 0 ? parseFloat((scrapCapturedKg/totalMpKg*100).toFixed(2)) : 0,
      // Desglose operador / supervisor de la merma reportada.
      scrapByOperatorKg:    parseFloat(scrapByOperatorKg.toFixed(3)),
      scrapBySupervisorKg:  parseFloat(scrapBySupervisorKg.toFixed(3)),
      scrapOperatorCount,
      scrapSupervisorCount,
      // Diferencia de balance = MP cargada − producido (bueno + 2da) − merma reportada.
      // Si es grande, hay pesajes/capturas que no cuadran.
      scrapBalanceDiff:    parseFloat((totalMpKg - goodKg - secondKg - scrapCapturedKg).toFixed(3)),
      scrapBalanceDiffPct: totalMpKg > 0
        ? parseFloat(((totalMpKg - goodKg - secondKg - scrapCapturedKg) / totalMpKg * 100).toFixed(2))
        : 0,
    },
    costs: {
      items:            fixedCosts,
      reprocessFactor:  parseFloat((reprocessFactor * 100).toFixed(2)),
      // Alias legacy para compatibilidad con frontend antiguo: mismo valor
      scrapFactor:      parseFloat((reprocessFactor * 100).toFixed(2)),
      avgCostPerKg:     parseFloat(avgCostPerKg.toFixed(4)),
      costSource,
      blendedCostUsed:  costSource !== 'cargas_registradas',
      // Desglose nuevo
      ptKg:             parseFloat(totalProducedKg.toFixed(3)),
      mpCostPT:         parseFloat(mpCostPT.toFixed(4)),
      scrapCapturedKg:  parseFloat(scrapCapturedKg.toFixed(3)),
      mpCostScrap:      parseFloat(mpCostScrap.toFixed(4)),       // merma normal no recuperable cargada al producto
      mpCostScrapLoss:  parseFloat(mpCostScrapLoss.toFixed(4)),   // merma a pérdida del período (NO al costo unitario)
      mpCostScrapInfo:  parseFloat(mpCostScrapInfo.toFixed(4)),   // valor del regrind generado (informativo)
      mpCostTotal:      parseFloat(mpCostTotal.toFixed(4)),
      // Alias legacy para compat — apunta al total MP
      estimatedMpKg:    parseFloat(totalProducedKg.toFixed(3)),
      estimatedMpCost:  parseFloat(mpCostTotal.toFixed(4)),
      fixedTotal:       parseFloat(fixedTotal.toFixed(4)),
      // Gastos indirectos (overhead) del módulo nuevo — desglose por ítem + total
      overheadItems:    overheadItems.map(o => ({ ...o, amount: parseFloat(o.amount.toFixed(4)) })),
      overheadTotal:    parseFloat(overheadTotal.toFixed(4)),
      packagingCost:    parseFloat(packagingCost.toFixed(4)),
      totalCost:        parseFloat(totalCost.toFixed(4)),
      costPerUnit:      parseFloat(costPerUnit.toFixed(4)),
      costPerMeter:     parseFloat(costPerMeter.toFixed(4)),
      // §6c: NRV multi-calidad
      nrvLowerGrades:   parseFloat(nrvLowerGrades.toFixed(4)),
      nrvWarning,
      costGrade1:       parseFloat(costGrade1.toFixed(4)),
      // Costo prorrateado por medida (mig 195) — modelo mixto. Una fila por SKU
      // cal-1. El frontend/PDF lo muestran cuando hay más de un producto.
      productCosts,
    },
    incidents,
    formulaChanges,
    corrections,
    reception: shift.reception ? {
      accepted:         shift.reception.accepted,
      issueDescription: shift.reception.issue_description,
      receivedAt:       shift.reception.received_at,
      receivedByName:   shift.reception.received_by_name,
    } : null,
    forceClose: shift.force_closed_at ? {
      at:     shift.force_closed_at,
      byName: shift.force_closed_by_name,
      reason: shift.force_close_reason,
    } : null,
  }
}


async function listShiftsHistory({ tenantId, dateFrom, dateTo, operatorId, status, page=1, limit=20 }) {
  const offset = (page-1)*limit
  const params = [tenantId]
  const filters = []

  if (status)     { params.push(status);     filters.push(`ps.status=$${params.length}`) }
  if (operatorId) { params.push(operatorId); filters.push(`ps.operator_id=$${params.length}`) }
  if (dateFrom)   { params.push(dateFrom);   filters.push(`ps.shift_date>=$${params.length}`) }
  if (dateTo)     { params.push(dateTo);     filters.push(`ps.shift_date<=$${params.length}`) }

  const where = filters.length ? `AND ${filters.join(' AND ')}` : ''
  params.push(limit, offset)

  const { rows } = await query(
    `SELECT ps.id, ps.status, ps.shift_number, ps.shift_date, ps.line_id,
            ps.pt_units_produced, ps.mp_real_kg, ps.cost_per_unit,
            ps.started_at, ps.closed_at,
            u.full_name AS operator_name,
            s.full_name AS supervisor_name,
            -- Metros totales calculados
            COALESCE((
              SELECT SUM(sp.quantity_units * (sp.length_mm / 1000.0))
              FROM shift_progress sp
              WHERE sp.shift_id = ps.id AND sp.is_second_quality = false AND sp.length_mm IS NOT NULL
            ), 0) AS total_meters,
            -- Órdenes trabajadas
            (SELECT COUNT(DISTINCT sp.production_order_id)
             FROM shift_progress sp
             WHERE sp.shift_id = ps.id AND sp.production_order_id IS NOT NULL
            ) AS orders_count
     FROM production_shifts ps
     JOIN users u ON u.id = ps.operator_id
     JOIN users s ON s.id = ps.supervisor_id
     WHERE ps.tenant_id=$1 ${where}
     ORDER BY ps.shift_date DESC, ps.shift_number DESC
     LIMIT $${params.length-1} OFFSET $${params.length}`,
    params
  )

  const { rows: cnt } = await query(
    `SELECT COUNT(*) FROM production_shifts ps WHERE ps.tenant_id=$1 ${where}`,
    params.slice(0, params.length-2)
  )

  return { data: rows, total: parseInt(cnt[0].count,10), page, limit }
}


async function reopenShift({ tenantId, shiftId, userId, ipAddress, userAgent }) {
  const { rows: shift } = await query(
    `SELECT id, operator_id, closed_at FROM production_shifts
     WHERE id=$1 AND tenant_id=$2 AND status='pending_handover'`,
    [shiftId, tenantId]
  )
  if (!shift[0]) throw createError(400, 'El turno no está pendiente de validación.')

  // Solo miembros con capacidad de captura (típicamente el capturista del
  // turno) pueden reabrirlo, y solo dentro de 30 minutos.
  if (!(await userCanActOnShift({ shiftId, userId, capability: 'capture' }))) {
    throw createError(403, 'Solo los miembros del turno con permiso de captura pueden reabrirlo.')
  }
  const minutesSinceClosed = (Date.now() - new Date(shift[0].closed_at).getTime()) / 60000
  if (minutesSinceClosed > 30) {
    throw createError(400, 'Han pasado más de 30 minutos. Pide al supervisor que lo reabra desde validación.')
  }

  const { rows } = await query(
    `UPDATE production_shifts SET status='active', closed_at=NULL
     WHERE id=$1 RETURNING *`,
    [shiftId]
  )

  await audit({ tenantId, userId, action:'shift.reopened', resource:'production_shifts',
    resourceId: shiftId, payload: { minutesSinceClosed: Math.round(minutesSinceClosed) },
    ipAddress, userAgent })

  return rows[0]
}

function createError(status, message) {
  const err = new Error(message); err.status = status; return err
}

/**
 * Persiste la "orden activa" del turno en production_shifts.production_order_id.
 * Se llama desde el frontend cuando el operador selecciona/cambia una orden de
 * la cola. Esto permite que otras validaciones (cambio de fórmula, reportes,
 * etc.) puedan identificar qué orden está trabajando el turno sin depender de
 * los paquetes ya capturados.
 *
 * También transiciona la orden de 'released' → 'in_progress' automáticamente
 * la primera vez que se selecciona (coherente con el comportamiento previo).
 */
async function setShiftActiveOrder({ tenantId, shiftId, orderId, userId }) {
  return withTransaction(async (client) => {
    // 1. Validar turno
    const { rows: shiftRows } = await client.query(
      `SELECT id, operator_id, supervisor_id, status
       FROM production_shifts
       WHERE id = $1 AND tenant_id = $2`,
      [shiftId, tenantId]
    )
    if (!shiftRows[0]) throw createError(404, 'Turno no encontrado.')
    const shift = shiftRows[0]
    if (shift.status !== 'active') {
      throw createError(400, 'Solo se puede cambiar la orden activa en turnos activos.')
    }

    // 2. Validar que el usuario sea operador, supervisor o admin
    const { rows: roleRows } = await client.query(
      `SELECT 1 FROM user_roles ur
       JOIN roles r ON r.id = ur.role_id
       WHERE ur.user_id = $1 AND r.name IN ('admin','super_admin')`,
      [userId]
    )
    const isAdmin = roleRows.length > 0
    if (!isAdmin && !(await userCanActOnShift({ shiftId, userId, capability: 'validate', client }))) {
      throw createError(403, 'Solo los miembros del turno con permiso de validación pueden cambiar la orden activa.')
    }

    // 3. Validar orden
    const { rows: orderRows } = await client.query(
      `SELECT id, status FROM production_orders
       WHERE id = $1 AND tenant_id = $2`,
      [orderId, tenantId]
    )
    if (!orderRows[0]) throw createError(404, 'Orden no encontrada.')
    if (!['released', 'in_progress'].includes(orderRows[0].status)) {
      throw createError(400, `No se puede trabajar la orden en estado '${orderRows[0].status}'.`)
    }

    // 4. Actualizar orden activa del turno
    await client.query(
      `UPDATE production_shifts
       SET production_order_id = $1, updated_at = NOW()
       WHERE id = $2`,
      [orderId, shiftId]
    )

    // 5. Si la orden estaba 'released', moverla a 'in_progress'
    if (orderRows[0].status === 'released') {
      await client.query(
        `UPDATE production_orders SET status = 'in_progress', updated_at = NOW()
         WHERE id = $1 AND status = 'released'`,
        [orderId]
      )
    }

    return { shiftId, orderId, success: true }
  })
}

// ═══════════════════════════════════════════════════════════════════════════
// REVERSIÓN DE VALIDACIÓN — Mig 163 / sesión 2026-05-29
// ═══════════════════════════════════════════════════════════════════════════
//
// Permite revertir un turno reviewed cuando surge un imprevisto después de
// validar. Las restricciones se evalúan contra tenant_process_config + estado
// del sistema (orden cerrada, periodo contable cerrado, stock disponible).
//
// Diseño: en vez de "deshacer" la operación, registramos movimientos de
// inventario OPUESTOS (signo invertido) referenciados al turno. Esto preserva
// trazabilidad — auditor ve la validación original Y su reverso, no un hueco.

/**
 * Calcula si un turno reviewed puede revertirse y por qué motivos no, sin
 * mutar nada. La UI lo consume vía GET /shifts/:id/revert-context para pintar
 * el botón habilitado/deshabilitado con el tooltip correcto.
 *
 * Devuelve:
 *   {
 *     allowed: boolean,
 *     blockers: [{ code, message }],   // motivos por los que NO se puede
 *     warnings: [{ code, message }],   // se permite pero el usuario debe saber
 *     config: { ...flags... },
 *     window_hours_remaining: number|null,
 *     requires_dual_approval: boolean,
 *     reversal_preview: {
 *       mp_to_return:  [{ raw_material_id, name, kg, unit_cost }],
 *       pt_to_remove:  [{ product_id, name, units, unit_cost }],
 *     },
 *   }
 */
async function getRevertContext({ tenantId, shiftId, bypassWindow = false }) {
  const { rows: shiftRows } = await query(
    `SELECT ps.*, po.status AS order_status, po.order_number
     FROM production_shifts ps
     LEFT JOIN production_orders po ON po.id = ps.production_order_id
     WHERE ps.id = $1 AND ps.tenant_id = $2`,
    [shiftId, tenantId]
  )
  if (!shiftRows[0]) throw createError(404, 'Turno no encontrado.')
  const shift = shiftRows[0]

  const { rows: cfgRows } = await query(
    `SELECT allow_revert_validation, revert_validation_window_hours,
            block_revert_if_order_fulfilled, block_revert_if_period_closed,
            require_revert_dual_approval
     FROM tenant_process_config WHERE tenant_id = $1`,
    [tenantId]
  )
  const config = cfgRows[0] || {
    allow_revert_validation: true,
    revert_validation_window_hours: 72,
    block_revert_if_order_fulfilled: true,
    block_revert_if_period_closed: true,
    require_revert_dual_approval: false,
  }

  const blockers = []
  const warnings = []

  // 1) Estado del turno: debe ser reviewed.
  if (shift.status !== 'reviewed') {
    blockers.push({ code: 'NOT_REVIEWED', message: `El turno está en estado ${shift.status}, no en reviewed.` })
  }

  // 2) Flag del tenant.
  if (!config.allow_revert_validation) {
    blockers.push({ code: 'NOT_ALLOWED_BY_TENANT', message: 'El tenant tiene desactivada la reversión de validación.' })
  }

  // 3) Ventana de tiempo.
  let windowHoursRemaining = null
  if (config.revert_validation_window_hours != null) {
    const { rows: handover } = await query(
      `SELECT reviewed_at FROM shift_handovers WHERE shift_id = $1`,
      [shiftId]
    )
    const reviewedAt = handover[0]?.reviewed_at
    if (reviewedAt) {
      const hoursSince = (Date.now() - new Date(reviewedAt).getTime()) / 3600000
      windowHoursRemaining = config.revert_validation_window_hours - hoursSince
      if (windowHoursRemaining <= 0) {
        // bypassWindow lo usa SOLO la herramienta admin de recálculo de costo
        // (super_admin): degrada la ventana de blocker a warning. Los demás
        // frenos (PT vendido, orden cerrada, período cerrado) NO se tocan.
        if (bypassWindow) {
          warnings.push({
            code: 'WINDOW_EXPIRED_BYPASSED',
            message: `Pasaron >${config.revert_validation_window_hours}h desde validar; ventana saltada por recálculo admin.`,
          })
        } else {
          blockers.push({
            code: 'WINDOW_EXPIRED',
            message: `Han pasado más de ${config.revert_validation_window_hours} horas desde la validación.`,
          })
        }
      }
    }
  }

  // 4) Orden cerrada (fulfilled / completed).
  if (config.block_revert_if_order_fulfilled
      && ['fulfilled', 'completed'].includes(shift.order_status)) {
    blockers.push({
      code: 'ORDER_FULFILLED',
      message: `La orden ${shift.order_number || ''} ya está ${shift.order_status}.`,
    })
  }
  if (shift.order_status === 'cancelled') {
    blockers.push({
      code: 'ORDER_CANCELLED',
      message: 'La orden está cancelada — no se puede revertir el turno.',
    })
  }

  // 5) Periodo contable cerrado: el overhead del turno pertenece a un período
  //    YA FINALIZADO. Las filas en shift_overhead_application se crean al validar
  //    cada turno mientras el período sigue abierto (is_finalized=false), así que
  //    la sola presencia no implica cierre — hay que exigir is_finalized=true.
  if (config.block_revert_if_period_closed) {
    const { rows: ohRows } = await query(
      `SELECT 1
         FROM shift_overhead_application soa
         JOIN tenant_overhead_periods top ON top.id = soa.period_id
        WHERE soa.shift_id = $1 AND top.is_finalized = true
        LIMIT 1`,
      [shiftId]
    )
    if (ohRows.length > 0) {
      blockers.push({
        code: 'PERIOD_CLOSED',
        message: 'El periodo contable del turno ya cerró y el overhead se aplicó.',
      })
    }
  }

  // 6) Stock disponible para reversa (chequeo de integridad inviolable).
  //    Si el PT que se va a sacar del almacén ya se vendió, no se puede.
  //    Lo computamos pero también lo materializamos en reversal_preview.
  const { rows: movs } = await query(
    `SELECT itm.item_type, itm.item_id, itm.warehouse_id, itm.quantity, itm.unit_cost,
            itm.movement_type, w.warehouse_type_id, twt.system_role
     FROM inventory_movements itm
     LEFT JOIN warehouses w ON w.id = itm.warehouse_id
     LEFT JOIN tenant_warehouse_types twt ON twt.id = w.warehouse_type_id
     WHERE itm.tenant_id = $1
       AND itm.reference_type = 'production_shift'
       AND itm.reference_id   = $2
     ORDER BY itm.created_at`,
    [tenantId, shiftId]
  )

  // Agregar movimientos por (warehouse_id, item_id) sumando quantities — neto de
  // lo que efectivamente entró/salió en cada almacén.
  const netByKey = new Map()
  for (const m of movs) {
    const key = `${m.warehouse_id}::${m.item_type}::${m.item_id}`
    const prev = netByKey.get(key) || {
      warehouse_id: m.warehouse_id, item_type: m.item_type, item_id: m.item_id,
      system_role: m.system_role, net: 0, unit_cost: parseFloat(m.unit_cost || 0),
    }
    prev.net += parseFloat(m.quantity)
    netByKey.set(key, prev)
  }

  const mpToReturn = []
  const ptToRemove = []
  for (const agg of netByKey.values()) {
    if (agg.item_type === 'raw_material' && agg.net < 0 && agg.system_role === 'input') {
      mpToReturn.push({ raw_material_id: agg.item_id, kg: -agg.net, unit_cost: agg.unit_cost })
    } else if (agg.item_type === 'product' && agg.net > 0 && agg.system_role === 'output') {
      ptToRemove.push({ product_id: agg.item_id, units: agg.net, unit_cost: agg.unit_cost })
    }
  }

  // Para cada PT a sacar, verificar que aún haya suficiente en el almacén.
  for (const pt of ptToRemove) {
    const { rows: stockRows } = await query(
      `SELECT COALESCE(SUM(quantity), 0) AS available
       FROM inventory_stock
       WHERE tenant_id = $1 AND item_type = 'product' AND item_id = $2 AND status = 'available'`,
      [tenantId, pt.product_id]
    )
    const available = parseFloat(stockRows[0].available)
    if (available < pt.units) {
      const { rows: pn } = await query(`SELECT name FROM products WHERE id = $1`, [pt.product_id])
      blockers.push({
        code: 'PT_INSUFFICIENT_STOCK',
        message: `El PT "${pn[0]?.name || pt.product_id}" tiene ${available} en almacén; el turno entregó ${pt.units}. Anula remisiones/ventas que lo consumieron primero.`,
      })
    }
  }

  // Enriquecer con nombres legibles
  for (const m of mpToReturn) {
    const { rows: rn } = await query(`SELECT name FROM raw_materials WHERE id = $1`, [m.raw_material_id])
    m.name = rn[0]?.name || ''
  }
  for (const p of ptToRemove) {
    const { rows: pn } = await query(`SELECT name FROM products WHERE id = $1`, [p.product_id])
    p.name = pn[0]?.name || ''
  }

  return {
    allowed: blockers.length === 0,
    blockers,
    warnings,
    config,
    window_hours_remaining: windowHoursRemaining,
    requires_dual_approval: !!config.require_revert_dual_approval,
    reversal_preview: { mp_to_return: mpToReturn, pt_to_remove: ptToRemove },
  }
}

/**
 * Ejecuta la reversión de validación. Llama a getRevertContext primero para
 * validar y abortar 422 si hay blockers. Si todo OK, dentro de una transacción:
 *
 *  1. Inserta inventory_movements con signo opuesto a los del turno, referenciados
 *     al mismo shift_id pero con movement_type='production_validation_reversed'.
 *     Esto restaura el stock al estado pre-validación SIN borrar el histórico.
 *  2. UPDATE production_shifts SET status='active', closed_at=NULL, cost_per_unit=NULL.
 *  3. UPDATE shift_handovers SET reviewed_by=NULL, reviewed_at=NULL, supervisor_notes=NULL.
 *  4. Si la orden estaba 'fulfilled' por culpa de este turno, regresarla a 'in_progress'.
 *  5. Audit log con reason + secondary approver id si aplica.
 */
async function revertValidation({
  tenantId, shiftId, reason, secondaryApproverId,
  userId, ipAddress, userAgent, bypassWindow = false,
}) {
  if (!reason || String(reason).trim().length < 20) {
    throw createError(400, 'La razón de la reversión debe tener al menos 20 caracteres.')
  }

  const ctx = await getRevertContext({ tenantId, shiftId, bypassWindow })
  if (!ctx.allowed) {
    const err = new Error(ctx.blockers.map(b => b.message).join(' '))
    err.status = 422
    err.code   = 'REVERT_BLOCKED'
    err.blockers = ctx.blockers
    throw err
  }
  if (ctx.requires_dual_approval) {
    if (!secondaryApproverId) {
      throw createError(400, 'El tenant requiere un aprobador secundario para revertir.')
    }
    if (secondaryApproverId === userId) {
      throw createError(400, 'El aprobador secundario debe ser distinto al supervisor que reversa.')
    }
    const { rows: approver } = await query(
      `SELECT 1 FROM users u
       JOIN user_roles ur ON ur.user_id = u.id
       JOIN roles r ON r.id = ur.role_id
       WHERE u.id = $1 AND u.tenant_id = $2 AND r.name IN ('admin', 'super_admin')`,
      [secondaryApproverId, tenantId]
    )
    if (!approver[0]) {
      throw createError(400, 'El aprobador secundario debe ser admin del tenant.')
    }
  }

  return withTransaction(async (client) => {
    // 1) Reverse de movimientos: insertar el opuesto para cada movimiento del turno.
    const { rows: original } = await client.query(
      `SELECT id, warehouse_id, item_type, item_id, quantity, unit, unit_cost,
              movement_type, status_to
       FROM inventory_movements
       WHERE tenant_id = $1 AND reference_type = 'production_shift' AND reference_id = $2`,
      [tenantId, shiftId]
    )
    for (const m of original) {
      await recordMovement(client, {
        tenantId,
        warehouseId: m.warehouse_id,
        itemType:    m.item_type,
        itemId:      m.item_id,
        movementType:'production_validation_reversed',
        quantity:    -parseFloat(m.quantity),
        unit:        m.unit,
        unitCost:    parseFloat(m.unit_cost || 0),
        statusTo:    m.status_to,
        referenceType: 'production_shift',
        referenceId:   shiftId,
        notes:       `Reverso de validación: ${reason.trim().slice(0, 200)}`,
        createdBy:   userId,
      })
    }

    // 2) Revertir status del turno + limpiar cost_per_unit (se recalcula al re-validar).
    await client.query(
      `UPDATE production_shifts
          SET status = 'active', closed_at = NULL, cost_per_unit = NULL
        WHERE id = $1 AND tenant_id = $2`,
      [shiftId, tenantId]
    )

    // 3) Limpiar reviewed_at / reviewed_by para reflejar que ya no está validado.
    await client.query(
      `UPDATE shift_handovers
          SET reviewed_at = NULL, reviewed_by = NULL, supervisor_notes = NULL
        WHERE shift_id = $1`,
      [shiftId]
    )

    // 4) Si la orden estaba fulfilled, devolverla a in_progress (no si está
    //    completed/cancelled — esos casos están bloqueados arriba).
    await client.query(
      `UPDATE production_orders
          SET status = 'in_progress'
        WHERE id = (SELECT production_order_id FROM production_shifts WHERE id = $1)
          AND status = 'fulfilled'`,
      [shiftId]
    )

    await audit({
      tenantId, userId,
      action: 'shift.validation_reverted',
      resource: 'production_shifts',
      resourceId: shiftId,
      payload: {
        reason: reason.trim(),
        secondaryApproverId: secondaryApproverId || null,
        movements_reversed: original.length,
        mp_returned_kg:  ctx.reversal_preview.mp_to_return.reduce((s, x) => s + x.kg, 0),
        pt_removed_units: ctx.reversal_preview.pt_to_remove.reduce((s, x) => s + x.units, 0),
      },
      ipAddress, userAgent,
    })

    return {
      reverted: true,
      shift_id: shiftId,
      movements_reversed: original.length,
    }
  })
}

module.exports = {
  getOrdersQueue, listOrders, getOrder, createOrder, updateOrder, cancelOrder,
  releaseOrder, updateOrderPriority, reorderQueue, getOrderStockAvailability,
  getActiveShifts, getShift, getShiftSummary, listShiftsHistory, reopenShift, openShift, selfStartShift, selfQuickStart, capturePackage,
  loadMp, recordScrap, reportIncident, closeShift: closeShiftWithOverhead, forceCloseShift, validateShift,
  getHandoverSummary, acceptHandover, getClosedShiftSummary,
  previewStockForNewOrder,
  // Correcciones: dual-mode (operador en turno activo / supervisor en pending_handover)
  editPackage, deletePackage,
  editScrap, deleteScrap,
  editIncident, deleteIncident,
  editMpLoad, deleteMpLoad,
  listCorrections,
  // Agregar registros faltantes durante validación
  addPackage, addScrap, addIncident,
  // Cierre explícito de órdenes
  closeOrder, reopenOrder,
  // Versionado de fórmula MP
  changeOrderFormula, getOrderFormulaHistory,
  setShiftActiveOrder,
  // Reversión de validación (mig 163)
  getRevertContext, revertValidation,
}
