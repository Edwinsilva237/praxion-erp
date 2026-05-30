import { useState, useEffect, useMemo, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useQuery } from '@tanstack/react-query'
import api from '@/api/axios'
import clsx from 'clsx'
import { useAnchoredMenu } from '@/hooks/useAnchoredMenu'

const UNIT_PATTERN = /^[A-Z0-9]{1,3}$/

/**
 * Combobox con búsqueda para la clave de unidad SAT (c_ClaveUnidad CFDI 4.0).
 *
 * Mig 167-168 cargó el catálogo completo (2,418 claves) en BD; este componente
 * consulta /api/sat/unit-codes con debounce en vez de tener el catálogo
 * embebido. Las 164 unidades más comunes (mig 168) tienen descripción legible;
 * las demás muestran solo el código hasta que se cargue el Excel oficial.
 *
 * El menú se renderiza en un PORTAL anclado al input (useAnchoredMenu) para
 * que el `overflow-hidden` de las secciones colapsables no lo recorte.
 *
 * Props:
 *   - value     : string. Código actual (ej. "KGM").
 *   - onChange  : (newCode: string) => void
 *   - className : string opcional. Se aplica al input.
 *   - error     : boolean opcional.
 *   - disabled  : boolean opcional.
 */
export default function SatUnitCombobox({ value, onChange, className, error, disabled }) {
  const [open, setOpen]     = useState(false)
  const [query, setQuery]   = useState('')
  const [debounced, setDeb] = useState('')
  const tryCommitRef = useRef(null)
  // Al hacer click fuera, primero intenta comprometer lo tecleado, luego cierra.
  const { anchorRef, menuRef, menuPos } = useAnchoredMenu(
    open,
    () => { tryCommitRef.current?.(); setOpen(false) },
  )

  // Sincronizar value externo con la query mostrada.
  useEffect(() => {
    if (!open) setQuery(value || '')
  }, [value, open])

  // Debounce de la query (200 ms) antes de pegarle al backend.
  useEffect(() => {
    const t = setTimeout(() => setDeb(query.trim()), 200)
    return () => clearTimeout(t)
  }, [query])

  // Sugerencias del backend.
  const { data: suggestions = [], isLoading } = useQuery({
    queryKey: ['sat-unit-codes', debounced],
    queryFn:  () => api.get('/sat/unit-codes', { params: { q: debounced } }).then(r => r.data),
    enabled:  open,
    staleTime: 60 * 1000,
  })

  // Resolver del valor seleccionado para mostrar descripción al lado.
  const { data: resolved } = useQuery({
    queryKey: ['sat-unit-code', value],
    queryFn:  async () => {
      try { return await api.get(`/sat/unit-codes/${value}`).then(r => r.data) }
      catch { return null }
    },
    enabled:  !!value && UNIT_PATTERN.test(String(value).toUpperCase()),
    staleTime: 5 * 60 * 1000,
  })

  const queryUpper = String(query || '').toUpperCase().trim()
  const queryIsCustom = useMemo(() => {
    if (!UNIT_PATTERN.test(queryUpper)) return false
    return !suggestions.some(s => s.code === queryUpper)
  }, [queryUpper, suggestions])

  function select(code) {
    onChange(code)
    setOpen(false)
    setQuery(code)
  }

  // Enter / Blur: si el usuario tecleó un código válido (1-3 caracteres) o
  // tipeó una sugerencia válida, lo comprometemos sin requerir click. Evita
  // perder "MIL" u otros códigos que tenían que escribir manualmente.
  function tryCommit() {
    const raw = queryUpper
    if (!raw) return
    // El resolved exacto por code tiene preferencia.
    const exactByCode = suggestions.find(s => s.code === raw)
    if (exactByCode) {
      if (exactByCode.code !== value) select(exactByCode.code)
      return
    }
    // Acepta como personalizado si cumple formato del SAT.
    if (UNIT_PATTERN.test(raw)) {
      if (raw !== value) select(raw)
    }
  }
  useEffect(() => { tryCommitRef.current = tryCommit })

  function handleKeyDown(e) {
    if (e.key === 'Enter') {
      e.preventDefault()
      if (suggestions.length > 0) select(suggestions[0].code)
      else if (queryIsCustom) select(queryUpper)
      else tryCommit()
    } else if (e.key === 'Escape') {
      setOpen(false)
    }
  }

  // Texto de la descripción para mostrar debajo. Si el name == code (placeholder
  // del XSD oficial sin descripción), no mostramos la línea para no llenar la UI
  // con redundancia.
  const showResolved = resolved && resolved.name && resolved.name !== resolved.code

  return (
    <div className="relative">
      <input
        ref={anchorRef}
        type="text"
        value={query}
        onChange={e => { setQuery(e.target.value); setOpen(true) }}
        onFocus={() => setOpen(true)}
        onKeyDown={handleKeyDown}
        onBlur={tryCommit}
        placeholder="Escribe código (ej. KGM) o nombre (ej. kilogramo)…"
        disabled={disabled}
        className={clsx('input', error && 'input-error', className)}
        autoComplete="off"
      />

      {!open && showResolved && (
        <p className="text-[11px] text-ink-muted mt-1">
          <span className="font-mono">{resolved.code}</span> · {resolved.name}
        </p>
      )}

      {open && !disabled && menuPos && createPortal(
        <div
          ref={menuRef}
          style={{ position: 'fixed', zIndex: 10000, ...menuPos }}
          className="overflow-y-auto rounded-lg border border-line-subtle bg-surface-primary shadow-card"
        >
          {isLoading && (
            <div className="px-3 py-2 text-xs text-ink-muted">Buscando…</div>
          )}
          {!isLoading && suggestions.length === 0 && !queryIsCustom && (
            <div className="px-3 py-2 text-xs text-ink-muted">
              Sin coincidencias. Si conoces la clave del SAT, escríbela completa (1-3 caracteres).
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
              <span className="font-mono text-xs text-ink-muted w-12 shrink-0">{s.code}</span>
              <span className="text-ink-primary truncate">
                {s.name && s.name !== s.code ? s.name : <em className="text-ink-muted">sin descripción</em>}
              </span>
            </button>
          ))}
          {queryIsCustom && (
            <button
              type="button"
              onClick={() => select(queryUpper)}
              className="w-full text-left px-3 py-2 text-sm border-t border-line-subtle hover:bg-brand-500/10 flex items-center gap-3"
            >
              <span className="font-mono text-xs text-brand-300 w-12 shrink-0">{queryUpper}</span>
              <span className="text-brand-300">Usar este código del SAT</span>
            </button>
          )}
        </div>,
        document.body
      )}
    </div>
  )
}
