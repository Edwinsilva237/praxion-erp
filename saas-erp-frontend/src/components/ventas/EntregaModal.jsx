import { useState, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { salesApi } from '@/api/sales'
import Spinner from '@/components/ui/Spinner'

/**
 * Modal para registrar la entrega de una remisión.
 * Captura foto del documento firmado + nombre del receptor.
 *
 * Props:
 *   note       — remisión (necesita id, document_number, partner_name)
 *   onClose, onDelivered
 */
export function EntregaModal({ note, onClose, onDelivered }) {
  const qc = useQueryClient()
  const fileInputRef = useRef(null)

  const [photoFile, setPhotoFile]   = useState(null)
  const [photoPreview, setPreview]  = useState(null)
  const [receiverName, setReceiverName] = useState('')
  const [error, setError]           = useState(null)

  function handlePhotoChange(e) {
    const f = e.target.files?.[0]
    if (!f) return
    if (f.size > 10 * 1024 * 1024) {
      setError('La foto excede 10MB. Toma una más pequeña.')
      return
    }
    setError(null)
    setPhotoFile(f)
    const reader = new FileReader()
    reader.onload = ev => setPreview(ev.target.result)
    reader.readAsDataURL(f)
  }

  function clearPhoto() {
    setPhotoFile(null)
    setPreview(null)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  const mutation = useMutation({
    mutationFn: () => {
      if (!receiverName.trim()) throw new Error('Captura el nombre de quien recibe.')

      const formData = new FormData()
      formData.append('receiverName', receiverName.trim())
      if (photoFile) formData.append('photo', photoFile)

      return salesApi.recordDelivery(note.id, formData)
    },
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['delivery-notes'] })
      qc.invalidateQueries({ queryKey: ['delivery-note', note.id] })
      qc.invalidateQueries({ queryKey: ['sales-orders'] })
      if (note.sales_order_id) {
        qc.invalidateQueries({ queryKey: ['sales-order', note.sales_order_id] })
        qc.invalidateQueries({ queryKey: ['sales-order', note.sales_order_id, 'pending'] })
      }
      onDelivered?.(res)
      onClose()
    },
    onError: (e) => setError(e.response?.data?.error || e.message || 'Error al registrar la entrega'),
  })

  function handleSubmit(e) { e.preventDefault(); setError(null); mutation.mutate() }

  return createPortal(
    <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/40 p-4">
      <form onSubmit={handleSubmit} className="card w-full max-w-md p-5 max-h-[92vh] overflow-y-auto flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-base font-semibold text-ink-primary">Registrar entrega</h3>
            <p className="text-xs text-ink-muted mt-0.5 font-mono">{note.document_number}</p>
          </div>
          <button type="button" onClick={onClose} className="btn-ghost btn-icon text-ink-muted">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12"/>
            </svg>
          </button>
        </div>

        {/* Foto */}
        <div>
          <label className="label">Foto del documento firmado</label>
          {photoPreview ? (
            <div className="relative">
              <img src={photoPreview} alt="Evidencia"
                className="w-full max-h-64 object-contain rounded-xl border border-line-subtle bg-surface-elevated/40" />
              <button type="button" onClick={clearPhoto}
                className="absolute top-2 right-2 bg-surface-primary/95 hover:bg-surface-primary border border-line-subtle rounded-full p-1.5 shadow-sm">
                <svg className="w-3.5 h-3.5 text-ink-secondary" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12"/>
                </svg>
              </button>
            </div>
          ) : (
            <label className="flex flex-col items-center gap-2 border-2 border-dashed border-line-subtle rounded-xl p-6 cursor-pointer hover:border-brand-500/40 hover:bg-brand-500/10/30 transition-colors">
              <svg className="w-8 h-8 text-ink-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z"/>
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 13a3 3 0 11-6 0 3 3 0 016 0z"/>
              </svg>
              <p className="text-sm text-ink-secondary font-medium">Tomar / subir foto</p>
              <p className="text-[11px] text-ink-muted">Acepta imágenes hasta 10MB</p>
              <input ref={fileInputRef} type="file"
                accept="image/jpeg,image/png,image/webp,application/pdf"
                capture="environment"
                onChange={handlePhotoChange}
                className="hidden" />
            </label>
          )}
        </div>

        {/* Receptor */}
        <div>
          <label className="label">Nombre de quien recibe <span className="text-status-danger">*</span></label>
          <input className="input text-base" value={receiverName}
            onChange={e => setReceiverName(e.target.value)}
            placeholder="Ej: Juan Pérez (almacén)" />
        </div>

        <div className="flex items-start gap-2 bg-surface-elevated/40 rounded-lg px-3 py-2">
          <svg className="w-4 h-4 text-ink-muted shrink-0 mt-0.5" fill="currentColor" viewBox="0 0 24 24">
            <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/>
          </svg>
          <p className="text-xs text-ink-secondary">
            Al registrar la entrega se genera automáticamente el pago pendiente del cliente y la remisión queda como <strong>Entregada</strong>.
          </p>
        </div>

        {error && <p className="field-error">{error}</p>}

        <div className="flex gap-2">
          <button type="button" onClick={onClose} className="btn-secondary flex-1" disabled={mutation.isPending}>
            Cancelar
          </button>
          <button type="submit" className="btn-primary flex-1" disabled={mutation.isPending}>
            {mutation.isPending ? <Spinner size="sm" /> : 'Registrar entrega'}
          </button>
        </div>
      </form>
    </div>,
    document.body
  )
}
