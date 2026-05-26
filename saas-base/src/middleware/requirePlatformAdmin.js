'use strict'

const { query, withBypass } = require('../db')

/**
 * Verifica que el usuario autenticado tenga la marca is_platform_admin=TRUE.
 * Debe ejecutarse DESPUÉS de authGuard (req.auth.userId requerido).
 *
 * No confiamos en el JWT para esta marca — la verificamos fresca contra BD
 * en cada request, así si se revoca el privilegio surte efecto al instante
 * sin tener que invalidar el token.
 *
 * La query corre en withBypass: las rutas de plataforma son cross-tenant
 * por definición y la tabla `users` tiene RLS scoped al tenant_id del JWT.
 */
async function requirePlatformAdmin(req, res, next) {
  try {
    if (!req.auth?.userId) {
      return res.status(401).json({ error: 'Autenticación requerida.' })
    }

    const { rows } = await withBypass(() => query(
      `SELECT is_platform_admin FROM users WHERE id = $1 AND is_active = TRUE`,
      [req.auth.userId]
    ))

    if (!rows.length || rows[0].is_platform_admin !== true) {
      return res.status(403).json({
        error: 'Acceso denegado. Solo administradores de la plataforma.',
      })
    }

    next()
  } catch (err) {
    next(err)
  }
}

module.exports = { requirePlatformAdmin }
