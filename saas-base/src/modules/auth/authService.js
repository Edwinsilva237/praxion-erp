'use strict'

const bcrypt = require('bcrypt')
const jwt = require('jsonwebtoken')
const crypto = require('crypto')
const { query, withTransaction, withBypass } = require('../../db')
const config = require('../../config')
const logger = require('../../config/logger')
const { audit } = require('../../utils/audit')
const { validatePassword } = require('../../utils/passwordPolicy')
const { getUserPermissions, getUserUiPrefs } = require('../roles/permissionService')

async function login({ email, password, tenantId, userAgent, ipAddress }) {
  const { rows: users } = await query(
    `SELECT u.id, u.email, u.full_name, u.is_active, u.is_platform_admin, uc.password_hash
     FROM users u
     JOIN user_credentials uc ON uc.user_id = u.id
     WHERE u.tenant_id = $1 AND u.email = $2`,
    [tenantId, email.toLowerCase().trim()]
  )

  if (users.length === 0) {
    await bcrypt.compare('dummy', '$2b$12$dummyhashtopreventtimingattacks000000000000000000000000')
    await audit({ tenantId, action: 'auth.login_failed', resource: 'auth', payload: { email }, ipAddress, userAgent })
    throw createError(401, 'Invalid credentials.')
  }

  const user = users[0]

  if (!user.is_active) {
    await audit({ tenantId, userId: user.id, action: 'auth.login_blocked', resource: 'auth', payload: { reason: 'account_disabled' }, ipAddress, userAgent })
    throw createError(401, 'Account is disabled.')
  }

  const passwordMatch = await bcrypt.compare(password, user.password_hash)
  if (!passwordMatch) {
    await audit({ tenantId, userId: user.id, action: 'auth.login_failed', resource: 'auth', payload: { email }, ipAddress, userAgent })
    throw createError(401, 'Invalid credentials.')
  }

  const { rows: roleRows } = await query(
    `SELECT r.name FROM roles r JOIN user_roles ur ON ur.role_id = r.id WHERE ur.user_id = $1`,
    [user.id]
  )
  const roles = roleRows.map((r) => r.name)

  // Permisos efectivos del usuario (suma de todos sus roles).
  // Devolvemos un array de strings "resource:action" para que el frontend
  // pueda filtrar items del menú via el store y can().
  const [permissionsSet, uiPrefs] = await Promise.all([
    getUserPermissions(user.id),
    getUserUiPrefs(user.id),
  ])
  const permissions = Array.from(permissionsSet)

  // Info básica del tenant (frontend la usa para encabezado y localStorage)
  const { rows: tenantRows } = await query(
    `SELECT id, slug, name, modules, is_active FROM tenants WHERE id = $1`,
    [tenantId]
  )
  const tenant = tenantRows[0] || { id: tenantId, modules: {}, is_active: true }

  const accessToken = generateAccessToken({ userId: user.id, tenantId, email: user.email, roles })
  const { token: refreshToken, hash: tokenHash, expiresAt } = generateRefreshToken()

  await withTransaction(async (client) => {
    await client.query(
      `INSERT INTO refresh_tokens (user_id, token_hash, expires_at, user_agent, ip_address)
       VALUES ($1, $2, $3, $4, $5)`,
      [user.id, tokenHash, expiresAt, userAgent || null, ipAddress || null]
    )
    await client.query(`UPDATE users SET last_login_at = NOW() WHERE id = $1`, [user.id])
  })

  await audit({ tenantId, userId: user.id, action: 'auth.login', resource: 'auth', ipAddress, userAgent })
  logger.info('User logged in', { userId: user.id, tenantId })

  return {
    accessToken,
    refreshToken,
    user: {
      id: user.id,
      email: user.email,
      fullName: user.full_name,
      roles,
      isPlatformAdmin: user.is_platform_admin === true,
    },
    permissions,
    uiPrefs,
    tenant,
  }
}

async function refresh({ refreshToken, tenantId }) {
  const tokenHash = hashToken(refreshToken)

  const { rows } = await query(
    `SELECT rt.id, rt.user_id, rt.expires_at, rt.is_revoked, u.email, u.is_active
     FROM refresh_tokens rt JOIN users u ON u.id = rt.user_id
     WHERE rt.token_hash = $1`,
    [tokenHash]
  )

  if (rows.length === 0)                        throw createError(401, 'Invalid refresh token.')
  const record = rows[0]
  if (record.is_revoked)                        throw createError(401, 'Refresh token has been revoked.')
  if (new Date(record.expires_at) < new Date()) throw createError(401, 'Refresh token expired.')
  if (!record.is_active)                        throw createError(401, 'Account is disabled.')

  // Validar que el user tiene membresía en el tenant del request. Los
  // refresh tokens no están bound a un tenant específico — un user con
  // membresías en N tenants puede refrescar desde cualquiera de ellos.
  const { rows: memb } = await withBypass(() => query(
    `SELECT 1 FROM tenant_memberships WHERE user_id = $1 AND tenant_id = $2`,
    [record.user_id, tenantId]
  ))
  if (memb.length === 0) throw createError(403, 'Token does not match tenant.')

  const { rows: roleRows } = await query(
    `SELECT r.name FROM roles r JOIN user_roles ur ON ur.role_id = r.id WHERE ur.user_id = $1`,
    [record.user_id]
  )
  const roles = roleRows.map((r) => r.name)

  const { token: newRefreshToken, hash: newHash, expiresAt } = generateRefreshToken()

  await withTransaction(async (client) => {
    await client.query(`UPDATE refresh_tokens SET is_revoked = true WHERE id = $1`, [record.id])
    await client.query(
      `INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)`,
      [record.user_id, newHash, expiresAt]
    )
  })

  await audit({ tenantId, userId: record.user_id, action: 'auth.token_refreshed', resource: 'auth' })

  const accessToken = generateAccessToken({ userId: record.user_id, tenantId, email: record.email, roles })
  return { accessToken, refreshToken: newRefreshToken }
}

async function logout({ refreshToken, userId, tenantId }) {
  const tokenHash = hashToken(refreshToken)
  await query(`UPDATE refresh_tokens SET is_revoked = true WHERE token_hash = $1`, [tokenHash])
  await audit({ tenantId, userId, action: 'auth.logout', resource: 'auth' })
}

function generateAccessToken({ userId, tenantId, email, roles }) {
  return jwt.sign({ tenantId, email, roles }, config.jwt.secret, { subject: userId, expiresIn: config.jwt.expiresIn })
}

function generateRefreshToken() {
  const token = crypto.randomBytes(40).toString('hex')
  const hash = hashToken(token)
  const expiresAt = new Date()
  expiresAt.setDate(expiresAt.getDate() + 7)
  return { token, hash, expiresAt }
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex')
}

function createError(status, message) {
  const err = new Error(message)
  err.status = status
  return err
}

/**
 * Cambia la contraseña del usuario autenticado.
 * Requiere el password actual para validar identidad.
 * Invalida todos los refresh tokens vigentes (cierra otras sesiones).
 */
async function changePassword({ userId, currentPassword, newPassword, tenantId, ipAddress, userAgent }) {
  if (!currentPassword || !newPassword) {
    throw createError(400, 'currentPassword y newPassword son requeridos.')
  }
  const check = validatePassword(newPassword)
  if (!check.valid) {
    throw createError(400, check.reason)
  }
  if (currentPassword === newPassword) {
    throw createError(400, 'La nueva contraseña debe ser distinta a la actual.')
  }

  const { rows } = await query(
    `SELECT uc.password_hash
       FROM user_credentials uc
       JOIN users u ON u.id = uc.user_id
      WHERE u.id = $1 AND u.tenant_id = $2 AND u.is_active = true`,
    [userId, tenantId]
  )
  if (!rows.length) throw createError(404, 'Usuario no encontrado.')

  const ok = await bcrypt.compare(currentPassword, rows[0].password_hash)
  if (!ok) {
    await audit({
      tenantId, userId, action: 'auth.change_password_failed',
      resource: 'auth', payload: { reason: 'wrong_current_password' },
      ipAddress, userAgent,
    })
    throw createError(401, 'La contraseña actual es incorrecta.')
  }

  const newHash = await bcrypt.hash(newPassword, config.bcrypt.rounds)

  await withTransaction(async (client) => {
    await client.query(
      `UPDATE user_credentials SET password_hash = $1, updated_at = NOW() WHERE user_id = $2`,
      [newHash, userId]
    )
    // Invalidar sesiones activas (forzar re-login en otros dispositivos)
    await client.query(
      `DELETE FROM refresh_tokens WHERE user_id = $1`,
      [userId]
    )
  })

  await audit({
    tenantId, userId, action: 'auth.password_changed',
    resource: 'auth', ipAddress, userAgent,
  })

  return { changed: true }
}

/**
 * Login con discovery cross-tenant. El usuario no especifica tenant; el sistema
 * busca todos los users con ese email cuyo password match. Si hay exactamente
 * UNO, hace el login. Si hay varios (mismo email en múltiples tenants y misma
 * password), devuelve la lista para que el cliente elija.
 *
 * No tener match → error genérico (no se distingue entre email mal o password mal,
 * para evitar user enumeration).
 *
 * Retorna:
 *   - { sessions: [{tenant, ...}] } cuando hay >1 match — el frontend muestra
 *     selector y luego llama a login normal con el tenant elegido.
 *   - El mismo shape de login() cuando hay 1 match (autoselección).
 */
async function loginDiscover({ email, password, userAgent, ipAddress }) {
  const emailLc = email.toLowerCase().trim()

  // Buscar TODOS los usuarios con ese email (cross-tenant). Usamos withBypass
  // de db si fuera necesario, pero como `users` se filtra por tenant_id NULL
  // en RLS (no se permite leer cross-tenant), esta consulta correrá en el
  // contexto del request (que no tiene tenant). RLS se evalúa con la policy
  // PERMISSIVE — cuando rls_enforce=false (default actual), no aplica.
  // Cuando se active RLS, este endpoint deberá envolverse en withBypass.
  // OJO: ya no filtramos por t.is_active. Permitimos login en tenants
  // suspendidos para que puedan llegar al portal de pagos. El bloqueo
  // efectivo de las rutas de negocio lo hace requireActiveTenant.
  const { rows: candidates } = await withBypass(() => query(
    `SELECT u.id, u.email, u.full_name, u.is_active, u.tenant_id,
            uc.password_hash,
            t.slug AS tenant_slug, t.name AS tenant_name, t.display_name,
            t.is_active AS tenant_active
       FROM users u
       JOIN user_credentials uc ON uc.user_id = u.id
       JOIN tenants t          ON t.id = u.tenant_id
      WHERE u.email = $1 AND u.is_active = true`,
    [emailLc]
  ))

  // Si no hay ni un user con ese email, hash dummy para no filtrar timing.
  if (candidates.length === 0) {
    await bcrypt.compare('dummy', '$2b$12$dummyhashtopreventtimingattacks000000000000000000000000')
    throw createError(401, 'Credenciales incorrectas.')
  }

  // Para cada candidato verificar password. Solo nos quedamos con los que match.
  const matches = []
  for (const c of candidates) {
    const ok = await bcrypt.compare(password, c.password_hash)
    if (ok) matches.push(c)
  }

  if (matches.length === 0) {
    throw createError(401, 'Credenciales incorrectas.')
  }

  // Si solo un match → login directo y devolvemos sesión completa.
  if (matches.length === 1) {
    return login({
      email: emailLc,
      password,
      tenantId: matches[0].tenant_id,
      userAgent,
      ipAddress,
    })
  }

  // Varios matches → devolver lista para que el cliente elija tenant.
  // No emitimos sesión todavía — el segundo paso requiere otro POST con tenant.
  // Incluimos tenant_active para que el frontend muestre badge "Suspendida".
  return {
    needsTenantSelection: true,
    tenants: matches.map(m => ({
      id:           m.tenant_id,
      slug:         m.tenant_slug,
      name:         m.tenant_name,
      display_name: m.display_name,
      is_active:    m.tenant_active !== false,
    })),
  }
}

module.exports = { login, loginDiscover, refresh, logout, changePassword }
