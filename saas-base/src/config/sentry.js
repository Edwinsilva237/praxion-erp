'use strict'

/**
 * Inicializa Sentry (error tracking + performance opcional).
 *
 * - Si SENTRY_DSN no está set, Sentry queda en no-op. El resto de la app no
 *   nota la diferencia.
 * - Se debe llamar `init()` ANTES de require otros módulos pesados para que
 *   la instrumentación automática de Express/HTTP/Postgres pueda engancharse.
 *
 * El módulo se carga por su side-effect: la primera vez que se require, llama
 * init() automáticamente si hay DSN configurado.
 */

const Sentry = require('@sentry/node')
const config = require('./index')

let initialized = false

function init() {
  if (initialized) return
  if (!config.sentry.dsn) return

  Sentry.init({
    dsn:              config.sentry.dsn,
    environment:      config.env,
    release:          config.sentry.release || undefined,
    tracesSampleRate: config.sentry.tracesSampleRate,

    // Filtra ruido: 4xx son errores del cliente (auth, validación, etc.),
    // no bugs del servidor. Solo capturamos 5xx automáticamente.
    beforeSend(event, hint) {
      const err = hint?.originalException
      const status = err?.status || err?.statusCode
      if (typeof status === 'number' && status >= 400 && status < 500) return null
      return event
    },

    // Sanea payloads: no enviamos contraseñas ni tokens accidentalmente.
    beforeBreadcrumb(breadcrumb) {
      if (breadcrumb.data?.body) {
        breadcrumb.data.body = scrubSecrets(breadcrumb.data.body)
      }
      return breadcrumb
    },
  })

  initialized = true
}

function scrubSecrets(obj) {
  if (!obj || typeof obj !== 'object') return obj
  const SECRET_KEYS = /password|token|secret|api[_-]?key|authorization|csd_password/i
  const out = Array.isArray(obj) ? [...obj] : { ...obj }
  for (const k of Object.keys(out)) {
    if (SECRET_KEYS.test(k)) {
      out[k] = '[REDACTED]'
    } else if (out[k] && typeof out[k] === 'object') {
      out[k] = scrubSecrets(out[k])
    }
  }
  return out
}

// Carga eager: init() al require — para que la instrumentación de HTTP/Express
// se enganche antes que cualquier require que use esas APIs.
init()

module.exports = {
  Sentry,
  init,
  isInitialized: () => initialized,
}
