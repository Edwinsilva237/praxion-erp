import { useState, useRef } from 'react'
import { createPortal } from 'react-dom'
import clsx from 'clsx'
import { useAnchoredMenu } from '@/hooks/useAnchoredMenu'

/**
 * Autocomplete genérico.
 *
 * El menú de resultados se renderiza en un PORTAL con posición fixed anclada
 * al input (useAnchoredMenu): sin esto, el `overflow-hidden` de las secciones
 * colapsables o el scroll de los modales recortaban el desplegable.
 *
 * Props:
 *   value        — objeto seleccionado { id, label, sub? }
 *   onChange     — (item) => void
 *   onSearch     — (query) => Promise<Array<{id, label, sub?}>>
 *   placeholder  — string
 *   disabled     — bool
 *   error        — bool
 */
export default function Autocomplete({ value, onChange, onSearch, placeholder = 'Buscar...', disabled = false, error = false }) {
  const [query,    setQuery]    = useState('')
  const [results,  setResults]  = useState([])
  const [open,     setOpen]     = useState(false)
  const [loading,  setLoading]  = useState(false)
  const debounce   = useRef(null)
  const { anchorRef, menuRef, menuPos } = useAnchoredMenu(open, () => setOpen(false), { maxHeight: 208 })

  // Buscar con debounce
  function handleInput(e) {
    const q = e.target.value

    // Si hay value seleccionado y el texto coincide exactamente con su label,
    // significa que el evento de input no cambió nada (autocompletado del browser,
    // foco programático, etc.). NO des-seleccionar — eso causaba que el usuario
    // viera el cliente "seleccionado" mientras el state internamente quedaba null.
    if (value && q === value.label) {
      setQuery(q)
      return
    }

    setQuery(q)
    onChange(null) // el usuario editó el texto, limpiar selección real

    if (!q.trim()) { setResults([]); setOpen(false); return }

    clearTimeout(debounce.current)
    debounce.current = setTimeout(async () => {
      setLoading(true)
      try {
        const res = await onSearch(q)
        setResults(res || [])
        setOpen(true)
      } catch { setResults([]) }
      finally { setLoading(false) }
    }, 280)
  }

  function select(item) {
    setQuery(item.label)
    onChange(item)
    setOpen(false)
    setResults([])
  }

  function clear() {
    setQuery('')
    onChange(null)
    setResults([])
    setOpen(false)
  }

  // Mostrar label del valor seleccionado
  const displayValue = value ? value.label : query

  return (
    <div className="relative">
      <div
        ref={anchorRef}
        className={clsx(
          'flex items-center gap-2 input pr-2',
          error && 'border-status-danger/40 focus-within:ring-status-danger/40',
          disabled && 'opacity-50 cursor-not-allowed'
        )}
      >
        <input
          type="text"
          className="flex-1 bg-transparent outline-none text-sm"
          placeholder={placeholder}
          value={displayValue}
          onChange={handleInput}
          onFocus={() => { if (results.length) setOpen(true) }}
          disabled={disabled}
          autoComplete="off"
        />
        {loading && (
          <svg className="w-4 h-4 animate-spin text-ink-muted shrink-0" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3"/>
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
          </svg>
        )}
        {value && !loading && (
          <button type="button" onClick={clear} className="text-ink-muted hover:text-ink-muted shrink-0">
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12"/>
            </svg>
          </button>
        )}
      </div>

      {open && results.length > 0 && menuPos && createPortal(
        <ul
          ref={menuRef}
          style={{ position: 'fixed', zIndex: 10000, ...menuPos }}
          className="bg-surface-primary border border-line-subtle rounded-xl shadow-card overflow-y-auto"
        >
          {results.map(item => (
            <li
              key={item.id}
              onMouseDown={() => select(item)}
              className="px-3 py-2 hover:bg-surface-elevated/40 cursor-pointer"
            >
              <p className="text-sm font-medium text-ink-primary">{item.label}</p>
              {item.sub && <p className="text-xs text-ink-muted">{item.sub}</p>}
            </li>
          ))}
        </ul>,
        document.body
      )}

      {open && !loading && query && results.length === 0 && menuPos && createPortal(
        <div
          ref={menuRef}
          style={{ position: 'fixed', zIndex: 10000, ...menuPos }}
          className="bg-surface-primary border border-line-subtle rounded-xl shadow-card px-3 py-2"
        >
          <p className="text-sm text-ink-muted">Sin resultados para "{query}"</p>
        </div>,
        document.body
      )}
    </div>
  )
}
