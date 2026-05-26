'use strict'

/**
 * Verifica que el módulo `key` esté habilitado para el tenant del request.
 * Lectura barata: usa req.tenant.modules ya cargado por tenantResolver.
 *
 * Lista negativa: key ausente o true = habilitado, false = apagado. Si está
 * apagado devuelve 403 con código MODULE_DISABLED para que el frontend pueda
 * mostrar mensaje específico.
 *
 *   const requireModule = require('../../middleware/requireModule')
 *   router.use(requireModule('invoicing'))
 */
function requireModule(key) {
  return function moduleGate(req, res, next) {
    const modules = req.tenant?.modules || {}
    if (modules[key] === false) {
      return res.status(403).json({
        error: `El módulo "${key}" está deshabilitado para tu organización. Contacta al administrador de la plataforma.`,
        code: 'MODULE_DISABLED',
        module: key,
      })
    }
    next()
  }
}

module.exports = requireModule
