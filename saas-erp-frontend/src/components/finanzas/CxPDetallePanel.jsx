import { useState, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { cxpApi } from '@/api/cxp'
import { PagoProveedorModal } from '@/components/finanzas/PagoProveedorModal'
import Badge from '@/components/ui/Badge'
import Spinner from '@/components/ui/Spinner'
import { fmtMXN, fmtDate } from '@/utils/fmt'
import { downloadBlob } from '@/utils/downloadBlob'
import clsx from 'clsx'

const MIME_ICON = {
  'application/pdf':   '📄',
  'image/jpeg':        '🖼️',
  'image/png':         '🖼️',
  'image/webp':        '🖼️',
}

function fmtBytes(n) {
  if (n == null) return ''
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(2)} MB`
}

const DOC_TYPE_LABEL = {
  invoice:      'Factura',
  remission:    'Remisión',
  credit_note:  'Nota de crédito',
}

const PAYMENT_METHOD_LABEL = {
  cash:                'Efectivo',
  transfer:            'Transferencia',
  check:               'Cheque',
}

// ── Documento origen (factura/remisión de proveedor) ───────────────────────
function DocumentoOrigen({ ap }) {
  const src = ap.sourceDoc
  if (!src) return null

  const isInvoice = ap.document_type === 'invoice'
  return (
    <div className={clsx(
      'border rounded-xl p-4 flex flex-col gap-2',
      isInvoice ? 'bg-status-info/10 border-status-info/40' : 'bg-purple-500/10 border-purple-500/40'
    )}>
      <div className="flex items-center justify-between flex-wrap gap-2">
        <p className={clsx('text-xs font-semibold uppercase tracking-wide',
          isInvoice ? 'text-status-info' : 'text-purple-300')}>
          {isInvoice ? 'Factura del proveedor' : 'Remisión del proveedor'}
        </p>
        <div className="flex items-center gap-2">
          {src.reconciliation_status === 'reconciled' && <Badge status="reconciled" />}
          {src.reconciliation_status === 'with_diff'  && <Badge status="with_diff" />}
          {src.uuid_sat && (
            <span className="text-[10px] font-bold uppercase bg-emerald-100 text-emerald-700 px-1.5 py-0.5 rounded-full">
              CFDI
            </span>
          )}
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2 text-xs">
        <div>
          <span className="text-ink-muted">Folio:</span>{' '}
          <span className="font-mono font-semibold">{src.invoice_number}</span>
        </div>
        <div>
          <span className="text-ink-muted">F. emisión:</span> {fmtDate(src.invoice_date)}
        </div>
        {src.serie && (
          <div>
            <span className="text-ink-muted">Serie/Folio:</span>{' '}
            <span className="font-mono">{src.serie}-{src.folio || '—'}</span>
          </div>
        )}
        {src.rfc_emisor && (
          <div>
            <span className="text-ink-muted">RFC emisor:</span>{' '}
            <span className="font-mono">{src.rfc_emisor}</span>
          </div>
        )}
        {src.uuid_sat && (
          <div className="col-span-2">
            <span className="text-ink-muted">UUID:</span>{' '}
            <span className="font-mono text-[10px] break-all">{src.uuid_sat}</span>
          </div>
        )}
        {src.purchase_order_number && (
          <div>
            <span className="text-ink-muted">OC:</span>{' '}
            <span className="font-mono font-semibold">{src.purchase_order_number}</span>
          </div>
        )}
        {src.receipt_number && (
          <div>
            <span className="text-ink-muted">Recepción:</span>{' '}
            <span className="font-mono">{src.receipt_number}</span>
            {src.receipt_date && <span className="text-ink-muted"> · {fmtDate(src.receipt_date)}</span>}
          </div>
        )}
        {src.reconciliation_status === 'with_diff' && src.reconciliation_diff != null && (
          <div className="col-span-2 text-[11px] text-status-warning">
            Diferencia con recepciones: {fmtMXN(src.reconciliation_diff)}
          </div>
        )}
        {src.notes && (
          <div className="col-span-2 text-[11px] text-ink-muted italic">
            {src.notes}
          </div>
        )}
      </div>
    </div>
  )
}

// ── Datos bancarios del proveedor (para hacer el pago) ─────────────────────
function DatosBancariosProveedor({ ap }) {
  const hasAny = ap.supplier_bank_name || ap.supplier_clabe ||
                 ap.supplier_account_number || ap.supplier_account_holder
  if (!hasAny) return null

  return (
    <div className="bg-emerald-50 border border-emerald-100 rounded-xl p-4 flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <p className="text-xs font-semibold uppercase tracking-wide text-emerald-700">
          Datos para transferir
        </p>
      </div>
      <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
        {ap.supplier_bank_name && (
          <div className="col-span-2">
            <span className="text-ink-muted">Banco:</span>{' '}
            <span className="font-medium">{ap.supplier_bank_name}</span>
          </div>
        )}
        {ap.supplier_account_holder && (
          <div className="col-span-2">
            <span className="text-ink-muted">Titular:</span>{' '}
            <span className="font-medium">{ap.supplier_account_holder}</span>
          </div>
        )}
        {ap.supplier_account_number && (
          <div>
            <span className="text-ink-muted">Cuenta:</span>{' '}
            <span className="font-mono">{ap.supplier_account_number}</span>
          </div>
        )}
        {ap.supplier_clabe && (
          <div>
            <span className="text-ink-muted">CLABE:</span>{' '}
            <span className="font-mono">{ap.supplier_clabe}</span>
          </div>
        )}
        {ap.supplier_swift && (
          <div>
            <span className="text-ink-muted">SWIFT:</span>{' '}
            <span className="font-mono">{ap.supplier_swift}</span>
          </div>
        )}
      </div>
    </div>
  )
}

// ── Pagos aplicados ────────────────────────────────────────────────────────
function PagosAplicados({ payments }) {
  if (!payments?.length) {
    return (
      <p className="text-sm text-ink-muted italic text-center py-4">
        Aún no se han registrado pagos para este documento.
      </p>
    )
  }

  return (
    <div className="border border-line-subtle rounded-xl overflow-x-auto">
      <table className="table text-xs min-w-full">
        <thead>
          <tr>
            <th>Fecha</th>
            <th>Método</th>
            <th>Banco</th>
            <th>Referencia</th>
            <th>Registró</th>
            <th className="text-right">Importe</th>
          </tr>
        </thead>
        <tbody>
          {payments.map(p => (
            <tr key={p.id}>
              <td className="text-ink-secondary">{fmtDate(p.payment_date)}</td>
              <td>{PAYMENT_METHOD_LABEL[p.payment_method] || p.payment_method}</td>
              <td className="text-ink-secondary text-[11px]">
                {p.bank_name
                  ? <>
                      {p.bank_name}
                      {p.bank_alias && <span className="text-ink-muted"> · {p.bank_alias}</span>}
                    </>
                  : <span className="text-ink-muted">—</span>}
              </td>
              <td className="font-mono text-ink-secondary">{p.reference || '—'}</td>
              <td className="text-ink-secondary">{p.created_by_name || '—'}</td>
              <td className="text-right font-mono tabular-nums font-semibold text-status-danger">
                {fmtMXN(p.amount)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ── Modal: aplicar anticipo a este AP ──────────────────────────────────────
function AplicarAnticipoModal({ ap, advances, onClose, onApplied }) {
  const qc = useQueryClient()
  const [applyByAdv, setApplyByAdv] = useState({})  // { [advanceId]: '123.45' }
  const [error, setError] = useState(null)

  const pending = parseFloat(ap.amount_pending)

  const totalToApply = Object.values(applyByAdv)
    .reduce((s, v) => s + (parseFloat(v) || 0), 0)
  const exceedsPending = totalToApply > pending + 0.01

  const mutation = useMutation({
    mutationFn: async () => {
      const ops = Object.entries(applyByAdv)
        .map(([advId, v]) => ({ advId, amount: parseFloat(v) }))
        .filter(o => o.amount > 0)
      if (!ops.length) throw new Error('Captura al menos un monto a aplicar.')
      if (exceedsPending) throw new Error('La suma excede el saldo pendiente del documento.')
      // Aplicar secuencialmente (cada uno es transacción atómica en backend)
      const results = []
      for (const op of ops) {
        const r = await cxpApi.applyAdvance(op.advId, {
          apId: ap.id, amount: op.amount,
        })
        results.push(r)
      }
      return results
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['cxp', ap.id] })
      qc.invalidateQueries({ queryKey: ['cxp'] })
      qc.invalidateQueries({ queryKey: ['ap-advances'] })
      onApplied?.()
      onClose()
    },
    onError: (e) => setError(e.response?.data?.error || e.message || 'Error al aplicar'),
  })

  function update(advId, val) {
    setApplyByAdv(prev => {
      if (!val) { const { [advId]: _, ...rest } = prev; return rest }
      return { ...prev, [advId]: val }
    })
  }

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40 p-4">
      <div className="card w-full max-w-2xl p-6 max-h-[92vh] overflow-y-auto flex flex-col gap-5">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold text-ink-primary">Aplicar anticipo</h2>
            <p className="text-xs text-ink-muted mt-0.5">
              Documento {ap.document_number} · pendiente {fmtMXN(pending)}
            </p>
          </div>
          <button type="button" onClick={onClose} className="btn-ghost btn-icon text-ink-muted">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12"/>
            </svg>
          </button>
        </div>

        <div className="border border-line-subtle rounded-xl overflow-x-auto">
          <table className="table text-xs min-w-full">
            <thead>
              <tr>
                <th>Fecha</th>
                <th>Origen</th>
                <th className="text-right">Disponible</th>
                <th className="text-right w-44">Aplicar</th>
              </tr>
            </thead>
            <tbody>
              {advances.map(a => {
                const avail = parseFloat(a.amount_available)
                return (
                  <tr key={a.id}>
                    <td className="text-ink-secondary">{fmtDate(a.payment_date)}</td>
                    <td className="text-ink-secondary">
                      <p className="text-[11px]">{a.payment_method} {a.reference ? `· ${a.reference}` : ''}</p>
                      {a.notes && <p className="text-[10px] text-ink-muted truncate max-w-[180px]" title={a.notes}>{a.notes}</p>}
                    </td>
                    <td className="text-right font-mono tabular-nums font-semibold text-emerald-700">
                      {fmtMXN(avail)}
                    </td>
                    <td className="text-right flex justify-end gap-1">
                      <input type="number" step="0.01" min="0" max={Math.min(avail, pending)}
                        inputMode="decimal"
                        className="input text-right text-sm w-28"
                        value={applyByAdv[a.id] || ''}
                        onChange={e => update(a.id, e.target.value)}
                        placeholder="0.00" />
                      <button type="button"
                        onClick={() => update(a.id, Math.min(avail, pending - (totalToApply - (parseFloat(applyByAdv[a.id]) || 0))).toFixed(2))}
                        className="btn-ghost btn-sm text-[10px]" title="Llenar al máximo">
                        Max
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>

        <div className="flex flex-col gap-1 text-sm">
          <div className="flex justify-between">
            <span className="text-ink-muted">Total a aplicar:</span>
            <span className="font-mono tabular-nums font-semibold">{fmtMXN(totalToApply)}</span>
          </div>
          {exceedsPending && (
            <p className="text-xs text-status-danger">La suma excede el saldo pendiente del documento.</p>
          )}
        </div>

        {error && (
          <div className="bg-status-danger/10 border border-status-danger/40 rounded-lg px-3 py-2">
            <p className="text-sm text-status-danger">{error}</p>
          </div>
        )}

        <div className="flex gap-2">
          <button type="button" onClick={onClose} className="btn-secondary flex-1">Cancelar</button>
          <button type="button" onClick={() => mutation.mutate()}
            disabled={mutation.isPending || totalToApply <= 0 || exceedsPending}
            className="btn-primary flex-1">
            {mutation.isPending ? <Spinner size="sm" /> : 'Aplicar'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}

// ── Sección de evidencias (subir / ver / descargar / borrar) ───────────────
function EvidenciasSection({ apId, attachments }) {
  const qc = useQueryClient()
  const fileInput = useRef(null)
  const [error, setError] = useState(null)
  const [previewUrl, setPreviewUrl] = useState(null)

  const uploadMutation = useMutation({
    mutationFn: (file) => cxpApi.uploadAttachment(apId, file, null),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['cxp', apId] })
      qc.invalidateQueries({ queryKey: ['cxp'] })
    },
    onError: (e) => setError(e.response?.data?.error || e.message || 'Error al subir'),
  })

  const deleteMutation = useMutation({
    mutationFn: (attachmentId) => cxpApi.deleteAttachment(apId, attachmentId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['cxp', apId] })
      qc.invalidateQueries({ queryKey: ['cxp'] })
    },
    onError: (e) => setError(e.response?.data?.error || e.message || 'Error al borrar'),
  })

  function handleFile(e) {
    const file = e.target.files?.[0]
    if (!file) return
    setError(null)
    uploadMutation.mutate(file)
    e.target.value = ''  // permitir re-subir el mismo nombre
  }

  async function openPreview(att) {
    try {
      setError(null)
      const r = await cxpApi.downloadAttachment(apId, att.id)
      const url = URL.createObjectURL(r.data)
      setPreviewUrl({ url, filename: att.filename, mime: att.mime_type })
    } catch (e) {
      setError(e.response?.data?.error || e.message || 'Error al cargar archivo')
    }
  }

  async function handleDownload(att) {
    try {
      const r = await cxpApi.downloadAttachment(apId, att.id)
      downloadBlob(r.data, att.filename)
    } catch (e) {
      setError(e.response?.data?.error || e.message || 'Error al descargar')
    }
  }

  function handleDelete(att) {
    if (!window.confirm(`¿Eliminar "${att.filename}"?`)) return
    deleteMutation.mutate(att.id)
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <p className="text-xs font-bold text-brand-300 uppercase tracking-wider">
          Evidencias ({attachments?.length || 0})
        </p>
        <button
          type="button"
          onClick={() => fileInput.current?.click()}
          disabled={uploadMutation.isPending}
          className="btn-ghost btn-sm text-brand-300"
        >
          {uploadMutation.isPending ? <Spinner size="sm" /> : '+ Subir archivo'}
        </button>
        <input
          ref={fileInput}
          type="file"
          accept="application/pdf,image/jpeg,image/png,image/webp"
          className="hidden"
          onChange={handleFile}
        />
      </div>

      {error && (
        <div className="bg-status-danger/10 border border-status-danger/40 rounded-lg px-3 py-2 mb-2 flex items-center justify-between">
          <p className="text-xs text-status-danger">{error}</p>
          <button onClick={() => setError(null)} className="text-status-danger">×</button>
        </div>
      )}

      {!attachments?.length ? (
        <div className="border border-dashed border-line-subtle rounded-xl p-6 text-center">
          <p className="text-xs text-ink-muted">
            Sin evidencias adjuntas.{' '}
            <button
              type="button"
              onClick={() => fileInput.current?.click()}
              className="text-brand-300 hover:underline"
            >
              Subir la primera
            </button>
          </p>
          <p className="text-[10px] text-ink-muted mt-1">PDF, JPG, PNG o WebP</p>
        </div>
      ) : (
        <div className="border border-line-subtle rounded-xl divide-y divide-line-subtle">
          {attachments.map(att => (
            <div key={att.id} className="px-3 py-2 flex items-center gap-3 text-sm">
              <span className="text-lg shrink-0">{MIME_ICON[att.mime_type] || '📁'}</span>
              <div className="flex-1 min-w-0">
                <p className="font-medium text-ink-primary truncate" title={att.filename}>
                  {att.filename}
                </p>
                <p className="text-[10px] text-ink-muted">
                  {fmtBytes(att.file_size_bytes)}
                  {att.uploaded_by_name && <> · {att.uploaded_by_name}</>}
                  <> · {fmtDate(att.created_at)}</>
                </p>
              </div>
              <button
                type="button"
                onClick={() => openPreview(att)}
                className="btn-ghost btn-sm text-status-info"
                title="Ver"
              >
                Ver
              </button>
              <button
                type="button"
                onClick={() => handleDownload(att)}
                className="btn-ghost btn-sm text-ink-secondary"
                title="Descargar"
              >
                ↓
              </button>
              <button
                type="button"
                onClick={() => handleDelete(att)}
                disabled={deleteMutation.isPending}
                className="btn-ghost btn-sm text-status-danger"
                title="Eliminar"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Preview modal */}
      {previewUrl && createPortal(
        <div className="fixed inset-0 z-[10000] flex flex-col bg-black/80">
          <div className="flex items-center justify-between px-4 py-2 bg-gray-900 text-white text-sm">
            <span className="truncate flex-1">{previewUrl.filename}</span>
            <button
              onClick={() => { URL.revokeObjectURL(previewUrl.url); setPreviewUrl(null) }}
              className="text-white hover:text-ink-muted ml-3"
            >
              ✕ Cerrar
            </button>
          </div>
          <div className="flex-1 overflow-auto flex items-center justify-center p-4">
            {previewUrl.mime?.startsWith('image/') ? (
              <img src={previewUrl.url} alt={previewUrl.filename}
                className="max-w-full max-h-full object-contain" />
            ) : (
              <iframe src={previewUrl.url} title={previewUrl.filename}
                className="w-full h-full bg-surface-primary" />
            )}
          </div>
        </div>,
        document.body
      )}
    </div>
  )
}

// ── Panel principal ────────────────────────────────────────────────────────
export function CxPDetallePanel({ apId, onClose }) {
  const qc = useQueryClient()
  const [showPagoModal, setShowPagoModal] = useState(false)
  const [showAnticipoModal, setShowAnticipoModal] = useState(false)
  const [paidMsg, setPaidMsg] = useState(null)

  const { data: ap, isLoading, error: queryError } = useQuery({
    queryKey: ['cxp', apId],
    queryFn:  () => cxpApi.getCXP(apId),
    enabled:  !!apId,
    retry:    1,
  })

  const hasPending = ap && parseFloat(ap.amount_pending) > 0.01

  return createPortal(
    <div className="fixed inset-0 z-[9998] flex">
      <div className="hidden sm:block flex-1 bg-black/30" onClick={onClose} />

      <div className="w-full max-w-2xl bg-surface-primary h-full overflow-y-auto shadow-card flex flex-col">
        {/* Header */}
        <div className="sticky top-0 bg-surface-primary border-b border-line-subtle px-5 py-4 flex items-start gap-3 z-10">
          <div className="flex-1 min-w-0">
            {isLoading ? (
              <div className="flex flex-col gap-2">
                <div className="skeleton h-5 w-40" />
                <div className="skeleton h-3 w-28" />
              </div>
            ) : ap ? (
              <>
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-[10px] font-bold uppercase tracking-wide bg-surface-elevated/60 text-ink-secondary px-1.5 py-0.5 rounded-full">
                    {DOC_TYPE_LABEL[ap.document_type] || ap.document_type}
                  </span>
                  <span className="font-mono text-base font-bold text-ink-primary">{ap.document_number}</span>
                  <Badge status={ap.is_overdue ? 'overdue' : ap.status} />
                </div>
                <p className="text-xs text-ink-muted mt-1">
                  {ap.partner_name} · Emitido {fmtDate(ap.issue_date)}
                  {ap.due_date && <> · Vence {fmtDate(ap.due_date)}</>}
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
          ) : queryError ? (
            <div className="flex flex-col items-center gap-3 py-12 text-center">
              <p className="text-sm text-status-danger">
                {queryError.response?.data?.error || queryError.message || 'Error al cargar el documento'}
              </p>
            </div>
          ) : !ap ? (
            <p className="text-sm text-ink-muted text-center py-8">El documento no fue encontrado</p>
          ) : (
            <div className="flex flex-col gap-5">
              {paidMsg && (
                <div className="flex items-center gap-2 bg-status-success/10 border border-status-success/40 rounded-lg px-3 py-2">
                  <svg className="w-4 h-4 text-status-success shrink-0" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/>
                  </svg>
                  <p className="text-sm text-status-success flex-1">{paidMsg}</p>
                  <button onClick={() => setPaidMsg(null)} className="text-status-success hover:text-status-success">×</button>
                </div>
              )}

              {/* Importes */}
              <div className="grid grid-cols-3 gap-2">
                <div className="card p-3">
                  <p className="text-[10px] text-ink-muted uppercase tracking-wide">Total</p>
                  <p className="text-base font-mono font-semibold text-ink-primary mt-0.5">{fmtMXN(ap.amount_total)}</p>
                  {ap.currency !== 'MXN' && (
                    <p className="text-[10px] text-ink-muted mt-0.5">
                      {ap.currency} · TC {parseFloat(ap.exchange_rate).toFixed(4)}
                    </p>
                  )}
                </div>
                <div className="card p-3 bg-status-success/10/40">
                  <p className="text-[10px] text-green-500 uppercase tracking-wide">Pagado</p>
                  <p className="text-base font-mono font-semibold text-status-success mt-0.5">{fmtMXN(ap.amount_paid)}</p>
                </div>
                <div className={clsx('card p-3', ap.is_overdue ? 'bg-status-danger/10/40' : 'bg-status-warning/10/40')}>
                  <p className={clsx('text-[10px] uppercase tracking-wide',
                    ap.is_overdue ? 'text-status-danger' : 'text-amber-500')}>
                    Pendiente
                  </p>
                  <p className={clsx('text-base font-mono font-semibold mt-0.5',
                    ap.is_overdue ? 'text-status-danger' : 'text-status-warning')}>
                    {fmtMXN(ap.amount_pending)}
                  </p>
                </div>
              </div>

              {/* Anticipos disponibles del proveedor */}
              {hasPending && ap.status !== 'cancelled' && ap.availableAdvances?.length > 0 && (() => {
                const total = ap.availableAdvances.reduce(
                  (s, a) => s + parseFloat(a.amount_available || 0), 0
                )
                return (
                  <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-4 flex flex-col gap-2">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-sm font-semibold text-emerald-800">
                          💰 Anticipos del proveedor · {fmtMXN(total)}
                        </p>
                        <p className="text-xs text-emerald-700">
                          {ap.availableAdvances.length} anticipo{ap.availableAdvances.length !== 1 ? 's' : ''} con saldo a favor
                        </p>
                      </div>
                      <button
                        onClick={() => setShowAnticipoModal(true)}
                        className="btn-secondary btn-sm">
                        Aplicar anticipo
                      </button>
                    </div>
                  </div>
                )
              })()}

              {/* Botón registrar pago */}
              {hasPending && ap.status !== 'cancelled' && (
                <button
                  onClick={() => setShowPagoModal(true)}
                  className="btn-primary w-full"
                >
                  Registrar pago a proveedor
                </button>
              )}

              {/* Documento origen */}
              <DocumentoOrigen ap={ap} />

              {/* Datos bancarios del proveedor */}
              <DatosBancariosProveedor ap={ap} />

              {/* Evidencias */}
              <EvidenciasSection apId={ap.id} attachments={ap.attachments} />

              {/* Pagos aplicados */}
              <div>
                <p className="text-xs font-bold text-brand-300 uppercase tracking-wider mb-2">
                  Pagos aplicados
                </p>
                <PagosAplicados payments={ap.payments} />
              </div>
            </div>
          )}
        </div>
      </div>

      {showPagoModal && (
        <PagoProveedorModal
          initialPartnerId={ap.partner_id}
          initialApId={ap.id}
          onClose={() => setShowPagoModal(false)}
          onSaved={(res) => {
            const parts = [`Pago de ${fmtMXN(res.amount)} registrado. Aplicado ${fmtMXN(res.total_applied || 0)}.`]
            if (res.advance_generated) {
              parts.push(`Anticipo de ${fmtMXN(res.advance_generated.amount)} guardado.`)
            }
            setPaidMsg(parts.join(' '))
            qc.invalidateQueries({ queryKey: ['cxp', apId] })
            qc.invalidateQueries({ queryKey: ['cxp'] })
            setShowPagoModal(false)
          }}
        />
      )}

      {showAnticipoModal && ap?.availableAdvances?.length > 0 && (
        <AplicarAnticipoModal
          ap={ap}
          advances={ap.availableAdvances}
          onClose={() => setShowAnticipoModal(false)}
          onApplied={() => setPaidMsg('Anticipo aplicado correctamente.')}
        />
      )}
    </div>,
    document.body
  )
}
