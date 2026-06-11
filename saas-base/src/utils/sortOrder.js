'use strict'

/**
 * Construye una cláusula ORDER BY SEGURA para los listados paginados de
 * documentos, a partir de un `sortBy`/`sortDir` que mandó el cliente.
 *
 * Seguridad: la columna NUNCA viene del cliente directo — `sortBy` es solo una
 * CLAVE que se resuelve contra un allowlist (`columns`); si no existe, cae al
 * `defaultKey`. La dirección se normaliza a ASC/DESC. Así no hay inyección SQL
 * aunque el front mande basura.
 *
 * @param {object}  opts
 * @param {string}  [opts.sortBy]      Clave pedida por el cliente (p.ej. 'folio').
 * @param {string}  [opts.sortDir]     'asc' | 'desc'.
 * @param {object}  opts.columns       Mapa { clave: 'expr.sql' } permitido.
 * @param {string}  opts.defaultKey    Clave por defecto (debe existir en columns).
 * @param {string}  [opts.defaultDir]  Dirección por defecto cuando no se manda
 *                                     sortDir (default 'desc' = más nuevo arriba).
 * @param {string}  [opts.tiebreaker]  SQL de desempate determinista (p.ej.
 *                                     'so.id DESC'); se concatena al final.
 * @returns {string} p.ej. "so.created_at DESC NULLS LAST, so.id DESC"
 */
function buildOrderBy({ sortBy, sortDir, columns, defaultKey, defaultDir = 'desc', tiebreaker } = {}) {
  if (!columns || !columns[defaultKey]) {
    throw new Error('buildOrderBy: defaultKey debe existir en columns')
  }
  const key = sortBy && columns[sortBy] ? sortBy : defaultKey
  const dir = String(sortDir || defaultDir).toLowerCase() === 'asc' ? 'ASC' : 'DESC'
  const col = columns[key]
  const tb  = tiebreaker && tiebreaker !== col ? `, ${tiebreaker}` : ''
  return `${col} ${dir} NULLS LAST${tb}`
}

module.exports = { buildOrderBy }
