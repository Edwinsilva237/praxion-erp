import { useState } from 'react'
import { createPortal } from 'react-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { purchasesApi } from '@/api/purchases'
import Badge from '@/components/ui/Badge'
import Spinner from '@/components/ui/Spinner'
import { fmtMXN, fmtDate, fmtNum, fmtDateOnly} from '@/utils/fmt'
import { downloadBlob } from '@/utils/downloadBlob'
import clsx from 'clsx'

// ── Barra de progreso por línea ────────────────────────────────────────────
function LineProgress({ ordered, received, unit, isEstimated }) {
  const pct      = ordered > 0 ? Math.min((received / ordered) * 100, 100) : 0
  const complete = pct >= 100
  return (
    <div className="flex flex-col gap-1 min-w-[140px]">
      <div className="flex items-center justify-between text-xs gap-2">
        <span className={clsx('font-medium tabular-nums', complete ? 'text-status-success' : 'text-ink-secondary')}>
          {fmtNum(received, 3)} / {fmtNum(ordered, 3)} {unit}
          {isEstimated && !complete && <span className="ml-1 text-amber-500 font-bold">~</span>}
        </span>
        {complete && (
          <svg className="w-3.5 h-3.5 text-green-500 shrink-0" fill="currentColor" viewBox="0 0 24 24">
            <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/>
          </svg>
        )}
      </div>
      <div className="h-1.5 bg-surface-elevated/60 rounded-full overflow-hidden">
        <div
          className={clsx('h-full rounded-full transition-all duration-500',
            complete ? 'bg-green-500' : 'bg-brand-500')}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  )
}

// ── Mini panel de detalle de una recepción (dentro del panel de OC) ────────
function RecepcionDetalle({ receiptId, onClose }) {
  const { data: receipt, isLoading } = useQuery({
    queryKey: ['receipt-detail', receiptId],
    queryFn: () => purchasesApi.getReceipt(receiptId),
    enabled: !!receiptId,
  })

  return (
    <div className="border border-brand-100 bg-brand-500/10/40 rounded-xl overflow-hidden">
      {/* Header mini */}
      <div className="flex items-center justify-between px-4 py-2.5 bg-brand-500/10 border-b border-brand-100">
        <div className="flex items-center gap-2">
          <svg className="w-3.5 h-3.5 text-brand-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4"/>
          </svg>
          <span className="text-sm font-semibold text-brand-300 font-mono">
            {isLoading ? '...' : receipt?.receipt_number}
          </span>
          {receipt && <Badge status={receipt.status} />}
        </div>
        <button onClick={onClose} className="text-ink-muted hover:text-ink-secondary p-0.5">
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12"/>
          </svg>
        </button>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-6"><Spinner size="sm" /></div>
      ) : receipt ? (
        <div className="p-4 flex flex-col gap-3">
          {/* Datos */}
          <div className="grid grid-cols-2 gap-2 text-xs">
            {[
              ['Fecha',        fmtDateOnly(receipt.received_date)],
              ['Almacén',      receipt.warehouse_name || '—'],
              ['Folio doc.',   receipt.document_type
                ? `${receipt.document_type} ${receipt.document_number || ''}`.trim() : '—'],
              ['Recibió',      receipt.created_by_name || '—'],
              ['Confirmó',     receipt.confirmed_by_name || '—'],
            ].map(([label, val]) => (
              <div key={label}>
                <span className="text-ink-muted">{label}: </span>
                <span className="font-medium text-ink-secondary">{val}</span>
              </div>
            ))}
          </div>

          {/* Líneas */}
          {(receipt.lines || []).length > 0 && (
            <div className="border border-line-subtle rounded-lg overflow-hidden">
              <table className="w-full text-xs">
                <thead className="bg-surface-elevated/40">
                  <tr>
                    <th className="text-left px-3 py-1.5 font-medium text-ink-muted">Artículo</th>
                    <th className="text-right px-3 py-1.5 font-medium text-ink-muted">Recibido</th>
                    <th className="text-right px-3 py-1.5 font-medium text-ink-muted">Importe</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line-subtle">
                  {receipt.lines.map((l, i) => (
                    <tr key={i} className="bg-surface-primary">
                      <td className="px-3 py-1.5 font-medium text-ink-primary">
                        {l.item_name || l.description || '—'}
                      </td>
                      <td className="px-3 py-1.5 text-right font-mono tabular-nums">
                        {fmtNum(l.quantity_received, 3)} {l.unit}
                      </td>
                      <td className="px-3 py-1.5 text-right font-mono tabular-nums">
                        {fmtMXN(parseFloat(l.quantity_received || 0) * parseFloat(l.unit_price || 0))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="bg-surface-elevated/40 border-t border-line-subtle px-3 py-1.5 flex justify-between">
                <span className="text-xs font-semibold text-ink-secondary">Total</span>
                <span className="text-xs font-bold text-brand-300 font-mono">
                  {fmtMXN(receipt.lines.reduce((s, l) =>
                    s + parseFloat(l.quantity_received || 0) * parseFloat(l.unit_price || 0), 0))}
                </span>
              </div>
            </div>
          )}

          {/* Evidencia */}
          {receipt.evidence_filename && (
            <div className="flex items-center gap-2 text-xs text-ink-muted">
              <svg className="w-3.5 h-3.5 text-brand-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13"/>
              </svg>
              <span>Evidencia: <strong>{receipt.evidence_filename}</strong></span>
            </div>
          )}
        </div>
      ) : (
        <p className="text-xs text-ink-muted text-center py-4">No se pudo cargar</p>
      )}
    </div>
  )
}

// ── Tab: Detalle de líneas ─────────────────────────────────────────────────
function TabDetalle({ oc }) {
  const lines    = oc.lines || []
  const subtotal = parseFloat(oc.subtotal_mxn || 0)
  const tax      = parseFloat(oc.tax_mxn || 0)
  const total    = parseFloat(oc.total_mxn || subtotal + tax)

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-2">
        {[
          ['Proveedor',        oc.partner_name || oc.generic_supplier || '—'],
          ['Moneda',           oc.currency === 'USD'
            ? `USD (TC $${oc.exchange_rate_value ? fmtNum(oc.exchange_rate_value, 4) : '—'})`
            : 'MXN'],
          ['F. creación',      fmtDate(oc.created_at)],
          ['F. entrega est.',  fmtDateOnly(oc.expected_date)],
        ].map(([label, val]) => (
          <div key={label} className="bg-surface-elevated/60 border border-line-strong rounded-lg px-3 py-2">
            <p className="text-[10px] font-bold text-ink-secondary uppercase tracking-wide">{label}</p>
            <p className="text-sm font-medium text-ink-primary mt-0.5">{val}</p>
          </div>
        ))}
      </div>

      {oc.notes && (
        <div className="bg-status-info/10 border border-status-info/40 rounded-lg px-3 py-2">
          <p className="text-[10px] text-blue-400 uppercase tracking-wide mb-0.5">Notas al proveedor</p>
          <p className="text-sm text-status-info">{oc.notes}</p>
        </div>
      )}

      {lines.length > 0 ? (
        <div className="border border-line-subtle rounded-xl overflow-hidden">
          <table className="table text-xs">
            <thead>
              <tr>
                <th>Artículo</th>
                <th className="text-right">Pedido</th>
                <th>Recibido</th>
                <th className="text-right">P. Unit.</th>
                <th className="text-right">Importe</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l, i) => {
                const received = parseFloat(l.quantity_received || 0)
                const ordered  = parseFloat(l.quantity || 0)
                const nombre   = l.item_name || l.description || '—'
                const importe  = parseFloat(l.subtotal || (ordered * parseFloat(l.unit_price || 0)))
                return (
                  <tr key={i}>
                    <td>
                      <p className="font-medium text-ink-primary">{nombre}</p>
                      {l.supplier_sku && (
                        <p className="text-[11px] text-ink-muted">Clave prov.: <span className="font-mono">{l.supplier_sku}</span></p>
                      )}
                      {l.notes && (
                        <p className="text-[11px] text-ink-muted italic">{l.notes}</p>
                      )}
                      {l.is_estimated && (
                        <span className="text-[10px] text-amber-500 font-medium">~ estimada</span>
                      )}
                    </td>
                    <td className="text-right font-mono tabular-nums">{fmtNum(ordered, 3)} {l.unit}</td>
                    <td>
                      <LineProgress ordered={ordered} received={received} unit={l.unit} isEstimated={l.is_estimated} />
                    </td>
                    <td className="text-right font-mono tabular-nums">{fmtMXN(l.unit_price, oc.currency)}</td>
                    <td className="text-right font-mono tabular-nums font-medium">{fmtMXN(importe, oc.currency)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          <div className="bg-surface-elevated/40 border-t border-line-subtle px-4 py-3 flex flex-col gap-1">
            {subtotal > 0 && (
              <div className="flex justify-between text-xs text-ink-muted">
                <span>Subtotal</span>
                <span className="font-mono tabular-nums">{fmtMXN(subtotal, oc.currency)}</span>
              </div>
            )}
            {tax > 0 && (
              <div className="flex justify-between text-xs text-ink-muted">
                <span>IVA 16%</span>
                <span className="font-mono tabular-nums">{fmtMXN(tax, oc.currency)}</span>
              </div>
            )}
            <div className="flex justify-between text-sm font-semibold text-ink-primary border-t border-line-subtle pt-1.5 mt-0.5">
              <span>Total</span>
              <span className="font-mono tabular-nums text-brand-300">{fmtMXN(total, oc.currency)}</span>
            </div>
            {oc.currency === 'USD' && parseFloat(oc.exchange_rate_value) > 0 && (
              <div className="flex justify-between text-xs text-ink-muted">
                <span>Equivalente MXN</span>
                <span className="font-mono tabular-nums">
                  {fmtMXN(total * parseFloat(oc.exchange_rate_value), 'MXN')}
                </span>
              </div>
            )}
          </div>
        </div>
      ) : (
        <p className="text-sm text-ink-muted text-center py-4">Sin líneas registradas</p>
      )}
    </div>
  )
}

// ── Tab: Recepciones ligadas — con click para ver detalle ──────────────────
function TabRecepciones({ oc, onGoToRecepcion }) {
  const [openReceiptId, setOpenReceiptId] = useState(null)
  const receipts = oc.receipts || []

  return (
    <div className="flex flex-col gap-3">
      {receipts.length === 0 ? (
        <div className="text-center py-8 flex flex-col items-center gap-2">
          <div className="w-10 h-10 rounded-xl bg-surface-elevated/60 flex items-center justify-center">
            <svg className="w-5 h-5 text-ink-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4"/>
            </svg>
          </div>
          <p className="text-sm text-ink-muted">Sin recepciones contra esta OC</p>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {receipts.map(r => (
            <div key={r.id} className="flex flex-col gap-2">
              {/* Fila de recepción — clickeable */}
              <button
                onClick={() => setOpenReceiptId(openReceiptId === r.id ? null : r.id)}
                className={clsx(
                  'w-full flex items-center justify-between px-4 py-3 rounded-xl border transition-colors text-left',
                  openReceiptId === r.id
                    ? 'border-brand-500/40 bg-brand-500/10'
                    : 'border-line-subtle bg-surface-elevated/40 hover:border-brand-500/40 hover:bg-brand-500/10/50'
                )}
              >
                <div className="flex items-center gap-3 min-w-0">
                  <svg className={clsx('w-4 h-4 shrink-0 transition-transform',
                    openReceiptId === r.id ? 'rotate-90 text-brand-500' : 'text-ink-muted')}
                    fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7"/>
                  </svg>
                  <div>
                    <p className="text-sm font-semibold text-brand-300 font-mono">{r.receipt_number}</p>
                    <p className="text-xs text-ink-muted mt-0.5">
                      {fmtDateOnly(r.received_date)}
                      {r.line_count > 0 && ` · ${r.line_count} línea${r.line_count !== 1 ? 's' : ''}`}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <Badge status={r.status} />
                  <span className="text-xs text-ink-muted font-mono">{fmtMXN(r.total_mxn)}</span>
                </div>
              </button>

              {/* Detalle expandido inline */}
              {openReceiptId === r.id && (
                <RecepcionDetalle
                  receiptId={r.id}
                  onClose={() => setOpenReceiptId(null)}
                />
              )}
            </div>
          ))}
        </div>
      )}

      {!['received', 'invoiced', 'cancelled'].includes(oc.status) && (
        <button onClick={onGoToRecepcion} className="btn-secondary btn-sm self-start mt-1">
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4"/>
          </svg>
          Registrar nueva recepción
        </button>
      )}
    </div>
  )
}

// ── Acciones según estado real del backend ─────────────────────────────────
function AccionesOC({ oc, onAction, loadingAction }) {
  const { status } = oc

  const Btn = ({ label, action, variant = 'secondary', icon }) => (
    <button onClick={() => onAction(action)} disabled={!!loadingAction}
      className={clsx(`btn-${variant} btn-sm justify-center`, loadingAction === action && 'opacity-60')}>
      {loadingAction === action ? <Spinner size="sm" /> : icon}
      {label}
    </button>
  )

  const PdfBtn = () => (
    <button onClick={() => onAction('pdf')} disabled={!!loadingAction} className="btn-secondary btn-sm justify-center">
      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/>
      </svg>
      Descargar PDF
    </button>
  )

  const EmailBtn = () => (
    <button disabled title="Próximamente"
      className="btn-secondary btn-sm justify-center opacity-40 cursor-not-allowed">
      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"/>
      </svg>
      Enviar correo <span className="text-[9px] ml-0.5">(próx.)</span>
    </button>
  )

  const RecepcionBtn = () => (
    <Btn label="Registrar recepción" action="receipt" variant="primary"
      icon={<svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4"/>
      </svg>}
    />
  )

  const CancelBtn = () => (
    <Btn label="Cancelar OC" action="cancel" variant="danger"
      icon={<svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12"/>
      </svg>}
    />
  )

  if (status === 'draft') return (
    <div className="flex flex-col sm:flex-row sm:flex-wrap gap-2 border-t border-line-subtle pt-4 mt-2">
      <Btn label="Confirmar y enviar" action="confirm" variant="primary"
        icon={<svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7"/>
        </svg>}
      />
      <PdfBtn /><EmailBtn /><CancelBtn />
    </div>
  )

  if (status === 'sent') return (
    <div className="flex flex-col sm:flex-row sm:flex-wrap gap-2 border-t border-line-subtle pt-4 mt-2">
      <RecepcionBtn /><PdfBtn /><EmailBtn /><CancelBtn />
    </div>
  )

  if (status === 'partially_received') return (
    <div className="flex flex-col sm:flex-row sm:flex-wrap gap-2 border-t border-line-subtle pt-4 mt-2">
      <RecepcionBtn /><PdfBtn />
    </div>
  )

  if (['received', 'invoiced'].includes(status)) return (
    <div className="flex flex-col sm:flex-row sm:flex-wrap gap-2 border-t border-line-subtle pt-4 mt-2">
      <PdfBtn />
    </div>
  )

  return null
}

// ── Panel principal ────────────────────────────────────────────────────────
export function OCDetallePanel({ ocId, onClose, onGoToRecepcion }) {
  const qc = useQueryClient()
  const [tab, setTab]               = useState('detalle')
  const [loadingAction, setLoading] = useState(null)
  const [actionError, setError]     = useState(null)

  const { data: oc, isLoading, error: queryError } = useQuery({
    queryKey: ['purchase-order', ocId],
    queryFn:  () => purchasesApi.getOrder(ocId),
    enabled:  !!ocId,
    retry:    1,
  })

  const isMP = oc?.lines?.some(l => l.item_type === 'raw_material')

  async function handleAction(action) {
    setError(null)
    setLoading(action)
    try {
      if (action === 'confirm') {
        await purchasesApi.authorizeOrder(ocId)
      } else if (action === 'cancel') {
        if (!window.confirm('¿Confirmas cancelar esta orden de compra? Esta acción no se puede deshacer.')) {
          setLoading(null); return
        }
        await purchasesApi.cancelOrder(ocId, {})
      } else if (action === 'pdf') {
        const blob = await purchasesApi.downloadOrderPdf(ocId)
        downloadBlob(blob, `${oc?.order_number || 'OC'}.pdf`)
        setLoading(null); return
      } else if (action === 'receipt') {
        onGoToRecepcion(oc)
        setLoading(null); return
      }
      qc.invalidateQueries({ queryKey: ['purchase-order', ocId] })
      qc.invalidateQueries({ queryKey: ['purchase-orders'] })
      if (action === 'confirm' || action === 'cancel') {
        // El cambio de status de la OC modifica el inventario en tránsito.
        qc.invalidateQueries({ queryKey: ['inv-levels'] })
        qc.invalidateQueries({ queryKey: ['inv-levels-summary'] })
        qc.invalidateQueries({ queryKey: ['inv-item-detail'] })
        qc.invalidateQueries({ queryKey: ['inv-stock'] })
      }
    } catch (e) {
      setError(e.response?.data?.error || e.message || 'Error al ejecutar la acción')
    } finally {
      setLoading(null)
    }
  }

  return createPortal(
    <div className="fixed inset-0 z-[9998] flex">
      <div className="hidden sm:block flex-1 bg-black/30" onClick={onClose} />

      <div className="w-full max-w-xl bg-surface-primary h-full overflow-y-auto shadow-card flex flex-col">

        {/* Header */}
        <div className="sticky top-0 bg-surface-primary border-b border-line-subtle px-5 py-4 flex items-start gap-3 z-10"
          style={{ paddingTop: 'calc(1rem + env(safe-area-inset-top))' }}>
          <div className="flex-1 min-w-0">
            {isLoading ? (
              <div className="flex flex-col gap-2">
                <div className="skeleton h-5 w-40" />
                <div className="skeleton h-3 w-28" />
              </div>
            ) : oc ? (
              <>
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-mono text-base font-bold text-ink-primary">{oc.order_number}</span>
                  <span className={clsx(
                    'text-[10px] font-bold px-2 py-0.5 rounded-full uppercase tracking-wide',
                    isMP ? 'bg-status-warning/15 text-status-warning' : 'bg-brand-500/15 text-brand-300'
                  )}>
                    {isMP ? 'MP' : 'PT'}
                  </span>
                  <Badge status={oc.status} />
                </div>
                <p className="text-xs text-ink-muted mt-1">
                  {oc.partner_name || oc.generic_supplier || 'Sin proveedor'} · Creada {fmtDate(oc.created_at)}
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

        {/* Tabs */}
        <div className="flex border-b border-line-subtle px-5">
          {[['detalle', 'Detalle'], ['recepciones', 'Recepciones']].map(([key, label]) => (
            <button key={key} onClick={() => setTab(key)}
              className={clsx(
                'px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors',
                tab === key ? 'border-brand-600 text-brand-300' : 'border-transparent text-ink-muted hover:text-ink-secondary'
              )}>
              {label}
              {key === 'recepciones' && oc?.receipts?.length > 0 && (
                <span className="ml-1.5 bg-surface-elevated/60 text-ink-secondary text-[10px] font-bold px-1.5 py-0.5 rounded-full">
                  {oc.receipts.length}
                </span>
              )}
            </button>
          ))}
        </div>

        {/* Contenido */}
        <div className="flex-1 p-5">
          {isLoading ? (
            <div className="flex justify-center py-16"><Spinner /></div>
          ) : queryError ? (
            <div className="flex flex-col items-center gap-3 py-12 text-center">
              <div className="w-12 h-12 rounded-xl bg-status-danger/10 flex items-center justify-center">
                <svg className="w-6 h-6 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/>
                </svg>
              </div>
              <div>
                <p className="text-sm font-medium text-ink-secondary">No se pudo cargar la orden</p>
                <p className="text-xs text-status-danger mt-1">
                  {queryError.response?.data?.error || queryError.message || 'Error de conexión'}
                </p>
              </div>
              <button onClick={() => qc.invalidateQueries({ queryKey: ['purchase-order', ocId] })}
                className="btn-secondary btn-sm">
                Reintentar
              </button>
            </div>
          ) : !oc ? (
            <p className="text-sm text-ink-muted text-center py-8">La orden no fue encontrada</p>
          ) : (
            <>
              {tab === 'detalle' && <TabDetalle oc={oc} />}
              {tab === 'recepciones' && (
                <TabRecepciones oc={oc} onGoToRecepcion={() => onGoToRecepcion(oc)} />
              )}

              {actionError && (
                <div className="mt-4 bg-status-danger/10 border border-status-danger/40 rounded-lg px-3 py-2">
                  <p className="text-sm text-status-danger">{actionError}</p>
                </div>
              )}

              <AccionesOC oc={oc} onAction={handleAction} loadingAction={loadingAction} />
            </>
          )}
        </div>
      </div>
    </div>,
    document.body
  )
}
