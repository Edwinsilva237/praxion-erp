import { useState, useEffect } from 'react'

/**
 * Devuelve `value` con un retraso de `delay` ms desde el último cambio.
 * Útil para no disparar una query (o búsqueda server-side) en cada tecla.
 */
export function useDebounced(value, delay = 300) {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay)
    return () => clearTimeout(t)
  }, [value, delay])
  return debounced
}

export default useDebounced
