import { useRef, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { productsApi } from '@/api/products'
import Spinner from '@/components/ui/Spinner'
import { downloadBlob } from '@/utils/downloadBlob'
import { fmtDate } from '@/utils/fmt'

const MAX_MB = 20
const ACCEPT = 'application/pdf'

/**
 * Lista + sube + descarga + elimina fichas técnicas (PDF) de un producto.
 * Soporta múltiples archivos por producto (datasheet, certificado, etc.).
 */
export function TechSheetsList({ productId }) {
  const qc = useQueryClient()
  const inputRef = useRef(null)
  const [error, setError] = useState(null)
  const [downloadingId, setDownloadingId] = useState(null)

  const { data: sheets = [], isLoading } = useQuery({
    queryKey: ['product-tech-sheets', productId],
    queryFn:  () => productsApi.listAttachments(productId, 'technical_sheet'),
    enabled:  !!productId,
  })

  const uploadMut = useMutation({
    mutationFn: (file) => productsApi.uploadAttachment(productId, file, 'technical_sheet'),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['product-tech-sheets', productId] })
      setError(null)
    },
    onError: (e) => setError(e.response?.data?.error || e.message || 'Error al subir'),
  })

  const deleteMut = useMutation({
    mutationFn: (id) => productsApi.deleteAttachment(productId, id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['product-tech-sheets', productId] }),
    onError: (e) => setError(e.response?.data?.error || e.message || 'Error al eliminar'),
  })

  function handleFile(file) {
    setError(null)
    if (!file) return
    if (file.type !== ACCEPT) return setError('Solo se aceptan archivos PDF.')
    if (file.size > MAX_MB * 1024 * 1024) {
      return setError(`El PDF excede ${MAX_MB}MB.`)
    }
    uploadMut.mutate(file)
  }

  async function download(sheet) {
    setError(null); setDownloadingId(`dl-${sheet.id}`)
    try {
      const blob = await productsApi.downloadAttachment(productId, sheet.id)
      downloadBlob(blob, sheet.filename)
    } catch (e) {
      setError(e.response?.data?.error || e.message || 'Error al descargar')
    } finally {
      setDownloadingId(null)
    }
  }

  // Abre el PDF en una nueva pestaña usando un blob URL. El navegador lo
  // renderiza inline gracias al MIME del blob (sin necesidad de tocar el
  // Content-Disposition del backend).
  async function viewInTab(sheet) {
    setError(null); setDownloadingId(`view-${sheet.id}`)
    try {
      const blob = await productsApi.downloadAttachment(productId, sheet.id)
      const url = URL.createObjectURL(blob)
      window.open(url, '_blank', 'noopener,noreferrer')
      // No revocamos inmediatamente — el tab nuevo necesita la URL viva
      // unos segundos. Liberamos en 60s.
      setTimeout(() => URL.revokeObjectURL(url), 60_000)
    } catch (e) {
      setError(e.response?.data?.error || e.message || 'Error al abrir')
    } finally {
      setDownloadingId(null)
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-xs font-medium text-ink-secondary">Fichas técnicas</p>
          <p className="text-[11px] text-ink-muted">
            PDFs visibles para tu equipo · datasheet, certificado, ficha de seguridad, etc.
          </p>
        </div>
        <button type="button" onClick={() => inputRef.current?.click()}
          disabled={uploadMut.isPending} className="btn-ghost btn-sm text-brand-300">
          {uploadMut.isPending ? <Spinner size="sm" /> : '+ Subir PDF'}
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

      {isLoading ? (
        <div className="flex justify-center py-3"><Spinner size="sm" /></div>
      ) : sheets.length === 0 ? (
        <p className="text-xs text-ink-muted italic py-2 text-center border border-dashed border-line-subtle rounded-lg">
          Sin fichas técnicas. Sube el primer PDF arriba.
        </p>
      ) : (
        <div className="border border-line-subtle rounded-lg divide-y divide-line-subtle">
          {sheets.map(s => (
            <div key={s.id} className="px-3 py-2 flex items-center gap-3">
              <svg className="w-5 h-5 text-status-danger shrink-0" fill="currentColor" viewBox="0 0 24 24">
                <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8l-6-6zm-1 7V3.5L18.5 9H13z"/>
              </svg>
              <div className="flex-1 min-w-0">
                <p className="text-xs font-medium text-ink-primary truncate" title={s.filename}>
                  {s.filename}
                </p>
                <p className="text-[10px] text-ink-muted">
                  {(s.file_size_bytes / 1024).toFixed(0)} KB · {fmtDate(s.created_at)}
                  {s.uploaded_by_name && ` · ${s.uploaded_by_name}`}
                </p>
              </div>
              <button type="button" onClick={() => viewInTab(s)}
                disabled={!!downloadingId}
                title="Abrir en nueva pestaña"
                className="btn-ghost btn-sm text-brand-300">
                {downloadingId === `view-${s.id}` ? <Spinner size="sm" /> : 'Ver'}
              </button>
              <button type="button" onClick={() => download(s)}
                disabled={!!downloadingId}
                className="btn-ghost btn-sm">
                {downloadingId === `dl-${s.id}` ? <Spinner size="sm" /> : 'Descargar'}
              </button>
              <button type="button"
                onClick={() => { if (confirm(`Eliminar "${s.filename}"?`)) deleteMut.mutate(s.id) }}
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
