'use strict'

/**
 * Rechaza el request con 403 si el tenant del request está suspendido
 * (tenants.is_active = false).
 *
 * Debe usarse DESPUÉS de tenantResolver. Aplica a las rutas de "negocio"
 * (facturación, ventas, etc.) para que un cliente suspendido no pueda
 * operar. Se OMITE en:
 *   - /api/auth/*           — login/logout/me/refresh tienen que funcionar
 *   - /api/billing/*        — necesitan abrir el portal Stripe para pagar
 *   - /api/tenants/current  — el frontend lo lee para saber el estado
 *   - /api/platform-admin/* — opera cross-tenant; no usa tenantResolver
 *
 * El frontend captura el código 'TENANT_SUSPENDED' (interceptor axios) y
 * redirige al usuario a /suspendido.
 */
function requireActiveTenant(req, res, next) {
  if (req.tenant && req.tenant.is_active === false) {
    return res.status(403).json({
      error: 'Tu organización está suspendida. Solo tienes acceso al panel de pagos.',
      code:  'TENANT_SUSPENDED',
    })
  }
  next()
}

module.exports = { requireActiveTenant }
