import { useState } from 'react'
import { createPortal } from 'react-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { inventoryApi } from '@/api/inventory'
import Spinner from '@/components/ui/Spinner'
import Badge from '@/components/ui/Badge'
import useAuthStore from '@/store/useAuthStore'
import clsx from 'clsx'

const fmtMXN = (n) => {
  if (n == null || isNaN(n)) return '$0.00'
  return `$${Number(n).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}
const fmtNum = (n, decimals = 2) => {
  if (n == null || isNaN(n)) return '0'
  return Number(n).toLocaleString('es-MX', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
}
const fmtDateTime = (d) => {
  if (!d) return '—'
  return new Date(d).toLocaleString('es-MX', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
}

export default function AdjustmentDetallePanel({ adjustmentId, onClose }) {
  const qc  = useQueryClient()
  const can = useAuthStore(s => s.can)
  const permissions = useAuthStore(s => s.permissions)
  const isSuperAdmin = permissions?.includes?.('*')
  const canCancel = isSuperAdmin || can?.('inventario', 'manage')

  const [showCancelModal, setShowCancelModal] = useState(false)

  const { data: adj, isLoading, isError, error } = useQuery({
    queryKey: ['inv-adjustment', adjustmentId],
    queryFn:  () => inventoryApi.getAdjustment(adjustmentId),
    enabled:  !!adjustmentId,
  })

  const isCancelled = adj?.status === 'cancelled'
  const hasReversal = adj?.reversalLines?.length > 0

  function handleCancelled() {
    qc.invalidateQueries({ queryKey: ['inv-adjustment', adjustmentId] })
    qc.invalidateQueries({ queryKey: ['inv-adjustments'] })
    qc.invalidateQueries({ queryKey: ['inv-stock'] })
    qc.invalidateQueries({ queryKey: ['inv-summary'] })
    qc.invalidateQueries({ queryKey: ['inv-movements'] })
    setShowCancelModal(false)
  }

  return createPortal(
    <div className="fixed inset-0 z-[9998] flex" onClick={onClose}>
      <div className="hidden sm:block flex-1 bg-black/30" />

      <div
        className="w-full max-w-2xl bg-surface-primary shadow-card overflow-y-auto flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="sticky top-0 bg-surface-primary border-b border-line-subtle px-6 py-4 flex items-center justify-between z-10"
          style={{ paddingTop: 'calc(1rem + env(safe-area-inset-top))' }}>
          <div className="min-w-0 flex items-center gap-3">
            <div>
              <p className="text-[10px] uppercase tracking-widest text-ink-muted font-semibold">Detalle de ajuste</p>
              <h2 className={clsx(
                'text-base font-semibold truncate',
                isCancelled ? 'text-ink-muted line-through' : 'text-ink-primary'
              )}>
                {adj?.adjustment_number || '...'}
              </h2>
            </div>
            {adj && (
              <Badge
                variant={isCancelled ? 'red' : 'green'}
                label={isCancelled ? 'Cancelado' : 'Activo'}
              />
            )}
          </div>
          <button
            onClick={onClose}
            className="btn-ghost btn-icon text-ink-muted shrink-0"
            aria-label="Cerrar"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12"/>
            </svg>
          </button>
        </div>

        {/* Cuerpo */}
        <div className="flex-1 px-6 py-5">
          {isLoading && <div className="flex justify-center py-20"><Spinner /></div>}

          {isError && (
            <div className="bg-status-danger/10 border border-status-danger/40 rounded-xl px-4 py-3 text-sm text-status-danger">
              {error?.response?.data?.error || 'Error al cargar el ajuste.'}
            </div>
          )}

          {adj && (
            <>
              {/* Banner de cancelación */}
              {isCancelled && (
                <div className="bg-status-danger/10 border border-status-danger/40 rounded-xl px-4 py-3 mb-5">
                  <div className="flex items-start gap-3">
                    <svg className="w-5 h-5 text-status-danger shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/>
                    </svg>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold text-status-danger">Ajuste cancelado</p>
                      <p className="text-xs text-status-danger mt-0.5">
                        Cancelado el {fmtDateTime(adj.cancelled_at)}
                        {adj.cancelled_by_name && <> por <span className="font-medium">{adj.cancelled_by_name}</span></>}
                      </p>
                      {adj.cancellation_reason && (
                        <p className="text-xs text-status-danger mt-2 bg-surface-primary/50 rounded px-2 py-1.5">
                          <span className="font-semibold">Razón:</span> {adj.cancellation_reason}
                        </p>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {/* Datos generales */}
              <div className="grid grid-cols-2 gap-x-6 gap-y-3 mb-6 pb-5 border-b border-line-subtle">
                <Field label="Fecha"          value={fmtDateTime(adj.created_at)} />
                <Field label="Almacén"        value={adj.warehouse_name} />
                <Field label="Capturado por"  value={adj.created_by_name || '—'} />
                <Field label="Total líneas"   value={adj.total_lines} />
                <Field label="Motivo"         value={adj.reason} colSpan={2} />
                {adj.notes && (
                  <Field label="Notas adicionales" value={adj.notes} colSpan={2} multiline />
                )}
              </div>

              {/* Totales */}
              <div className="grid grid-cols-3 gap-3 mb-6">
                <SummaryBox
                  label="Entradas"
                  value={`+${fmtMXN(adj.total_in_value)}`}
                  variant="green"
                  dimmed={isCancelled}
                />
                <SummaryBox
                  label="Salidas"
                  value={`−${fmtMXN(adj.total_out_value)}`}
                  variant="red"
                  dimmed={isCancelled}
                />
                <SummaryBox
                  label="Neto"
                  value={`${parseFloat(adj.net_value) >= 0 ? '+' : '−'}${fmtMXN(Math.abs(adj.net_value))}`}
                  variant={parseFloat(adj.net_value) >= 0 ? 'blue' : 'amber'}
                  dimmed={isCancelled}
                />
              </div>

              {/* Líneas originales */}
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-semibold text-ink-secondary">Movimientos originales</h3>
                <span className="text-xs text-ink-muted">{adj.lines?.length || 0} línea(s)</span>
              </div>
              {!adj.lines?.length ? (
                <p className="text-sm text-ink-muted italic">Sin líneas registradas.</p>
              ) : (
                <div className={clsx('table-wrap', isCancelled && 'opacity-60')}>
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Artículo</th>
                        <th>Tipo</th>
                        <th>Mov.</th>
                        <th className="text-right">Cantidad</th>
                        <th className="text-right">Costo unit.</th>
                        <th className="text-right">Total</th>
                      </tr>
                    </thead>
                    <tbody>
                      {adj.lines.map(ln => <LineRow key={ln.id} line={ln} />)}
                    </tbody>
                  </table>
                </div>
              )}

              {/* Líneas de reversión (si está cancelado) */}
              {hasReversal && (
                <>
                  <div className="flex items-center justify-between mb-3 mt-6">
                    <h3 className="text-sm font-semibold text-status-danger flex items-center gap-2">
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                          d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6"/>
                      </svg>
                      Movimientos de reversión
                    </h3>
                    <span className="text-xs text-ink-muted">{adj.reversalLines.length} línea(s)</span>
                  </div>
                  <div className="table-wrap border-l-4 border-status-danger/40">
                    <table className="table">
                      <thead>
                        <tr>
                          <th>Artículo</th>
                          <th>Tipo</th>
                          <th>Mov.</th>
                          <th className="text-right">Cantidad</th>
                          <th className="text-right">Costo unit.</th>
                          <th className="text-right">Total</th>
                        </tr>
                      </thead>
                      <tbody>
                        {adj.reversalLines.map(ln => <LineRow key={ln.id} line={ln} />)}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </>
          )}
        </div>

        {/* Footer con acción cancelar */}
        {adj && !isCancelled && canCancel && (
          <div className="sticky bottom-0 bg-surface-primary border-t border-line-subtle px-6 py-3 flex justify-end">
            <button
              onClick={() => setShowCancelModal(true)}
              className="btn-secondary text-status-danger hover:bg-status-danger/10 hover:border-status-danger/40 border-status-danger/40"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6"/>
              </svg>
              Cancelar ajuste
            </button>
          </div>
        )}

        {/* Modal de cancelación */}
        {showCancelModal && adj && (
          <CancelConfirmModal
            adjustment={adj}
            onClose={() => setShowCancelModal(false)}
            onCancelled={handleCancelled}
          />
        )}
      </div>
    </div>,
    document.body
  )
}

// ─────────────────────────────────────────────────────────────────────────────
//  Modal de confirmación de cancelación
// ─────────────────────────────────────────────────────────────────────────────
function CancelConfirmModal({ adjustment, onClose, onCancelled }) {
  const [reason, setReason]       = useState('')
  const [showError, setShowError] = useState(false)
  const [serverError, setServerError] = useState(null)

  const mutation = useMutation({
    mutationFn: (body) => inventoryApi.cancelAdjustment(adjustment.id, body),
    onSuccess:  () => onCancelled(),
    onError:    (err) => setServerError(err.response?.data?.error || err.message),
  })

  function submit() {
    setShowError(true)
    setServerError(null)
    if (!reason.trim()) return
    mutation.mutate({ reason: reason.trim() })
  }

  return createPortal(
    <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/50 p-4">
      <div className="bg-surface-primary rounded-2xl shadow-card w-full max-w-md p-6">
        <div className="flex items-start gap-3 mb-4">
          <div className="w-10 h-10 rounded-full bg-status-danger/15 flex items-center justify-center shrink-0">
            <svg className="w-5 h-5 text-status-danger" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/>
            </svg>
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="text-base font-semibold text-ink-primary">Cancelar ajuste {adjustment.adjustment_number}</h3>
            <p className="text-xs text-ink-muted mt-1">
              Se generarán <strong>movimientos contrarios</strong> automáticamente para revertir el efecto en inventario.
              Esta acción se registra en el kardex y no se puede deshacer.
            </p>
          </div>
        </div>

        <div className="mb-4">
          <label className="label">Razón de la cancelación *</label>
          <textarea
            className={clsx(
              'input min-h-[80px]',
              showError && !reason.trim() && 'border-status-danger/40 focus:ring-status-danger/40'
            )}
            placeholder="Ej: error de captura, ajuste duplicado, motivo registrado por error..."
            value={reason}
            onChange={e => setReason(e.target.value)}
            rows={3}
            autoFocus
          />
          {showError && !reason.trim() && (
            <p className="text-[11px] text-status-danger mt-1">La razón es obligatoria.</p>
          )}
        </div>

        {serverError && (
          <div className="bg-status-danger/10 border border-status-danger/40 rounded-xl px-3 py-2 text-xs text-status-danger mb-4">
            {serverError}
          </div>
        )}

        <div className="flex gap-2">
          <button
            onClick={onClose}
            className="btn-secondary flex-1"
            disabled={mutation.isPending}
          >
            Volver
          </button>
          <button
            onClick={submit}
            disabled={mutation.isPending}
            className="flex-1 px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded-xl text-sm font-medium transition-colors disabled:opacity-50"
          >
            {mutation.isPending ? <Spinner size="sm" /> : 'Sí, cancelar'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}

// ── Sub-componentes ──────────────────────────────────────────────────────────
function LineRow({ line }) {
  const qty   = parseFloat(line.quantity)
  const isIn  = qty >= 0
  const total = Math.abs(qty) * parseFloat(line.unit_cost || 0)
  return (
    <tr>
      <td>
        <p className="text-sm font-medium text-ink-primary">{line.item_name}</p>
        {line.sku && <p className="text-xs text-ink-muted font-mono">#{line.sku}</p>}
        {line.notes && <p className="text-xs text-ink-muted italic mt-0.5">{line.notes}</p>}
      </td>
      <td>
        <Badge
          variant={line.item_type === 'raw_material' ? 'amber' : 'blue'}
          label={line.item_type === 'raw_material' ? 'MP' : 'PT'}
        />
      </td>
      <td>
        <Badge
          variant={isIn ? 'green' : 'red'}
          label={isIn ? 'Entrada' : 'Salida'}
        />
      </td>
      <td className={clsx(
        'text-right font-mono text-sm font-semibold',
        isIn ? 'text-status-success' : 'text-status-danger'
      )}>
        {isIn ? '+' : '−'}{fmtNum(Math.abs(qty), 4)}
        <span className="ml-1 text-[10px] font-normal text-ink-muted">{line.unit}</span>
      </td>
      <td className="text-right font-mono text-xs text-ink-muted">{fmtMXN(line.unit_cost)}</td>
      <td className="text-right font-mono text-xs">{fmtMXN(total)}</td>
    </tr>
  )
}

function Field({ label, value, colSpan = 1, multiline = false }) {
  return (
    <div className={clsx(colSpan === 2 && 'col-span-2')}>
      <p className="text-[10px] uppercase tracking-widest text-ink-muted font-semibold">{label}</p>
      <p className={clsx(
        'text-sm text-ink-primary mt-0.5',
        multiline && 'whitespace-pre-wrap'
      )}>{value}</p>
    </div>
  )
}

function SummaryBox({ label, value, variant, dimmed }) {
  const styles = {
    green: 'bg-status-success/10 border-status-success/40 text-status-success',
    red:   'bg-status-danger/10 border-status-danger/40 text-status-danger',
    blue:  'bg-status-info/10 border-status-info/40 text-status-info',
    amber: 'bg-status-warning/10 border-status-warning/40 text-status-warning',
  }
  const labelStyles = {
    green: 'text-status-success',
    red:   'text-status-danger',
    blue:  'text-status-info',
    amber: 'text-status-warning',
  }
  return (
    <div className={clsx('border rounded-xl p-3', styles[variant], dimmed && 'opacity-50')}>
      <p className={clsx('text-[10px] uppercase font-semibold tracking-wider', labelStyles[variant])}>{label}</p>
      <p className="text-sm sm:text-base font-bold mt-1 tabular-nums break-all">{value}</p>
    </div>
  )
}
