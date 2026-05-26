'use strict'

const express = require('express')
const jwt = require('jsonwebtoken')
const crypto = require('crypto')
const { authGuard } = require('../../middleware/authGuard')
const { query, withTransaction, withBypass } = require('../../db')
const config = require('../../config')
const logger = require('../../config/logger')
const { audit } = require('../../utils/audit')
const { getUserPermissions, getUserUiPrefs } = require('../roles/permissionService')
const membershipService = require('./membershipService')

const router = express.Router()

/**
 * Estos endpoints NO usan tenantResolver: el switch reemite JWT con tenant
 * distinto al actual, y /me debe poder listar tenants aunque el JWT esté
 * en uno cualquiera. authGuard sigue corriendo y valida el JWT vigente.
 */

/**
 * GET /api/memberships/me
 * Lista las empresas a las que pertenece el usuario autenticado.
 * Devuelve metadata mínima para pintar el switcher.
 */
router.get('/me', authGuard, async (req, res, next) => {
  try {
    const memberships = await membershipService.listMembershipsForUser(req.auth.userId)
    res.json({
      activeTenantId: req.auth.tenantId,
      memberships,
    })
  } catch (err) { next(err) }
})

/**
 * POST /api/memberships/switch
 * Body: { tenantId }
 * Cambia el tenant activo del usuario. Valida que tenga membresía en el
 * tenant target, revoca refresh tokens previos y emite nuevo par
 * accessToken+refreshToken bound al nuevo tenant.
 */
router.post('/switch', authGuard, async (req, res, next) => {
  try {
    const { tenantId } = req.body
    if (!tenantId) {
      return res.status(400).json({ error: 'tenantId requerido.' })
    }

    if (tenantId === req.auth.tenantId) {
      return res.status(400).json({ error: 'Ya estás en ese tenant.' })
    }

    // Validar que el user tiene membresía en el target
    const membership = await membershipService.getMembership(req.auth.userId, tenantId)
    if (!membership) {
      await audit({
        tenantId: req.auth.tenantId,
        userId:   req.auth.userId,
        action:   'membership.switch_denied',
        resource: 'memberships',
        payload:  { targetTenantId: tenantId },
        ipAddress: req.ip,
        userAgent: req.get('user-agent'),
      })
      return res.status(403).json({ error: 'No tienes acceso a esa empresa.' })
    }

    // Validar que el target tenant exista y no esté borrado
    const { rows: trows } = await withBypass(() => query(
      `SELECT id, slug, name, modules, is_active, plan, is_sandbox
         FROM tenants WHERE id = $1`,
      [tenantId]
    ))
    if (!trows.length) {
      return res.status(404).json({ error: 'Empresa no encontrada.' })
    }
    const targetTenant = trows[0]

    // Datos del user para el nuevo JWT
    const { rows: urows } = await withBypass(() => query(
      `SELECT id, email, full_name, is_active, is_platform_admin
         FROM users WHERE id = $1`,
      [req.auth.userId]
    ))
    if (!urows.length || !urows[0].is_active) {
      return res.status(403).json({ error: 'Usuario inactivo.' })
    }
    const user = urows[0]

    // Roles globales del user (siguen siendo los mismos en cualquier tenant
    // por ahora; el role de membership es ortogonal).
    const { rows: roleRows } = await withBypass(() => query(
      `SELECT r.name FROM roles r
         JOIN user_roles ur ON ur.role_id = r.id
        WHERE ur.user_id = $1`,
      [req.auth.userId]
    ))
    const roles = roleRows.map((r) => r.name)

    // Emitir nuevo par de tokens en una transacción atómica
    const accessToken = jwt.sign(
      { tenantId, email: user.email, roles },
      config.jwt.secret,
      { subject: user.id, expiresIn: config.jwt.expiresIn }
    )

    const refreshTokenRaw = crypto.randomBytes(40).toString('hex')
    const refreshHash = crypto.createHash('sha256').update(refreshTokenRaw).digest('hex')
    const expiresAt = new Date()
    expiresAt.setDate(expiresAt.getDate() + 7)

    await withTransaction(async (client) => {
      // Revocar refresh tokens previos del user (mismo dispositivo, evitamos
      // tener N refresh tokens vivos apuntando a distintos tenants).
      await client.query(
        `UPDATE refresh_tokens SET is_revoked = true WHERE user_id = $1 AND is_revoked = false`,
        [user.id]
      )
      await client.query(
        `INSERT INTO refresh_tokens (user_id, token_hash, expires_at, user_agent, ip_address)
         VALUES ($1, $2, $3, $4, $5)`,
        [user.id, refreshHash, expiresAt, req.get('user-agent') || null, req.ip || null]
      )
    })

    // Permisos y prefs UI para enviar al frontend de una vez (evita un /me extra)
    const [permsSet, uiPrefs] = await Promise.all([
      getUserPermissions(user.id),
      getUserUiPrefs(user.id),
    ])

    await audit({
      tenantId,
      userId:   user.id,
      action:   'membership.switched',
      resource: 'memberships',
      payload:  { fromTenantId: req.auth.tenantId, toTenantId: tenantId },
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    })

    logger.info('Tenant switched', {
      userId: user.id,
      from:   req.auth.tenantId,
      to:     tenantId,
    })

    res.json({
      accessToken,
      refreshToken: refreshTokenRaw,
      user: {
        id:              user.id,
        email:           user.email,
        fullName:        user.full_name,
        roles,
        isPlatformAdmin: user.is_platform_admin === true,
      },
      tenant:      targetTenant,
      permissions: Array.from(permsSet),
      uiPrefs,
      membership:  { role: membership.role },
    })
  } catch (err) { next(err) }
})

module.exports = router
