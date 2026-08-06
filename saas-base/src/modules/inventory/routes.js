'use strict'

const router = require('express').Router()
const { authGuard }           = require('../../middleware/authGuard')
const { checkPermission }     = require('../../middleware/checkPermission')
const { tenantResolver }      = require('../../middleware/tenantResolver')
const requireModule           = require('../../middleware/requireModule')
const inventoryService        = require('./inventoryService')
const levelsService           = require('./inventoryLevelsService')
const countService            = require('./inventoryCountService')
const suggestionService       = require('./inventoryCountSuggestionService')
const voucherService          = require('./consumptionVoucherService')
const { generateConsumptionVoucherPDF } = require('./consumptionVoucherPdfService')

router.use(tenantResolver)
router.use(authGuard)
router.use(requireModule('inventory'))

// ── GET /api/inventory/warehouses ─────────────────────────────────────────────
router.get('/warehouses', checkPermission('inventory', 'read'), async (req, res, next) => {
  try {
    const data = await inventoryService.getWarehouses({ tenantId: req.tenant.id })
    res.json(data)
  } catch (err) { next(err) }
})

// ── GET /api/inventory/summary ────────────────────────────────────────────────
router.get('/summary', checkPermission('inventory', 'read'), async (req, res, next) => {
  try {
    const data = await inventoryService.getInventorySummary({ tenantId: req.tenant.id })
    res.json(data)
  } catch (err) { next(err) }
})

// ── GET /api/inventory/stock ──────────────────────────────────────────────────
router.get('/stock', checkPermission('inventory', 'read'), async (req, res, next) => {
  try {
    const { warehouse_id, item_type, status, search, include_zero, page, limit } = req.query
    const data = await inventoryService.getStock({
      tenantId:    req.tenant.id,
      warehouseId: warehouse_id || null,
      itemType:    item_type    || null,
      status:      status       || null,
      search:      search       || null,
      includeZero: include_zero === 'true' || include_zero === '1',
      page:        parseInt(page)  || 1,
      limit:       parseInt(limit) || 50,
    })
    res.json(data)
  } catch (err) { next(err) }
})

// ── POST /api/inventory/recompute-stock ───────────────────────────────────────
// Recalcula los saldos de inventory_stock a partir del kardex (suma de
// movimientos = posición verdadera, revela negativos por sobreventa). apply=false
// devuelve solo la vista previa del diff; apply=true lo aplica. Gated a
// inventory:adjust (acción sensible: reescribe saldos).
router.post('/recompute-stock', checkPermission('inventory', 'adjust'), async (req, res, next) => {
  try {
    const apply = req.body?.apply === true
    const data = await inventoryService.recomputeStockFromMovements({
      tenantId: req.tenant.id,
      apply,
    })
    res.json(data)
  } catch (err) { next(err) }
})

// ── POST /api/inventory/stock/cost ────────────────────────────────────────────
// Edita manualmente el COSTO UNITARIO (avg_cost) de un artículo en un almacén.
// Para corregir productos a $0 o mal costeados. Registra auditoría. Gated a
// inventory:adjust (acción sensible: cambia la valuación).
router.post('/stock/cost', checkPermission('inventory', 'adjust'), async (req, res, next) => {
  try {
    const { itemType, itemId, warehouseId, status, unitCost, note } = req.body || {}
    const data = await inventoryService.setStockCost({
      tenantId:   req.tenant.id,
      itemType, itemId, warehouseId, status, unitCost, note,
      userId:     req.auth.userId,
      ipAddress:  req.ip,
      userAgent:  req.get('user-agent'),
    })
    res.json(data)
  } catch (err) { next(err) }
})

// ── POST /api/inventory/stock/release-blocked ────────────────────────────────
// Libera stock de 2ª calidad ('blocked') a 'available' para poder venderlo.
// Mueve dentro del mismo almacén conservando el costo. Gated a inventory:adjust.
router.post('/stock/release-blocked', checkPermission('inventory', 'adjust'), async (req, res, next) => {
  try {
    const { itemId, warehouseId, quantity, note } = req.body || {}
    const data = await inventoryService.releaseBlockedStock({
      tenantId:    req.tenant.id,
      itemId, warehouseId,
      quantity:    quantity != null && quantity !== '' ? quantity : null,
      note,
      userId:      req.auth.userId,
      ipAddress:   req.ip,
      userAgent:   req.get('user-agent'),
    })
    res.json(data)
  } catch (err) { next(err) }
})

// ── POST /api/inventory/stock/transfer ───────────────────────────────────────
// Traspaso entre almacenes: par transfer_out/transfer_in ligados, al costo
// promedio del origen. Con lotIds mueve lotes COMPLETOS y los reubica. Gated a
// inventory:adjust (mueve existencias entre bodegas).
router.post('/stock/transfer', checkPermission('inventory', 'adjust'), async (req, res, next) => {
  try {
    const { itemType, itemId, fromWarehouseId, toWarehouseId, quantity, lotIds, note } = req.body || {}
    const data = await inventoryService.transferStock({
      tenantId:  req.tenant.id,
      itemType, itemId, fromWarehouseId, toWarehouseId,
      quantity:  quantity != null && quantity !== '' ? quantity : null,
      lotIds:    Array.isArray(lotIds) && lotIds.length ? lotIds : null,
      note,
      userId:    req.auth.userId,
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    })
    res.json(data)
  } catch (err) { next(err) }
})

// ── GET /api/inventory/stock/transferable-lots ───────────────────────────────
// Lotes activos con saldo de un artículo en un almacén (para elegir qué mover).
router.get('/stock/transferable-lots', checkPermission('inventory', 'read'), async (req, res, next) => {
  try {
    const { item_type, item_id, warehouse_id } = req.query
    const data = await inventoryService.listTransferableLots({
      tenantId: req.tenant.id,
      itemType: item_type, itemId: item_id, warehouseId: warehouse_id,
    })
    res.json(data)
  } catch (err) { next(err) }
})

// ── GET /api/inventory/movements/:id ─────────────────────────────────────────
// Detalle de un movimiento del kardex + su documento origen resuelto (remisión,
// recepción, ajuste, turno, etc.) para trazabilidad.
router.get('/movements/:id', checkPermission('inventory', 'read'), async (req, res, next) => {
  try {
    const data = await inventoryService.getMovementDetail({
      tenantId: req.tenant.id, movementId: req.params.id,
    })
    if (!data) return res.status(404).json({ error: 'Movimiento no encontrado.' })
    res.json(data)
  } catch (err) { next(err) }
})

// ── GET /api/inventory/movements ─────────────────────────────────────────────
router.get('/movements', checkPermission('inventory', 'read'), async (req, res, next) => {
  try {
    const { item_type, item_id, warehouse_id, movement_type, date_from, date_to, page, limit } = req.query
    const data = await inventoryService.getMovements({
      tenantId:      req.tenant.id,
      itemType:      item_type      || null,
      itemId:        item_id        || null,
      warehouseId:   warehouse_id   || null,
      movementType:  movement_type  || null,
      dateFrom:      date_from      || null,
      dateTo:        date_to        || null,
      page:          parseInt(page)  || 1,
      limit:         parseInt(limit) || 50,
    })
    res.json(data)
  } catch (err) { next(err) }
})

// ─────────────────────────────────────────────────────────────────────────────
// Documentos de ajuste
// ─────────────────────────────────────────────────────────────────────────────

router.get('/adjustments', checkPermission('inventory', 'read'), async (req, res, next) => {
  try {
    const { warehouse_id, status, date_from, date_to, search, page, limit } = req.query
    const data = await inventoryService.listAdjustments({
      tenantId:    req.tenant.id,
      warehouseId: warehouse_id || null,
      status:      status       || null,
      dateFrom:    date_from    || null,
      dateTo:      date_to      || null,
      search:      search       || null,
      page:        parseInt(page)  || 1,
      limit:       parseInt(limit) || 50,
    })
    res.json(data)
  } catch (err) { next(err) }
})

router.get('/adjustments/:id', checkPermission('inventory', 'read'), async (req, res, next) => {
  try {
    const data = await inventoryService.getAdjustment({
      tenantId: req.tenant.id, adjustmentId: req.params.id,
    })
    if (!data) return res.status(404).json({ error: 'Ajuste no encontrado.' })
    res.json(data)
  } catch (err) { next(err) }
})

router.post('/adjustments', checkPermission('inventory', 'adjust'), async (req, res, next) => {
  try {
    const { warehouseId, reason, notes, lines } = req.body
    if (!warehouseId)            return res.status(400).json({ error: 'warehouseId es requerido.' })
    if (!reason || !reason.trim()) return res.status(400).json({ error: 'reason (motivo) es requerido.' })
    if (!notes  || !notes.trim())  return res.status(400).json({ error: 'notes (notas adicionales) es obligatorio.' })
    if (!lines || !Array.isArray(lines) || lines.length === 0) {
      return res.status(400).json({ error: 'Se requiere al menos una línea.' })
    }
    const adj = await inventoryService.createAdjustmentDocument({
      tenantId:    req.tenant.id,
      warehouseId, reason, notes, lines,
      userId:      req.auth.userId,
    })
    res.status(201).json(adj)
  } catch (err) { next(err) }
})

router.post('/adjustments/:id/cancel', checkPermission('inventory', 'adjust'), async (req, res, next) => {
  try {
    const { reason } = req.body
    if (!reason || !String(reason).trim()) {
      return res.status(400).json({ error: 'reason (razón de la cancelación) es obligatorio.' })
    }
    const adj = await inventoryService.cancelAdjustment({
      tenantId:     req.tenant.id,
      adjustmentId: req.params.id,
      reason,
      userId:       req.auth.userId,
    })
    res.json(adj)
  } catch (err) { next(err) }
})

// ── GET /api/inventory/items/search ──────────────────────────────────────────
router.get('/items/search', checkPermission('inventory', 'read'), async (req, res, next) => {
  try {
    const { q, type, warehouseId, limit } = req.query
    const data = await inventoryService.searchItems({
      tenantId:    req.tenant.id,
      q:           q || '',
      type:        type        || null,
      warehouseId: warehouseId || null,
      limit:       parseInt(limit) || 20,
    })
    res.json(data)
  } catch (err) { next(err) }
})

// ─────────────────────────────────────────────────────────────────────────────
// NIVELES DE STOCK
// ─────────────────────────────────────────────────────────────────────────────

router.get('/levels', checkPermission('inventory', 'read'), async (req, res, next) => {
  try {
    const { status } = req.query
    const data = await levelsService.listWithStatus({
      tenantId: req.tenant.id, status: status || null,
    })
    res.json(data)
  } catch (err) { next(err) }
})

router.get('/levels/summary', checkPermission('inventory', 'read'), async (req, res, next) => {
  try {
    const data = await levelsService.countByStatus({ tenantId: req.tenant.id })
    res.json(data)
  } catch (err) { next(err) }
})

// Disparo MANUAL del escaneo de stock bajo (el cron lo corre 1×/día a las 8 MX).
// Re-evalúa ítems bajo mínimo/reorden y dispara alertas tenant_alerts + push.
// dispatchAlert dedupea → no duplica alertas ya pendientes.
router.post('/levels/low-stock-scan', checkPermission('inventory', 'read'), async (req, res, next) => {
  try {
    const dispatched = await levelsService.checkLowStock(req.tenant.id)
    res.json({ dispatched })
  } catch (err) { next(err) }
})

router.get('/levels/:itemType/:itemId', checkPermission('inventory', 'read'), async (req, res, next) => {
  try {
    const data = await levelsService.getLevelsByItem({
      tenantId: req.tenant.id,
      itemType: req.params.itemType,
      itemId:   req.params.itemId,
    })
    res.json(data)
  } catch (err) { next(err) }
})

router.put('/levels/:itemType/:itemId/:warehouseId', checkPermission('inventory', 'create'), async (req, res, next) => {
  try {
    const { itemType, itemId, warehouseId } = req.params
    const { minStock, maxStock, reorderPoint, safetyStock, isManualReorderPoint, lastCalculatedAvg, notes } = req.body
    const data = await levelsService.upsertLevel({
      tenantId: req.tenant.id, itemType, itemId, warehouseId,
      minStock, maxStock, reorderPoint, safetyStock,
      isManualReorderPoint, lastCalculatedAvg, notes,
      userId: req.auth.userId,
    })
    res.json(data)
  } catch (err) { next(err) }
})

router.delete('/levels/:itemType/:itemId/:warehouseId', checkPermission('inventory', 'create'), async (req, res, next) => {
  try {
    const { itemType, itemId, warehouseId } = req.params
    const data = await levelsService.removeLevel({
      tenantId: req.tenant.id, itemType, itemId, warehouseId,
    })
    res.json(data)
  } catch (err) { next(err) }
})

router.get('/items/:itemType/:itemId/consumption', checkPermission('inventory', 'read'), async (req, res, next) => {
  try {
    const { itemType, itemId } = req.params
    const { warehouseId, leadTimeDays, safetyStock, days } = req.query
    if (!warehouseId) return res.status(400).json({ error: 'warehouseId es requerido como query param.' })
    const data = await levelsService.suggestReorderPoint({
      tenantId:    req.tenant.id, itemType, itemId, warehouseId,
      leadTimeDays: parseInt(leadTimeDays) || 7,
      safetyStock:  parseFloat(safetyStock) || 0,
      days:         parseInt(days) || 90,
    })
    res.json(data)
  } catch (err) { next(err) }
})

router.get('/items/:itemType/:itemId/detail', checkPermission('inventory', 'read'), async (req, res, next) => {
  try {
    const { itemType, itemId } = req.params
    const { warehouseId } = req.query
    if (!warehouseId) return res.status(400).json({ error: 'warehouseId es requerido como query param.' })
    const data = await levelsService.getItemDetail({
      tenantId: req.tenant.id, itemType, itemId, warehouseId,
    })
    res.json(data)
  } catch (err) { next(err) }
})

// ─────────────────────────────────────────────────────────────────────────────
// CONTEOS FÍSICOS
// ─────────────────────────────────────────────────────────────────────────────

// Listar conteos
router.get('/counts', checkPermission('inventory', 'read'), async (req, res, next) => {
  try {
    const { count_type, status, warehouse_id, date_from, date_to, search, page, limit } = req.query
    const data = await countService.listCounts({
      tenantId:    req.tenant.id,
      countType:   count_type   || null,
      status:      status       || null,
      warehouseId: warehouse_id || null,
      dateFrom:    date_from    || null,
      dateTo:      date_to      || null,
      search:      search       || null,
      page:        parseInt(page)  || 1,
      limit:       parseInt(limit) || 50,
    })
    res.json(data)
  } catch (err) { next(err) }
})

// Detalle del conteo (con líneas)
router.get('/counts/:id', checkPermission('inventory', 'read'), async (req, res, next) => {
  try {
    const data = await countService.getCountById({
      tenantId: req.tenant.id, countId: req.params.id,
    })
    if (!data) return res.status(404).json({ error: 'Conteo no encontrado.' })
    res.json(data)
  } catch (err) { next(err) }
})

// Crear conteo (toma snapshot)
router.post('/counts', checkPermission('inventory', 'adjust'), async (req, res, next) => {
  try {
    const { countType, warehouseId, scope, selectedItems, countDate, notes } = req.body
    const data = await countService.createCount({
      tenantId:      req.tenant.id,
      countType, warehouseId, scope, selectedItems,
      countDate, notes,
      userId:        req.auth.userId,
    })
    res.status(201).json(data)
  } catch (err) { next(err) }
})

// Sugerencia inteligente de items a contar (ABC + diferencias + tiempo + valor)
router.post('/counts/suggest', checkPermission('inventory', 'adjust'), async (req, res, next) => {
  try {
    const { warehouseId, count, weights, randomness, excludeRecentlyCountedDays } = req.body
    const data = await suggestionService.suggestItemsToCount({
      tenantId: req.tenant.id,
      warehouseId,
      count:    parseInt(count) || 25,
      weights:  weights || { rotation: 40, history: 30, time: 20, value: 10 },
      randomness: randomness != null ? parseFloat(randomness) : 15,
      excludeRecentlyCountedDays: excludeRecentlyCountedDays != null
        ? parseInt(excludeRecentlyCountedDays) : null,
    })
    res.json(data)
  } catch (err) { next(err) }
})

// Capturar línea (cantidad física)
router.put('/counts/:id/lines/:lineId', checkPermission('inventory', 'adjust'), async (req, res, next) => {
  try {
    const { physicalQty, notes, unitCost } = req.body
    const data = await countService.captureLine({
      tenantId:    req.tenant.id,
      countId:     req.params.id,
      lineId:      req.params.lineId,
      physicalQty, notes, unitCost,
      userId:      req.auth.userId,
    })
    res.json(data)
  } catch (err) { next(err) }
})

// Marcar varias líneas como "sin diferencia"
router.post('/counts/:id/mark-no-diff', checkPermission('inventory', 'adjust'), async (req, res, next) => {
  try {
    const { lineIds } = req.body
    const data = await countService.markLinesNoDiff({
      tenantId: req.tenant.id,
      countId:  req.params.id,
      lineIds,
      userId:   req.auth.userId,
    })
    res.json(data)
  } catch (err) { next(err) }
})

// Pasar a conciliación
router.post('/counts/:id/move-to-reconcile', checkPermission('inventory', 'adjust'), async (req, res, next) => {
  try {
    const data = await countService.moveToReconcile({
      tenantId: req.tenant.id,
      countId:  req.params.id,
      userId:   req.auth.userId,
    })
    res.json(data)
  } catch (err) { next(err) }
})

// Aplicar conteo (genera ajuste)
router.post('/counts/:id/apply', checkPermission('inventory', 'adjust'), async (req, res, next) => {
  try {
    const { closingNotes } = req.body
    const data = await countService.applyCount({
      tenantId:     req.tenant.id,
      countId:      req.params.id,
      closingNotes,
      userId:       req.auth.userId,
    })
    res.json(data)
  } catch (err) { next(err) }
})

// Cancelar conteo
router.post('/counts/:id/cancel', checkPermission('inventory', 'adjust'), async (req, res, next) => {
  try {
    const { reason } = req.body
    const data = await countService.cancelCount({
      tenantId: req.tenant.id,
      countId:  req.params.id,
      reason,
      userId:   req.auth.userId,
    })
    res.json(data)
  } catch (err) { next(err) }
})

// ═══ Vales de salida (consumo interno a áreas) — migs 245/246 ═════════════════
// Permisos: reusa inventory:read / inventory:adjust (SIN permiso nuevo).

// Catálogo de áreas de consumo
router.get('/consumption-areas', checkPermission('inventory', 'read'), async (req, res, next) => {
  try {
    res.json(await voucherService.listAreas({
      tenantId: req.tenant.id,
      includeInactive: req.query.include_inactive === 'true' || req.query.include_inactive === '1',
    }))
  } catch (err) { next(err) }
})

router.post('/consumption-areas', checkPermission('inventory', 'adjust'), async (req, res, next) => {
  try {
    res.status(201).json(await voucherService.createArea({
      tenantId: req.tenant.id, name: req.body?.name,
    }))
  } catch (err) { next(err) }
})

router.patch('/consumption-areas/:id', checkPermission('inventory', 'adjust'), async (req, res, next) => {
  try {
    const { name, isActive, sortOrder } = req.body || {}
    res.json(await voucherService.updateArea({
      tenantId: req.tenant.id, areaId: req.params.id, name, isActive, sortOrder,
    }))
  } catch (err) { next(err) }
})

// Vales
router.get('/consumption-vouchers', checkPermission('inventory', 'read'), async (req, res, next) => {
  try {
    const { warehouse_id, area_id, status, date_from, date_to, search, page, limit } = req.query
    res.json(await voucherService.listVouchers({
      tenantId:    req.tenant.id,
      warehouseId: warehouse_id || null,
      areaId:      area_id      || null,
      status:      status       || null,
      dateFrom:    date_from    || null,
      dateTo:      date_to      || null,
      search:      search       || null,
      page:        parseInt(page)  || 1,
      limit:       Math.min(parseInt(limit) || 25, 100),
    }))
  } catch (err) { next(err) }
})

// Resumen valorizado por área (antes de /:id para que no lo capture)
router.get('/consumption-vouchers/summary-by-area', checkPermission('inventory', 'read'), async (req, res, next) => {
  try {
    res.json(await voucherService.consumptionByArea({
      tenantId: req.tenant.id,
      dateFrom: req.query.date_from || null,
      dateTo:   req.query.date_to   || null,
    }))
  } catch (err) { next(err) }
})

router.get('/consumption-vouchers/:id', checkPermission('inventory', 'read'), async (req, res, next) => {
  try {
    const voucher = await voucherService.getVoucher({ tenantId: req.tenant.id, voucherId: req.params.id })
    if (!voucher) return res.status(404).json({ error: 'Vale no encontrado.' })
    res.json(voucher)
  } catch (err) { next(err) }
})

router.get('/consumption-vouchers/:id/pdf', checkPermission('inventory', 'read'), async (req, res, next) => {
  try {
    const buf = await generateConsumptionVoucherPDF({ tenantId: req.tenant.id, voucherId: req.params.id })
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `inline; filename="vale-${req.params.id}.pdf"`)
    res.send(buf)
  } catch (err) { next(err) }
})

router.post('/consumption-vouchers', checkPermission('inventory', 'adjust'), async (req, res, next) => {
  try {
    const { warehouseId, areaId, receivedBy, notes, lines } = req.body || {}
    res.status(201).json(await voucherService.createVoucher({
      tenantId: req.tenant.id, warehouseId, areaId, receivedBy, notes, lines,
      userId: req.auth.userId,
    }))
  } catch (err) { next(err) }
})

router.post('/consumption-vouchers/:id/cancel', checkPermission('inventory', 'adjust'), async (req, res, next) => {
  try {
    res.json(await voucherService.cancelVoucher({
      tenantId: req.tenant.id, voucherId: req.params.id,
      reason: req.body?.reason, userId: req.auth.userId,
    }))
  } catch (err) { next(err) }
})

module.exports = router
