import { useState } from 'react'
import { createPortal } from 'react-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Capacitor } from '@capacitor/core'
import { purchasesApi } from '@/api/purchases'
import { printBlob, downloadBlob } from '@/utils/downloadBlob'
import { fmtMXN, fmtDateOnly } from '@/utils/fmt'
import Badge from '@/components/ui/Badge'
import Spinner from '@/components/ui/Spinner'
import clsx from 'clsx'

// Abre/imprime un adjunto (XML/PDF/imagen) según plataforma.
async function viewAttachment(blob, att) {
  const isPdf = (att?.mime_type || '').includes('pdf')
  if (Capacitor.isNativePlatform()) {
    if (isPdf) await printBlob(blob, att?.filename || 'respaldo')
    else await downloadBlob(blob, att?.filename || 'respaldo')
    return
  }
  const url = URL.createObjectURL(blob)
  window.open(url, '_blank')
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

function Field({ label, children }) {
  return (
    <div className="bg-surface-elevated/60 border border-line-strong rounded-lg px-3 py-2">
      <p className="text-[10px] font-bold text-ink-secondary uppercase tracking-wide">{label}</p>
      <p className="text-sm font-medium text-ink-primary mt-0.5 break-words">{children ?? '—'}</p>
    </div>
  )
}

export function FacturaProveedorDetallePanel({ invoiceId, onClose }) {
  const qc = useQueryClient()
  const [err, setErr] = useState(null)
  const [busy, setBusy] = useState(false)

  const { data: inv, isLoading, error: queryError } = useQuery({
    queryKey: ['purchase-invoice-detail', invoiceId],
    queryFn:  () => purchasesApi.getInvoice(invoiceId),
    enabled:  !!invoiceId,
    retry:    1,
  })

  const { data: files = [] } = useQuery({
    queryKey: ['purchase-invoice-attachments', invoiceId],
    queryFn:  () => purchasesApi.listInvoiceAttachments(invoiceId),
    enabled:  !!invoiceId,
  })

  async function view(att) {
    setErr(null)
    try {
      const blob = await purchasesApi.downloadInvoiceAttachment(invoiceId, att.id)
      await viewAttachment(blob, att)
    } catch (e) {
      setErr(e.response?.data?.error || 'No se pudo abrir el archivo.')
    }
  }

  async function upload(file) {
    if (!file) return
    setBusy(true); setErr(null)
    try {
      const fd = new FormData()
      fd.append('file', file)
      await purchasesApi.addInvoiceAttachment(invoiceId, fd)
      qc.invalidateQueries({ queryKey: ['purchase-invoice-attachments', invoiceId] })
      qc.invalidateQueries({ queryKey: ['purchase-invoices'] })
    } catch (e) {
      setErr(e.response?.data?.error || e.message || 'No se pudo subir el respaldo.')
    } finally { setBusy(false) }
  }

  const isRemission = inv?.type === 'remission'
  const paid = parseFloat(inv?.amount_paid || 0)
  const pending = inv?.amount_pending != null ? parseFloat(inv.amount_pending) : parseFloat(inv?.balance || 0)

  return createPortal(
    <div className="fixed inset-0 z-[9998] flex">
      <div className="hidden sm:block flex-1 bg-black/30" onClick={onClose} />
      <div className="w-full max-w-xl bg-surface-primary h-full overflow-y-auto shadow-card flex flex-col">
        {/* Header */}
        <div className="sticky top-0 bg-surface-primary border-b border-line-subtle px-5 py-4 flex items-start gap-3 z-10"
          style={{ paddingTop: 'calc(1rem + env(safe-area-inset-top))' }}>
          <div className="flex-1 min-w-0">
            {isLoading ? (
              <div className="skeleton h-5 w-40" />
            ) : inv ? (
              <>
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-mono text-base font-bold text-ink-primary">{inv.invoice_number}</span>
                  <span className={clsx('text-[10px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded-full',
                    isRemission ? 'bg-purple-500/15 text-purple-300' : 'bg-emerald-100 text-emerald-700')}>
                    {isRemission ? 'Remisión' : 'Factura'}
                  </span>
                  {inv.status && <Badge status={inv.status} />}
                </div>
                <p className="text-xs text-ink-muted mt-1">
                  {inv.partner_name || inv.generic_supplier || '—'} · {fmtDateOnly(inv.invoice_date)}
                </p>
              </>
            ) : null}
          </div>
          <button onClick={onClose} className="btn-ghost btn-icon text-ink-muted shrink-0">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12"/>
            </svg>
          </button>
        </div>

        {/* Contenido */}
        <div className="flex-1 p-5">
          {isLoading ? (
            <div className="flex justify-center py-16"><Spinner /></div>
          ) : queryError || !inv ? (
            <p className="text-sm text-ink-muted text-center py-8">No se pudo cargar el comprobante.</p>
          ) : (
            <div className="flex flex-col gap-5">
              <div className="grid grid-cols-2 gap-2">
                <Field label="Proveedor">{inv.partner_name || inv.generic_supplier}</Field>
                <Field label="RFC">{inv.partner_rfc || inv.rfc_emisor}</Field>
                <Field label="UUID SAT">{inv.uuid_sat ? <span className="font-mono text-[11px]">{inv.uuid_sat}</span> : '—'}</Field>
                <Field label="Serie / Folio">{[inv.serie, inv.folio].filter(Boolean).join('-') || '—'}</Field>
                <Field label="F. emisión">{fmtDateOnly(inv.invoice_date)}</Field>
                <Field label="F. vencimiento">{fmtDateOnly(inv.due_date)}</Field>
                <Field label="OC">{inv.purchase_order_number}</Field>
                <Field label="Recepción">{inv.receipt_number}</Field>
                <Field label="Moneda">{inv.currency === 'USD'
                  ? `USD (TC ${inv.exchange_rate_value ? `$${Number(inv.exchange_rate_value).toFixed(4)}` : '—'})`
                  : 'MXN'}</Field>
                <Field label="Forma de pago">{inv.payment_method || '—'}</Field>
              </div>

              {/* Importes */}
              <div className="border border-line-subtle rounded-xl p-4 flex flex-col gap-1.5">
                <div className="flex justify-between text-sm"><span className="text-ink-muted">Subtotal</span>
                  <span className="font-mono tabular-nums">{fmtMXN(inv.subtotal, inv.currency)}</span></div>
                <div className="flex justify-between text-sm"><span className="text-ink-muted">IVA</span>
                  <span className="font-mono tabular-nums">{fmtMXN(inv.tax, inv.currency)}</span></div>
                <div className="flex justify-between text-sm font-semibold text-ink-primary border-t border-line-subtle pt-1.5">
                  <span>Total</span><span className="font-mono tabular-nums text-brand-300">{fmtMXN(inv.total, inv.currency)}</span></div>
              </div>

              {/* Estado de pago */}
              <div className="border border-line-subtle rounded-xl p-4 flex flex-col gap-1.5">
                <p className="text-xs font-bold text-brand-300 uppercase tracking-wider mb-1">Pago</p>
                <div className="flex justify-between text-sm"><span className="text-ink-muted">Pagado</span>
                  <span className="font-mono tabular-nums text-status-success">{fmtMXN(paid)}</span></div>
                <div className="flex justify-between text-sm"><span className="text-ink-muted">Pendiente</span>
                  <span className={clsx('font-mono tabular-nums font-semibold',
                    pending <= 0.01 ? 'text-status-success' : 'text-status-warning')}>{fmtMXN(pending)}</span></div>
              </div>

              {inv.notes && (
                <div className="bg-status-info/10 border border-status-info/40 rounded-lg px-3 py-2">
                  <p className="text-[10px] text-blue-400 uppercase tracking-wide mb-0.5">Notas</p>
                  <p className="text-sm text-status-info">{inv.notes}</p>
                </div>
              )}

              {/* Respaldo (XML/PDF) */}
              <div className="border border-line-subtle rounded-xl p-3 flex flex-col gap-2">
                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                  <div>
                    <p className="text-xs font-bold text-brand-300 uppercase tracking-wider">Archivo de respaldo</p>
                    <p className="text-[11px] text-ink-muted">XML/PDF del comprobante u otra evidencia.</p>
                  </div>
                  <label className={clsx('btn-secondary btn-sm cursor-pointer shrink-0', busy && 'opacity-50 pointer-events-none')}>
                    Adjuntar
                    <input type="file" accept=".xml,.pdf,image/*" className="hidden"
                      onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; upload(f) }} />
                  </label>
                </div>
                {err && <p className="text-xs text-status-danger">{err}</p>}
                {busy && <p className="text-xs text-ink-muted">Subiendo…</p>}
                {files.length > 0 ? (
                  <ul className="flex flex-col gap-1">
                    {files.map(f => (
                      <li key={f.id} className="flex items-center justify-between gap-2 text-xs bg-surface-elevated/40 rounded-lg px-3 py-1.5">
                        <span className="truncate text-ink-secondary min-w-0">{f.filename}</span>
                        <button type="button" onClick={() => view(f)} className="text-brand-300 hover:underline shrink-0">Ver / Imprimir</button>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-[11px] text-ink-muted italic">Sin archivo de respaldo adjunto.</p>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body
  )
}

export default FacturaProveedorDetallePanel
