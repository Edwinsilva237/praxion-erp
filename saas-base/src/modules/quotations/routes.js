'use strict'

const express = require('express')
const { tenantResolver }  = require('../../middleware/tenantResolver')
const { authGuard }       = require('../../middleware/authGuard')
const { requireActiveTenant } = require('../../middleware/requireActiveTenant')
const { checkPermission } = require('../../middleware/checkPermission')
const requireModule       = require('../../middleware/requireModule')
const quotationService    = require('./quotationService')
const { generateQuotationPDF } = require('./quotationPdfService')
const { query }           = require('../../db')

const router = express.Router()

router.use(tenantResolver)
router.use(authGuard)
router.use(requireActiveTenant)
router.use(requireModule('quotations'))

// ── List ────────────────────────────────────────────────────────────────────
router.get('/', checkPermission('sales', 'read'), async (req, res, next) => {
  try {
    const { status, partnerId, from, to, page, limit } = req.query
    const result = await quotationService.listQuotations({
      tenantId: req.tenant.id,
      status, partnerId, from, to,
      page:  parseInt(page || 1, 10),
      limit: Math.min(parseInt(limit || 50, 10), 100),
    })
    res.json(result)
  } catch (err) { next(err) }
})

// ── Get ─────────────────────────────────────────────────────────────────────
router.get('/:id', checkPermission('sales', 'read'), async (req, res, next) => {
  try {
    const q = await quotationService.getQuotation({
      tenantId: req.tenant.id, quotationId: req.params.id,
    })
    res.json(q)
  } catch (err) { next(err) }
})

// ── Create ──────────────────────────────────────────────────────────────────
router.post('/', checkPermission('sales', 'create'), async (req, res, next) => {
  try {
    const { partnerId, currency, validUntil, notes, lines } = req.body
    const q = await quotationService.createQuotation({
      tenantId: req.tenant.id,
      userId:    req.auth.userId,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
      partnerId, currency, validUntil, notes, lines,
    })
    res.status(201).json(q)
  } catch (err) { next(err) }
})

// ── Update datos generales (draft) ───────────────────────────────────────────
router.patch('/:id', checkPermission('sales', 'update'), async (req, res, next) => {
  try {
    const { validUntil, notes, currency } = req.body
    const q = await quotationService.updateQuotation({
      tenantId: req.tenant.id, quotationId: req.params.id,
      userId: req.auth.userId, ipAddress: req.ip, userAgent: req.headers['user-agent'],
      validUntil, notes, currency,
    })
    res.json(q)
  } catch (err) { next(err) }
})

// ── Líneas (draft) ───────────────────────────────────────────────────────────
router.post('/:id/lines', checkPermission('sales', 'update'), async (req, res, next) => {
  try {
    const { productId, quantity, unit, unitPrice, discountPct, notes,
            packOptionId, packFactor } = req.body
    const q = await quotationService.addLine({
      tenantId: req.tenant.id, quotationId: req.params.id,
      userId: req.auth.userId,
      productId, quantity, unit, unitPrice, discountPct, notes,
      packOptionId, packFactor,
    })
    res.status(201).json(q)
  } catch (err) { next(err) }
})

router.patch('/:id/lines/:lineId', checkPermission('sales', 'update'), async (req, res, next) => {
  try {
    const { quantity, unit, unitPrice, discountPct, notes,
            packOptionId, packFactor } = req.body
    const q = await quotationService.updateLine({
      tenantId: req.tenant.id, quotationId: req.params.id, lineId: req.params.lineId,
      userId: req.auth.userId,
      quantity, unit, unitPrice, discountPct, notes,
      packOptionId, packFactor,
    })
    res.json(q)
  } catch (err) { next(err) }
})

router.delete('/:id/lines/:lineId', checkPermission('sales', 'update'), async (req, res, next) => {
  try {
    const q = await quotationService.deleteLine({
      tenantId: req.tenant.id, quotationId: req.params.id, lineId: req.params.lineId,
    })
    res.json(q)
  } catch (err) { next(err) }
})

// ── PDF ──────────────────────────────────────────────────────────────────────
router.get('/:id/pdf', checkPermission('sales', 'read'), async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT quotation_number FROM quotations WHERE id = $1 AND tenant_id = $2`,
      [req.params.id, req.tenant.id]
    )
    if (!rows.length) return res.status(404).json({ error: 'Cotización no encontrada.' })
    const buf = await generateQuotationPDF({ tenantId: req.tenant.id, quotationId: req.params.id })
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `inline; filename="${rows[0].quotation_number}.pdf"`)
    res.end(buf)
  } catch (err) { next(err) }
})

// ── Contactos del partner para modal de envío ────────────────────────────────
router.get('/:id/contacts', checkPermission('sales', 'read'), async (req, res, next) => {
  try {
    const q = await quotationService.getQuotation({
      tenantId: req.tenant.id, quotationId: req.params.id,
    })
    const contacts = await quotationService.listPartnerContacts(req.tenant.id, q.partner_id)
    res.json({ contacts, defaultRecipients: contacts.filter(c => c.email).map(c => c.email) })
  } catch (err) { next(err) }
})

// ── Transiciones de estado ───────────────────────────────────────────────────
router.post('/:id/send', checkPermission('sales', 'update'), async (req, res, next) => {
  try {
    const { emails, skipEmail } = req.body
    const q = await quotationService.sendQuotation({
      tenantId: req.tenant.id, quotationId: req.params.id,
      userId: req.auth.userId, ipAddress: req.ip, userAgent: req.headers['user-agent'],
      emails: Array.isArray(emails) ? emails : (emails ? [emails] : []),
      skipEmail: !!skipEmail,
    })
    res.json(q)
  } catch (err) { next(err) }
})

router.post('/:id/accept', checkPermission('sales', 'update'), async (req, res, next) => {
  try {
    const q = await quotationService.acceptQuotation({
      tenantId: req.tenant.id, quotationId: req.params.id,
      userId: req.auth.userId, ipAddress: req.ip, userAgent: req.headers['user-agent'],
    })
    res.json(q)
  } catch (err) { next(err) }
})

router.post('/:id/convert', checkPermission('sales', 'create'), async (req, res, next) => {
  try {
    const result = await quotationService.convertToOrder({
      tenantId: req.tenant.id, quotationId: req.params.id,
      userId: req.auth.userId, ipAddress: req.ip, userAgent: req.headers['user-agent'],
    })
    res.json(result)
  } catch (err) { next(err) }
})

router.post('/:id/reject', checkPermission('sales', 'update'), async (req, res, next) => {
  try {
    const { reason } = req.body
    const q = await quotationService.rejectQuotation({
      tenantId: req.tenant.id, quotationId: req.params.id,
      userId: req.auth.userId, ipAddress: req.ip, userAgent: req.headers['user-agent'],
      reason,
    })
    res.json(q)
  } catch (err) { next(err) }
})

router.post('/:id/cancel', checkPermission('sales', 'update'), async (req, res, next) => {
  try {
    const q = await quotationService.cancelQuotation({
      tenantId: req.tenant.id, quotationId: req.params.id,
      userId: req.auth.userId, ipAddress: req.ip, userAgent: req.headers['user-agent'],
    })
    res.json(q)
  } catch (err) { next(err) }
})

module.exports = router
