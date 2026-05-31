import { useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import api from '@/api/axios'
import Spinner from '@/components/ui/Spinner'
import { downloadBlob } from '@/utils/downloadBlob'

/**
 * Carga la evidencia de entrega de una remisión via axios (preservando los
 * headers X-Tenant-Slug y Authorization). Si es imagen la muestra (con lightbox
 * fullscreen al hacer click). Si es un PDF (documento escaneado) ofrece abrirlo /
 * descargarlo — un <img> no puede renderizar un PDF.
 *
 * Props:
 *   noteId
 *   className — clases para el wrapper de la imagen pequeña
 */
export function DeliveryPhoto({ noteId, className }) {
  const [blob, setBlob] = useState(null)
  const [blobUrl, setBlobUrl] = useState(null)
  const [isPdf, setIsPdf] = useState(false)
  const [error, setError] = useState(null)
  const [showLightbox, setShowLightbox] = useState(false)

  useEffect(() => {
    let createdUrl = null
    let cancelled = false

    api.get(`/sales/delivery-notes/${noteId}/photo`, { responseType: 'blob' })
      .then(async r => {
        if (cancelled) return
        const b = r.data
        // Detectar PDF por content-type y, como respaldo, por los bytes "%PDF".
        let pdf = b.type === 'application/pdf'
        if (!pdf) {
          try { pdf = (await b.slice(0, 5).text()).startsWith('%PDF') } catch { /* ignore */ }
        }
        if (cancelled) return
        setBlob(b)
        setIsPdf(pdf)
        if (!pdf) {
          createdUrl = URL.createObjectURL(b)
          setBlobUrl(createdUrl)
        }
      })
      .catch(e => {
        if (cancelled) return
        setError(e.response?.data?.error || e.message || 'No se pudo cargar')
      })

    return () => {
      cancelled = true
      if (createdUrl) URL.revokeObjectURL(createdUrl)
    }
  }, [noteId])

  if (error) {
    return <p className="text-xs text-status-danger italic">No se pudo cargar la evidencia: {error}</p>
  }
  if (!blob) {
    return <div className="flex justify-center py-8"><Spinner size="sm" /></div>
  }

  // PDF (documento escaneado): no se muestra en <img> → botón para abrir/descargar.
  if (isPdf) {
    return (
      <div className="flex items-center gap-3 rounded-xl border border-line-subtle bg-surface-elevated/40 p-4">
        <svg className="w-9 h-9 text-status-danger shrink-0" fill="currentColor" viewBox="0 0 24 24">
          <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z"/>
        </svg>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-ink-primary">Evidencia en PDF</p>
          <p className="text-xs text-ink-muted">Documento escaneado</p>
        </div>
        <button type="button" onClick={() => downloadBlob(blob, `evidencia-${noteId}.pdf`)}
          className="btn-secondary btn-sm shrink-0">
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/>
          </svg>
          Abrir
        </button>
      </div>
    )
  }

  return (
    <>
      <button type="button" onClick={() => setShowLightbox(true)}
        className={className || "block w-full group"}>
        <img src={blobUrl} alt="Evidencia de entrega"
          className="w-full max-h-72 object-contain rounded-xl border border-line-subtle bg-surface-elevated/40 group-hover:border-brand-500/40 transition-colors" />
        <p className="text-[11px] text-ink-muted mt-1 text-center">Click para ver en grande</p>
      </button>

      {showLightbox && createPortal(
        <div className="fixed inset-0 z-[10002] bg-black/90 flex items-center justify-center p-4 cursor-zoom-out"
          onClick={() => setShowLightbox(false)}>
          <img src={blobUrl} alt="Evidencia de entrega"
            className="max-w-full max-h-full object-contain"
            onClick={e => e.stopPropagation()} />
          <button onClick={() => setShowLightbox(false)}
            className="absolute top-4 right-4 text-white/80 hover:text-white bg-black/40 hover:bg-black/60 rounded-full p-2">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12"/>
            </svg>
          </button>
        </div>,
        document.body
      )}
    </>
  )
}
