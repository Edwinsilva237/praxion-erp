import { useRef, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { productsApi } from '@/api/products'
import Spinner from '@/components/ui/Spinner'
import { ImageLightbox } from './ImageLightbox'
import clsx from 'clsx'

const MAX_MB = 5
const ACCEPT = 'image/jpeg,image/png,image/webp'

/**
 * Sube/reemplaza la imagen principal de un producto. Una sola imagen vigente
 * por producto — al subir una nueva, el backend elimina la anterior.
 */
export function ProductImageUploader({ productId, imageAttachmentId }) {
  const qc = useQueryClient()
  const inputRef = useRef(null)
  const [error, setError] = useState(null)
  const [zoom, setZoom]   = useState(false)

  // Carga la imagen como blob y la expone como object URL.
  const { data: imageUrl, isLoading } = useQuery({
    queryKey: ['product-image', productId, imageAttachmentId],
    queryFn:  async () => {
      if (!imageAttachmentId) return null
      const blob = await productsApi.downloadAttachment(productId, imageAttachmentId)
      return URL.createObjectURL(blob)
    },
    enabled:  !!productId && !!imageAttachmentId,
    staleTime: 10 * 60 * 1000,
  })

  const uploadMut = useMutation({
    mutationFn: (file) => productsApi.uploadAttachment(productId, file, 'image'),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['products'] })
      qc.invalidateQueries({ queryKey: ['product', productId] })
      qc.invalidateQueries({ queryKey: ['product-image', productId] })
      setError(null)
    },
    onError: (e) => setError(e.response?.data?.error || e.message || 'Error al subir la imagen'),
  })

  const deleteMut = useMutation({
    mutationFn: () => productsApi.deleteAttachment(productId, imageAttachmentId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['products'] })
      qc.invalidateQueries({ queryKey: ['product', productId] })
      qc.invalidateQueries({ queryKey: ['product-image', productId] })
    },
    onError: (e) => setError(e.response?.data?.error || e.message || 'Error al eliminar'),
  })

  function handleFile(file) {
    setError(null)
    if (!file) return
    if (!ACCEPT.split(',').includes(file.type)) {
      return setError('Formato no soportado. Usa JPG, PNG o WebP.')
    }
    if (file.size > MAX_MB * 1024 * 1024) {
      return setError(`La imagen excede ${MAX_MB}MB.`)
    }
    uploadMut.mutate(file)
  }

  const busy = uploadMut.isPending || deleteMut.isPending

  return (
    <div className="flex gap-4 items-start">
      <div
        onClick={() => {
          if (busy) return
          // Si ya hay imagen, click abre el lightbox; sin imagen, abre el selector.
          if (imageUrl) setZoom(true)
          else inputRef.current?.click()
        }}
        onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy' }}
        onDrop={(e) => {
          e.preventDefault()
          if (busy) return
          const f = e.dataTransfer.files?.[0]
          if (f) handleFile(f)
        }}
        title={imageUrl ? 'Click para ver completa' : 'Click o arrastra para subir'}
        className={clsx(
          'w-32 h-32 rounded-xl border-2 border-dashed flex items-center justify-center',
          'transition-colors shrink-0 overflow-hidden bg-surface-elevated/40',
          busy ? 'opacity-60 cursor-wait' : (imageUrl
            ? 'cursor-zoom-in hover:ring-2 hover:ring-brand-300'
            : 'cursor-pointer hover:border-brand-500/40 hover:bg-brand-500/10/30'),
          imageUrl ? 'border-line-subtle' : 'border-line-strong'
        )}>
        {isLoading ? (
          <Spinner size="sm" />
        ) : imageUrl ? (
          <img src={imageUrl} alt="Producto" className="w-full h-full object-cover" />
        ) : (
          <div className="text-center text-ink-muted px-2">
            <svg className="w-8 h-8 mx-auto" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.409a2.25 2.25 0 013.182 0l2.909 2.909m-18 3.75h16.5a1.5 1.5 0 001.5-1.5V6a1.5 1.5 0 00-1.5-1.5H3.75A1.5 1.5 0 002.25 6v12a1.5 1.5 0 001.5 1.5zm10.5-11.25h.008v.008h-.008V8.25zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0z"/>
            </svg>
            <p className="text-[10px] mt-1">Subir imagen</p>
          </div>
        )}
      </div>

      <div className="flex-1 min-w-0">
        <p className="text-xs font-medium text-ink-secondary">Imagen del producto</p>
        <p className="text-[11px] text-ink-muted mt-0.5">
          JPG, PNG o WebP · máx {MAX_MB}MB · arrastra o haz clic en el recuadro
        </p>
        <div className="flex gap-2 mt-2">
          <button type="button" onClick={() => inputRef.current?.click()}
            disabled={busy} className="btn-ghost btn-sm">
            {uploadMut.isPending
              ? <Spinner size="sm" />
              : (imageUrl ? 'Reemplazar' : 'Seleccionar archivo')}
          </button>
          {imageUrl && (
            <button type="button" onClick={() => setZoom(true)} disabled={busy}
              className="btn-ghost btn-sm">
              Ver completa
            </button>
          )}
          {imageUrl && imageAttachmentId && (
            <button type="button"
              onClick={() => { if (confirm('Eliminar la imagen del producto?')) deleteMut.mutate() }}
              disabled={busy}
              className="btn-ghost btn-sm text-status-danger">
              {deleteMut.isPending ? <Spinner size="sm" /> : 'Eliminar'}
            </button>
          )}
        </div>
        {error && <p className="field-error mt-1">{error}</p>}
        <input ref={inputRef} type="file" accept={ACCEPT} className="hidden"
          onChange={(e) => handleFile(e.target.files?.[0])} />
      </div>

      {zoom && <ImageLightbox imageUrl={imageUrl} caption="Imagen del producto" onClose={() => setZoom(false)} />}
    </div>
  )
}
