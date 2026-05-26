'use strict'

const express = require('express')
const rateLimit = require('express-rate-limit')
const { tenantResolver } = require('../../middleware/tenantResolver')
const { authGuard } = require('../../middleware/authGuard')
const authService = require('./authService')
const { forgotPassword, resetPassword } = require('./passwordResetService')
const { getUserPermissions, getUserUiPrefs } = require('../roles/permissionService')
const { query } = require('../../db')
const storage = require('../../utils/storage')
const config = require('../../config')

const router = express.Router()

// ── Limiter para LOGIN ──────────────────────────────────────────────────────
// Sólo cuenta intentos FALLIDOS hacia el límite. Un usuario que entra correctamente
// puede entrar y salir tantas veces como quiera sin agotar el cupo.
// Esto protege contra brute force pero no bloquea operación normal del negocio.
const loginLimiter = rateLimit({
  windowMs: config.rateLimit.windowMs,
  max: config.rateLimit.authMax,
  skipSuccessfulRequests: true,
  message: { error: 'Too many failed login attempts. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
})

// ── Limiter para REFRESH ────────────────────────────────────────────────────
// El frontend renueva el access token cada ~15 minutos. Con varias pestañas o
// múltiples operadores en una misma IP de LAN, este endpoint se llama mucho.
// Mantenemos generoso. La validación real está en el hash del refresh token.
const refreshLimiter = rateLimit({
  windowMs: config.rateLimit.windowMs,
  max: config.rateLimit.refreshMax,
  message: { error: 'Too many refresh attempts. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
})

// ── Limiter para FORGOT/RESET PASSWORD ──────────────────────────────────────
// Más estricto porque son acciones que envían emails / cambian credenciales.
const passwordLimiter = rateLimit({
  windowMs: config.rateLimit.windowMs,
  max: config.rateLimit.forgotMax,
  message: { error: 'Too many password reset requests. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
})

/**
 * POST /api/auth/login-discover
 * Login sin escribir tenant. El usuario envía solo email + password; el
 * sistema busca en qué tenants existe ese email con esa password.
 *   - Si hay 1 match → devuelve la sesión completa.
 *   - Si hay >1 match → devuelve { needsTenantSelection: true, tenants: [...] }
 *     y el frontend pide al usuario que elija; luego llama a /login normal
 *     pasando el slug elegido en el header X-Tenant-Slug.
 *   - Si hay 0 match → 401 genérico.
 *
 * Esta ruta NO usa tenantResolver porque a propósito no requiere header.
 */
router.post('/login-discover', loginLimiter, async (req, res, next) => {
  try {
    const { email, password } = req.body
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required.' })
    }
    const result = await authService.loginDiscover({
      email, password,
      userAgent: req.get('user-agent'),
      ipAddress: req.ip,
    })
    res.json(result)
  } catch (err) { next(err) }
})

/**
 * GET /api/auth/tenant-brand/:slug
 * Endpoint público. Devuelve logo + colores del tenant para tenant-brandear
 * pantallas pre-login (reset password, forgot password, etc.).
 *
 * No expone is_active, plan, suspended_reason ni info sensible — solo lo que
 * se necesita pintar en la UI. El slug ya es público (sale en links de email).
 */
router.get('/tenant-brand/:slug', async (req, res, next) => {
  try {
    const slug = String(req.params.slug || '').toLowerCase().trim()
    if (!slug) return res.status(400).json({ error: 'slug requerido' })

    const { rows } = await query(
      `SELECT name, display_name, logo_storage_path,
              brand_color_primary, brand_color_secondary
         FROM tenants
        WHERE LOWER(slug) = $1
        LIMIT 1`,
      [slug]
    )
    if (!rows.length) return res.status(404).json({ error: 'Tenant no encontrado' })
    const t = rows[0]

    // Logo como data URL (mismo patrón que /tenants/current).
    let logoUrl = null
    if (t.logo_storage_path) {
      try {
        const buffer = await storage.fetchBuffer(t.logo_storage_path)
        if (buffer) {
          const key = t.logo_storage_path
          const mime = key.endsWith('.png')  ? 'image/png'
                     : key.endsWith('.webp') ? 'image/webp'
                     : key.endsWith('.svg')  ? 'image/svg+xml'
                     : (key.endsWith('.jpg') || key.endsWith('.jpeg')) ? 'image/jpeg'
                     : 'application/octet-stream'
          logoUrl = `data:${mime};base64,${buffer.toString('base64')}`
        }
      } catch (_) { /* logo opcional */ }
    }

    res.json({
      slug,
      name:                  t.name,
      display_name:          t.display_name,
      logo_url:              logoUrl,
      brand_color_primary:   t.brand_color_primary,
      brand_color_secondary: t.brand_color_secondary,
    })
  } catch (err) { next(err) }
})

router.use(tenantResolver)

/**
 * POST /api/auth/login
 */
router.post('/login', loginLimiter, async (req, res, next) => {
  try {
    const { email, password } = req.body
    if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' })

    const result = await authService.login({
      email, password,
      tenantId:  req.tenant.id,
      userAgent: req.get('user-agent'),
      ipAddress: req.ip,
    })
    res.json(result)
  } catch (err) { next(err) }
})

/**
 * POST /api/auth/refresh
 */
router.post('/refresh', refreshLimiter, async (req, res, next) => {
  try {
    const { refreshToken } = req.body
    if (!refreshToken) return res.status(400).json({ error: 'refreshToken is required.' })

    const result = await authService.refresh({ refreshToken, tenantId: req.tenant.id })
    res.json(result)
  } catch (err) { next(err) }
})

/**
 * POST /api/auth/logout
 */
router.post('/logout', authGuard, async (req, res, next) => {
  try {
    const { refreshToken } = req.body
    if (!refreshToken) return res.status(400).json({ error: 'refreshToken is required.' })

    await authService.logout({ refreshToken, userId: req.auth.userId, tenantId: req.tenant.id })
    res.json({ message: 'Logged out successfully.' })
  } catch (err) { next(err) }
})

/**
 * GET /api/auth/me
 * Devuelve datos del usuario autenticado + sus permisos efectivos.
 * El frontend lo usa para refrescar el store sin re-login (ej. después
 * de un cambio de permisos por un admin).
 */
router.get('/me', authGuard, async (req, res, next) => {
  try {
    const { query, withBypass } = require('../../db')
    const [permissionsSet, uiPrefs, platformRow, tenantRow] = await Promise.all([
      getUserPermissions(req.auth.userId),
      getUserUiPrefs(req.auth.userId),
      withBypass(() => query(
        `SELECT is_platform_admin FROM users WHERE id = $1`,
        [req.auth.userId]
      )),
      withBypass(() => query(
        `SELECT is_active FROM tenants WHERE id = $1`,
        [req.auth.tenantId]
      )),
    ])
    res.json({
      userId:      req.auth.userId,
      tenantId:    req.auth.tenantId,
      email:       req.auth.email,
      roles:       req.auth.roles,
      permissions: Array.from(permissionsSet),
      isPlatformAdmin: platformRow.rows[0]?.is_platform_admin === true,
      tenantActive:    tenantRow.rows[0]?.is_active !== false,
      uiPrefs,
      // Si el JWT actual es de impersonación, exponemos los datos del actor
      // real para que el frontend pinte el banner rojo y el botón "Volver".
      impersonation: req.auth.impersonation || null,
    })
  } catch (err) { next(err) }
})

/**
 * POST /api/auth/forgot-password
 * Body: { email }
 * Siempre responde 200 para no revelar si el email existe.
 */
router.post('/forgot-password', passwordLimiter, async (req, res, next) => {
  try {
    const { email } = req.body
    if (!email) return res.status(400).json({ error: 'email is required.' })

    await forgotPassword({
      email,
      tenantId:   req.tenant.id,
      tenantSlug: req.tenant.slug,
      ipAddress:  req.ip,
      userAgent:  req.get('user-agent'),
    })

    // Respuesta genérica siempre — nunca revelar si el email existe
    res.json({ message: 'If that email exists, a reset link has been sent.' })
  } catch (err) { next(err) }
})

/**
 * POST /api/auth/reset-password
 * Body: { token, newPassword }
 */
router.post('/reset-password', passwordLimiter, async (req, res, next) => {
  try {
    const { token, newPassword } = req.body
    if (!token || !newPassword) return res.status(400).json({ error: 'token and newPassword are required.' })

    await resetPassword({
      token,
      newPassword,
      tenantId:  req.tenant.id,
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    })

    res.json({ message: 'Password updated successfully. Please log in again.' })
  } catch (err) { next(err) }
})

/**
 * POST /api/auth/change-password
 * Body: { currentPassword, newPassword }
 * Cambio de contraseña autenticado. Invalida otras sesiones activas.
 */
router.post('/change-password', passwordLimiter, authGuard, async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body
    await authService.changePassword({
      userId:    req.auth.userId,
      tenantId:  req.auth.tenantId,
      currentPassword, newPassword,
      ipAddress: req.ip, userAgent: req.get('user-agent'),
    })
    res.json({ message: 'Contraseña actualizada correctamente. Vuelve a iniciar sesión en otros dispositivos.' })
  } catch (err) { next(err) }
})

module.exports = router
