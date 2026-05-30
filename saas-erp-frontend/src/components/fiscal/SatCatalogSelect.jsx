import { useState, useEffect, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { useQuery } from '@tanstack/react-query'
import api from '@/api/axios'
import clsx from 'clsx'
import { useAnchoredMenu } from '@/hooks/useAnchoredMenu'

/**
 * Dropdown con búsqueda para catálogos SAT pequeños (régimen fiscal, uso CFDI,
 * forma de pago, método de pago, tipo comprobante, objeto imp, etc.).
 *
 * Carga el catálogo al montar el componente y filtra en cliente — bueno
 * para listas < 500 entradas. Para catálogos grandes (productos, unidades)
 * usar los componentes específicos con debounce backend.
 *
 * El menú se renderiza en un PORTAL con posición fixed anclada al input
 * (ver useAnchoredMenu): sin esto, el `overflow-hidden` de las secciones
 * colapsables recortaba el desplegable y los campos del fondo de cada sección
 * quedaban tapados por la sección siguiente.
 *
 * Props:
 *   - endpoint   : string. Ruta del backend bajo /sat (ej. 'regimen-fiscal').
 *   - params     : object opcional. Query params para filtrar (ej. {persona:'fisica'}).
 *   - value      : string. Código actual.
 *   - onChange   : (code: string) => void
 *   - placeholder: string. Texto del input cuando está vacío.
 *   - showCode   : boolean. Si true muestra "CODE — Nombre"; si false solo "Nombre".
 *   - error      : boolean.
 *   - disabled   : boolean.
 */
export default function SatCatalogSelect({
  endpoint, params = {}, value, onChange,
  placeholder = 'Seleccionar…', showCode = true,
  error, disabled,
}) {
  const [open, setOpen]   = useState(false)
  const [query, setQuery] = useState('')
  const { anchorRef, menuRef, menuPos } = useAnchoredMenu(open, () => setOpen(false))

  const { data: items = [], isLoading } = useQuery({
    queryKey: ['sat-catalog', endpoint, params],
    queryFn:  () => api.get(`/sat/${endpoint}`, { params }).then(r => r.data),
    staleTime: 10 * 60 * 1000,
  })

  // Sincronizar el input con el value externo cuando se cierra el dropdown.
  useEffect(() => {
    if (!open) {
      const selected = items.find(i => i.code === value)
      setQuery(selected ? (showCode ? `${selected.code} — ${selected.name}` : selected.name) : (value || ''))
    }
  }, [value, open, items, showCode])

  // Filtro por código o nombre — case insensitive.
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return items.slice(0, 100)
    return items.filter(i =>
      i.code.toLowerCase().includes(q) || (i.name || '').toLowerCase().includes(q)
    ).slice(0, 100)
  }, [query, items])

  function select(code) {
    onChange(code)
    setOpen(false)
  }

  return (
    <div className="relative">
      <input
        ref={anchorRef}
        type="text"
        value={query}
        onChange={e => { setQuery(e.target.value); setOpen(true) }}
        onFocus={() => setOpen(true)}
        placeholder={isLoading ? 'Cargando catálogo…' : placeholder}
        disabled={disabled || isLoading}
        className={clsx('input', error && 'input-error')}
        autoComplete="off"
      />
      {open && !disabled && menuPos && createPortal(
        <div
          ref={menuRef}
          style={{ position: 'fixed', zIndex: 10000, ...menuPos }}
          className="overflow-y-auto rounded-lg border border-line-subtle bg-surface-primary shadow-card"
        >
          {filtered.length === 0 ? (
            <div className="px-3 py-2 text-xs text-ink-muted">Sin coincidencias.</div>
          ) : (
            filtered.map(i => (
              <button
                key={i.code}
                type="button"
                onClick={() => select(i.code)}
                className={clsx(
                  'w-full text-left px-3 py-1.5 text-sm hover:bg-surface-elevated/40 flex items-center gap-3',
                  value === i.code && 'bg-brand-500/10'
                )}
              >
                <span className="font-mono text-xs text-ink-muted w-12 shrink-0">{i.code}</span>
                <span className="text-ink-primary truncate">{i.name}</span>
              </button>
            ))
          )}
        </div>,
        document.body
      )}
    </div>
  )
}
