import * as Sentry from '@sentry/react'

/**
 * Inicializa Sentry en el frontend.
 *
 * - Si VITE_SENTRY_DSN no está set, Sentry queda en no-op.
 * - tracesSampleRate=0 por defecto (solo errores, sin tracing — barato).
 * - Tag `environment` toma de VITE_MODE (dev/production/staging).
 */

let initialized = false

export function initSentry() {
  if (initialized) return
  const dsn = import.meta.env.VITE_SENTRY_DSN
  if (!dsn) return

  Sentry.init({
    dsn,
    environment: import.meta.env.VITE_SENTRY_ENV || import.meta.env.MODE,
    release:     import.meta.env.VITE_SENTRY_RELEASE || undefined,
    tracesSampleRate: parseFloat(import.meta.env.VITE_SENTRY_TRACES_SAMPLE_RATE || '0'),

    // Filtra ruido: errores ya manejados (mostrados como toast/banner) no son bugs.
    // Solo nos interesan los unhandled.
    beforeSend(event, hint) {
      const err = hint?.originalException
      // No reportar errores de red 4xx — son del cliente o validación normal.
      const status = err?.response?.status
      if (typeof status === 'number' && status >= 400 && status < 500) return null
      return event
    },

    // Limita información sensible: nunca enviamos tokens en logs.
    beforeBreadcrumb(breadcrumb) {
      if (breadcrumb.category === 'console' && breadcrumb.message?.includes('Bearer')) {
        return null
      }
      return breadcrumb
    },
  })

  initialized = true
}

export function setSentryUser({ user, tenant }) {
  if (!initialized) return
  if (!user) {
    Sentry.setUser(null)
    return
  }
  Sentry.setUser({
    id:        user.id,
    email:     user.email,
    tenant_id: tenant?.id,
  })
  if (tenant?.id)   Sentry.setTag('tenant_id', tenant.id)
  if (tenant?.slug) Sentry.setTag('tenant_slug', tenant.slug)
}

export function clearSentryUser() {
  if (!initialized) return
  Sentry.setUser(null)
}

export { Sentry }
