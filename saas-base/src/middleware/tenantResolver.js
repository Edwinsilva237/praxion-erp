'use strict'

const { query, withTenant } = require('../db')
const { Sentry, isInitialized: sentryReady } = require('../config/sentry')

/**
 * Resuelve el tenant desde el header X-Tenant-Slug o el subdominio.
 * Inyecta req.tenant = { id, slug, name, plan } en cada request.
 *
 * Además envuelve el resto del request en `withTenant(id, ...)` — establece
 * el contexto de RLS para que todas las queries del request apliquen el
 * filtro automático por tenant (cuando el interruptor está encendido).
 */
async function tenantResolver(req, res, next) {
  try {
    const slug = extractSlug(req)

    if (!slug) {
      return res.status(400).json({ error: 'Tenant not specified. Use X-Tenant-Slug header.' })
    }

    // Esta query corre SIN contexto (no sabemos el tenant aún). Cuando RLS
    // está activo en producción, la tabla `tenants` NO tiene policy
    // (no es tenant-scoped — ¡es la tabla DE los tenants!).
    //
    // OJO: NO filtramos por is_active. Necesitamos resolver el tenant aún
    // cuando esté suspendido para que el usuario pueda iniciar sesión y
    // aterrizar en /suspendido (y pagar desde ahí). El bloqueo real lo hace
    // requireActiveTenant en cada router de negocio.
    const { rows } = await query(
      `SELECT id, slug, name, plan, is_sandbox, modules, is_active
       FROM tenants
       WHERE slug = $1`,
      [slug]
    )

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Tenant not found.' })
    }

    req.tenant = rows[0]

    if (sentryReady()) {
      const scope = Sentry.getCurrentScope()
      scope.setTag('tenant_id', req.tenant.id)
      scope.setTag('tenant_slug', req.tenant.slug)
    }

    // Envolver el resto del pipeline en el contexto de RLS. Cualquier query
    // que se haga después de este punto verá `app.tenant_id` seteado.
    withTenant(req.tenant.id, () => next())
  } catch (err) {
    next(err)
  }
}

function extractSlug(req) {
  // 1. Header explícito (desarrollo y APIs)
  if (req.headers['x-tenant-slug']) {
    return req.headers['x-tenant-slug'].toLowerCase().trim()
  }

  // 2. Subdominio (producción: acme.tuapp.com → acme)
  const host = req.headers.host || ''
  const parts = host.split('.')
  if (parts.length >= 3) {
    const subdomain = parts[0].toLowerCase()
    // Ignorar subdominios reservados
    const reserved = ['www', 'api', 'app', 'admin', 'mail', 'smtp']
    if (!reserved.includes(subdomain)) {
      return subdomain
    }
  }

  return null
}

module.exports = { tenantResolver }
