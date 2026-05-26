import { useEffect } from 'react'
import { createPortal } from 'react-dom'

/**
 * Overlay full-screen para visualizar una imagen en tamaño completo.
 * Click fuera de la imagen o tecla ESC para cerrar.
 *
 * Props:
 *   imageUrl: blob URL (de URL.createObjectURL) o URL absoluta
 *   caption:  texto debajo de la imagen (ej: nombre del producto)
 *   onClose:  callback al cerrar
 */
export function ImageLightbox({ imageUrl, caption, onClose }) {
  // Cerrar con ESC
  useEffect(() => {
    const handler = (e) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  if (!imageUrl) return null

  return createPortal(
    <div
      onClick={onClose}
      className="fixed inset-0 z-[10001] flex flex-col items-center justify-center bg-black/85 p-4 cursor-zoom-out">
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onClose() }}
        className="absolute top-4 right-4 text-white/80 hover:text-white"
        aria-label="Cerrar">
        <svg className="w-7 h-7" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12"/>
        </svg>
      </button>

      <img
        src={imageUrl}
        alt={caption || 'Producto'}
        onClick={(e) => e.stopPropagation()}
        className="max-w-[92vw] max-h-[85vh] object-contain rounded-lg shadow-card cursor-default" />

      {caption && (
        <p className="mt-3 text-sm text-white/80 max-w-[80vw] text-center truncate">
          {caption}
        </p>
      )}
    </div>,
    document.body
  )
}
