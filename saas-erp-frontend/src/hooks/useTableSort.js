import { useState, useCallback, useMemo } from 'react'

/**
 * Estado de ordenamiento para tablas de documentos.
 *
 * Devuelve `{ sortBy, sortDir, onSort, sortParams }`:
 *  - `onSort(key)`: si clickeas la columna activa, invierte la dirección; si
 *    clickeas otra, la activa con la dirección inicial de esa columna (default
 *    'desc' = más nuevo/mayor arriba).
 *  - `sortParams`: `{ sortBy, sortDir }` para meter a queryParams/queryKey y
 *    mandar al backend.
 *
 * @param {string} defaultBy   Clave de columna inicial (debe coincidir con el
 *                             allowlist del backend, p.ej. 'fecha').
 * @param {string} defaultDir  'asc' | 'desc' inicial (default 'desc').
 */
export function useTableSort(defaultBy = 'fecha', defaultDir = 'desc') {
  const [sort, setSort] = useState({ by: defaultBy, dir: defaultDir })

  const onSort = useCallback((key, initialDir = 'desc') => {
    setSort((s) =>
      s.by === key
        ? { by: key, dir: s.dir === 'asc' ? 'desc' : 'asc' }
        : { by: key, dir: initialDir }
    )
  }, [])

  const sortParams = useMemo(
    () => ({ sortBy: sort.by, sortDir: sort.dir }),
    [sort.by, sort.dir]
  )

  return { sortBy: sort.by, sortDir: sort.dir, onSort, sortParams }
}
