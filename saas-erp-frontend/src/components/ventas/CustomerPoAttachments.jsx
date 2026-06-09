import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Capacitor } from '@capacitor/core'
import { salesApi } from '@/api/sales'
import { printBlob, downloadBlob } from '@/utils/downloadBlob'
import clsx from 'clsx'

/**
 * Abre / imprime un documento de OC del cliente (PDF o imagen) según plataforma.
 *  - Web: abre en pestaña nueva → el usuario imprime con Ctrl+P (sirve PDF e imagen).
 *  - Nativo: PDF → diálogo de impresión nativo; imagen → menú compartir/guardar.
 */
export async function viewOrPrintPo(blob, att) {
  const isPdf = (att?.mime_type || '').includes('pdf')
  if (Capacitor.isNativePlatform()) {
    if (isPdf) await printBlob(blob, att?.filename || 'OC-cliente')
    else await downloadBlob(blob, att?.filename || 'OC-cliente')
    return
  }
  const url = URL.createObjectURL(blob)
  window.open(url, '_blank')
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

/**
 * Adjuntos de la ORDEN DE COMPRA del cliente sobre un pedido (sales_order).
 * El cliente a veces exige su propia OC impresa para recibir la mercancía, así
 * que se adjunta aquí (PDF/foto) y se puede descargar/imprimir desde el pedido
 * y desde la remisión ligada. Aditivo (varios documentos por pedido).
 *
 * @param {string}  orderId
 * @param {boolean} [readOnly] — oculta subir/quitar (solo ver/imprimir).
 */
export default function CustomerPoAttachments({ orderId, readOnly = false }) {
  const qc = useQueryClient()
  const [busy, setBusy] = useState(false)
  const [err, setErr]   = useState(null)

  const { data: files = [], isLoading } = useQuery({
    queryKey: ['order-po', orderId],
    queryFn:  () => salesApi.listOrderPo(orderId),
    enabled:  !!orderId,
  })

  function invalidate() {
    qc.invalidateQueries({ queryKey: ['order-po', orderId] })
    qc.invalidateQueries({ queryKey: ['sales-order', orderId] })
  }

  const upload = useMutation({
    mutationFn: (file) => {
      const fd = new FormData()
      fd.append('file', file)
      return salesApi.addOrderPo(orderId, fd)
    },
    onMutate: () => { setBusy(true); setErr(null) },
    onSuccess: invalidate,
    onError: (e) => setErr(e.response?.data?.error || e.message || 'No se pudo subir el documento.'),
    onSettled: () => setBusy(false),
  })

  async function view(att) {
    setErr(null)
    try {
      const blob = await salesApi.downloadOrderPo(orderId, att.id)
      await viewOrPrintPo(blob, att)
    } catch (e) {
      setErr(e.response?.data?.error || 'No se pudo abrir el documento.')
    }
  }

  async function remove(att) {
    if (!window.confirm(`¿Quitar el documento "${att.filename}"?`)) return
    setBusy(true); setErr(null)
    try {
      await salesApi.deleteOrderPo(orderId, att.id)
      invalidate()
    } catch (e) {
      setErr(e.response?.data?.error || e.message || 'No se pudo quitar el documento.')
    } finally { setBusy(false) }
  }

  return (
    <div className="border border-line-subtle rounded-xl p-3 flex flex-col gap-2">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
        <div className="min-w-0">
          <p className="text-xs font-bold text-brand-300 uppercase tracking-wider">Orden de compra del cliente</p>
          <p className="text-[11px] text-ink-muted">Documento (PDF o foto) que el cliente exige para recibir la mercancía.</p>
        </div>
        {!readOnly && (
          <label className={clsx('btn-secondary btn-sm cursor-pointer shrink-0', busy && 'opacity-50 pointer-events-none')}>
            Adjuntar OC
            <input type="file" accept="image/*,application/pdf" className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) upload.mutate(f) }} />
          </label>
        )}
      </div>

      {err && <p className="text-xs text-status-danger">{err}</p>}
      {(busy || isLoading) && <p className="text-xs text-ink-muted">Procesando…</p>}

      {files.length > 0 ? (
        <ul className="flex flex-col gap-1">
          {files.map(f => (
            <li key={f.id} className="flex items-center justify-between gap-2 text-xs bg-surface-elevated/40 rounded-lg px-3 py-1.5">
              <span className="truncate text-ink-secondary flex items-center gap-1.5 min-w-0">
                <svg className="w-3.5 h-3.5 shrink-0 text-ink-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/>
                </svg>
                <span className="truncate">{f.filename}</span>
              </span>
              <span className="flex items-center gap-3 shrink-0">
                <button type="button" onClick={() => view(f)} className="text-brand-300 hover:underline">Ver / Imprimir</button>
                {!readOnly && (
                  <button type="button" onClick={() => remove(f)} className="text-status-danger hover:underline">Quitar</button>
                )}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[11px] text-ink-muted italic">Sin documento de OC adjunto.</p>
      )}
    </div>
  )
}
