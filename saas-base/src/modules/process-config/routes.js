'use strict'

/**
 * SaaS v2 — Rutas del Process Template.
 *
 * GET    /api/process-config       — leer config del tenant
 * PATCH  /api/process-config       — actualizar uno o más flags
 *
 * Referencia: docs/saas-v2/00-design.md §2.2.1.
 */

const express = require('express')
const { tenantResolver }       = require('../../middleware/tenantResolver')
const { authGuard }            = require('../../middleware/authGuard')
const { requireActiveTenant }  = require('../../middleware/requireActiveTenant')
const { checkPermission }      = require('../../middleware/checkPermission')
const svc                      = require('./processConfigService')
const unitsSvc                 = require('./unitsService')
const whTypesSvc               = require('./warehouseTypesService')
const scrapTypesSvc            = require('./scrapTypesService')
const qualityGradesSvc         = require('./qualityGradesService')
const shiftRolesSvc            = require('./shiftRolesService')
const productKindsSvc          = require('./productKindsService')
const tenantAllergensSvc       = require('./tenantAllergensService')

const router = express.Router()
router.use(tenantResolver)
router.use(authGuard)
router.use(requireActiveTenant)

const tid = (req) => req.tenant.id
const uid = (req) => req.auth.userId
const ip  = (req) => req.ip
const ua  = (req) => req.get('user-agent')

const handleSvcError = (err, res, next) => {
  if (err.status) return res.status(err.status).json({ error: err.message })
  next(err)
}

// ═══════════════════════════════════════════════════════════════════════════
// tenant_process_config (flags globales)
// ═══════════════════════════════════════════════════════════════════════════

/** GET /api/process-config */
router.get('/', checkPermission('process_config', 'read'), async (req, res, next) => {
  try {
    const config = await svc.getConfig({ tenantId: tid(req) })
    res.json(config)
  } catch (err) { next(err) }
})

/** PATCH /api/process-config */
router.patch('/', checkPermission('process_config', 'update'), async (req, res, next) => {
  try {
    const config = await svc.updateConfig({
      tenantId: tid(req),
      userId:   uid(req),
      updates:  req.body,
      ipAddress: ip(req),
      userAgent: ua(req),
    })
    res.json(config)
  } catch (err) { handleSvcError(err, res, next) }
})

// ═══════════════════════════════════════════════════════════════════════════
// tenant_units (catálogo de unidades de medida)
// ═══════════════════════════════════════════════════════════════════════════

/** GET /api/process-config/units?unitType=weight&isActive=true */
router.get('/units', checkPermission('tenant_catalogs', 'read'), async (req, res, next) => {
  try {
    const { unitType, isActive } = req.query
    const units = await unitsSvc.listUnits({
      tenantId: tid(req),
      unitType,
      isActive: isActive !== undefined ? isActive === 'true' : undefined,
    })
    res.json(units)
  } catch (err) { next(err) }
})

/** GET /api/process-config/units/:id */
router.get('/units/:id', checkPermission('tenant_catalogs', 'read'), async (req, res, next) => {
  try {
    const u = await unitsSvc.getUnit({ tenantId: tid(req), id: req.params.id })
    if (!u) return res.status(404).json({ error: 'Unidad no encontrada.' })
    res.json(u)
  } catch (err) { next(err) }
})

/** POST /api/process-config/units */
router.post('/units', checkPermission('tenant_catalogs', 'update'), async (req, res, next) => {
  try {
    const u = await unitsSvc.createUnit({
      tenantId: tid(req),
      userId:   uid(req),
      ipAddress: ip(req),
      userAgent: ua(req),
      code:      req.body.code,
      name:      req.body.name,
      symbol:    req.body.symbol,
      unitType:  req.body.unit_type ?? req.body.unitType,
      isBase:    req.body.is_base ?? req.body.isBase ?? false,
      decimals:  req.body.decimals,
      sortOrder: req.body.sort_order ?? req.body.sortOrder ?? 0,
    })
    res.status(201).json(u)
  } catch (err) { handleSvcError(err, res, next) }
})

/** PATCH /api/process-config/units/:id */
router.patch('/units/:id', checkPermission('tenant_catalogs', 'update'), async (req, res, next) => {
  try {
    const u = await unitsSvc.updateUnit({
      tenantId: tid(req),
      userId:   uid(req),
      id:       req.params.id,
      ipAddress: ip(req),
      userAgent: ua(req),
      name:      req.body.name,
      symbol:    req.body.symbol,
      decimals:  req.body.decimals,
      sortOrder: req.body.sort_order ?? req.body.sortOrder,
      isActive:  req.body.is_active ?? req.body.isActive,
    })
    res.json(u)
  } catch (err) { handleSvcError(err, res, next) }
})

// ═══════════════════════════════════════════════════════════════════════════
// tenant_unit_conversions
// ═══════════════════════════════════════════════════════════════════════════

/** GET /api/process-config/unit-conversions?fromUnitId=...&toUnitId=... */
router.get('/unit-conversions', checkPermission('tenant_catalogs', 'read'), async (req, res, next) => {
  try {
    const { fromUnitId, toUnitId } = req.query
    const items = await unitsSvc.listConversions({
      tenantId: tid(req), fromUnitId, toUnitId,
    })
    res.json(items)
  } catch (err) { next(err) }
})

/** POST /api/process-config/unit-conversions */
router.post('/unit-conversions', checkPermission('tenant_catalogs', 'update'), async (req, res, next) => {
  try {
    const c = await unitsSvc.createConversion({
      tenantId: tid(req),
      userId:   uid(req),
      ipAddress: ip(req),
      userAgent: ua(req),
      fromUnitId: req.body.from_unit_id ?? req.body.fromUnitId,
      toUnitId:   req.body.to_unit_id   ?? req.body.toUnitId,
      factor:     req.body.factor,
    })
    res.status(201).json(c)
  } catch (err) { handleSvcError(err, res, next) }
})

/** POST /api/process-config/unit-conversions/convert
 *  body: { from_unit_id, to_unit_id, quantity }
 *  Devuelve la cantidad convertida o 422 si no se puede.
 */
router.post('/unit-conversions/convert', checkPermission('tenant_catalogs', 'read'), async (req, res, next) => {
  try {
    const { from_unit_id, to_unit_id, quantity } = req.body
    if (!from_unit_id || !to_unit_id || quantity === undefined) {
      return res.status(400).json({ error: 'from_unit_id, to_unit_id y quantity son requeridos.' })
    }
    const result = await unitsSvc.convert({
      tenantId: tid(req),
      fromUnitId: from_unit_id, toUnitId: to_unit_id, quantity,
    })
    if (result === null) {
      return res.status(422).json({ error: 'No se puede convertir entre estas unidades.' })
    }
    res.json({ from_unit_id, to_unit_id, quantity_in: parseFloat(quantity), quantity_out: result })
  } catch (err) { handleSvcError(err, res, next) }
})

// ═══════════════════════════════════════════════════════════════════════════
// tenant_warehouse_types
// ═══════════════════════════════════════════════════════════════════════════

/** GET /api/process-config/warehouse-types?systemRole=scrap&isActive=true */
router.get('/warehouse-types', checkPermission('tenant_catalogs', 'read'), async (req, res, next) => {
  try {
    const { systemRole, isActive } = req.query
    const items = await whTypesSvc.listTypes({
      tenantId: tid(req),
      systemRole,
      isActive: isActive !== undefined ? isActive === 'true' : undefined,
    })
    res.json(items)
  } catch (err) { next(err) }
})

/** GET /api/process-config/warehouse-types/:id */
router.get('/warehouse-types/:id', checkPermission('tenant_catalogs', 'read'), async (req, res, next) => {
  try {
    const t = await whTypesSvc.getType({ tenantId: tid(req), id: req.params.id })
    if (!t) return res.status(404).json({ error: 'Tipo de almacén no encontrado.' })
    res.json(t)
  } catch (err) { next(err) }
})

/** POST /api/process-config/warehouse-types */
router.post('/warehouse-types', checkPermission('tenant_catalogs', 'update'), async (req, res, next) => {
  try {
    const t = await whTypesSvc.createType({
      tenantId: tid(req),
      userId:   uid(req),
      ipAddress: ip(req),
      userAgent: ua(req),
      code:        req.body.code,
      name:        req.body.name,
      systemRole:  req.body.system_role ?? req.body.systemRole,
      defaultScrapDestination:
        req.body.default_scrap_destination ?? req.body.defaultScrapDestination,
      color:       req.body.color,
      sortOrder:   req.body.sort_order ?? req.body.sortOrder ?? 0,
    })
    res.status(201).json(t)
  } catch (err) { handleSvcError(err, res, next) }
})

/** PATCH /api/process-config/warehouse-types/:id */
router.patch('/warehouse-types/:id', checkPermission('tenant_catalogs', 'update'), async (req, res, next) => {
  try {
    const t = await whTypesSvc.updateType({
      tenantId: tid(req),
      userId:   uid(req),
      id:       req.params.id,
      ipAddress: ip(req),
      userAgent: ua(req),
      name:       req.body.name,
      defaultScrapDestination:
        req.body.default_scrap_destination ?? req.body.defaultScrapDestination,
      color:      req.body.color,
      sortOrder:  req.body.sort_order ?? req.body.sortOrder,
      isActive:   req.body.is_active ?? req.body.isActive,
    })
    res.json(t)
  } catch (err) { handleSvcError(err, res, next) }
})

// ═══════════════════════════════════════════════════════════════════════════
// tenant_scrap_types
// ═══════════════════════════════════════════════════════════════════════════

/** GET /api/process-config/scrap-types */
router.get('/scrap-types', checkPermission('tenant_catalogs', 'read'), async (req, res, next) => {
  try {
    const { destination, isNormal, isActive } = req.query
    const items = await scrapTypesSvc.listTypes({
      tenantId: tid(req),
      destination,
      isNormal: isNormal !== undefined ? isNormal === 'true' : undefined,
      isActive: isActive !== undefined ? isActive === 'true' : undefined,
    })
    res.json(items)
  } catch (err) { next(err) }
})

/** GET /api/process-config/scrap-types/:id */
router.get('/scrap-types/:id', checkPermission('tenant_catalogs', 'read'), async (req, res, next) => {
  try {
    const t = await scrapTypesSvc.getType({ tenantId: tid(req), id: req.params.id })
    if (!t) return res.status(404).json({ error: 'Tipo de merma no encontrado.' })
    res.json(t)
  } catch (err) { next(err) }
})

/** POST /api/process-config/scrap-types */
router.post('/scrap-types', checkPermission('tenant_catalogs', 'update'), async (req, res, next) => {
  try {
    const t = await scrapTypesSvc.createType({
      tenantId: tid(req),
      userId:   uid(req),
      ipAddress: ip(req),
      userAgent: ua(req),
      code:                req.body.code,
      name:                req.body.name,
      defaultDestination:  req.body.default_destination ?? req.body.defaultDestination,
      defaultRecoveryValuePct:
        req.body.default_recovery_value_pct ?? req.body.defaultRecoveryValuePct ?? 0,
      isNormal:            req.body.is_normal ?? req.body.isNormal ?? true,
      linkedRawMaterialId: req.body.linked_raw_material_id ?? req.body.linkedRawMaterialId ?? null,
      allowsReprocessOfExpired:
        req.body.allows_reprocess_of_expired ?? req.body.allowsReprocessOfExpired ?? false,
      sortOrder:           req.body.sort_order ?? req.body.sortOrder ?? 0,
    })
    res.status(201).json(t)
  } catch (err) { handleSvcError(err, res, next) }
})

/** PATCH /api/process-config/scrap-types/:id */
router.patch('/scrap-types/:id', checkPermission('tenant_catalogs', 'update'), async (req, res, next) => {
  try {
    const t = await scrapTypesSvc.updateType({
      tenantId: tid(req),
      userId:   uid(req),
      id:       req.params.id,
      ipAddress: ip(req),
      userAgent: ua(req),
      name:                req.body.name,
      defaultDestination:  req.body.default_destination ?? req.body.defaultDestination,
      defaultRecoveryValuePct:
        req.body.default_recovery_value_pct ?? req.body.defaultRecoveryValuePct,
      isNormal:            req.body.is_normal ?? req.body.isNormal,
      linkedRawMaterialId: req.body.linked_raw_material_id ?? req.body.linkedRawMaterialId,
      allowsReprocessOfExpired:
        req.body.allows_reprocess_of_expired ?? req.body.allowsReprocessOfExpired,
      sortOrder:           req.body.sort_order ?? req.body.sortOrder,
      isActive:            req.body.is_active ?? req.body.isActive,
    })
    res.json(t)
  } catch (err) { handleSvcError(err, res, next) }
})

// ═══════════════════════════════════════════════════════════════════════════
// tenant_quality_grades
// ═══════════════════════════════════════════════════════════════════════════

/** GET /api/process-config/quality-grades */
router.get('/quality-grades', checkPermission('tenant_catalogs', 'read'), async (req, res, next) => {
  try {
    const { isActive } = req.query
    const items = await qualityGradesSvc.listGrades({
      tenantId: tid(req),
      isActive: isActive !== undefined ? isActive === 'true' : undefined,
    })
    res.json(items)
  } catch (err) { next(err) }
})

/** GET /api/process-config/quality-grades/:id */
router.get('/quality-grades/:id', checkPermission('tenant_catalogs', 'read'), async (req, res, next) => {
  try {
    const g = await qualityGradesSvc.getGrade({ tenantId: tid(req), id: req.params.id })
    if (!g) return res.status(404).json({ error: 'Calidad no encontrada.' })
    res.json(g)
  } catch (err) { next(err) }
})

/** POST /api/process-config/quality-grades */
router.post('/quality-grades', checkPermission('tenant_catalogs', 'update'), async (req, res, next) => {
  try {
    const g = await qualityGradesSvc.createGrade({
      tenantId: tid(req),
      userId:   uid(req),
      ipAddress: ip(req),
      userAgent: ua(req),
      gradeNumber:                req.body.grade_number ?? req.body.gradeNumber,
      code:                       req.body.code,
      name:                       req.body.name,
      countsForOrderFulfillment:
        req.body.counts_for_order_fulfillment ?? req.body.countsForOrderFulfillment ?? false,
      goesToWarehouseTypeId:
        req.body.goes_to_warehouse_type_id ?? req.body.goesToWarehouseTypeId ?? null,
      defaultColor:               req.body.default_color ?? req.body.defaultColor ?? null,
      sortOrder:                  req.body.sort_order ?? req.body.sortOrder ?? 0,
    })
    res.status(201).json(g)
  } catch (err) { handleSvcError(err, res, next) }
})

/** PATCH /api/process-config/quality-grades/:id */
router.patch('/quality-grades/:id', checkPermission('tenant_catalogs', 'update'), async (req, res, next) => {
  try {
    const g = await qualityGradesSvc.updateGrade({
      tenantId: tid(req),
      userId:   uid(req),
      id:       req.params.id,
      ipAddress: ip(req),
      userAgent: ua(req),
      name:                       req.body.name,
      countsForOrderFulfillment:
        req.body.counts_for_order_fulfillment ?? req.body.countsForOrderFulfillment,
      goesToWarehouseTypeId:
        req.body.goes_to_warehouse_type_id ?? req.body.goesToWarehouseTypeId,
      defaultColor:               req.body.default_color ?? req.body.defaultColor,
      sortOrder:                  req.body.sort_order ?? req.body.sortOrder,
      isActive:                   req.body.is_active ?? req.body.isActive,
    })
    res.json(g)
  } catch (err) { handleSvcError(err, res, next) }
})

// ═══════════════════════════════════════════════════════════════════════════
// tenant_shift_roles
// ═══════════════════════════════════════════════════════════════════════════

/** GET /api/process-config/shift-roles?isActive=true&isRequired=true */
router.get('/shift-roles', checkPermission('tenant_catalogs', 'read'), async (req, res, next) => {
  try {
    const { isActive, isRequired } = req.query
    const items = await shiftRolesSvc.listRoles({
      tenantId: tid(req),
      isActive:   isActive   !== undefined ? isActive   === 'true' : undefined,
      isRequired: isRequired !== undefined ? isRequired === 'true' : undefined,
    })
    res.json(items)
  } catch (err) { next(err) }
})

/** GET /api/process-config/shift-roles/:id */
router.get('/shift-roles/:id', checkPermission('tenant_catalogs', 'read'), async (req, res, next) => {
  try {
    const r = await shiftRolesSvc.getRole({ tenantId: tid(req), id: req.params.id })
    if (!r) return res.status(404).json({ error: 'Rol no encontrado.' })
    res.json(r)
  } catch (err) { next(err) }
})

/** POST /api/process-config/shift-roles */
router.post('/shift-roles', checkPermission('tenant_catalogs', 'update'), async (req, res, next) => {
  try {
    const r = await shiftRolesSvc.createRole({
      tenantId: tid(req),
      userId:   uid(req),
      ipAddress: ip(req),
      userAgent: ua(req),
      code:               req.body.code,
      name:               req.body.name,
      isRequired:         req.body.is_required          ?? req.body.isRequired         ?? false,
      isUniquePerShift:   req.body.is_unique_per_shift  ?? req.body.isUniquePerShift   ?? false,
      canCapture:         req.body.can_capture          ?? req.body.canCapture         ?? false,
      canValidate:        req.body.can_validate         ?? req.body.canValidate        ?? false,
      canHandover:        req.body.can_handover         ?? req.body.canHandover        ?? false,
      sortOrder:          req.body.sort_order           ?? req.body.sortOrder          ?? 0,
    })
    res.status(201).json(r)
  } catch (err) { handleSvcError(err, res, next) }
})

/** PATCH /api/process-config/shift-roles/:id */
router.patch('/shift-roles/:id', checkPermission('tenant_catalogs', 'update'), async (req, res, next) => {
  try {
    const r = await shiftRolesSvc.updateRole({
      tenantId: tid(req),
      userId:   uid(req),
      id:       req.params.id,
      ipAddress: ip(req),
      userAgent: ua(req),
      name:               req.body.name,
      isRequired:         req.body.is_required         ?? req.body.isRequired,
      isUniquePerShift:   req.body.is_unique_per_shift ?? req.body.isUniquePerShift,
      canCapture:         req.body.can_capture         ?? req.body.canCapture,
      canValidate:        req.body.can_validate        ?? req.body.canValidate,
      canHandover:        req.body.can_handover        ?? req.body.canHandover,
      sortOrder:          req.body.sort_order          ?? req.body.sortOrder,
      isActive:           req.body.is_active           ?? req.body.isActive,
    })
    res.json(r)
  } catch (err) { handleSvcError(err, res, next) }
})

// ═══════════════════════════════════════════════════════════════════════════
// tenant_product_kinds
// ═══════════════════════════════════════════════════════════════════════════

/** GET /api/process-config/product-kinds?isActive=true&isProduced=true */
router.get('/product-kinds', checkPermission('tenant_catalogs', 'read'), async (req, res, next) => {
  try {
    const { isActive, isProduced } = req.query
    const items = await productKindsSvc.listKinds({
      tenantId: tid(req),
      isActive:   isActive   !== undefined ? isActive   === 'true' : undefined,
      isProduced: isProduced !== undefined ? isProduced === 'true' : undefined,
    })
    res.json(items)
  } catch (err) { next(err) }
})

/** GET /api/process-config/product-kinds/:id */
router.get('/product-kinds/:id', checkPermission('tenant_catalogs', 'read'), async (req, res, next) => {
  try {
    const k = await productKindsSvc.getKind({ tenantId: tid(req), id: req.params.id })
    if (!k) return res.status(404).json({ error: 'Product kind no encontrado.' })
    res.json(k)
  } catch (err) { next(err) }
})

/** POST /api/process-config/product-kinds */
router.post('/product-kinds', checkPermission('tenant_catalogs', 'update'), async (req, res, next) => {
  try {
    const k = await productKindsSvc.createKind({
      tenantId: tid(req),
      userId:   uid(req),
      ipAddress: ip(req),
      userAgent: ua(req),
      code:                  req.body.code,
      name:                  req.body.name,
      isProduced:            req.body.is_produced               ?? req.body.isProduced               ?? true,
      baseUnitId:            req.body.base_unit_id              ?? req.body.baseUnitId              ?? null,
      attributeSchema:       req.body.attribute_schema          ?? req.body.attributeSchema          ?? null,
      captureSchema:         req.body.capture_schema            ?? req.body.captureSchema            ?? null,
      requiresLots:          req.body.requires_lots             ?? req.body.requiresLots             ?? null,
      defaultShelfLifeDays:  req.body.default_shelf_life_days   ?? req.body.defaultShelfLifeDays    ?? null,
      defaultQualityGradeId: req.body.default_quality_grade_id  ?? req.body.defaultQualityGradeId   ?? null,
    })
    res.status(201).json(k)
  } catch (err) { handleSvcError(err, res, next) }
})

/** PATCH /api/process-config/product-kinds/:id */
router.patch('/product-kinds/:id', checkPermission('tenant_catalogs', 'update'), async (req, res, next) => {
  try {
    const k = await productKindsSvc.updateKind({
      tenantId: tid(req),
      userId:   uid(req),
      id:       req.params.id,
      ipAddress: ip(req),
      userAgent: ua(req),
      name:                  req.body.name,
      isProduced:            req.body.is_produced              ?? req.body.isProduced,
      baseUnitId:            req.body.base_unit_id             ?? req.body.baseUnitId,
      attributeSchema:       req.body.attribute_schema         ?? req.body.attributeSchema,
      captureSchema:         req.body.capture_schema           ?? req.body.captureSchema,
      requiresLots:          req.body.requires_lots            ?? req.body.requiresLots,
      defaultShelfLifeDays:  req.body.default_shelf_life_days  ?? req.body.defaultShelfLifeDays,
      defaultQualityGradeId: req.body.default_quality_grade_id ?? req.body.defaultQualityGradeId,
      isActive:              req.body.is_active                ?? req.body.isActive,
    })
    res.json(k)
  } catch (err) { handleSvcError(err, res, next) }
})

// ═══════════════════════════════════════════════════════════════════════════
// tenant_allergens
// ═══════════════════════════════════════════════════════════════════════════

/** GET /api/process-config/allergens?isActive=true&isPriority=true */
router.get('/allergens', checkPermission('tenant_catalogs', 'read'), async (req, res, next) => {
  try {
    const { isActive, isPriority } = req.query
    const items = await tenantAllergensSvc.listAllergens({
      tenantId: tid(req),
      isActive:   isActive   !== undefined ? isActive   === 'true' : undefined,
      isPriority: isPriority !== undefined ? isPriority === 'true' : undefined,
    })
    res.json(items)
  } catch (err) { next(err) }
})

/** GET /api/process-config/allergens/:id */
router.get('/allergens/:id', checkPermission('tenant_catalogs', 'read'), async (req, res, next) => {
  try {
    const a = await tenantAllergensSvc.getAllergen({ tenantId: tid(req), id: req.params.id })
    if (!a) return res.status(404).json({ error: 'Alérgeno no encontrado.' })
    res.json(a)
  } catch (err) { next(err) }
})

/** POST /api/process-config/allergens */
router.post('/allergens', checkPermission('tenant_catalogs', 'update'), async (req, res, next) => {
  try {
    const a = await tenantAllergensSvc.createAllergen({
      tenantId: tid(req),
      userId:   uid(req),
      ipAddress: ip(req),
      userAgent: ua(req),
      code:        req.body.code,
      name:        req.body.name,
      isPriority:  req.body.is_priority ?? req.body.isPriority ?? false,
      sortOrder:   req.body.sort_order  ?? req.body.sortOrder  ?? 0,
    })
    res.status(201).json(a)
  } catch (err) { handleSvcError(err, res, next) }
})

/** PATCH /api/process-config/allergens/:id */
router.patch('/allergens/:id', checkPermission('tenant_catalogs', 'update'), async (req, res, next) => {
  try {
    const a = await tenantAllergensSvc.updateAllergen({
      tenantId: tid(req),
      userId:   uid(req),
      id:       req.params.id,
      ipAddress: ip(req),
      userAgent: ua(req),
      name:        req.body.name,
      isPriority:  req.body.is_priority ?? req.body.isPriority,
      sortOrder:   req.body.sort_order  ?? req.body.sortOrder,
      isActive:    req.body.is_active   ?? req.body.isActive,
    })
    res.json(a)
  } catch (err) { handleSvcError(err, res, next) }
})

module.exports = router
