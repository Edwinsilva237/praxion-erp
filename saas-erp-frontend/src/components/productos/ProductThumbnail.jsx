import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { productsApi } from '@/api/products'
import { ImageLightbox } from './ImageLightbox'
import clsx from 'clsx'

/**
 * Thumbnail pequeño de la imagen del producto para la lista.
 * Si no hay imagen, muestra un placeholder con icono.
 *
 * Click → abre lightbox a tamaño completo.
 * Cachea el blob en react-query 10 min para evitar re-descargas al
 * navegar entre páginas de la lista.
 */
export function ProductThumbnail({ productId, attachmentId, size = 40, caption, className }) {
  const [zoom, setZoom] = useState(false)

  const { data: url } = useQuery({
    queryKey: ['product-image', productId, attachmentId],
    queryFn:  async () => {
      const blob = await productsApi.downloadAttachment(productId, attachmentId)
      return URL.createObjectURL(blob)
    },
    enabled:  !!productId && !!attachmentId,
    staleTime: 10 * 60 * 1000,
  })

  const style = { width: size, height: size }

  if (!attachmentId) {
    return (
      <div className={clsx('rounded-lg bg-surface-elevated/60 flex items-center justify-center text-ink-muted', className)}
           style={style}>
        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.409a2.25 2.25 0 013.182 0l2.909 2.909m-18 3.75h16.5a1.5 1.5 0 001.5-1.5V6a1.5 1.5 0 00-1.5-1.5H3.75A1.5 1.5 0 002.25 6v12a1.5 1.5 0 001.5 1.5z"/>
        </svg>
      </div>
    )
  }

  return (
    <>
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); url && setZoom(true) }}
        title={url ? 'Ver imagen completa' : 'Cargando…'}
        className={clsx(
          'rounded-lg overflow-hidden bg-surface-elevated/40 border border-line-subtle block',
          'hover:ring-2 hover:ring-brand-300 transition-shadow cursor-zoom-in',
          className
        )}
        style={style}>
        {url && <img src={url} alt="" className="w-full h-full object-cover" />}
      </button>
      {zoom && <ImageLightbox imageUrl={url} caption={caption} onClose={() => setZoom(false)} />}
    </>
  )
}
