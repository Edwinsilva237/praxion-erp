import { useRef, useState } from 'react'

const MAX_MB = 20
const ACCEPT = 'application/pdf'

/**
 * Versión "stash" del tech sheets list para el modo creación.
 * Mantiene los PDFs en memoria; el upload real lo hace el padre
 * después de crear el producto.
 */
export function PendingSheetsPicker({ value = [], onChange }) {
  const inputRef = useRef(null)
  const [error, setError] = useState(null)

  function handleFile(file) {
    setError(null)
    if (!file) return
    if (file.type !== ACCEPT) return setError('Solo se aceptan archivos PDF.')
    if (file.size > MAX_MB * 1024 * 1024) {
      return setError(`El PDF excede ${MAX_MB}MB.`)
    }
    onChange([...value, file])
  }

  function removeAt(i) {
    onChange(value.filter((_, idx) => idx !== i))
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-xs font-medium text-ink-secondary">Fichas técnicas</p>
          <p className="text-[11px] text-ink-muted">
            PDFs · se suben al crear el producto · datasheet, certificado, etc.
          </p>
        </div>
        <button type="button" onClick={() => inputRef.current?.click()}
          className="btn-ghost btn-sm text-brand-300">
          + Agregar PDF
        </button>
        <input ref={inputRef} type="file" accept={ACCEPT} className="hidden"
          onChange={(e) => { handleFile(e.target.files?.[0]); e.target.value = '' }} />
      </div>

      {error && (
        <div className="bg-status-danger/10 border border-status-danger/40 rounded-lg px-3 py-1.5 flex items-center justify-between">
          <p className="text-xs text-status-danger">{error}</p>
          <button onClick={() => setError(null)} className="text-status-danger text-xs">×</button>
        </div>
      )}

      {value.length === 0 ? (
        <p className="text-xs text-ink-muted italic py-2 text-center border border-dashed border-line-subtle rounded-lg">
          Sin fichas técnicas seleccionadas.
        </p>
      ) : (
        <div className="border border-line-subtle rounded-lg divide-y divide-line-subtle">
          {value.map((f, i) => (
            <div key={i} className="px-3 py-2 flex items-center gap-3">
              <svg className="w-5 h-5 text-status-danger shrink-0" fill="currentColor" viewBox="0 0 24 24">
                <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8l-6-6zm-1 7V3.5L18.5 9H13z"/>
              </svg>
              <div className="flex-1 min-w-0">
                <p className="text-xs font-medium text-ink-primary truncate" title={f.name}>
                  {f.name}
                </p>
                <p className="text-[10px] text-ink-muted">
                  {(f.size / 1024).toFixed(0)} KB · pendiente de subir
                </p>
              </div>
              <button type="button" onClick={() => removeAt(i)}
                className="btn-ghost btn-sm text-status-danger">
                ×
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
