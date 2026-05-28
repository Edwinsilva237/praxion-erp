'use strict'

const express = require('express')
const { tenantResolver }  = require('../../middleware/tenantResolver')
const { authGuard }       = require('../../middleware/authGuard')
const { requireActiveTenant } = require('../../middleware/requireActiveTenant')
const { checkPermission, checkAnyPermission } = require('../../middleware/checkPermission')
const requireModule       = require('../../middleware/requireModule')
const svc                 = require('./productionService')
const svcSched            = require('./scheduledShiftService')
const svcShiftCfg         = require('./shiftConfigService')

const router = express.Router()
router.use(tenantResolver)
router.use(authGuard)
router.use(requireActiveTenant)
router.use(requireModule('production'))

const tid = (req) => req.tenant.id
const uid = (req) => req.auth.userId
const ip  = (req) => req.ip
const ua  = (req) => req.get('user-agent')

// ── Cola de órdenes ───────────────────────────────────────────────────────────
router.get('/queue', checkPermission('production','read'), async (req,res,next) => {
  try {
    const { lineId } = req.query
    res.json(await svc.getOrdersQueue({ tenantId:tid(req), lineId: lineId ? parseInt(lineId) : null }))
  } catch(err){next(err)}
})

// ── Órdenes ───────────────────────────────────────────────────────────────────
router.get('/orders', checkPermission('production','read'), async (req,res,next) => {
  try {
    const { status,lineId,page,limit } = req.query
    res.json(await svc.listOrders({ tenantId:tid(req), status, lineId, page:parseInt(page||1), limit:parseInt(limit||50) }))
  } catch(err){next(err)}
})
router.get('/orders/:id', checkPermission('production','read'), async (req,res,next) => {
  try {
    const o = await svc.getOrder({ tenantId:tid(req), orderId:req.params.id })
    if (!o) return res.status(404).json({ error:'Orden no encontrada.' })
    res.json(o)
  } catch(err){next(err)}
})
router.post('/orders', checkPermission('production','manage'), async (req,res,next) => {
  try {
    const { productId,rawMaterialId,lengthMm,quantityPackages,lineId,priority,deliveryDate,notes,mpFormula,
            recipeId, recipe_id,
            customAttributes, custom_attributes,
            additionalCosts, additional_costs,
            additionalCostsNotes, additional_costs_notes } = req.body
    if (!productId||!quantityPackages) return res.status(400).json({ error:'Faltan campos requeridos.' })
    res.status(201).json(await svc.createOrder({
      tenantId:tid(req), productId,rawMaterialId,lengthMm,
      quantityPackages,lineId,priority,deliveryDate,notes,mpFormula,
      recipeId: recipeId ?? recipe_id ?? null,
      customAttributes: customAttributes ?? custom_attributes ?? undefined,
      additionalCosts:  additionalCosts  ?? additional_costs  ?? undefined,
      additionalCostsNotes: additionalCostsNotes ?? additional_costs_notes ?? undefined,
      userId:uid(req),ipAddress:ip(req),userAgent:ua(req)
    }))
  } catch(err){
    if (err.status) return res.status(err.status).json({ error: err.message })
    next(err)
  }
})
router.post('/orders/:id/release', checkPermission('production','update'), async (req,res,next) => {
  try {
    const { lowStockOverrideReason } = req.body || {}
    res.json(await svc.releaseOrder({
      tenantId: tid(req),
      orderId:  req.params.id,
      userId:   uid(req),
      ipAddress: ip(req),
      userAgent: ua(req),
      lowStockOverrideReason,
    }))
  } catch(err){next(err)}
})

// ═══════════════════════════════════════════════════════════════════════════
// ⚠ STOCK PREVIEW / AVAILABILITY — NO ELIMINAR ESTAS DOS RUTAS
// ═══════════════════════════════════════════════════════════════════════════
// Consumidas por el formulario de creación/edición de órdenes para mostrar
// disponibilidad de materia prima en tiempo real. Sin estas rutas, el form
// muestra el banner "Route not found" al agregar fórmulas de mezcla.
//
// preview-stock  → para órdenes que aún no existen (formulario nuevo).
// stock-availability → para órdenes ya creadas (vista detalle, antes de liberar).
//
// Si alguna vez se "limpia código no usado", verificar primero el frontend:
//   - src/api/production.js → previewStock, getStockAvailability
//   - cualquier formulario o vista de orden de producción
//
// Historial de incidentes (agregar al final cada vez que se rompa):
//   - 2026-05-13 sesión 5: ruta /preview-stock ausente. Se agregó junto con
//     /stock-availability (que estaba huérfana, función existía pero sin ruta).
// ═══════════════════════════════════════════════════════════════════════════
router.post('/orders/preview-stock', checkPermission('production','read'), async (req,res,next) => {
  try {
    const { productId, lengthMm, quantityPackages, mpFormula,
            recipeId, recipe_id, totalPtKg, total_pt_kg } = req.body
    res.json(await svc.previewStockForNewOrder({
      tenantId: tid(req),
      productId,
      lengthMm,
      quantityPackages,
      mpFormula,
      recipeId: recipeId ?? recipe_id ?? null,
      totalPtKg: totalPtKg ?? total_pt_kg ?? null,
    }))
  } catch(err){
    if (err.status) return res.status(err.status).json({ error: err.message })
    next(err)
  }
})

router.get('/orders/:id/stock-availability', checkPermission('production','read'), async (req,res,next) => {
  try {
    res.json(await svc.getOrderStockAvailability({
      tenantId: tid(req),
      orderId:  req.params.id,
    }))
  } catch(err){next(err)}
})

// NOTA SaaS v2 §5e: Aquí había un PATCH /orders/:id duplicado que llamaba
// releaseOrder y sombreaba al updateOrder definido más abajo (Express toma
// la primera ruta que matchea). Esto rompía todos los PATCH a /orders/:id.
// La ruta correcta para release es POST /orders/:id/release (definida arriba).
// El PATCH ahora apunta correctamente a updateOrder.

router.patch('/orders/:id', checkPermission('production','update'), async (req,res,next) => {
  try {
    const { notes, priority, deliveryDate, mpFormula, recipeId, recipe_id,
            customAttributes, custom_attributes,
            additionalCosts, additional_costs,
            additionalCostsNotes, additional_costs_notes } = req.body
    // recipeId/customAttributes pueden ser null (limpiar) o valor (setear). undefined = no tocar.
    const has = (key) => Object.prototype.hasOwnProperty.call(req.body, key)
    const resolvedRecipeId =
      has('recipeId') ? recipeId : has('recipe_id') ? recipe_id : undefined
    const resolvedCa =
      has('customAttributes') ? customAttributes : has('custom_attributes') ? custom_attributes : undefined
    res.json(await svc.updateOrder({
      tenantId:tid(req), orderId:req.params.id,
      notes, priority, deliveryDate, mpFormula,
      recipeId: resolvedRecipeId,
      customAttributes: resolvedCa,
      additionalCosts:  has('additionalCosts') ? additionalCosts : has('additional_costs') ? additional_costs : undefined,
      additionalCostsNotes: has('additionalCostsNotes') ? additionalCostsNotes : has('additional_costs_notes') ? additional_costs_notes : undefined,
      userId:uid(req), ipAddress:ip(req), userAgent:ua(req)
    }))
  } catch(err){
    if (err.status) return res.status(err.status).json({ error: err.message })
    next(err)
  }
})

router.delete('/orders/:id', checkPermission('production','update'), async (req,res,next) => {
  try {
    res.json(await svc.cancelOrder({
      tenantId:tid(req), orderId:req.params.id,
      userId:uid(req), ipAddress:ip(req), userAgent:ua(req)
    }))
  } catch(err){next(err)}
})

router.patch('/orders/:id/priority', checkPermission('production','update'), async (req,res,next) => {
  try {
    const { priority,deliveryDate } = req.body
    if (!priority) return res.status(400).json({ error:'priority es requerido.' })
    res.json(await svc.updateOrderPriority({ tenantId:tid(req), orderId:req.params.id, priority, deliveryDate, userId:uid(req) }))
  } catch(err){next(err)}
})

// ── Versionado de fórmula MP (cambio de mezcla durante producción) ───────────
router.post('/orders/:id/change-formula', checkPermission('production','change_formula'), async (req,res,next) => {
  try {
    const { newFormula, reason } = req.body
    if (!newFormula) return res.status(400).json({ error:'newFormula es requerido.' })
    if (!reason || !String(reason).trim()) return res.status(400).json({ error:'La razón es obligatoria.' })
    res.json(await svc.changeOrderFormula({
      tenantId:tid(req), orderId:req.params.id,
      newFormula, reason, userId:uid(req),
      ipAddress: req.ip, userAgent: req.headers['user-agent'],
    }))
  } catch(err){next(err)}
})
router.get('/orders/:id/formula-history', checkPermission('production','read'), async (req,res,next) => {
  try {
    res.json(await svc.getOrderFormulaHistory({ tenantId:tid(req), orderId:req.params.id }))
  } catch(err){next(err)}
})

router.post('/orders/reorder', checkPermission('production','update'), async (req,res,next) => {
  try {
    const { orderedIds } = req.body
    if (!Array.isArray(orderedIds)) return res.status(400).json({ error:'orderedIds debe ser array.' })
    res.json(await svc.reorderQueue({ tenantId:tid(req), orderedIds }))
  } catch(err){next(err)}
})

// ── Turnos ────────────────────────────────────────────────────────────────────

router.get('/shifts/history', checkPermission('production','read'), async (req,res,next) => {
  try {
    const { dateFrom, dateTo, operatorId, status, page, limit } = req.query
    res.json(await svc.listShiftsHistory({
      tenantId:tid(req), dateFrom, dateTo, operatorId, status,
      page:parseInt(page||1), limit:parseInt(limit||20),
    }))
  } catch(err){next(err)}
})


router.get('/shifts/:id/summary', checkPermission('production','read'), async (req,res,next) => {
  try {
    const summary = await svc.getShiftSummary({ tenantId:tid(req), shiftId:req.params.id })
    if (!summary) return res.status(404).json({ error:'Turno no encontrado.' })
    res.json(summary)
  } catch(err){next(err)}
})

router.get('/shifts/active', checkPermission('production','read'), async (req,res,next) => {
  try { res.json(await svc.getActiveShifts({ tenantId:tid(req) })) }
  catch(err){next(err)}
})
router.get('/shifts/:id', checkPermission('production','read'), async (req,res,next) => {
  try {
    const s = await svc.getShift({ tenantId:tid(req), shiftId:req.params.id })
    if (!s) return res.status(404).json({ error:'Turno no encontrado.' })
    res.json(s)
  } catch(err){next(err)}
})
router.post('/shifts', checkPermission('production','create'), async (req,res,next) => {
  try {
    const { lineId,shiftNumber,shiftDate,operatorId,supervisorId } = req.body
    if (!shiftNumber||!shiftDate||!operatorId||!supervisorId) return res.status(400).json({ error:'Faltan campos requeridos.' })
    res.status(201).json(await svc.openShift({
      tenantId:tid(req), lineId,shiftNumber,shiftDate,operatorId,supervisorId,
      userId:uid(req),ipAddress:ip(req),userAgent:ua(req)
    }))
  } catch(err){
    if(err.code==='23505') return res.status(409).json({error:'Ya existe un turno para esa línea, fecha y número.'})
    next(err)
  }
})
router.post('/shifts/:id/reopen', async (req,res,next) => {
  try {
    res.json(await svc.reopenShift({
      tenantId:tid(req), shiftId:req.params.id,
      userId:uid(req), ipAddress:ip(req), userAgent:ua(req)
    }))
  } catch(err){next(err)}
})

router.post('/shifts/:id/close', checkPermission('production','close_own_shift'), async (req,res,next) => {
  try { res.json(await svc.closeShift({ tenantId:tid(req), shiftId:req.params.id, userId:uid(req), ipAddress:ip(req), userAgent:ua(req) })) }
  catch(err){next(err)}
})
router.post('/shifts/:id/validate', checkPermission('production','update'), async (req,res,next) => {
  try {
    const { approved,supervisorNotes } = req.body
    res.json(await svc.validateShift({ tenantId:tid(req), shiftId:req.params.id, approved:approved!==false, supervisorNotes, userId:uid(req), ipAddress:ip(req), userAgent:ua(req) }))
  } catch(err){next(err)}
})

// ── Captura de paquetes (ahora incluye productionOrderId) ─────────────────────
router.post('/shifts/:id/packages', checkPermission('production','create'), async (req,res,next) => {
  try {
    const {
      productionOrderId, quantityUnits, realWeightKg, theoreticalWeightKg,
      lengthMm, isSecondQuality, secondQualityProductId, notes,
      qualityGradeId, gradeNumber,    // §6f
      dynamicAttributes,              // §C: atributos custom según product_kind.capture_schema
    } = req.body
    if (!realWeightKg) return res.status(400).json({ error:'realWeightKg es requerido.' })
    res.status(201).json(await svc.capturePackage({
      tenantId: tid(req), shiftId: req.params.id,
      productionOrderId, quantityUnits, realWeightKg, theoreticalWeightKg,
      lengthMm, isSecondQuality, secondQualityProductId, notes,
      qualityGradeId, gradeNumber,
      dynamicAttributes,
      userId: uid(req),
    }))
  } catch(err){
    if (err.status) return res.status(err.status).json({ error: err.message })
    next(err)
  }
})

// ── Carga de MP ───────────────────────────────────────────────────────────────
router.post('/shifts/:id/mp-loads', checkPermission('production','create'), async (req,res,next) => {
  try {
    const { rawMaterialId,kg,isReplacement,notes,lotId,unitId,quantity } = req.body
    if (!rawMaterialId||!kg) return res.status(400).json({ error:'rawMaterialId y kg son requeridos.' })
    res.status(201).json(await svc.loadMp({
      tenantId:tid(req), shiftId:req.params.id,
      rawMaterialId, kg, isReplacement, notes,
      lotId, unitId, quantity,
      userId: req.auth.userId,
    }))
  } catch(err){next(err)}
})

// ── Merma ─────────────────────────────────────────────────────────────────────
router.post('/shifts/:id/scrap', checkPermission('production','create'), async (req,res,next) => {
  try {
    const { scrapType, scrapTypeId, destination, kg, notes, productionOrderId } = req.body
    if ((!scrapType && !scrapTypeId) || !kg) {
      return res.status(400).json({ error:'scrapType o scrapTypeId, y kg son requeridos.' })
    }
    res.status(201).json(await svc.recordScrap({
      tenantId: tid(req), shiftId: req.params.id,
      scrapType, scrapTypeId, destination, kg, notes,
      productionOrderId, userId: uid(req),
    }))
  } catch(err){
    if (err.status) return res.status(err.status).json({ error: err.message })
    next(err)
  }
})

// ── Incidencias ───────────────────────────────────────────────────────────────
router.post('/shifts/:id/incidents', checkPermission('production','create'), async (req,res,next) => {
  try {
    const { category,description,durationMin } = req.body
    if (!category||!description) return res.status(400).json({ error:'category y description son requeridos.' })
    res.status(201).json(await svc.reportIncident({ tenantId:tid(req), shiftId:req.params.id, category,description,durationMin,userId:uid(req) }))
  } catch(err){next(err)}
})

// ── Editar/eliminar registros del turno ───────────────────────────────────────
// Dual-mode:
//   - Operador del turno (status='active'): sin razón. Delete sólo dentro de 30 min.
//   - Supervisor/admin (status='pending_handover'): razón obligatoria, registra en shift_corrections.
// La validación fina de modo (operador del turno vs supervisor) y de razón vive
// en productionService.resolveEditMode. A nivel de ruta pedimos permiso
// `production:create` (operador) O `production:update` (supervisor): así un
// operador con permiso de captura no obtiene 403 antes de llegar al service.
const editOrCreate = checkAnyPermission([['production','create'], ['production','update']])

router.patch('/shifts/:id/packages/:pid', editOrCreate, async (req,res,next) => {
  try {
    const { reason, ...updates } = req.body || {}
    res.json(await svc.editPackage({
      tenantId:tid(req), shiftId:req.params.id, packageId:req.params.pid,
      updates, reason, userId:uid(req),
    }))
  } catch(err){next(err)}
})
router.delete('/shifts/:id/packages/:pid', editOrCreate, async (req,res,next) => {
  try {
    const { reason } = req.body || {}
    res.json(await svc.deletePackage({
      tenantId:tid(req), shiftId:req.params.id, packageId:req.params.pid,
      reason, userId:uid(req),
    }))
  } catch(err){next(err)}
})
router.patch('/shifts/:id/scrap/:sid', editOrCreate, async (req,res,next) => {
  try {
    const { reason, ...updates } = req.body || {}
    res.json(await svc.editScrap({
      tenantId:tid(req), shiftId:req.params.id, scrapId:req.params.sid,
      updates, reason, userId:uid(req),
    }))
  } catch(err){next(err)}
})
router.delete('/shifts/:id/scrap/:sid', editOrCreate, async (req,res,next) => {
  try {
    const { reason } = req.body || {}
    res.json(await svc.deleteScrap({
      tenantId:tid(req), shiftId:req.params.id, scrapId:req.params.sid,
      reason, userId:uid(req),
    }))
  } catch(err){next(err)}
})
router.patch('/shifts/:id/incidents/:iid', editOrCreate, async (req,res,next) => {
  try {
    const { reason, ...updates } = req.body || {}
    res.json(await svc.editIncident({
      tenantId:tid(req), shiftId:req.params.id, incidentId:req.params.iid,
      updates, reason, userId:uid(req),
    }))
  } catch(err){next(err)}
})
router.delete('/shifts/:id/incidents/:iid', editOrCreate, async (req,res,next) => {
  try {
    const { reason } = req.body || {}
    res.json(await svc.deleteIncident({
      tenantId:tid(req), shiftId:req.params.id, incidentId:req.params.iid,
      reason, userId:uid(req),
    }))
  } catch(err){next(err)}
})

// MP loads — solo modo operador (no hay flujo supervisor en pending_handover)
router.patch('/shifts/:id/mp-loads/:mid', editOrCreate, async (req,res,next) => {
  try {
    const { ...updates } = req.body || {}
    res.json(await svc.editMpLoad({
      tenantId:tid(req), shiftId:req.params.id, mpLoadId:req.params.mid,
      updates, userId:uid(req),
    }))
  } catch(err){next(err)}
})
router.delete('/shifts/:id/mp-loads/:mid', editOrCreate, async (req,res,next) => {
  try {
    res.json(await svc.deleteMpLoad({
      tenantId:tid(req), shiftId:req.params.id, mpLoadId:req.params.mid,
      userId:uid(req),
    }))
  } catch(err){next(err)}
})
router.get('/shifts/:id/corrections', checkPermission('production','read'), async (req,res,next) => {
  try {
    res.json(await svc.listCorrections({ tenantId:tid(req), shiftId:req.params.id }))
  } catch(err){next(err)}
})

// ── Agregar registros faltantes (supervisor, en validación pre-cierre) ───────
router.post('/shifts/:id/packages/add', checkPermission('production','update'), async (req,res,next) => {
  try {
    const {
      productionOrderId, realWeightKg, isSecondQuality, quantityUnits, notes, reason,
      qualityGradeId, gradeNumber,  // §6f
    } = req.body
    if (!reason || !String(reason).trim()) return res.status(400).json({ error:'La razón es obligatoria.' })
    res.status(201).json(await svc.addPackage({
      tenantId:tid(req), shiftId:req.params.id,
      productionOrderId, realWeightKg, isSecondQuality, quantityUnits, notes, reason,
      qualityGradeId, gradeNumber,
      userId:uid(req),
    }))
  } catch(err){
    if (err.status) return res.status(err.status).json({ error: err.message })
    next(err)
  }
})
router.post('/shifts/:id/scrap/add', checkPermission('production','update'), async (req,res,next) => {
  try {
    const { productionOrderId, scrapType, scrapTypeId, destination, kg, notes, reason } = req.body
    if (!reason || !String(reason).trim()) return res.status(400).json({ error:'La razón es obligatoria.' })
    res.status(201).json(await svc.addScrap({
      tenantId:tid(req), shiftId:req.params.id,
      productionOrderId, scrapType, scrapTypeId, destination, kg, notes, reason,
      userId:uid(req),
    }))
  } catch(err){
    if (err.status) return res.status(err.status).json({ error: err.message })
    next(err)
  }
})
router.post('/shifts/:id/incidents/add', checkPermission('production','update'), async (req,res,next) => {
  try {
    const { category, description, durationMin, reason } = req.body
    if (!reason || !String(reason).trim()) return res.status(400).json({ error:'La razón es obligatoria.' })
    res.status(201).json(await svc.addIncident({
      tenantId:tid(req), shiftId:req.params.id,
      category, description, durationMin, reason,
      userId:uid(req),
    }))
  } catch(err){next(err)}
})

// ── Cierre explícito de órdenes ──────────────────────────────────────────────
router.post('/orders/:id/close', checkPermission('production','update'), async (req,res,next) => {
  try {
    const { reason } = req.body
    res.json(await svc.closeOrder({
      tenantId:tid(req), orderId:req.params.id, reason,
      userId:uid(req), ipAddress: req.ip, userAgent: req.headers['user-agent'],
    }))
  } catch(err){next(err)}
})
router.post('/orders/:id/reopen', checkPermission('production','update'), async (req,res,next) => {
  try {
    const { reason } = req.body
    if (!reason || !String(reason).trim()) return res.status(400).json({ error:'La razón es obligatoria.' })
    res.json(await svc.reopenOrder({
      tenantId:tid(req), orderId:req.params.id, reason,
      userId:uid(req), ipAddress: req.ip, userAgent: req.headers['user-agent'],
    }))
  } catch(err){next(err)}
})

// ── Turnos programados ────────────────────────────────────────────────────────
router.get('/scheduled-shifts', checkPermission('production','read'), async (req,res,next) => {
  try {
    const { operatorId,dateFrom,dateTo,status } = req.query
    res.json(await svcSched.listScheduledShifts({ tenantId:tid(req), operatorId,dateFrom,dateTo,status }))
  } catch(err){next(err)}
})
router.get('/scheduled-shifts/my-today', async (req,res,next) => {
  try { res.json(await svcSched.getTodayShiftsForOperator({ tenantId:tid(req), operatorId:uid(req) })) }
  catch(err){next(err)}
})
router.get('/scheduled-shifts/operator-hours', checkPermission('production','read'), async (req,res,next) => {
  try {
    const { operatorId, date } = req.query
    if (!operatorId || !date) return res.status(400).json({ error: 'operatorId y date son requeridos.' })
    res.json(await svcSched.getOperatorHoursForDate({ tenantId:tid(req), operatorId, date }))
  } catch(err){next(err)}
})
router.post('/scheduled-shifts', checkPermission('production','manage'), async (req,res,next) => {
  try {
    const { productionOrderId,shiftNumber,scheduledDate,scheduledStart,operatorId,supervisorId,lineId,notes,
            isOvertimeAcknowledged, overtimeContext } = req.body
    if (!shiftNumber||!scheduledDate||!scheduledStart||!operatorId||!supervisorId) return res.status(400).json({ error:'Faltan campos requeridos.' })
    res.status(201).json(await svcSched.scheduleShift({
      tenantId:tid(req), productionOrderId,shiftNumber,scheduledDate,
      scheduledStart,operatorId,supervisorId,lineId,notes,
      isOvertimeAcknowledged: !!isOvertimeAcknowledged, overtimeContext,
      userId:uid(req),ipAddress:ip(req),userAgent:ua(req)
    }))
  } catch(err){
    if(err.code==='23505') return res.status(409).json({error:'Ya existe un turno programado para esa fecha y número.'})
    next(err)
  }
})
router.patch('/scheduled-shifts/:id', checkPermission('production','manage'), async (req,res,next) => {
  try {
    const { scheduledDate,scheduledStart,operatorId,notes,status,isOvertime,absenceRegistered,replacementOperatorId } = req.body
    res.json(await svcSched.updateScheduledShift({ tenantId:tid(req), id:req.params.id, scheduledDate,scheduledStart,operatorId,notes,status,isOvertime,absenceRegistered,replacementOperatorId, userId:uid(req),ipAddress:ip(req),userAgent:ua(req) }))
  } catch(err){next(err)}
})
router.post('/scheduled-shifts/:id/confirm', async (req,res,next) => {
  try { res.json(await svcSched.confirmPresence({ tenantId:tid(req), id:req.params.id, userId:uid(req),ipAddress:ip(req),userAgent:ua(req) })) }
  catch(err){next(err)}
})

// ─── Selección de orden activa por el operador del turno ──────────────────────
// Persiste production_order_id en production_shifts. El operador puede elegir
// orden al iniciar el turno o cambiarla durante (multi-orden por turno).
router.patch('/shifts/:id/active-order', checkPermission('production','create'), async (req,res,next) => {
  try {
    const { orderId } = req.body
    if (!orderId) return res.status(400).json({ error: 'orderId es obligatorio.' })
    res.json(await svc.setShiftActiveOrder({
      tenantId: tid(req), shiftId: req.params.id, orderId, userId: uid(req),
    }))
  } catch (err) { next(err) }
})

// ─── Forzar cierre de turno (solo supervisor, después de 5 min de espera) ─────
router.post('/shifts/:id/force-close', checkPermission('production','update'), async (req,res,next) => {
  try {
    const { reason } = req.body
    const result = await svc.forceCloseShift({
      tenantId: tid(req), shiftId: req.params.id,
      reason: reason || null,
      userId: uid(req), ipAddress: ip(req), userAgent: ua(req),
    })
    res.json({ ...result, message: `Turno cerrado. ${result.operator_name} fue reemplazado.` })
  } catch(err) { next(err) }
})

// ─── Resumen de turno saliente para pantalla de recepción ────────────────────
router.get('/shifts/:id/handover-summary', checkPermission('production','read'), async (req,res,next) => {
  try {
    const result = await svc.getHandoverSummary({
      tenantId: tid(req),
      incomingShiftId: req.params.id,
      userId: uid(req),
    })
    res.json(result)
  } catch(err) { next(err) }
})

// ─── Operador entrante acepta la recepción (con o sin observaciones) ─────────
router.post('/shifts/:id/accept-handover', checkPermission('production','create'), async (req,res,next) => {
  try {
    const { accepted, issue_description } = req.body
    const result = await svc.acceptHandover({
      tenantId:        tid(req),
      incomingShiftId: req.params.id,
      userId:          uid(req),
      accepted,
      issueDescription: issue_description,
      ipAddress:       ip(req),
      userAgent:       ua(req),
    })
    res.json({ ...result, message: 'Turno recibido correctamente.' })
  } catch(err) { next(err) }
})

// ─── Resumen del turno cerrado (para el operador que cerró) ───────────────────
router.get('/shifts/:id/closed-summary', checkPermission('production','read'), async (req,res,next) => {
  try {
    const result = await svc.getClosedShiftSummary({
      tenantId: tid(req),
      shiftId:  req.params.id,
      userId:   uid(req),
    })
    res.json(result)
  } catch(err) { next(err) }
})

// ─── Configuración de turnos ──────────────────────────────────────────────────
router.get('/shift-config', checkPermission('production','read'), async (req, res, next) => {
  try { res.json(await svcShiftCfg.getShiftConfig({ tenantId: tid(req) })) }
  catch(err) { next(err) }
})

router.put('/shift-config', checkPermission('production','manage'), async (req, res, next) => {
  try {
    const { shifts } = req.body
    if (!Array.isArray(shifts) || !shifts.length) return res.status(400).json({ error: 'Se requiere array de turnos.' })
    res.json(await svcShiftCfg.updateShiftConfig({ tenantId: tid(req), shifts }))
  } catch(err) { next(err) }
})

module.exports = router
