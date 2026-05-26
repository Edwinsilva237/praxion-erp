'use strict'

const { query, withBypass } = require('../../db')

/**
 * Servicio de membresías user↔tenant.
 *
 * Toda lectura/escritura corre en `withBypass()` porque es inherentemente
 * cross-tenant: un usuario puede pertenecer a varias empresas y necesita
 * verlas todas para elegir.
 */

/**
 * Lista los tenants donde el usuario tiene membresía activa.
 * Devuelve metadata mínima para pintar el switcher (slug, name, role).
 */
async function listMembershipsForUser(userId) {
  const { rows } = await withBypass(() =>
    query(
      `SELECT m.tenant_id          AS id,
              m.role,
              t.slug,
              t.name,
              t.display_name,
              t.is_active,
              t.is_sandbox,
              t.plan,
              t.brand_color_primary,
              t.logo_storage_path,
              m.created_at         AS joined_at
         FROM tenant_memberships m
         JOIN tenants t ON t.id = m.tenant_id
        WHERE m.user_id = $1
        ORDER BY t.name ASC`,
      [userId]
    )
  )
  return rows
}

/**
 * Devuelve { role } si existe la membresía, o null si no.
 */
async function getMembership(userId, tenantId) {
  const { rows } = await withBypass(() =>
    query(
      `SELECT role FROM tenant_memberships WHERE user_id = $1 AND tenant_id = $2`,
      [userId, tenantId]
    )
  )
  return rows[0] || null
}

/**
 * Crea una membresía. Idempotente: si ya existe, no falla (ON CONFLICT DO NOTHING)
 * y devuelve la existente.
 */
async function addMembership({ userId, tenantId, role = 'member', invitedBy = null }) {
  if (!['owner', 'admin', 'member'].includes(role)) {
    throw createError(400, `Rol inválido: ${role}`)
  }
  const { rows } = await withBypass(() =>
    query(
      `INSERT INTO tenant_memberships (user_id, tenant_id, role, invited_by)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, tenant_id) DO NOTHING
       RETURNING id, user_id, tenant_id, role, created_at`,
      [userId, tenantId, role, invitedBy]
    )
  )
  if (rows.length === 0) {
    // Ya existía — devolver la actual
    const { rows: existing } = await withBypass(() =>
      query(
        `SELECT id, user_id, tenant_id, role, created_at
           FROM tenant_memberships
          WHERE user_id = $1 AND tenant_id = $2`,
        [userId, tenantId]
      )
    )
    return existing[0]
  }
  return rows[0]
}

/**
 * Elimina membresía. No se permite eliminar la del home tenant del user
 * (users.tenant_id) — esa solo se libera al borrar el user.
 */
async function removeMembership({ userId, tenantId }) {
  const { rows: userRow } = await withBypass(() =>
    query(`SELECT tenant_id FROM users WHERE id = $1`, [userId])
  )
  if (userRow.length && userRow[0].tenant_id === tenantId) {
    throw createError(
      400,
      'No se puede quitar la membresía del tenant home del usuario. Borra el usuario en su lugar.'
    )
  }
  const { rowCount } = await withBypass(() =>
    query(
      `DELETE FROM tenant_memberships WHERE user_id = $1 AND tenant_id = $2`,
      [userId, tenantId]
    )
  )
  return rowCount > 0
}

/**
 * Lista los usuarios que tienen membresía en un tenant. Para SuperAdmin/tab
 * Miembros del tenant. Incluye datos básicos del user + role.
 */
async function listMembersOfTenant(tenantId) {
  const { rows } = await withBypass(() =>
    query(
      `SELECT u.id           AS user_id,
              u.email,
              u.full_name,
              u.is_active,
              m.role,
              m.created_at   AS joined_at,
              u.tenant_id    AS home_tenant_id,
              (u.tenant_id = $1) AS is_home
         FROM tenant_memberships m
         JOIN users u ON u.id = m.user_id
        WHERE m.tenant_id = $1
        ORDER BY u.full_name ASC`,
      [tenantId]
    )
  )
  return rows
}

function createError(status, message) {
  const err = new Error(message)
  err.status = status
  return err
}

module.exports = {
  listMembershipsForUser,
  getMembership,
  addMembership,
  removeMembership,
  listMembersOfTenant,
}
