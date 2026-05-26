'use strict'

const express = require('express')
const { tenantResolver } = require('../../middleware/tenantResolver')
const { authGuard } = require('../../middleware/authGuard')
const { requireActiveTenant } = require('../../middleware/requireActiveTenant')
const { checkPermission } = require('../../middleware/checkPermission')
const exchangeRateService = require('./exchangeRateService')

const router = express.Router()

router.use(tenantResolver)
router.use(authGuard)
router.use(requireActiveTenant)

/**
 * GET /api/exchange-rates
 * Lista historial de tipos de cambio.
 * Query: currency, from, to, page, limit
 */
router.get('/', checkPermission('settings', 'read'), async (req, res, next) => {
  try {
    const { currency = 'USD', from, to, page, limit } = req.query
    const result = await exchangeRateService.listRates({
      tenantId: req.tenant.id,
      currency, from, to,
      page:  parseInt(page || 1, 10),
      limit: Math.min(parseInt(limit || 30, 10), 100),
    })
    res.json(result)
  } catch (err) { next(err) }
})

/**
 * GET /api/exchange-rates/current
 * Retorna el TC vigente de hoy o de una fecha específica.
 * Query: date (YYYY-MM-DD), currency
 */
router.get('/current', checkPermission('settings', 'read'), async (req, res, next) => {
  try {
    const { date = new Date().toISOString().split('T')[0], currency = 'USD' } = req.query
    const rate = await exchangeRateService.getRateForDate({
      tenantId: req.tenant.id, date, currency,
    })
    if (!rate) {
      return res.status(404).json({
        error: `No hay tipo de cambio disponible para ${date}. Sincroniza o captura manualmente.`,
      })
    }
    res.json(rate)
  } catch (err) { next(err) }
})

/**
 * POST /api/exchange-rates/sync
 * Fuerza la sincronización con Banxico ahora mismo.
 * Solo administradores.
 */
router.post('/sync', checkPermission('settings', 'update'), async (req, res, next) => {
  try {
    const result = await exchangeRateService.syncDailyRate()
    if (!result.success) {
      return res.status(502).json({
        error: 'No se pudo obtener el tipo de cambio de Banxico.',
        detail: result.error,
      })
    }
    res.json({
      message: 'Tipo de cambio sincronizado correctamente.',
      rate:     result.rate,
      rateDate: result.rateDate,
    })
  } catch (err) { next(err) }
})

/**
 * POST /api/exchange-rates/override
 * Sobrescribe el TC de un día específico.
 * Body: { date, currency, rate, reason }
 */
router.post('/override', checkPermission('settings', 'update'), async (req, res, next) => {
  try {
    const { date, currency = 'USD', rate, reason } = req.body
    if (!date || !rate) {
      return res.status(400).json({ error: 'date y rate son requeridos.' })
    }

    const result = await exchangeRateService.overrideRate({
      tenantId:  req.tenant.id,
      date, currency,
      rate:      parseFloat(rate),
      reason,
      userId:    req.auth.userId,
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    })
    res.json(result)
  } catch (err) { next(err) }
})

module.exports = router
