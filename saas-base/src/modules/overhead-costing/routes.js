'use strict'

/**
 * SaaS v2 §Fase3 — Rutas del módulo de Overhead & Recosting.
 *
 * GET    /api/overhead/items                   — lista ítems del tenant
 * POST   /api/overhead/items                   — crea ítem
 * PATCH  /api/overhead/items/:id               — actualiza ítem
 *
 * GET    /api/overhead/periods                 — lista períodos (?year&month&itemId)
 * POST   /api/overhead/periods/ensure-current  — crea períodos del mes actual si no existen
 * PATCH  /api/overhead/periods/:id             — actualiza período
 *
 * POST   /api/overhead/close-month             — finaliza períodos y re-costea
 *                                               body: { year, month, reals: [{periodId, realAmount}] }
 *
 * GET    /api/overhead/variance-report         — reporte varianza (?year&month)
 * GET    /api/overhead/snapshots               — snapshots de orden (?orderId)
 */

const express = require('express')
const { tenantResolver }      = require('../../middleware/tenantResolver')
const { authGuard }           = require('../../middleware/authGuard')
const { requireActiveTenant } = require('../../middleware/requireActiveTenant')
const { checkPermission }     = require('../../middleware/checkPermission')

const itemsSvc     = require('./overheadItemsService')
const periodsSvc   = require('./overheadPeriodsService')
const recostingSvc = require('./recostingService')
const reportSvc    = require('./varianceReportService')
const { query, withBypass } = require('../../db')

const router = express.Router()
router.use(tenantResolver)
router.use(authGuard)
router.use(requireActiveTenant)

const tid = (req) => req.tenant.id
const uid = (req) => req.auth.userId

const handleSvcError = (err, res, next) => {
  if (err.status) return res.status(err.status).json({ error: err.message })
  next(err)
}

// ═══════════════════════════════════════════════════════════════════════════
// tenant_overhead_items
// ═══════════════════════════════════════════════════════════════════════════

/** GET /api/overhead/items */
router.get('/items', checkPermission('overhead', 'read'), async (req, res, next) => {
  try {
    const includeInactive = req.query.includeInactive === 'true'
    const items = await itemsSvc.listItems(tid(req), { includeInactive })
    res.json(items)
  } catch (err) { next(err) }
})

/** POST /api/overhead/items */
router.post('/items', checkPermission('overhead', 'update'), async (req, res, next) => {
  try {
    const item = await itemsSvc.createItem(tid(req), req.body)
    res.status(201).json(item)
  } catch (err) { handleSvcError(err, res, next) }
})

/** PATCH /api/overhead/items/:id */
router.patch('/items/:id', checkPermission('overhead', 'update'), async (req, res, next) => {
  try {
    const item = await itemsSvc.updateItem(tid(req), req.params.id, req.body)
    res.json(item)
  } catch (err) { handleSvcError(err, res, next) }
})

// ═══════════════════════════════════════════════════════════════════════════
// tenant_overhead_periods
// ═══════════════════════════════════════════════════════════════════════════

/** GET /api/overhead/periods */
router.get('/periods', checkPermission('overhead', 'read'), async (req, res, next) => {
  try {
    const { year, month, itemId, includeFinalized } = req.query
    const periods = await periodsSvc.listPeriods(tid(req), {
      year:             year     ? parseInt(year)  : undefined,
      month:            month    ? parseInt(month) : undefined,
      itemId:           itemId   || undefined,
      includeFinalized: includeFinalized !== 'false',  // default true
    })
    res.json(periods)
  } catch (err) { next(err) }
})

/** POST /api/overhead/periods/ensure-current
 *  body: { year?, month? }  — defaults a mes actual si no se envía
 */
router.post('/periods/ensure-current', checkPermission('overhead', 'update'), async (req, res, next) => {
  try {
    const now   = new Date()
    const year  = req.body.year  || now.getFullYear()
    const month = req.body.month || (now.getMonth() + 1)
    const result = await periodsSvc.ensurePeriodsForMonth(tid(req), year, month)
    res.status(201).json(result)
  } catch (err) { handleSvcError(err, res, next) }
})

/** PATCH /api/overhead/periods/:id */
router.patch('/periods/:id', checkPermission('overhead', 'update'), async (req, res, next) => {
  try {
    const period = await periodsSvc.updatePeriod(tid(req), req.params.id, req.body)
    res.json(period)
  } catch (err) { handleSvcError(err, res, next) }
})

// ═══════════════════════════════════════════════════════════════════════════
// close-month — finaliza períodos y re-costea
// ═══════════════════════════════════════════════════════════════════════════

/** POST /api/overhead/close-month
 *  body: { year, month, reals: [{ periodId, realAmount }] }
 *  Devuelve el reporte de varianza tras el cierre.
 */
router.post('/close-month', checkPermission('overhead', 'update'), async (req, res, next) => {
  try {
    const { year, month, reals } = req.body
    if (!year || !month) {
      return res.status(400).json({ error: 'year y month son requeridos.' })
    }
    if (!Array.isArray(reals) || reals.length === 0) {
      return res.status(400).json({ error: 'reals debe ser un array no vacío.' })
    }

    const result = await recostingSvc.finalizeAndRecoste(
      tid(req), year, month, reals, uid(req)
    )

    // Adjuntar reporte de varianza al response
    const report = await reportSvc.buildVarianceReport(tid(req), year, month)

    res.json({ ...result, report })
  } catch (err) { handleSvcError(err, res, next) }
})

// ═══════════════════════════════════════════════════════════════════════════
// variance-report
// ═══════════════════════════════════════════════════════════════════════════

/** GET /api/overhead/variance-report?year=&month= */
router.get('/variance-report', checkPermission('overhead', 'read'), async (req, res, next) => {
  try {
    const { year, month } = req.query
    if (!year || !month) {
      return res.status(400).json({ error: 'year y month son requeridos.' })
    }
    const report = await reportSvc.buildVarianceReport(tid(req), parseInt(year), parseInt(month))
    res.json(report)
  } catch (err) { handleSvcError(err, res, next) }
})

// ═══════════════════════════════════════════════════════════════════════════
// snapshots
// ═══════════════════════════════════════════════════════════════════════════

/** GET /api/overhead/snapshots?orderId= */
router.get('/snapshots', checkPermission('overhead', 'read'), async (req, res, next) => {
  try {
    const { orderId } = req.query
    if (!orderId) {
      return res.status(400).json({ error: 'orderId es requerido.' })
    }
    // Verificar que la orden pertenece al tenant
    const { rows: orderCheck } = await withBypass(() =>
      query(
        `SELECT id FROM production_orders WHERE id = $1 AND tenant_id = $2`,
        [orderId, tid(req)]
      )
    )
    if (!orderCheck[0]) {
      return res.status(404).json({ error: 'Orden no encontrada.' })
    }
    const { rows: snapshots } = await withBypass(() =>
      query(
        `SELECT * FROM order_cost_snapshots WHERE order_id = $1 ORDER BY created_at DESC`,
        [orderId]
      )
    )
    res.json(snapshots)
  } catch (err) { next(err) }
})

module.exports = router
