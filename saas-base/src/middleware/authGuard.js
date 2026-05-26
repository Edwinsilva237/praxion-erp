'use strict'

const jwt = require('jsonwebtoken')
const config = require('../config')
const { Sentry, isInitialized: sentryReady } = require('../config/sentry')

/**
 * Verifica el JWT del header Authorization.
 * Inyecta req.auth = { userId, tenantId, email, roles } en cada request autenticado.
 */
async function authGuard(req, res, next) {
  try {
    const token = extractToken(req)

    if (!token) {
      return res.status(401).json({ error: 'Authentication required.' })
    }

    let payload
    try {
      payload = jwt.verify(token, config.jwt.secret)
    } catch (err) {
      if (err.name === 'TokenExpiredError') {
        return res.status(401).json({ error: 'Token expired.', code: 'TOKEN_EXPIRED' })
      }
      return res.status(401).json({ error: 'Invalid token.' })
    }

    // Verificar que el token pertenece al tenant del request
    if (req.tenant && payload.tenantId !== req.tenant.id) {
      return res.status(403).json({ error: 'Token does not match tenant.' })
    }

    req.auth = {
      userId:   payload.sub,
      tenantId: payload.tenantId,
      email:    payload.email,
      roles:    payload.roles || [],
    }

    // Si el token fue emitido en modo impersonación, transportamos los datos
    // del actor real (el platform admin). Los downstream pueden enriquecer
    // audit logs y mostrar el banner rojo en UI.
    if (payload.impersonation) {
      req.auth.impersonation = {
        sessionId:      payload.impersonation.sessionId,
        actorUserId:    payload.impersonation.actorUserId,
        actorTenantId:  payload.impersonation.actorTenantId,
        actorEmail:     payload.impersonation.actorEmail,
      }
    }

    if (sentryReady()) {
      Sentry.getCurrentScope().setUser({
        id:        req.auth.userId,
        email:     req.auth.email,
        tenant_id: req.auth.tenantId,
      })
    }

    next()
  } catch (err) {
    next(err)
  }
}

function extractToken(req) {
  const authHeader = req.headers.authorization || ''
  if (authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7)
  }
  return null
}

module.exports = { authGuard }
