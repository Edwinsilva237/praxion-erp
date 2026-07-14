'use strict'

const express                 = require('express')
const { tenantResolver }      = require('../../middleware/tenantResolver')
const { authGuard }           = require('../../middleware/authGuard')
const { requireActiveTenant } = require('../../middleware/requireActiveTenant')
const { checkPermission }     = require('../../middleware/checkPermission')
const employeeService         = require('./employeeService')
const vacationService         = require('./vacationService')

const router = express.Router()
router.use(tenantResolver)
router.use(authGuard)
router.use(requireActiveTenant)

const ctx = (req) => ({ tenantId: req.tenant.id, userId: req.auth.userId, ipAddress: req.ip, userAgent: req.get('user-agent') })

// ── Tabla de días por antigüedad (config del tenant) ─────────────────────────

router.get('/vacations/rules', checkPermission('hr', 'read'), async (req, res, next) => {
  try {
    res.json(await vacationService.getEntitlementRules({ tenantId: req.tenant.id }))
  } catch (err) { next(err) }
})

router.put('/vacations/rules', checkPermission('hr', 'manage'), async (req, res, next) => {
  try {
    res.json(await vacationService.updateEntitlementRules({ ...ctx(req), rules: req.body.rules }))
  } catch (err) { next(err) }
})

router.post('/vacations/rules/reset', checkPermission('hr', 'manage'), async (req, res, next) => {
  try {
    res.json(await vacationService.resetEntitlementRules({ ...ctx(req) }))
  } catch (err) { next(err) }
})

// ── Empleados ─────────────────────────────────────────────────────────────────

router.get('/employees', checkPermission('hr', 'read'), async (req, res, next) => {
  try {
    const rows = await employeeService.list({
      tenantId: req.tenant.id,
      includeInactive: req.query.includeInactive === '1' || req.query.includeInactive === 'true',
      search: req.query.search,
    })
    res.json(rows)
  } catch (err) { next(err) }
})

router.get('/employees/:id', checkPermission('hr', 'read'), async (req, res, next) => {
  try {
    const row = await employeeService.get({ tenantId: req.tenant.id, id: req.params.id })
    if (!row) return res.status(404).json({ error: 'Empleado no encontrado.' })
    res.json(row)
  } catch (err) { next(err) }
})

router.post('/employees', checkPermission('hr', 'manage'), async (req, res, next) => {
  try {
    res.status(201).json(await employeeService.create({ ...ctx(req), body: req.body }))
  } catch (err) { next(err) }
})

router.patch('/employees/:id', checkPermission('hr', 'manage'), async (req, res, next) => {
  try {
    res.json(await employeeService.update({ ...ctx(req), id: req.params.id, body: req.body }))
  } catch (err) { next(err) }
})

router.delete('/employees/:id', checkPermission('hr', 'manage'), async (req, res, next) => {
  try {
    res.json(await employeeService.remove({ ...ctx(req), id: req.params.id }))
  } catch (err) { next(err) }
})

// ── Vacaciones por empleado ───────────────────────────────────────────────────

/** Saldo vacacional: periodos + días gozados/pendientes + prima + resumen. */
router.get('/employees/:id/vacations', checkPermission('hr', 'read'), async (req, res, next) => {
  try {
    res.json(await vacationService.getBalance({ tenantId: req.tenant.id, employeeId: req.params.id }))
  } catch (err) { next(err) }
})

/** Bitácora de movimientos vacacionales del empleado. */
router.get('/employees/:id/vacations/ledger', checkPermission('hr', 'read'), async (req, res, next) => {
  try {
    res.json(await vacationService.getLedger({ tenantId: req.tenant.id, employeeId: req.params.id }))
  } catch (err) { next(err) }
})

/** Re-generar/actualizar los periodos del empleado (idempotente). */
router.post('/employees/:id/vacations/generate', checkPermission('hr', 'manage'), async (req, res, next) => {
  try {
    res.json(await vacationService.generatePeriodsForEmployee({ tenantId: req.tenant.id, userId: req.auth.userId, employeeId: req.params.id }))
  } catch (err) { next(err) }
})

/** Registrar días gozados en un periodo. */
router.post('/employees/:id/vacations/taken', checkPermission('hr', 'manage'), async (req, res, next) => {
  try {
    const { periodId, days, startDate, endDate, note } = req.body
    res.status(201).json(await vacationService.registerTaken({ ...ctx(req), employeeId: req.params.id, periodId, days, startDate, endDate, note }))
  } catch (err) { next(err) }
})

/** Registrar días pagados sin gozar. */
router.post('/employees/:id/vacations/paid', checkPermission('hr', 'manage'), async (req, res, next) => {
  try {
    const { periodId, days, note } = req.body
    res.status(201).json(await vacationService.registerPaid({ ...ctx(req), employeeId: req.params.id, periodId, days, note }))
  } catch (err) { next(err) }
})

/** Ajuste manual (con signo) sobre un periodo. */
router.post('/employees/:id/vacations/adjustment', checkPermission('hr', 'manage'), async (req, res, next) => {
  try {
    const { periodId, days, note } = req.body
    res.status(201).json(await vacationService.registerAdjustment({ ...ctx(req), employeeId: req.params.id, periodId, days, note }))
  } catch (err) { next(err) }
})

/** Borrar un movimiento (corrección de captura). */
router.delete('/employees/:id/vacations/ledger/:entryId', checkPermission('hr', 'manage'), async (req, res, next) => {
  try {
    res.json(await vacationService.deleteLedgerEntry({ ...ctx(req), employeeId: req.params.id, entryId: req.params.entryId }))
  } catch (err) { next(err) }
})

module.exports = router
