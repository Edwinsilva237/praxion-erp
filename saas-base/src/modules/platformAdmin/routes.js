'use strict'

// Panel de super-admin de la plataforma (dueños de Praxion).
// Operaciones cross-tenant: listar todos los inquilinos, crearlos,
// suspenderlos y activar/desactivar módulos por tenant.
//
// Acceso: usuario autenticado con users.is_platform_admin = TRUE.
// No usa tenantResolver — estas rutas son cross-tenant por definición.

const express = require('express')
const { authGuard } = require('../../middleware/authGuard')
const { requirePlatformAdmin } = require('../../middleware/requirePlatformAdmin')
const svc = require('./platformAdminService')
const sandboxReset = require('./sandboxResetService')
const impersonation = require('./impersonationService')
const processConfigSvc = require('../process-config/processConfigService')
const { audit } = require('../../utils/audit')
const { validatePassword } = require('../../utils/passwordPolicy')
const logger = require('../../config/logger')

const router = express.Router()

router.use(authGuard)
router.use(requirePlatformAdmin)

// GET /api/platform-admin/tenants?q=foo&page=1&limit=50
router.get('/tenants', async (req, res, next) => {
  try {
    const page  = Math.max(1, parseInt(req.query.page || 1, 10))
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit || 50, 10)))
    const result = await svc.listAllTenants({ q: req.query.q, page, limit })
    res.json(result)
  } catch (err) { next(err) }
})

// GET /api/platform-admin/tenants/:id
router.get('/tenants/:id', async (req, res, next) => {
  try {
    const tenant = await svc.getTenantDetail(req.params.id)
    if (!tenant) return res.status(404).json({ error: 'Tenant no encontrado.' })
    res.json(tenant)
  } catch (err) { next(err) }
})

// GET /api/platform-admin/tenants/:id/users
router.get('/tenants/:id/users', async (req, res, next) => {
  try {
    const users = await svc.listTenantUsers(req.params.id)
    res.json(users)
  } catch (err) { next(err) }
})

// POST /api/platform-admin/tenants
router.post('/tenants', async (req, res, next) => {
  try {
    const { slug, name, plan, adminEmail, adminPassword, adminName, modules, sendInitialPassword } = req.body || {}
    if (!slug || !name || !adminEmail || !adminPassword || !adminName) {
      return res.status(400).json({
        error: 'slug, name, adminEmail, adminPassword y adminName son requeridos.',
      })
    }
    const pwCheck = validatePassword(adminPassword)
    if (!pwCheck.valid) {
      return res.status(400).json({ error: pwCheck.reason })
    }

    const result = await svc.createTenant({
      slug, name, plan, adminEmail, adminPassword, adminName, modules,
      sendInitialPassword: sendInitialPassword === true,
    })

    await audit({
      tenantId:  result.tenant.id,
      userId:    req.auth.userId,
      action:    'platform_admin.tenant_created',
      resource:  'tenant',
      resourceId: result.tenant.id,
      payload:   { slug, name, plan, email_sent: result.emailSent === true },
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    }).catch(err => logger.warn('audit failed', { error: err.message }))

    // Devolvemos la contraseña en plano SOLO en este momento — es la única
    // ventana donde la tenemos sin hashear y el super-admin la necesita para
    // mostrarla en pantalla / compartirla por WhatsApp. Nunca se guarda
    // tampoco se reenvía después.
    res.status(201).json({
      tenant: result.tenant,
      user: result.user,
      credentials: {
        email:        adminEmail.toLowerCase().trim(),
        tempPassword: adminPassword,
        loginUrl:     result.loginUrl,
      },
      emailSent: result.emailSent === true,
    })
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Ya existe un tenant con ese slug.' })
    if (err.code === '23514') return res.status(400).json({ error: 'Formato de slug inválido. Solo minúsculas, números y guiones.' })
    next(err)
  }
})

// PATCH /api/platform-admin/tenants/:id
router.patch('/tenants/:id', async (req, res, next) => {
  try {
    const updated = await svc.updateTenant(req.params.id, req.body || {})

    await audit({
      tenantId:  req.params.id,
      userId:    req.auth.userId,
      action:    'platform_admin.tenant_updated',
      resource:  'tenant',
      resourceId: req.params.id,
      payload:   { fields: Object.keys(req.body || {}) },
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    }).catch(err => logger.warn('audit failed', { error: err.message }))

    res.json(updated)
  } catch (err) { next(err) }
})

// POST /api/platform-admin/tenants/:id/suspend
// Body: { reason: 'payment' | 'manual' }
router.post('/tenants/:id/suspend', async (req, res, next) => {
  try {
    if (req.params.id === req.auth.tenantId) {
      return res.status(400).json({
        error: 'No puedes suspender tu propia organización — perderías acceso al panel para reactivarla.',
        code:  'CANNOT_SELF_SUSPEND',
      })
    }
    const reason = req.body?.reason || 'manual'
    const result = await svc.suspendTenant(req.params.id, { reason })
    await audit({
      tenantId:  req.params.id,
      userId:    req.auth.userId,
      action:    'platform_admin.tenant_suspended',
      resource:  'tenant',
      resourceId: req.params.id,
      payload:   { reason },
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    }).catch(err => logger.warn('audit failed', { error: err.message }))
    res.json(result)
  } catch (err) { next(err) }
})

// POST /api/platform-admin/tenants/:id/reactivate
router.post('/tenants/:id/reactivate', async (req, res, next) => {
  try {
    const result = await svc.reactivateTenant(req.params.id)
    await audit({
      tenantId:  req.params.id,
      userId:    req.auth.userId,
      action:    'platform_admin.tenant_reactivated',
      resource:  'tenant',
      resourceId: req.params.id,
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    }).catch(err => logger.warn('audit failed', { error: err.message }))
    res.json(result)
  } catch (err) { next(err) }
})

// ─── Impersonar tenant ────────────────────────────────────────────────────
//
// El platform admin obtiene un JWT temporal (30 min) que lo loguea como el
// admin del tenant destino. La función SIEMPRE deja registro auditable.

router.post('/tenants/:id/impersonate', async (req, res, next) => {
  try {
    const targetTenantId = req.params.id
    if (targetTenantId === req.auth.tenantId) {
      return res.status(400).json({
        error: 'No tiene sentido impersonar tu propio tenant — ya estás dentro.',
        code:  'CANNOT_SELF_IMPERSONATE',
      })
    }

    const result = await impersonation.startImpersonation({
      actorUserId:    req.auth.userId,
      actorTenantId:  req.auth.tenantId,
      actorEmail:     req.auth.email,
      targetTenantId,
      reason:         req.body?.reason || null,
      ipAddress:      req.ip,
      userAgent:      req.get('user-agent'),
    })

    await audit({
      tenantId:   targetTenantId,
      userId:     req.auth.userId,
      action:     'platform_admin.impersonation_started',
      resource:   'tenant',
      resourceId: targetTenantId,
      payload: {
        sessionId:    result.sessionId,
        targetUserId: result.target.userId,
        reason:       req.body?.reason || null,
      },
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    }).catch((e) => logger.warn('audit failed', { error: e.message }))

    res.json(result)
  } catch (err) { next(err) }
})

router.post('/impersonation/end', async (req, res, next) => {
  try {
    // El sessionId viaja en req.auth.impersonation cuando el JWT actual es
    // de impersonación. También se puede pasar explícito en el body.
    const sessionId = req.auth?.impersonation?.sessionId || req.body?.sessionId
    if (sessionId) {
      await impersonation.endImpersonation({ sessionId })
      await audit({
        tenantId:   req.auth.impersonation?.actorTenantId || req.auth.tenantId,
        userId:     req.auth.impersonation?.actorUserId   || req.auth.userId,
        action:     'platform_admin.impersonation_ended',
        resource:   'impersonation',
        resourceId: sessionId,
        ipAddress: req.ip,
        userAgent: req.get('user-agent'),
      }).catch((e) => logger.warn('audit failed', { error: e.message }))
    }
    res.json({ ok: true })
  } catch (err) { next(err) }
})

router.get('/tenants/:id/impersonation-history', async (req, res, next) => {
  try {
    const rows = await impersonation.listForTenant(req.params.id, {
      limit: Math.min(200, parseInt(req.query.limit || 50, 10)),
    })
    res.json(rows)
  } catch (err) { next(err) }
})

// ─── Reset de datos sandbox ───────────────────────────────────────────────

// GET /api/platform-admin/tenants/:id/sandbox-reset-preview
// Devuelve el conteo de registros que se borrarían, sin borrar nada.
router.get('/tenants/:id/sandbox-reset-preview', async (req, res, next) => {
  try {
    await sandboxReset.assertSandbox(req.params.id)
    const keepInventory = req.query.keepInventory === 'true'
    const preview = await sandboxReset.previewCounts(req.params.id, { keepInventory })
    res.json(preview)
  } catch (err) {
    if (err.code === 'TENANT_NOT_SANDBOX') {
      return res.status(400).json({ error: err.message, code: err.code })
    }
    next(err)
  }
})

// POST /api/platform-admin/tenants/:id/sandbox-reset
// Body: { keepInventory: bool, confirm: 'RESET' }  — confirm es a propósito
//   para evitar que un click accidental dispare un borrado masivo.
router.post('/tenants/:id/sandbox-reset', async (req, res, next) => {
  try {
    if (req.body?.confirm !== 'RESET') {
      return res.status(400).json({
        error: 'Falta confirmación. Envía body.confirm = "RESET" para proceder.',
      })
    }
    if (req.params.id === req.auth.tenantId) {
      return res.status(400).json({
        error: 'No puedes resetear datos de tu propio tenant.',
        code:  'CANNOT_SELF_RESET',
      })
    }
    const result = await sandboxReset.resetTenantData(req.params.id, {
      keepInventory: req.body?.keepInventory === true,
    })
    await audit({
      tenantId:  req.params.id,
      userId:    req.auth.userId,
      action:    'platform_admin.sandbox_reset',
      resource:  'tenant',
      resourceId: req.params.id,
      payload:   { total: result.total, keepInventory: req.body?.keepInventory === true },
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    }).catch(err => logger.warn('audit failed', { error: err.message }))
    res.json(result)
  } catch (err) {
    if (err.code === 'TENANT_NOT_SANDBOX') {
      return res.status(400).json({ error: err.message, code: err.code })
    }
    next(err)
  }
})

// ─── Planes de suscripción ────────────────────────────────────────────────

// GET /api/platform-admin/plans
router.get('/plans', async (_req, res, next) => {
  try {
    const plans = await svc.listPlans()
    res.json(plans)
  } catch (err) { next(err) }
})

// GET /api/platform-admin/plans/:id
router.get('/plans/:id', async (req, res, next) => {
  try {
    const plan = await svc.getPlan(req.params.id)
    if (!plan) return res.status(404).json({ error: 'Plan no encontrado.' })
    res.json(plan)
  } catch (err) { next(err) }
})

// PATCH /api/platform-admin/plans/:id
router.patch('/plans/:id', async (req, res, next) => {
  try {
    const updated = await svc.updatePlan(req.params.id, req.body || {})
    await audit({
      userId:    req.auth.userId,
      action:    'platform_admin.plan_updated',
      resource:  'plan',
      resourceId: req.params.id,
      payload:   { fields: Object.keys(req.body || {}) },
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    }).catch(err => logger.warn('audit failed', { error: err.message }))
    res.json(updated)
  } catch (err) {
    if (err.code === 'PLAN_HAS_ACTIVE_SUBS') {
      return res.status(409).json({ error: err.message, code: err.code })
    }
    next(err)
  }
})

// GET /api/platform-admin/metrics
router.get('/metrics', async (_req, res, next) => {
  try {
    const m = await svc.getPlatformMetrics()
    res.json(m)
  } catch (err) { next(err) }
})

// GET /api/platform-admin/modules — catálogo de módulos
router.get('/modules', (_req, res) => {
  res.json({ modules: svc.SUPPORTED_MODULES })
})

// GET /api/platform-admin/tenants/:id/process-config
router.get('/tenants/:id/process-config', async (req, res, next) => {
  try {
    const config = await processConfigSvc.getConfig({ tenantId: req.params.id })
    res.json(config)
  } catch (err) { next(err) }
})

// PATCH /api/platform-admin/tenants/:id/process-config
router.patch('/tenants/:id/process-config', async (req, res, next) => {
  try {
    const updated = await processConfigSvc.updateConfig({
      tenantId:  req.params.id,
      userId:    req.user.id,
      updates:   req.body,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    })
    res.json(updated)
  } catch (err) { next(err) }
})

// ── Tab Miembros del tenant ─────────────────────────────────────────────────
const membershipService = require('../memberships/membershipService')

// GET /api/platform-admin/tenants/:id/members
router.get('/tenants/:id/members', async (req, res, next) => {
  try {
    const members = await membershipService.listMembersOfTenant(req.params.id)
    res.json(members)
  } catch (err) { next(err) }
})

// POST /api/platform-admin/tenants/:id/members  body: { userId, role }
router.post('/tenants/:id/members', async (req, res, next) => {
  try {
    const { userId, role = 'member' } = req.body
    if (!userId) return res.status(400).json({ error: 'userId requerido.' })

    const m = await membershipService.addMembership({
      userId,
      tenantId:  req.params.id,
      role,
      invitedBy: req.auth.userId,
    })

    await audit({
      tenantId:  req.params.id,
      userId:    req.auth.userId,
      action:    'membership.added',
      resource:  'memberships',
      resourceId: m.id,
      payload:   { userId, role },
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    })

    res.status(201).json(m)
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ error: err.message })
    next(err)
  }
})

// DELETE /api/platform-admin/tenants/:id/members/:userId
router.delete('/tenants/:id/members/:userId', async (req, res, next) => {
  try {
    const ok = await membershipService.removeMembership({
      userId:   req.params.userId,
      tenantId: req.params.id,
    })
    if (!ok) return res.status(404).json({ error: 'Membresía no encontrada.' })

    await audit({
      tenantId:  req.params.id,
      userId:    req.auth.userId,
      action:    'membership.removed',
      resource:  'memberships',
      payload:   { userId: req.params.userId },
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    })

    res.status(204).end()
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ error: err.message })
    next(err)
  }
})

module.exports = router
