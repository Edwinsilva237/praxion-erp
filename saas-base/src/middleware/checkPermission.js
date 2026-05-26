'use strict'

const { hasPermission } = require('../modules/roles/permissionService')
// Nota: path relativo desde src/middleware/ hacia src/modules/roles/

/**
 * Middleware factory que protege una ruta verificando un permiso específico.
 * Debe usarse después de authGuard.
 *
 * Uso:
 *   router.delete('/users/:id', authGuard, checkPermission('users', 'delete'), handler)
 */
function checkPermission(resource, action) {
  return async (req, res, next) => {
    try {
      if (!req.auth) {
        return res.status(401).json({ error: 'Authentication required.' })
      }

      const allowed = await hasPermission(req.auth.userId, resource, action)

      if (!allowed) {
        return res.status(403).json({
          error: `Forbidden. Required permission: ${resource}:${action}`,
        })
      }

      next()
    } catch (err) {
      next(err)
    }
  }
}

/**
 * Variante que pasa si el usuario tiene CUALQUIERA de los permisos listados.
 * Útil cuando un endpoint sirve a varios roles con permisos distintos
 * (p. ej. operador con `create` y supervisor con `update` sobre el mismo recurso).
 *
 * Uso:
 *   router.patch('/x', authGuard,
 *     checkAnyPermission([['production','create'], ['production','update']]),
 *     handler)
 */
function checkAnyPermission(pairs) {
  return async (req, res, next) => {
    try {
      if (!req.auth) {
        return res.status(401).json({ error: 'Authentication required.' })
      }
      for (const [resource, action] of pairs) {
        // eslint-disable-next-line no-await-in-loop
        if (await hasPermission(req.auth.userId, resource, action)) return next()
      }
      const summary = pairs.map(([r, a]) => `${r}:${a}`).join(' o ')
      return res.status(403).json({
        error: `Forbidden. Required permission: ${summary}`,
      })
    } catch (err) {
      next(err)
    }
  }
}

module.exports = { checkPermission, checkAnyPermission }
