import { useState, useRef, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { salesApi } from '@/api/sales'
import Spinner from '@/components/ui/Spinner'
import { useDocumentScanner } from '@/hooks/useDocumentScanner'

// Reconstruye un File desde un data URL (para restaurar el borrador guardado).
function dataUrlToFile(dataUrl, name, type) {
  const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1)
  const mime = type || dataUrl.slice(5, dataUrl.indexOf(';')) || 'application/octet-stream'
  const bin = atob(b64)
  const arr = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i)
  return new File([arr], name || 'evidencia', { type: mime })
}

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
  const { isSupported: scanSupported, scanToPdf } = useDocumentScanner()
  const DRAFT_KEY = `entrega-draft-${note.id}`

  const [photoFile, setPhotoFile]   = useState(null)
  const [photoPreview, setPreview]  = useState(null)
  const [photoB64, setPhotoB64]     = useState(null) // base64 para persistir el borrador
  const [pageCount, setPageCount]   = useState(null) // si la evidencia es un PDF escaneado
  const [scanning, setScanning]     = useState(false)
  const [receiverName, setReceiverName] = useState('')
  const [restored, setRestored]     = useState(false)
  const [error, setError]           = useState(null)

  // Restaurar borrador al abrir: si la app se recargó tras abrir la cámara
  // (Android la mata por memoria), recuperamos foto + nombre y no se pierde nada.
  useEffect(() => {
    try {
      const d = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null')
      if (!d) return
      if (d.receiverName) setReceiverName(d.receiverName)
      if (d.photoB64) {
        setPhotoB64(d.photoB64)
        setPhotoFile(dataUrlToFile(d.photoB64, d.photoName, d.photoType))
        setPageCount(d.pageCount || null)
        setPreview((d.photoType || '').startsWith('image/') ? d.photoB64 : null)
      }
      if (d.receiverName || d.photoB64) setRestored(true)
    } catch { /* borrador corrupto: lo ignoramos */ }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Guardar el borrador en cada cambio (sobrevive la recarga de la app).
  useEffect(() => {
    if (!receiverName && !photoB64) { try { localStorage.removeItem(DRAFT_KEY) } catch { /* */ } return }
    const draft = { receiverName, photoB64, photoName: photoFile?.name, photoType: photoFile?.type, pageCount }
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify(draft))
    } catch {
      // Cuota excedida (archivo muy grande): al menos conservamos el nombre.
      try { localStorage.setItem(DRAFT_KEY, JSON.stringify({ receiverName })) } catch { /* */ }
    }
  }, [receiverName, photoB64, pageCount]) // eslint-disable-line react-hooks/exhaustive-deps

  const clearDraft = () => { try { localStorage.removeItem(DRAFT_KEY) } catch { /* */ } }
  const handleClose = () => { clearDraft(); onClose() }

  function handlePhotoChange(e) {
    const f = e.target.files?.[0]
    if (!f) return
    if (f.size > 10 * 1024 * 1024) {
      setError('El archivo excede 10MB. Usa uno más pequeño.')
      return
    }
    setError(null)
    setPhotoFile(f)
    setPageCount(null)
    // Leemos a base64 para la vista previa (solo imágenes) y para el borrador.
    const reader = new FileReader()
    reader.onload = ev => {
      setPhotoB64(ev.target.result)
      setPreview(f.type.startsWith('image/') ? ev.target.result : null)
    }
    reader.readAsDataURL(f)
  }

  // Escáner de documentos (ML Kit) → PDF. Solo en nativo.
  async function handleScan() {
    setError(null)
    setScanning(true)
    try {
      const res = await scanToPdf({ pageLimit: 5, fileName: `entrega-${note.document_number || 'remision'}.pdf` })
      if (res?.file) {
        if (res.file.size > 10 * 1024 * 1024) { setError('El documento escaneado excede 10MB.'); return }
        setPhotoFile(res.file)
        setPreview(null)
        setPageCount(res.pageCount || 1)
        const reader = new FileReader()
        reader.onload = ev => setPhotoB64(ev.target.result)
        reader.readAsDataURL(res.file)
      }
    } catch (e) {
      const msg = String(e?.message || '')
      if (!/cancel/i.test(msg)) setError('No se pudo escanear: ' + (e?.message || 'inténtalo de nuevo'))
    } finally {
      setScanning(false)
    }
  }

  function clearPhoto() {
    setPhotoFile(null)
    setPreview(null)
    setPhotoB64(null)
    setPageCount(null)
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
      clearDraft()
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
          <button type="button" onClick={handleClose} className="btn-ghost btn-icon text-ink-muted">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12"/>
            </svg>
          </button>
        </div>

        {restored && (
          <div className="flex items-start gap-2 bg-status-info/10 border border-status-info/40 rounded-lg px-3 py-2">
            <svg className="w-4 h-4 text-status-info shrink-0 mt-0.5" fill="currentColor" viewBox="0 0 24 24">
              <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/>
            </svg>
            <p className="text-xs text-status-info">Recuperamos tu captura en progreso — continúa donde te quedaste.</p>
          </div>
        )}

        {/* Foto */}
        <div>
          <label className="label">Foto del documento firmado</label>
          {photoFile ? (
            <div className="relative">
              {photoPreview ? (
                <img src={photoPreview} alt="Evidencia"
                  className="w-full max-h-64 object-contain rounded-xl border border-line-subtle bg-surface-elevated/40" />
              ) : (
                <div className="flex items-center gap-3 rounded-xl border border-line-subtle bg-surface-elevated/40 p-4">
                  <svg className="w-9 h-9 text-status-danger shrink-0" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z"/>
                  </svg>
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-ink-primary">Documento escaneado (PDF)</p>
                    <p className="text-xs text-ink-muted">
                      {pageCount ? `${pageCount} página${pageCount > 1 ? 's' : ''} · ` : ''}{(photoFile.size / 1024).toFixed(0)} KB
                    </p>
                  </div>
                </div>
              )}
              <button type="button" onClick={clearPhoto}
                className="absolute top-2 right-2 bg-surface-primary/95 hover:bg-surface-primary border border-line-subtle rounded-full p-1.5 shadow-sm">
                <svg className="w-3.5 h-3.5 text-ink-secondary" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12"/>
                </svg>
              </button>
            </div>
          ) : scanSupported ? (
            /* Nativo: escáner ML Kit (encuadre + auto-crop + perspectiva + PDF) */
            <div className="flex flex-col gap-2">
              <button type="button" onClick={handleScan} disabled={scanning}
                className="btn-primary justify-center">
                {scanning ? <Spinner size="sm" /> : (
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 7V5a1 1 0 011-1h2M4 17v2a1 1 0 001 1h2m10-16h2a1 1 0 011 1v2m-3 13h2a1 1 0 001-1v-2M7 12h10"/>
                  </svg>
                )}
                Escanear documento
              </button>
              <label className="btn-secondary justify-center cursor-pointer">
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-5l-4-4m0 0L8 7m4-4v12"/>
                </svg>
                Subir archivo
                <input ref={fileInputRef} type="file"
                  accept="image/jpeg,image/png,image/webp,application/pdf"
                  onChange={handlePhotoChange} className="hidden" />
              </label>
              <p className="text-[11px] text-ink-muted text-center">
                Escanea con encuadre y mejora automática (guarda PDF), o sube un archivo. Hasta 10MB.
              </p>
            </div>
          ) : (
            /* Web: cámara / subir archivo (sin escáner nativo) */
            <div className="flex flex-col gap-2">
              <div className="grid grid-cols-2 gap-2">
                <label className="flex flex-col items-center justify-center gap-1.5 border-2 border-dashed border-line-subtle rounded-xl p-5 cursor-pointer hover:border-brand-500/40 hover:bg-brand-500/10 transition-colors">
                  <svg className="w-7 h-7 text-ink-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z"/>
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 13a3 3 0 11-6 0 3 3 0 016 0z"/>
                  </svg>
                  <span className="text-xs text-ink-secondary font-medium">Tomar foto</span>
                  <input type="file" accept="image/*" capture="environment"
                    onChange={handlePhotoChange} className="hidden" />
                </label>
                <label className="flex flex-col items-center justify-center gap-1.5 border-2 border-dashed border-line-subtle rounded-xl p-5 cursor-pointer hover:border-brand-500/40 hover:bg-brand-500/10 transition-colors">
                  <svg className="w-7 h-7 text-ink-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-5l-4-4m0 0L8 7m4-4v12"/>
                  </svg>
                  <span className="text-xs text-ink-secondary font-medium">Subir archivo</span>
                  <input ref={fileInputRef} type="file"
                    accept="image/jpeg,image/png,image/webp,application/pdf"
                    onChange={handlePhotoChange} className="hidden" />
                </label>
              </div>
              <p className="text-[11px] text-ink-muted text-center">Imágenes o PDF, hasta 10MB</p>
            </div>
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
