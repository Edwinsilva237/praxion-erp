import { useState, useRef, useEffect, useMemo } from 'react'
import { SAT_UNITS, isSatUnitCodeValid, findSatUnit } from '@/data/satUnits'
import clsx from 'clsx'

/**
 * Combobox con búsqueda para la clave de unidad SAT (c_ClaveUnidad CFDI 4.0).
 *
 *  Comportamiento:
 *   - El usuario teclea el código (ej. "KGM") o el nombre (ej. "kilo") y la
 *     lista filtra por ambos.
 *   - Si la búsqueda matchea exactamente o parcialmente claves del catálogo
 *     curado (~150 unidades comunes), las muestra.
 *   - Si el cliente conoce una clave que no está en el catálogo curado, puede
 *     escribirla directamente (ej. "B43"). El componente la acepta siempre que
 *     cumpla el formato del SAT (1-3 caracteres alfanuméricos) y muestra un
 *     ítem extra "Usar B43 como código personalizado".
 *   - El valor que sale al form siempre es el código en mayúsculas.
 *
 *  Props:
 *   - value:      string. Código actual (ej. "KGM").
 *   - onChange:   (newCode: string) => void
 *   - className:  string opcional. Se aplica al input.
 *   - error:      boolean opcional. Cambia el borde del input.
 *   - disabled:   boolean opcional.
 */
export default function SatUnitCombobox({ value, onChange, className, error, disabled }) {
  const [open, setOpen]   = useState(false)
  const [query, setQuery] = useState('')
  const rootRef = useRef(null)

  // Cuando el value cambia desde fuera (ej. reset del form), reflejarlo en la query.
  useEffect(() => {
    if (!open) {
      const selected = findSatUnit(value)
      setQuery(selected ? `${selected.code} — ${selected.label}` : (value || ''))
    }
  }, [value, open])

  // Cerrar al hacer click fuera. Antes de cerrar, intentamos hacer commit del
  // texto que el usuario tecleó para no perder código personalizado.
  useEffect(() => {
    function onDoc(e) {
      if (rootRef.current && !rootRef.current.contains(e.target)) {
        // Commit antes de cerrar
        tryCommitFromQueryRef.current?.()
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [])

  // Ref para evitar dependencias circulares en el useEffect del click fuera.
  const tryCommitFromQueryRef = useRef(null)
  useEffect(() => {
    tryCommitFromQueryRef.current = tryCommitFromQuery
  })

  // Filtrado: por código exacto, prefijo, o substring del label.
  const filtered = useMemo(() => {
    const q = (query || '').toUpperCase().trim()
    if (!q) return SAT_UNITS.slice(0, 50)
    // Tokens del query para hacer un AND simple sobre code+label
    const tokens = q.split(/\s+/).filter(Boolean)
    return SAT_UNITS.filter(u => {
      const haystack = `${u.code} ${u.label.toUpperCase()}`
      return tokens.every(t => haystack.includes(t))
    }).slice(0, 50)
  }, [query])

  // Si el usuario tipeó algo que parece un código SAT válido pero NO está
  // en el catálogo curado, ofrecer guardarlo como código personalizado.
  const queryUpper = String(query || '').toUpperCase().trim()
  const queryIsCustomCandidate =
    isSatUnitCodeValid(queryUpper)
    && !SAT_UNITS.some(u => u.code === queryUpper)

  function select(code) {
    onChange(code)
    setOpen(false)
    const u = findSatUnit(code)
    setQuery(u ? `${u.code} — ${u.label}` : code)
  }

  function handleInputChange(e) {
    setQuery(e.target.value)
    setOpen(true)
  }

  // Si el usuario escribe un código válido y sale del input (Tab/click fuera)
  // o pulsa Enter sin elegir nada del dropdown, lo aceptamos automáticamente.
  // Esto evita la situación en la que tecleaba "MIL" y al salir el componente
  // resetea al valor anterior porque nadie llamó onChange.
  function tryCommitFromQuery() {
    const raw = String(query || '').toUpperCase().trim()
    if (!raw) return
    // Caso 1: ya seleccionó una entrada del catálogo con el formato "XXX — Label".
    const fromLabel = raw.split('—')[0].trim()
    const matchByCode = findSatUnit(fromLabel) || findSatUnit(raw)
    if (matchByCode) {
      if (matchByCode.code !== value) select(matchByCode.code)
      return
    }
    // Caso 2: lo tecleado parece un código SAT válido pero no está en catálogo →
    // aceptarlo como personalizado.
    if (isSatUnitCodeValid(raw)) {
      if (raw !== value) select(raw)
    }
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter') {
      e.preventDefault()
      // Si hay sugerencias, tomar la primera; si no, intentar el código tecleado.
      if (filtered.length > 0) {
        select(filtered[0].code)
      } else if (queryIsCustomCandidate) {
        select(queryUpper)
      } else {
        tryCommitFromQuery()
      }
    } else if (e.key === 'Escape') {
      setOpen(false)
    }
  }

  return (
    <div ref={rootRef} className="relative">
      <input
        type="text"
        value={query}
        onChange={handleInputChange}
        onFocus={() => setOpen(true)}
        onKeyDown={handleKeyDown}
        onBlur={tryCommitFromQuery}
        placeholder="Escribe código (ej. KGM) o nombre (ej. kilogramo)…"
        disabled={disabled}
        className={clsx('input', error && 'input-error', className)}
        autoComplete="off"
      />
      {open && !disabled && (
        <div className="absolute z-20 mt-1 w-full max-h-64 overflow-y-auto rounded-lg border border-line-subtle bg-surface-primary shadow-card">
          {filtered.length === 0 && !queryIsCustomCandidate && (
            <div className="px-3 py-2 text-xs text-ink-muted">
              Sin coincidencias. Si conoces la clave SAT, escríbela completa (1-3 caracteres).
            </div>
          )}
          {filtered.map(u => (
            <button
              key={u.code}
              type="button"
              onClick={() => select(u.code)}
              className={clsx(
                'w-full text-left px-3 py-1.5 text-sm hover:bg-surface-elevated/40 flex items-center gap-3',
                value === u.code && 'bg-brand-500/10'
              )}
            >
              <span className="font-mono text-xs text-ink-muted w-12 shrink-0">{u.code}</span>
              <span className="text-ink-primary truncate">{u.label}</span>
            </button>
          ))}
          {queryIsCustomCandidate && (
            <button
              type="button"
              onClick={() => select(queryUpper)}
              className="w-full text-left px-3 py-2 text-sm border-t border-line-subtle hover:bg-brand-500/10 flex items-center gap-3"
            >
              <span className="font-mono text-xs text-brand-300 w-12 shrink-0">{queryUpper}</span>
              <span className="text-brand-300">Usar como código personalizado del SAT</span>
            </button>
          )}
        </div>
      )}
    </div>
  )
}
