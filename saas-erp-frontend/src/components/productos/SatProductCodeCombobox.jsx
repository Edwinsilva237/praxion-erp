import { useState, useRef, useEffect, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import api from '@/api/axios'
import clsx from 'clsx'

/**
 * Combobox con búsqueda para la Clave SAT del producto (c_ClaveProdServ
 * CFDI 4.0, 8 dígitos).
 *
 * Diferencias con SatUnitCombobox:
 *  - El catálogo c_ClaveProdServ tiene ~52,000 entradas: no se embebe en el
 *    frontend, se consulta vía /api/sat/product-codes con debounce.
 *  - Si el código que el usuario escribe NO está en el seed pero cumple el
 *    formato (8 dígitos), se acepta marcado como "no verificada". El SAT
 *    podría tenerla en su catálogo completo aunque no esté en nuestro seed.
 *  - Cuando el valor actual matchea una entrada en BD, se muestra la
 *    descripción al lado del input.
 *
 * Props:
 *   - value     : string. Código actual (8 dígitos).
 *   - onChange  : (newCode: string) => void
 *   - error     : boolean opcional.
 *   - disabled  : boolean opcional.
 */
export default function SatProductCodeCombobox({ value, onChange, error, disabled }) {
  const [open, setOpen]     = useState(false)
  const [query, setQuery]   = useState('')
  const [debounced, setDeb] = useState('')
  const rootRef = useRef(null)

  // Si el value externo cambia (reset del form), sincronizamos el input.
  useEffect(() => {
    if (!open) setQuery(value || '')
  }, [value, open])

  // Debounce del query antes de pegarle al backend (250 ms).
  useEffect(() => {
    const t = setTimeout(() => setDeb(query.trim()), 250)
    return () => clearTimeout(t)
  }, [query])

  // Cerrar al hacer click fuera.
  useEffect(() => {
    function onDoc(e) {
      if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [])

  // Lookup de sugerencias.
  const { data: suggestions = [], isLoading } = useQuery({
    queryKey: ['sat-product-codes', debounced],
    queryFn:  () => api.get('/sat/product-codes', { params: { q: debounced } }).then(r => r.data),
    enabled:  open,
    staleTime: 60 * 1000,
  })

  // Resolver del valor seleccionado para mostrarlo al lado del input.
  const { data: resolved } = useQuery({
    queryKey: ['sat-product-code', value],
    queryFn:  async () => {
      try { return await api.get(`/sat/product-codes/${value}`).then(r => r.data) }
      catch { return null }
    },
    enabled:  !!value && /^\d{8}$/.test(value),
    staleTime: 5 * 60 * 1000,
  })

  // Permitir aceptar como "personalizado" cuando el query es un código de 8
  // dígitos válido pero no aparece en sugerencias.
  const queryIsCustom = useMemo(() => {
    if (!/^\d{8}$/.test(debounced)) return false
    return !suggestions.some(s => s.code === debounced)
  }, [debounced, suggestions])

  function select(code) {
    onChange(code)
    setOpen(false)
    setQuery(code)
  }

  // Enter/Blur: si el usuario tecleó un código válido (8 dígitos) o un
  // nombre que matchea exactamente, lo comprometemos sin requerir click
  // en el dropdown. Evita perder lo escrito al hacer Tab o click fuera.
  function tryCommitFromQuery() {
    const raw = String(query || '').trim()
    if (!raw) return
    if (/^\d{8}$/.test(raw)) {
      if (raw !== value) select(raw)
      return
    }
    // Si hay una sugerencia exacta por nombre, aceptarla
    const exactByName = suggestions.find(s => s.name.toLowerCase() === raw.toLowerCase())
    if (exactByName && exactByName.code !== value) {
      select(exactByName.code)
    }
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter') {
      e.preventDefault()
      if (suggestions.length > 0) select(suggestions[0].code)
      else if (/^\d{8}$/.test(debounced)) select(debounced)
    } else if (e.key === 'Escape') {
      setOpen(false)
    }
  }

  return (
    <div ref={rootRef} className="relative">
      <input
        type="text"
        value={query}
        onChange={e => { setQuery(e.target.value); setOpen(true) }}
        onFocus={() => setOpen(true)}
        onKeyDown={handleKeyDown}
        onBlur={tryCommitFromQuery}
        placeholder="Escribe código (ej. 50202200) o nombre (ej. palomitas)…"
        disabled={disabled}
        className={clsx('input', error && 'input-error')}
        inputMode="text"
        autoComplete="off"
      />

      {/* Descripción del código actual debajo del input cuando matchea con
          una entrada del catálogo local. Si el código del cliente no está en
          nuestro seed (el catálogo del SAT tiene ~52K entradas, el seed solo
          cubre lo más común), no mostramos advertencia — el SAT valida al
          timbrar y el cliente sabe qué código está usando. */}
      {!open && value && resolved && (
        <p className="text-[11px] text-ink-muted mt-1">
          <span className="font-mono">{resolved.code}</span> · {resolved.name}
        </p>
      )}

      {open && !disabled && (
        <div className="absolute z-20 mt-1 w-full max-h-72 overflow-y-auto rounded-lg border border-line-subtle bg-surface-primary shadow-card">
          {isLoading && (
            <div className="px-3 py-2 text-xs text-ink-muted">Buscando…</div>
          )}
          {!isLoading && suggestions.length === 0 && !queryIsCustom && (
            <div className="px-3 py-2 text-xs text-ink-muted">
              Sin coincidencias. Si conoces la clave del SAT, escríbela completa (8 dígitos).
            </div>
          )}
          {suggestions.map(s => (
            <button
              key={s.code}
              type="button"
              onClick={() => select(s.code)}
              className={clsx(
                'w-full text-left px-3 py-1.5 text-sm hover:bg-surface-elevated/40 flex items-center gap-3',
                value === s.code && 'bg-brand-500/10'
              )}
            >
              <span className="font-mono text-xs text-ink-muted w-20 shrink-0">{s.code}</span>
              <span className="text-ink-primary truncate">{s.name}</span>
            </button>
          ))}
          {queryIsCustom && (
            <button
              type="button"
              onClick={() => select(debounced)}
              className="w-full text-left px-3 py-2 text-sm border-t border-line-subtle hover:bg-brand-500/10 flex items-center gap-3"
            >
              <span className="font-mono text-xs text-brand-300 w-20 shrink-0">{debounced}</span>
              <span className="text-brand-300">Usar este código del SAT</span>
            </button>
          )}
        </div>
      )}
    </div>
  )
}
