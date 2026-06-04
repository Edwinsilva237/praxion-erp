'use strict'

/**
 * Resolutor de audiencia para notificaciones push.
 *
 * Traduce una "spec" de audiencia a la lista concreta de user_ids de un tenant
 * a los que hay que mandar el push. Centraliza el "¿a quién le toca?" para que
 * pushService no tenga que conocer RBAC ni membresías.
 *
 * Specs soportadas:
 *   { userIds: ['..'] }              → esos usuarios tal cual (deduplicados).
 *   { permission: ['sales','read'] } → todos los usuarios del tenant que tienen
 *                                       ese permiso (reverse-RBAC).
 *   { membershipRoles: ['owner','admin'] } → por rol de membresía (tenant_memberships).
 *   'all'                            → todos los usuarios activos del tenant.
 *
 * Siempre filtra usuarios inactivos (is_active = false) salvo el passthrough de
 * userIds, donde el caller ya sabe a quién apunta.
 */

const { query } = require('../../db')
const membershipService = require('../memberships/membershipService')

function dedupe(ids) {
  return [...new Set((ids || []).filter(Boolean))]
}

/**
 * @param {string} tenantId
 * @param {object|string} spec  ver arriba
 * @returns {Promise<string[]>} user_ids
 */
async function resolveAudience(tenantId, spec) {
  if (!tenantId || !spec) return []

  // 'all' → todos los usuarios activos del tenant (por home tenant).
  if (spec === 'all') {
    const { rows } = await query(
      `SELECT id FROM users WHERE tenant_id = $1 AND is_active = true`,
      [tenantId]
    )
    return rows.map((r) => r.id)
  }

  // userIds explícitos → passthrough.
  if (Array.isArray(spec.userIds)) {
    return dedupe(spec.userIds)
  }

  // Por permiso → reverse-RBAC: users→user_roles→role_permissions→permissions.
  if (Array.isArray(spec.permission)) {
    const [resource, action] = spec.permission
    const { rows } = await query(
      `SELECT DISTINCT u.id
         FROM users u
         JOIN user_roles ur       ON ur.user_id = u.id
         JOIN role_permissions rp ON rp.role_id = ur.role_id
         JOIN permissions p       ON p.id = rp.permission_id
        WHERE u.tenant_id = $1
          AND u.is_active = true
          AND p.resource = $2
          AND p.action   = $3`,
      [tenantId, resource, action]
    )
    return rows.map((r) => r.id)
  }

  // Por rol de membresía (owner/admin/member).
  if (Array.isArray(spec.membershipRoles)) {
    const members = await membershipService.listMembersOfTenant(tenantId)
    return dedupe(
      members
        .filter((m) => m.is_active && spec.membershipRoles.includes(m.role))
        .map((m) => m.user_id)
    )
  }

  return []
}

module.exports = { resolveAudience }
