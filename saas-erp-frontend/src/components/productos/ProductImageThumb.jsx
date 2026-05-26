import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { productsApi } from '@/api/products'
import { ImageLightbox } from './ImageLightbox'
import Spinner from '@/components/ui/Spinner'
import clsx from 'clsx'

/**
 * Botón pequeño para visualizar la foto de un producto desde cualquier línea
 * (pedido, remisión, factura). Lazy-loads la imagen solo cuando el usuario
 * hace click — no descarga blobs de todos los productos al renderizar la
 * tabla.
 *
 * Props:
 *   productId:         requerido
 *   imageAttachmentId: si null/undefined → muestra el ícono en gris (sin foto)
 *   caption:           texto debajo del lightbox (típicamente nombre del producto)
 *   size:              'sm' (default, 18px) | 'md' (24px) — tamaño del ícono
 */
export function ProductImageThumb({ productId, imageAttachmentId, caption, size = 'sm' }) {
  const [open, setOpen] = useState(false)
  const hasImage = !!imageAttachmentId

  // Lazy: la query solo se dispara cuando el usuario abre el lightbox.
  const { data: imageUrl, isLoading } = useQuery({
    queryKey: ['product-image', productId, imageAttachmentId],
    queryFn:  async () => {
      const blob = await productsApi.downloadAttachment(productId, imageAttachmentId)
      return URL.createObjectURL(blob)
    },
    enabled:   open && hasImage,
    staleTime: 10 * 60 * 1000,
  })

  const iconSize = size === 'md' ? 'w-5 h-5' : 'w-4 h-4'

  if (!hasImage) {
    return (
      <span
        title="Sin foto en el catálogo"
        className={clsx('inline-flex items-center justify-center text-ink-muted align-middle', iconSize)}
        aria-hidden="true">
        <svg className="w-full h-full" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round"
            d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.409a2.25 2.25 0 013.182 0l2.909 2.909m-18 3.75h16.5a1.5 1.5 0 001.5-1.5V6a1.5 1.5 0 00-1.5-1.5H3.75A1.5 1.5 0 002.25 6v12a1.5 1.5 0 001.5 1.5z"/>
        </svg>
      </span>
    )
  }

  return (
    <>
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); setOpen(true) }}
        title="Ver foto del producto"
        aria-label="Ver foto del producto"
        className={clsx(
          'inline-flex items-center justify-center text-brand-300 hover:text-brand-300',
          'hover:bg-brand-500/10 rounded-md p-0.5 transition-colors align-middle',
          iconSize === 'w-5 h-5' ? 'min-h-[28px] min-w-[28px]' : 'min-h-[24px] min-w-[24px]'
        )}>
        {isLoading && open ? (
          <Spinner className={iconSize} />
        ) : (
          <svg className={iconSize} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round"
              d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.409a2.25 2.25 0 013.182 0l2.909 2.909m-18 3.75h16.5a1.5 1.5 0 001.5-1.5V6a1.5 1.5 0 00-1.5-1.5H3.75A1.5 1.5 0 002.25 6v12a1.5 1.5 0 001.5 1.5zm10.5-11.25h.008v.008h-.008V8.25zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0z"/>
          </svg>
        )}
      </button>
      {open && imageUrl && (
        <ImageLightbox
          imageUrl={imageUrl}
          caption={caption}
          onClose={() => setOpen(false)} />
      )}
    </>
  )
}
