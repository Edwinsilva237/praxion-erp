import { useState, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { countsApi } from '@/api/counts'
import Spinner from '@/components/ui/Spinner'
import Can from '@/components/auth/Can'
import ScanButton from '@/components/scanner/ScanButton'
import { fmtMXN, fmtNum, fmtDate } from '@/utils/fmt'
import clsx from 'clsx'

const STATUS_BADGE = {
  in_capture:  { color: 'bg-status-info/15 text-status-info',     label: 'En captura' },
  reconciling: { color: 'bg-status-warning/15 text-status-warning',   label: 'Conciliando' },
  applied:     { color: 'bg-status-success/15 text-status-success',   label: 'Aplicado' },
  cancelled:   { color: 'bg-surface-elevated/60 text-ink-muted',     label: 'Cancelado' },
}

// ── Mini hook para captura editable con auto-save ───────────────────────────
function useCellSave(countId, lineId) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ physicalQty, notes }) =>
      countsApi.captureLine(countId, lineId, { physicalQty, notes }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['count', countId] })
    },
  })
}

// ── Fila editable de captura ────────────────────────────────────────────────
function CaptureRow({ line, countId, readOnly }) {
  const [physical, setPhysical] = useState(line.physical_qty != null ? String(line.physical_qty) : '')
  const [notes, setNotes]       = useState(line.notes || '')
  const [touched, setTouched]   = useState(false)

  const saveMut = useCellSave(countId, line.id)

  const diff = physical !== '' ? parseFloat(physical) - parseFloat(line.system_qty) : null
  const diffValue = diff != null ? diff * parseFloat(line.system_avg_cost) : null

  function handleBlur() {
    if (!touched) return
    saveMut.mutate({
      physicalQty: physical === '' ? null : parseFloat(physical),
      notes:       notes,
    })
    setTouched(false)
  }

  return (
    <tr className={clsx(
      line.status === 'captured' && diff !== 0 && diff != null && 'bg-status-warning/10/40',
      line.status === 'pending' && 'bg-surface-primary',
    )}>
      <td className="font-medium text-ink-primary text-sm">
        {line.item_name}
        {line.sku && <span className="ml-1 text-[11px] text-ink-muted font-mono">#{line.sku}</span>}
        {/* Subtítulo opcional: atributos del item (resina/tipo si plástico, lote/caducidad si trazabilidad) */}
        {(line.lot_number || line.resin_type) && (
          <span className="block text-[10px] text-ink-muted">
            {line.lot_number && <>Lote: {line.lot_number}</>}
            {line.lot_number && line.expiry_date && ' · '}
            {line.expiry_date && <>vence {new Date(line.expiry_date).toLocaleDateString('es-MX')}</>}
            {line.resin_type && !line.lot_number && <>{line.resin_type} {line.material_type || ''}</>}
          </span>
        )}
      </td>
      <td className="text-xs text-ink-muted hidden sm:table-cell">{line.warehouse_name}</td>
      <td className="text-right tabular-nums text-sm text-ink-secondary">
        {fmtNum(line.system_qty, 2)} <span className="text-[10px] text-ink-muted">{line.unit}</span>
      </td>
      <td className="w-[120px]">
        <input
          type="number"
          step="0.0001"
          min="0"
          className="input input-sm tabular-nums text-right"
          placeholder="—"
          value={physical}
          onChange={e => { setPhysical(e.target.value); setTouched(true) }}
          onBlur={handleBlur}
          disabled={readOnly}
        />
      </td>
      <td className="text-right tabular-nums text-sm hidden sm:table-cell">
        {diff != null && physical !== '' ? (
          <span className={clsx(
            'font-mono font-semibold',
            diff > 0 ? 'text-status-success' : diff < 0 ? 'text-status-danger' : 'text-ink-muted'
          )}>
            {diff > 0 ? '+' : ''}{fmtNum(diff, 2)}
          </span>
        ) : <span className="text-ink-muted">—</span>}
      </td>
      <td className="text-right tabular-nums text-xs hidden sm:table-cell">
        {diffValue != null && physical !== '' && diff !== 0 ? (
          <span className={diffValue >= 0 ? 'text-status-success' : 'text-status-danger'}>
            {fmtMXN(diffValue)}
          </span>
        ) : <span className="text-ink-muted">—</span>}
      </td>
      <td className="w-[180px] hidden sm:table-cell">
        <input
          type="text"
          className="input input-sm text-xs"
          placeholder={diff !== 0 && diff != null ? 'Razón de la diferencia…' : 'Notas (opcional)'}
          value={notes}
          onChange={e => { setNotes(e.target.value); setTouched(true) }}
          onBlur={handleBlur}
          disabled={readOnly}
        />
      </td>
      <td className="w-[60px] text-center">
        {saveMut.isPending && <Spinner size="sm" />}
        {!saveMut.isPending && line.status === 'captured' && (
          <span title="Capturado" className="text-green-500">✓</span>
        )}
        {!saveMut.isPending && line.status === 'applied' && (
          <span title="Aplicado" className="text-status-success">✓✓</span>
        )}
      </td>
    </tr>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Componente principal
// ─────────────────────────────────────────────────────────────────────────────
export default function ConteoDetalle() {
  const { id } = useParams()
  const navigate = useNavigate()
  const qc = useQueryClient()

  const [searchTerm, setSearchTerm]   = useState('')
  const [statusTab, setStatusTab]     = useState('all')   // all | pending | captured | diff
  const [showApplyModal, setShowApplyModal] = useState(false)
  const [closingNotes, setClosingNotes]     = useState('')
  const [showCancelModal, setShowCancelModal] = useState(false)
  const [cancelReason, setCancelReason]       = useState('')
  const [actionError, setActionError]         = useState(null)

  const { data: count, isLoading } = useQuery({
    queryKey: ['count', id],
    queryFn:  () => countsApi.get(id),
    enabled:  !!id,
  })

  const moveToReconcileMut = useMutation({
    mutationFn: () => countsApi.moveToReconcile(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['count', id] }),
    onError: (err) => setActionError(err.response?.data?.error || err.message),
  })

  const applyMut = useMutation({
    mutationFn: () => countsApi.apply(id, closingNotes),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['count', id] })
      qc.invalidateQueries({ queryKey: ['counts'] })
      setShowApplyModal(false)
    },
    onError: (err) => setActionError(err.response?.data?.error || err.message),
  })

  const cancelMut = useMutation({
    mutationFn: () => countsApi.cancel(id, cancelReason),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['count', id] })
      qc.invalidateQueries({ queryKey: ['counts'] })
      setShowCancelModal(false)
    },
    onError: (err) => setActionError(err.response?.data?.error || err.message),
  })

  const markNoDiffMut = useMutation({
    mutationFn: (lineIds) => countsApi.markNoDiff(id, lineIds),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['count', id] }),
    onError: (err) => setActionError(err.response?.data?.error || err.message),
  })

  // Filtrar líneas
  const filteredLines = useMemo(() => {
    if (!count?.lines) return []
    let lines = count.lines

    if (searchTerm.trim()) {
      const term = searchTerm.toLowerCase()
      lines = lines.filter(l => (l.item_name || '').toLowerCase().includes(term) || (l.sku || '').toLowerCase().includes(term))
    }
    if (statusTab === 'pending') {
      lines = lines.filter(l => l.status === 'pending')
    } else if (statusTab === 'captured') {
      lines = lines.filter(l => l.status === 'captured' || l.status === 'applied')
    } else if (statusTab === 'diff') {
      lines = lines.filter(l => l.physical_qty != null && parseFloat(l.physical_qty) !== parseFloat(l.system_qty))
    }
    return lines
  }, [count, searchTerm, statusTab])

  // Resumen
  const summary = useMemo(() => {
    if (!count?.lines) return null
    const pending = count.lines.filter(l => l.status === 'pending').length
    const captured = count.lines.filter(l => l.status === 'captured' || l.status === 'applied').length
    const diffLines = count.lines.filter(l =>
      l.physical_qty != null && parseFloat(l.physical_qty) !== parseFloat(l.system_qty)
    )
    const totalDiffValue = diffLines.reduce((sum, l) =>
      sum + (parseFloat(l.physical_qty) - parseFloat(l.system_qty)) * parseFloat(l.system_avg_cost), 0)
    return {
      total: count.lines.length,
      pending,
      captured,
      noDiff: captured - diffLines.length,
      withDiff: diffLines.length,
      totalDiffValue,
    }
  }, [count])

  if (isLoading) {
    return <div className="flex justify-center py-20"><Spinner /></div>
  }

  if (!count) {
    return (
      <div className="page-container">
        <p className="text-sm text-ink-muted">Conteo no encontrado.</p>
        <button onClick={() => navigate('/inventario/conteos')} className="btn-secondary mt-4">
          ← Volver a la lista
        </button>
      </div>
    )
  }

  const statusCfg = STATUS_BADGE[count.status] || { color: 'bg-surface-elevated/60', label: count.status }
  const isReadOnly = count.status === 'applied' || count.status === 'cancelled'
  const canMoveToReconcile = count.status === 'in_capture' && summary?.captured > 0
  const canApply = (count.status === 'in_capture' || count.status === 'reconciling') && summary?.captured > 0
  const canCancel = count.status === 'in_capture' || count.status === 'reconciling'

  return (
    <div className="page-container max-w-[1400px]">
      {/* Header */}
      <div className="flex items-start justify-between mb-4 flex-wrap gap-3">
        <div className="flex items-start gap-3 min-w-0">
          <button onClick={() => navigate('/inventario/conteos')} className="btn-ghost btn-icon mt-1">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
          </button>
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-xl font-bold font-mono text-ink-primary">{count.count_number}</h1>
              <span className={clsx('px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wide', statusCfg.color)}>
                {statusCfg.label}
              </span>
              <span className="text-xs text-ink-muted">
                {count.count_type === 'cyclic' ? '🔄 Cíclico' : '📅 Cierre de mes'}
              </span>
            </div>
            <p className="text-xs text-ink-muted mt-1">
              {count.warehouse_name || 'Todos los almacenes'} · Iniciado {fmtDate(count.started_at)} por {count.started_by_name || '—'}
              {count.notes && <> · {count.notes}</>}
            </p>
            {count.adjustment_number && (
              <p className="text-xs text-status-success mt-1">
                ✓ Ajuste contable generado: <span className="font-mono font-semibold">{count.adjustment_number}</span>
              </p>
            )}
          </div>
        </div>

        {/* Acciones */}
        <div className="flex gap-2 flex-wrap">
          {canCancel && (
            <button onClick={() => setShowCancelModal(true)} className="btn-secondary btn-sm text-status-danger border-status-danger/40 hover:bg-status-danger/10">
              Cancelar conteo
            </button>
          )}
          {canMoveToReconcile && (
            <button onClick={() => moveToReconcileMut.mutate()} disabled={moveToReconcileMut.isPending} className="btn-secondary btn-sm disabled:opacity-50">
              {moveToReconcileMut.isPending ? <Spinner size="sm" /> : 'Conciliar →'}
            </button>
          )}
          {canApply && (
            <Can do="inventory:adjust">
              <button onClick={() => setShowApplyModal(true)} className="btn-primary btn-sm">
                Aplicar ajustes →
              </button>
            </Can>
          )}
        </div>
      </div>

      {/* Resumen (cards) */}
      {summary && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-2 mb-4">
          <SummaryCard label="Total ítems"     value={summary.total}    color="gray" />
          <SummaryCard label="Pendientes"      value={summary.pending}  color="blue" />
          <SummaryCard label="Capturados"      value={summary.captured} color="gray" />
          <SummaryCard label="Sin diferencia"  value={summary.noDiff}   color="green" />
          <SummaryCard label="Con diferencia"  value={summary.withDiff} color="amber" valueExtra={
            summary.withDiff > 0 ? (
              <span className={clsx(
                'block text-xs font-medium',
                summary.totalDiffValue >= 0 ? 'text-status-success' : 'text-status-danger'
              )}>
                {fmtMXN(summary.totalDiffValue)}
              </span>
            ) : null
          } />
        </div>
      )}

      {/* Errores */}
      {actionError && (
        <div className="bg-status-danger/10 border border-status-danger/40 rounded-lg p-3 mb-3 text-sm text-status-danger">
          {actionError}
        </div>
      )}

      {/* Filtros */}
      <div className="bg-surface-primary border border-line-subtle rounded-xl p-3 mb-3 flex flex-wrap items-center gap-2">
        <input
          type="text"
          className="input input-sm flex-1 min-w-[200px]"
          placeholder="Buscar o escanear artículo / SKU…"
          value={searchTerm}
          onChange={e => setSearchTerm(e.target.value)}
        />
        <ScanButton onScan={code => setSearchTerm(code)} title="Escanear artículo a contar" />
        <div className="flex gap-1">
          {[
            ['all',      'Todos',           summary?.total],
            ['pending',  'Pendientes',      summary?.pending],
            ['captured', 'Capturados',      summary?.captured],
            ['diff',     'Con diferencia',  summary?.withDiff],
          ].map(([key, label, count]) => (
            <button
              key={key}
              onClick={() => setStatusTab(key)}
              className={clsx(
                'px-3 py-1 rounded-lg text-xs font-medium transition-colors',
                statusTab === key
                  ? 'bg-brand-500/15 text-brand-300'
                  : 'bg-surface-elevated/60 text-ink-secondary hover:bg-surface-elevated'
              )}
            >
              {label} {count != null && <span className="opacity-60">({count})</span>}
            </button>
          ))}
        </div>
        {!isReadOnly && summary?.pending > 0 && (
          <button
            onClick={() => {
              const pendingIds = count.lines.filter(l => l.status === 'pending').map(l => l.id)
              if (pendingIds.length === 0) return
              if (confirm(`¿Marcar ${pendingIds.length} pendientes como "sin diferencia" (físico = sistema)?`)) {
                markNoDiffMut.mutate(pendingIds)
              }
            }}
            disabled={markNoDiffMut.isPending}
            className="btn-secondary btn-sm text-xs disabled:opacity-50"
            title="Útil para almacenes grandes donde solo unos pocos ítems tienen diferencia."
          >
            ✓ Marcar pendientes sin diferencia
          </button>
        )}
      </div>

      {/* Tabla de captura */}
      {filteredLines.length === 0 ? (
        <div className="empty-state">
          <p className="text-sm text-ink-muted">
            {searchTerm ? 'No hay artículos que coincidan con la búsqueda.' :
             statusTab !== 'all' ? `No hay artículos en este filtro.` :
             'Sin artículos en este conteo.'}
          </p>
        </div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Artículo</th>
                <th className="hidden sm:table-cell">Almacén</th>
                <th className="text-right">Sistema</th>
                <th className="text-right">Físico</th>
                <th className="text-right hidden sm:table-cell">Diferencia</th>
                <th className="text-right hidden sm:table-cell">Impacto $</th>
                <th className="hidden sm:table-cell">Notas</th>
                <th className="text-center w-[60px]"></th>
              </tr>
            </thead>
            <tbody>
              {filteredLines.map(line => (
                <CaptureRow key={line.id} line={line} countId={id} readOnly={isReadOnly} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Modal: Aplicar */}
      {showApplyModal && (
        <ApplyModal
          summary={summary}
          closingNotes={closingNotes}
          setClosingNotes={setClosingNotes}
          onApply={() => {
            setActionError(null)
            applyMut.mutate()
          }}
          onClose={() => setShowApplyModal(false)}
          isPending={applyMut.isPending}
          error={actionError}
        />
      )}

      {/* Modal: Cancelar */}
      {showCancelModal && (
        <CancelModal
          reason={cancelReason}
          setReason={setCancelReason}
          onCancel={() => {
            setActionError(null)
            cancelMut.mutate()
          }}
          onClose={() => setShowCancelModal(false)}
          isPending={cancelMut.isPending}
          error={actionError}
        />
      )}
    </div>
  )
}

// ── Card de resumen ─────────────────────────────────────────────────────────
function SummaryCard({ label, value, color, valueExtra }) {
  const cfg = {
    gray:  'bg-surface-elevated/40 border-line-subtle text-ink-secondary',
    blue:  'bg-status-info/10 border-status-info/40 text-status-info',
    green: 'bg-status-success/10 border-status-success/40 text-status-success',
    amber: 'bg-status-warning/10 border-status-warning/40 text-status-warning',
  }[color] || 'bg-surface-elevated/40'
  return (
    <div className={clsx('rounded-xl border p-3', cfg)}>
      <p className="text-[10px] uppercase tracking-wider opacity-70 font-semibold">{label}</p>
      <p className="text-xl font-bold tabular-nums mt-1">{value ?? '—'}</p>
      {valueExtra}
    </div>
  )
}

// ── Modal: Aplicar ajustes ──────────────────────────────────────────────────
function ApplyModal({ summary, closingNotes, setClosingNotes, onApply, onClose, isPending, error }) {
  return createPortal(
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40 p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="card w-full max-w-md p-6">
        <h2 className="text-base font-semibold mb-3">Aplicar ajustes contables</h2>
        <div className="bg-surface-elevated/40 rounded-xl p-3 mb-4 text-sm">
          <p><strong>{summary?.withDiff || 0}</strong> ítems con diferencia</p>
          <p className={clsx(
            'font-medium tabular-nums',
            summary?.totalDiffValue >= 0 ? 'text-status-success' : 'text-status-danger'
          )}>
            Impacto total: {fmtMXN(summary?.totalDiffValue || 0)}
          </p>
          <p className="text-xs text-ink-muted mt-2">
            Se generará automáticamente un documento de ajuste (AJ-YYYYMM-XXXX) con todas las
            líneas que tengan diferencia. El ajuste será irreversible salvo cancelación manual.
          </p>
        </div>

        <label className="label">Notas de cierre del conteo *</label>
        <textarea
          className="input min-h-[80px]"
          placeholder="Razones generales, contexto del conteo, observaciones globales…"
          value={closingNotes}
          onChange={e => setClosingNotes(e.target.value)}
        />
        <p className="text-[11px] text-ink-muted mt-1">
          Estas notas quedarán archivadas tanto en el conteo como en el ajuste contable.
        </p>

        {error && (
          <div className="bg-status-danger/10 border border-status-danger/40 rounded-lg p-3 mt-3 text-xs text-status-danger">{error}</div>
        )}

        <div className="flex gap-2 mt-4">
          <button onClick={onClose} className="btn-secondary flex-1">Cancelar</button>
          <button
            onClick={onApply}
            disabled={isPending || !closingNotes.trim()}
            className="btn-primary flex-1 disabled:opacity-50"
          >
            {isPending ? <Spinner size="sm" /> : 'Aplicar y generar ajuste'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}

// ── Modal: Cancelar conteo ──────────────────────────────────────────────────
function CancelModal({ reason, setReason, onCancel, onClose, isPending, error }) {
  return createPortal(
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40 p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="card w-full max-w-md p-6">
        <h2 className="text-base font-semibold mb-3">Cancelar conteo</h2>
        <p className="text-sm text-ink-secondary mb-3">
          El conteo quedará marcado como cancelado y no se generará ningún ajuste contable.
          Las capturas realizadas se mantienen para auditoría.
        </p>

        <label className="label">Razón de la cancelación *</label>
        <textarea
          className="input min-h-[80px]"
          placeholder="Ej. Inventario detenido por ingreso de pedido grande sin contar, conteo se reanuda otro día…"
          value={reason}
          onChange={e => setReason(e.target.value)}
        />

        {error && (
          <div className="bg-status-danger/10 border border-status-danger/40 rounded-lg p-3 mt-3 text-xs text-status-danger">{error}</div>
        )}

        <div className="flex gap-2 mt-4">
          <button onClick={onClose} className="btn-secondary flex-1">Cerrar</button>
          <button
            onClick={onCancel}
            disabled={isPending || !reason.trim()}
            className="btn-primary flex-1 bg-red-600 hover:bg-red-700 disabled:opacity-50"
          >
            {isPending ? <Spinner size="sm" /> : 'Confirmar cancelación'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
