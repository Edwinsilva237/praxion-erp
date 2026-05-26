import { useRef, useState, useEffect } from 'react'
import clsx from 'clsx'

const MAX_MB = 5
const ACCEPT = 'image/jpeg,image/png,image/webp'

/**
 * Versión "stash" del image uploader para el modo creación.
 * Solo captura el archivo en memoria; el upload real lo hace el padre
 * después de crear el producto, contra el ID nuevo.
 */
export function PendingImagePicker({ value, onChange }) {
  const inputRef = useRef(null)
  const [error, setError] = useState(null)
  const [previewUrl, setPreviewUrl] = useState(null)

  // Generar preview cuando cambia el archivo
  useEffect(() => {
    if (!value) { setPreviewUrl(null); return }
    const url = URL.createObjectURL(value)
    setPreviewUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [value])

  function handleFile(file) {
    setError(null)
    if (!file) return
    if (!ACCEPT.split(',').includes(file.type)) {
      return setError('Formato no soportado. Usa JPG, PNG o WebP.')
    }
    if (file.size > MAX_MB * 1024 * 1024) {
      return setError(`La imagen excede ${MAX_MB}MB.`)
    }
    onChange(file)
  }

  return (
    <div className="flex gap-4 items-start">
      <div
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy' }}
        onDrop={(e) => {
          e.preventDefault()
          const f = e.dataTransfer.files?.[0]
          if (f) handleFile(f)
        }}
        className={clsx(
          'w-32 h-32 rounded-xl border-2 border-dashed flex items-center justify-center',
          'cursor-pointer transition-colors shrink-0 overflow-hidden bg-surface-elevated/40',
          previewUrl ? 'border-line-subtle' : 'border-line-strong hover:border-brand-500/40 hover:bg-brand-500/10/30'
        )}>
        {previewUrl ? (
          <img src={previewUrl} alt="Producto" className="w-full h-full object-cover" />
        ) : (
          <div className="text-center text-ink-muted px-2">
            <svg className="w-8 h-8 mx-auto" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.409a2.25 2.25 0 013.182 0l2.909 2.909m-18 3.75h16.5a1.5 1.5 0 001.5-1.5V6a1.5 1.5 0 00-1.5-1.5H3.75A1.5 1.5 0 002.25 6v12a1.5 1.5 0 001.5 1.5z"/>
            </svg>
            <p className="text-[10px] mt-1">Subir imagen</p>
          </div>
        )}
      </div>

      <div className="flex-1 min-w-0">
        <p className="text-xs font-medium text-ink-secondary">Imagen del producto</p>
        <p className="text-[11px] text-ink-muted mt-0.5">
          JPG, PNG o WebP · máx {MAX_MB}MB · se sube al crear el producto
        </p>
        <div className="flex gap-2 mt-2">
          <button type="button" onClick={() => inputRef.current?.click()} className="btn-ghost btn-sm">
            {value ? 'Reemplazar' : 'Seleccionar archivo'}
          </button>
          {value && (
            <button type="button" onClick={() => onChange(null)}
              className="btn-ghost btn-sm text-status-danger">
              Quitar
            </button>
          )}
        </div>
        {value && (
          <p className="text-[11px] text-ink-muted mt-1 truncate">
            {value.name} · {(value.size / 1024).toFixed(0)} KB
          </p>
        )}
        {error && <p className="field-error mt-1">{error}</p>}
        <input ref={inputRef} type="file" accept={ACCEPT} className="hidden"
          onChange={(e) => { handleFile(e.target.files?.[0]); e.target.value = '' }} />
      </div>
    </div>
  )
}
