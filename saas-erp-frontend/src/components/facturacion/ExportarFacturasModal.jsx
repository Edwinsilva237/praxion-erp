import { useState } from 'react'
import { createPortal } from 'react-dom'
import { invoicingApi } from '@/api/invoicing'
import { partnersApi } from '@/api/partners'
import Autocomplete from '@/components/ui/Autocomplete'
import Spinner from '@/components/ui/Spinner'
import { downloadBlob } from '@/utils/downloadBlob'

/**
 * Exportación de facturación por cliente y periodo:
 *   - Excel: listado con montos, cobrado y saldo (+ hoja de complementos).
 *   - ZIP: XML y PDF de cada documento (+ Resumen.xlsx) — "las facturas del
 *     mes" para el contador. Tope de 300 documentos por descarga.
 *
 * Modal SIEMPRE via createPortal(document.body) — ver gotcha .page-enter.
 */
const firstOfMonth = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`
}
const today = () => new Date().toISOString().slice(0, 10)

export function ExportarFacturasModal({ onClose, initialPartner = null, initialFrom = '', initialTo = '' }) {
  const [partner, setPartner]   = useState(initialPartner)
  const [dateFrom, setDateFrom] = useState(initialFrom || firstOfMonth())
  const [dateTo, setDateTo]     = useState(initialTo || today())
  const [includeCancelled, setIncludeCancelled]     = useState(false)
  const [includeCreditNotes, setIncludeCreditNotes] = useState(true)
  const [includeComplements, setIncludeComplements] = useState(true)
  const [busy, setBusy]   = useState(null)          // 'excel' | 'zip' | null
  const [error, setError] = useState(null)

  const searchPartners = async (q) => {
    const res = await partnersApi.list({ search: q, role: 'customer', limit: 20 })
    return (res.data || res).map(p => ({ id: p.id, label: p.name,
      sub: [p.rfc, p.tax_name && p.tax_name !== p.name ? p.tax_name : null].filter(Boolean).join(' · ') }))
  }

  const params = () => ({
    dateFrom, dateTo,
    ...(partner?.id ? { partnerId: partner.id } : {}),
    ...(includeCancelled   ? { includeCancelled: 1 } : {}),
    ...(includeCreditNotes ? { includeCreditNotes: 1 } : {}),
    ...(includeComplements ? { includeComplements: 1 } : {}),
  })

  async function download(kind) {
    if (!dateFrom || !dateTo) { setError('Elige el periodo (desde y hasta).'); return }
    if (dateFrom > dateTo) { setError('La fecha inicial es posterior a la final.'); return }
    setError(null); setBusy(kind)
    try {
      const fn = kind === 'excel' ? invoicingApi.exportExcel : invoicingApi.exportZip
      const r = await fn(params())
      const who = partner ? `_${String(partner.label || '').replace(/[^\w-]+/g, '_').slice(0, 30)}` : ''
      downloadBlob(r.data, `Facturas_${dateFrom}_a_${dateTo}${who}.${kind === 'excel' ? 'xlsx' : 'zip'}`)
    } catch (e) {
      // responseType:'blob' → el JSON de error del servidor llega como Blob.
      let msg = e.response?.data?.error
      if (!msg && e.response?.data instanceof Blob) {
        try { msg = JSON.parse(await e.response.data.text()).error } catch { /* no-json */ }
      }
      setError(msg || e.message || 'Error al exportar')
    } finally {
      setBusy(null)
    }
  }

  return createPortal(
    <div className="fixed inset-0 z-[9998] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40" onClick={() => !busy && onClose()} />
      <div className="relative bg-surface-primary rounded-xl shadow-card w-full max-w-lg p-5 flex flex-col gap-4 max-h-[90vh] overflow-y-auto">
        <div>
          <h2 className="text-lg font-semibold text-ink-primary">Exportar facturación</h2>
          <p className="text-xs text-ink-muted mt-0.5">
            Excel con el listado, o ZIP con los XML y PDF del periodo (incluye el Excel de resumen).
          </p>
        </div>

        <div>
          <label className="label">Cliente (opcional — vacío = todos)</label>
          <Autocomplete value={partner} onChange={setPartner}
            onSearch={searchPartners} placeholder="Todos los clientes" />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">Desde</label>
            <input type="date" className="input" value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)} />
          </div>
          <div>
            <label className="label">Hasta</label>
            <input type="date" className="input" value={dateTo}
              onChange={(e) => setDateTo(e.target.value)} />
          </div>
        </div>

        <div className="flex flex-col gap-2 text-sm">
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={includeCreditNotes}
              onChange={(e) => setIncludeCreditNotes(e.target.checked)} />
            Incluir notas de crédito del periodo
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={includeComplements}
              onChange={(e) => setIncludeComplements(e.target.checked)} />
            Incluir complementos de pago (REP) del periodo
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={includeCancelled}
              onChange={(e) => setIncludeCancelled(e.target.checked)} />
            Incluir también canceladas
          </label>
        </div>

        {error && <div className="alert-error text-sm">{error}</div>}

        <div className="flex flex-col sm:flex-row justify-end gap-2 pt-1">
          <button type="button" className="btn-secondary" disabled={!!busy} onClick={onClose}>
            Cerrar
          </button>
          <button type="button" className="btn-secondary" disabled={!!busy} onClick={() => download('excel')}>
            {busy === 'excel' ? <Spinner size="sm" /> : '📊'} Descargar Excel
          </button>
          <button type="button" className="btn-primary" disabled={!!busy} onClick={() => download('zip')}>
            {busy === 'zip' ? <Spinner size="sm" /> : '🗜️'} Descargar ZIP (XML y PDF)
          </button>
        </div>
        {busy === 'zip' && (
          <p className="text-[11px] text-ink-muted text-right -mt-2">
            Bajando cada XML y PDF del timbrador — puede tardar un poco con muchos documentos…
          </p>
        )}
      </div>
    </div>,
    document.body
  )
}
