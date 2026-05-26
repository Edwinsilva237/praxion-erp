'use strict'

/**
 * Servicio de impersonación de tenants.
 *
 * Flujo:
 *   1. startImpersonation(actorUserId, targetTenantId, reason, req)
 *      → busca al admin del tenant destino, crea fila en impersonation_sessions,
 *        emite un JWT especial (TTL 30 min) con identidad del target user pero
 *        con metadata del actor real para el banner y audit logs.
 *   2. El JWT viaja por el header Authorization. authGuard lo decodifica y
 *      llena req.auth.impersonation con los datos del actor.
 *   3. endImpersonation(sessionId) — marca la fila como cerrada. El frontend
 *      restaura el JWT original desde localStorage.
 *
 * Audit obligatorio en start y end (cumplimiento LFPDPPP / Términos del SaaS).
 */

const jwt = require('jsonwebtoken')
const { query, withBypass } = require('../../db')
const config = require('../../config')
const logger = require('../../config/logger')
const { getUserPermissions, getUserUiPrefs } = require('../roles/permissionService')

const IMPERSONATION_TTL_SECONDS = 30 * 60 // 30 minutos

/**
 * Busca al usuario "admin principal" del tenant destino para impersonarlo.
 * Estrategia: rol super_admin más antiguo y activo. Si no hay super_admin,
 * cae al primer usuario activo.
 */
async function findTargetUser(tenantId) {
  return withBypass(async () => {
    // Primero: super_admin activo más antiguo
    const sa = await query(
      `SELECT u.id, u.email, u.full_name
         FROM users u
         JOIN user_roles ur ON ur.user_id = u.id
         JOIN roles r       ON r.id      = ur.role_id
        WHERE u.tenant_id = $1 AND u.is_active = TRUE
          AND r.name = 'super_admin'
        ORDER BY u.created_at ASC
        LIMIT 1`,
      [tenantId]
    )
    if (sa.rows.length) return sa.rows[0]

    // Fallback: cualquier usuario activo
    const any = await query(
      `SELECT id, email, full_name FROM users
        WHERE tenant_id = $1 AND is_active = TRUE
        ORDER BY created_at ASC LIMIT 1`,
      [tenantId]
    )
    return any.rows[0] || null
  })
}

async function startImpersonation({
  actorUserId, actorTenantId, actorEmail,
  targetTenantId, reason,
  ipAddress, userAgent,
}) {
  // Validar tenant destino existe.
  const tt = await withBypass(() => query(
    `SELECT id, slug, name FROM tenants WHERE id = $1`, [targetTenantId]
  ))
  if (!tt.rows.length) {
    const e = new Error('Tenant destino no existe.')
    e.status = 404
    throw e
  }

  const target = await findTargetUser(targetTenantId)
  if (!target) {
    const e = new Error('El tenant destino no tiene usuarios activos para impersonar.')
    e.status = 422
    throw e
  }

  // Crear fila de sesión.
  const expiresAt = new Date(Date.now() + IMPERSONATION_TTL_SECONDS * 1000)
  const sessionRow = await withBypass(() => query(
    `INSERT INTO impersonation_sessions
       (actor_user_id, actor_tenant_id, target_user_id, target_tenant_id,
        reason, expires_at, ip_address, user_agent)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING id, started_at, expires_at`,
    [actorUserId, actorTenantId, target.id, targetTenantId,
     reason || null, expiresAt, ipAddress || null, userAgent || null]
  ))
  const session = sessionRow.rows[0]

  // Permisos/UI del target user (igual que en /login normal).
  const roles      = await getUserPermissions(target.id, targetTenantId).catch(() => [])
  const uiPrefs    = await getUserUiPrefs(target.id, targetTenantId).catch(() => null)

  // JWT especial: subject = target user, tenantId = target tenant, pero con
  // metadata del actor en el campo `impersonation`.
  const accessToken = jwt.sign(
    {
      tenantId: targetTenantId,
      email:    target.email,
      roles,
      impersonation: {
        sessionId:     session.id,
        actorUserId,
        actorTenantId,
        actorEmail,
      },
    },
    config.jwt.secret,
    { subject: target.id, expiresIn: IMPERSONATION_TTL_SECONDS }
  )

  logger.info('[impersonation] iniciada', {
    sessionId: session.id, actorUserId, actorEmail,
    targetTenantId, targetSlug: tt.rows[0].slug,
  })

  return {
    accessToken,
    sessionId:  session.id,
    expiresAt:  session.expires_at,
    target: {
      tenantId:    targetTenantId,
      tenantSlug:  tt.rows[0].slug,
      tenantName:  tt.rows[0].name,
      userId:      target.id,
      userEmail:   target.email,
      userName:    target.full_name,
    },
    actor: {
      userId:    actorUserId,
      tenantId:  actorTenantId,
      email:     actorEmail,
    },
    uiPrefs,
    roles,
  }
}

async function endImpersonation({ sessionId, endReason = 'user_ended' }) {
  if (!sessionId) return
  await withBypass(() => query(
    `UPDATE impersonation_sessions
        SET ended_at  = NOW(),
            end_reason = $2
      WHERE id = $1 AND ended_at IS NULL`,
    [sessionId, endReason]
  ))
  logger.info('[impersonation] terminada', { sessionId, endReason })
}

/**
 * Historial de impersonaciones de un tenant — útil para mostrárselo al cliente
 * si pregunta, o para el panel super admin.
 */
async function listForTenant(tenantId, { limit = 50 } = {}) {
  const { rows } = await withBypass(() => query(
    `SELECT s.id, s.actor_user_id, u.email AS actor_email, u.full_name AS actor_name,
            s.reason, s.started_at, s.ended_at, s.expires_at, s.end_reason,
            s.ip_address, s.user_agent
       FROM impersonation_sessions s
       LEFT JOIN users u ON u.id = s.actor_user_id
      WHERE s.target_tenant_id = $1
      ORDER BY s.started_at DESC
      LIMIT $2`,
    [tenantId, limit]
  ))
  return rows
}

module.exports = {
  IMPERSONATION_TTL_SECONDS,
  startImpersonation,
  endImpersonation,
  listForTenant,
}
