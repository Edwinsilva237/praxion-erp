'use strict'
const { query } = require('../../db')

/**
 * Obtiene todos los permisos de un usuario (a través de sus roles).
 * Retorna un Set de strings "resource:action".
 */
async function getUserPermissions(userId) {
  const { rows } = await query(
    `SELECT DISTINCT p.resource, p.action
     FROM permissions p
     JOIN role_permissions rp ON rp.permission_id = p.id
     JOIN user_roles ur       ON ur.role_id = rp.role_id
     WHERE ur.user_id = $1`,
    [userId]
  )
  return new Set(rows.map((r) => `${r.resource}:${r.action}`))
}

/**
 * Verifica si un usuario tiene un permiso específico.
 * @param {string} userId
 * @param {string} resource - ej: 'users'
 * @param {string} action   - ej: 'delete'
 */
async function hasPermission(userId, resource, action) {
  const { rows } = await query(
    `SELECT 1
     FROM permissions p
     JOIN role_permissions rp ON rp.permission_id = p.id
     JOIN user_roles ur       ON ur.role_id = rp.role_id
     WHERE ur.user_id = $1
       AND p.resource = $2
       AND p.action   = $3
     LIMIT 1`,
    [userId, resource, action]
  )
  return rows.length > 0
}

/**
 * Devuelve las preferencias de UI efectivas del usuario combinando sus roles.
 * Si tiene varios roles con valores distintos, gana el rol propio del tenant
 * sobre el de sistema, y dentro de cada grupo el creado más recientemente.
 *
 * @returns {Promise<{ mobile_tabs: string[]|null, home_route: string|null }>}
 */
async function getUserUiPrefs(userId) {
  // Si el usuario tiene primary_role_id, ese rol gana — definitivo, sin caer
  // al fallback aunque su mobile_tabs/home_route sean NULL. Esa es la
  // intención: "este es mi rol principal, sus preferencias mandan".
  const { rows: primaryRows } = await query(
    `SELECT r.mobile_tabs, r.home_route
       FROM users u
       JOIN roles r ON r.id = u.primary_role_id
      WHERE u.id = $1`,
    [userId]
  )
  if (primaryRows.length) {
    const r = primaryRows[0]
    return { mobile_tabs: r.mobile_tabs || null, home_route: r.home_route || null }
  }

  // Sin rol principal — fallback al rol propio del tenant más reciente con
  // valor definido (uno por campo, pueden venir de roles distintos).
  const { rows } = await query(
    `SELECT
       (SELECT mobile_tabs FROM roles r
         JOIN user_roles ur ON ur.role_id = r.id
        WHERE ur.user_id = $1 AND r.mobile_tabs IS NOT NULL
        ORDER BY r.is_system ASC, r.created_at DESC
        LIMIT 1) AS mobile_tabs,
       (SELECT home_route FROM roles r
         JOIN user_roles ur ON ur.role_id = r.id
        WHERE ur.user_id = $1 AND r.home_route IS NOT NULL
        ORDER BY r.is_system ASC, r.created_at DESC
        LIMIT 1) AS home_route
    `,
    [userId]
  )
  const r = rows[0] || {}
  return {
    mobile_tabs: r.mobile_tabs || null,
    home_route:  r.home_route  || null,
  }
}

module.exports = { hasPermission, getUserPermissions, getUserUiPrefs }
