import { useState } from 'react'
import { invoicingApi } from '@/api/invoicing'
import { downloadBlob } from '@/utils/downloadBlob'
import Spinner from '@/components/ui/Spinner'
import Can from '@/components/auth/Can'

/**
 * Botones PDF / XML de una factura TIMBRADA (para las importadas el backend
 * sirve automáticamente el respaldo adjunto). Autocontenido: maneja loading y
 * error localmente, y detiene la propagación del click (pensado para vivir
 * dentro de filas clickeables de tablas de CxC / reportes).
 *
 * Solo se muestra a usuarios con permiso invoicing:read (los endpoints de
 * descarga lo exigen).
 */
export default function InvoiceFileButtons({ invoiceId, documentNumber }) {
  const [loading, setLoading] = useState(null)  // 'pdf' | 'xml' | null
  const [error, setError] = useState(null)

  if (!invoiceId) return null

  async function download(kind) {
    setError(null); setLoading(kind)
    try {
      const fn = kind === 'xml' ? invoicingApi.downloadXmlStamped : invoicingApi.downloadPdfStamped
      const r = await fn(invoiceId)
      downloadBlob(r.data, `${documentNumber || invoiceId}.${kind}`)
    } catch (e) {
      // Con responseType:'blob' el error JSON llega envuelto en un Blob.
      let msg = e.response?.data?.error || e.message
      if (e.response?.data instanceof Blob) {
        try { msg = JSON.parse(await e.response.data.text()).error || msg } catch (_) {}
      }
      setError(msg || `No se pudo descargar el ${kind.toUpperCase()}`)
    } finally {
      setLoading(null)
    }
  }

  return (
    <Can do="invoicing:read">
      <span className="inline-flex items-center gap-1" onClick={e => e.stopPropagation()}>
        <button type="button" onClick={() => download('pdf')} disabled={!!loading}
          className="btn-secondary btn-sm" title="Descargar PDF de la factura">
          {loading === 'pdf' ? <Spinner size="sm" /> : 'PDF'}
        </button>
        <button type="button" onClick={() => download('xml')} disabled={!!loading}
          className="btn-ghost btn-sm" title="Descargar XML de la factura">
          {loading === 'xml' ? <Spinner size="sm" /> : 'XML'}
        </button>
        {error && (
          <span className="text-status-danger text-xs cursor-help" title={error}>⚠</span>
        )}
      </span>
    </Can>
  )
}
