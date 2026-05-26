import { useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import api from '@/api/axios'
import Spinner from '@/components/ui/Spinner'

/**
 * Carga la foto de evidencia de una remisión via axios (preservando los
 * headers X-Tenant-Slug y Authorization) y la renderiza como blob URL.
 * Click sobre la imagen abre un lightbox fullscreen para verla en grande.
 *
 * Props:
 *   noteId
 *   className — clases para el wrapper de la imagen pequeña
 */
export function DeliveryPhoto({ noteId, className }) {
  const [blobUrl, setBlobUrl] = useState(null)
  const [error, setError] = useState(null)
  const [showLightbox, setShowLightbox] = useState(false)

  useEffect(() => {
    let createdUrl = null
    let cancelled = false

    api.get(`/sales/delivery-notes/${noteId}/photo`, { responseType: 'blob' })
      .then(r => {
        if (cancelled) return
        createdUrl = URL.createObjectURL(r.data)
        setBlobUrl(createdUrl)
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
    return <p className="text-xs text-status-danger italic">No se pudo cargar la foto: {error}</p>
  }
  if (!blobUrl) {
    return <div className="flex justify-center py-8"><Spinner size="sm" /></div>
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
