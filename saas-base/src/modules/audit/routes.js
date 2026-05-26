'use strict'

const express = require('express')
const { tenantResolver } = require('../../middleware/tenantResolver')
const { authGuard } = require('../../middleware/authGuard')
const { requireActiveTenant } = require('../../middleware/requireActiveTenant')
const { checkPermission } = require('../../middleware/checkPermission')
const { query } = require('../../db')

const router = express.Router()

router.use(tenantResolver)
router.use(authGuard)
router.use(requireActiveTenant)

/**
 * GET /api/audit-logs
 * Lista el log de auditoría del tenant con filtros opcionales.
 * Query params: page, limit, action, resource, userId, from, to
 */
router.get('/', checkPermission('audit_logs', 'read'), async (req, res, next) => {
  try {
    const {
      page = 1,
      limit = 50,
      action,
      resource,
      userId,
      from,
      to,
    } = req.query

    const offset = (parseInt(page, 10) - 1) * Math.min(parseInt(limit, 10), 100)
    const params = [req.tenant.id]
    const filters = []

    if (action) {
      params.push(action)
      filters.push(`al.action = $${params.length}`)
    }
    if (resource) {
      params.push(resource)
      filters.push(`al.resource = $${params.length}`)
    }
    if (userId) {
      params.push(userId)
      filters.push(`al.user_id = $${params.length}`)
    }
    if (from) {
      params.push(from)
      filters.push(`al.created_at >= $${params.length}`)
    }
    if (to) {
      params.push(to)
      filters.push(`al.created_at <= $${params.length}`)
    }

    const whereClause = filters.length > 0 ? `AND ${filters.join(' AND ')}` : ''

    params.push(Math.min(parseInt(limit, 10), 100))
    params.push(offset)

    const { rows } = await query(
      `SELECT
         al.id,
         al.action,
         al.resource,
         al.resource_id,
         al.payload,
         al.ip_address,
         al.created_at,
         u.email    AS user_email,
         u.full_name AS user_name
       FROM audit_logs al
       LEFT JOIN users u ON u.id = al.user_id
       WHERE al.tenant_id = $1 ${whereClause}
       ORDER BY al.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    )

    const { rows: countRows } = await query(
      `SELECT COUNT(*) FROM audit_logs al WHERE al.tenant_id = $1 ${whereClause}`,
      params.slice(0, params.length - 2)
    )

    res.json({
      data:  rows,
      total: parseInt(countRows[0].count, 10),
      page:  parseInt(page, 10),
      limit: Math.min(parseInt(limit, 10), 100),
    })
  } catch (err) {
    next(err)
  }
})

/**
 * GET /api/audit-logs/actions
 * Lista las acciones únicas disponibles para filtrar.
 */
router.get('/actions', checkPermission('audit_logs', 'read'), async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT DISTINCT action FROM audit_logs WHERE tenant_id = $1 ORDER BY action`,
      [req.tenant.id]
    )
    res.json(rows.map((r) => r.action))
  } catch (err) {
    next(err)
  }
})

module.exports = router
