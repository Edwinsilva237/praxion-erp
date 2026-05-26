import { useState, useEffect, useMemo } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { createPortal } from 'react-dom'
import { pettyCashApi } from '@/api/pettyCash'
import Spinner from '@/components/ui/Spinner'
import useAuthStore from '@/store/useAuthStore'
import clsx from 'clsx'

const fmtMXN  = (n) => new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 }).format(n || 0)
const fmtMXNf = (n) => new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' }).format(n || 0)
const fmtDate = (d) => d ? new Date(d).toLocaleDateString('es-MX', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '—'

export default function CajaChica() {
  const { can } = useAuthStore()
  const canCreate = can('petty_cash', 'create')
  const canCancel = can('petty_cash', 'cancel')

  const [selectedFundId, setSelectedFundId] = useState(null)
  const [kindFilter, setKindFilter]   = useState('')
  const [statusFilter, setStatusFilter] = useState('active')
  const [showCapture, setShowCapture]   = useState(null) // 'in' | 'out' | null
  const [showCancel, setShowCancel]     = useState(null) // movement object

  const { data: fundsResp } = useQuery({
    queryKey: ['petty-cash', 'funds'],
    queryFn:  () => pettyCashApi.listFunds(),
  })
  const funds = fundsResp?.data || []

  // Selecciona el primer fondo activo si no hay selección.
  useEffect(() => {
    if (!selectedFundId && funds.length > 0) {
      setSelectedFundId(funds[0].id)
    }
  }, [funds, selectedFundId])

  const selectedFund = funds.find(f => f.id === selectedFundId)

  const movementsFilters = useMemo(() => ({
    fundId: selectedFundId,
    kind:   kindFilter || undefined,
    status: statusFilter || undefined,
    limit:  100,
  }), [selectedFundId, kindFilter, statusFilter])

  const { data: movementsResp, isLoading } = useQuery({
    queryKey: ['petty-cash', 'movements', movementsFilters],
    queryFn:  () => pettyCashApi.listMovements(movementsFilters),
    enabled:  !!selectedFundId,
  })
  const movements = movementsResp?.data || []

  if (funds.length === 0) {
    return (
      <div className="page-enter max-w-3xl mx-auto py-10 px-4 text-center">
        <div className="card p-8 flex flex-col items-center gap-3">
          <div className="w-12 h-12 rounded-xl bg-surface-elevated/60 flex items-center justify-center">
            <svg className="w-6 h-6 text-ink-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 10h18M3 14h18M5 6h14a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2z" />
            </svg>
          </div>
          <h2 className="text-lg font-semibold text-ink-primary">No hay cajas configuradas</h2>
          <p className="text-sm text-ink-muted max-w-md">
            Antes de capturar movimientos, crea al menos una caja en{' '}
            <strong>Configuración → Cajas chicas</strong>. Puedes tener una caja por sucursal,
            departamento o responsable.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="page-enter max-w-7xl mx-auto py-6 px-4 flex flex-col gap-5">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-xl font-semibold text-ink-primary">Caja chica</h1>
          <p className="text-sm text-ink-muted mt-1">
            Registro de entradas y salidas. Saldo calculado en vivo. Los movimientos
            no se editan — se cancelan con motivo.
          </p>
        </div>
        <div className="flex gap-2">
          {canCreate && selectedFund && (
            <>
              <button onClick={() => setShowCapture('in')} className="btn-primary">
                + Entrada
              </button>
              <button onClick={() => setShowCapture('out')}
                disabled={selectedFund.current_balance <= 0}
                className="btn-danger"
                title={selectedFund.current_balance <= 0 ? 'Sin saldo disponible' : ''}>
                − Salida
              </button>
            </>
          )}
        </div>
      </div>

      {/* Selector de fondo + KPIs */}
      <section className="card p-4 flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <label className="text-xs text-ink-muted">Caja:</label>
          <select className="select min-w-[260px]"
            value={selectedFundId || ''}
            onChange={e => setSelectedFundId(e.target.value)}>
            {funds.map(f => (
              <option key={f.id} value={f.id}>
                {f.name}{f.location ? ` · ${f.location}` : ''}
                {!f.is_active ? ' (inactiva)' : ''}
              </option>
            ))}
          </select>
          {selectedFund?.responsible_name && (
            <span className="text-xs text-ink-muted">
              Responsable: <strong className="text-ink-secondary">{selectedFund.responsible_name}</strong>
            </span>
          )}
        </div>

        {selectedFund && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <KpiCard label="Saldo actual"  value={fmtMXNf(selectedFund.current_balance)}
              tone={selectedFund.current_balance < 0 ? 'danger'
                : selectedFund.current_balance < 500 ? 'warning' : 'success'} />
            <KpiCard label="Saldo inicial" value={fmtMXN(selectedFund.initial_balance)} />
            <KpiCard label="Movimientos"   value={selectedFund.movements_count} />
            <KpiCard label="Estado"
              value={selectedFund.is_active ? 'Activa' : 'Inactiva'}
              tone={selectedFund.is_active ? 'success' : 'danger'} />
          </div>
        )}
      </section>

      {/* Filtros */}
      <div className="card p-4 flex flex-wrap gap-3 items-end">
        <div>
          <label className="label">Tipo</label>
          <select className="select" value={kindFilter} onChange={e => setKindFilter(e.target.value)}>
            <option value="">Todos</option>
            <option value="in">Entradas</option>
            <option value="out">Salidas</option>
          </select>
        </div>
        <div>
          <label className="label">Estado</label>
          <select className="select" value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
            <option value="active">Activos</option>
            <option value="cancelled">Cancelados</option>
            <option value="">Todos</option>
          </select>
        </div>
        {(kindFilter || statusFilter !== 'active') && (
          <button onClick={() => { setKindFilter(''); setStatusFilter('active') }}
            className="btn-ghost btn-sm text-ink-muted">Limpiar</button>
        )}
      </div>

      {/* Tabla */}
      <div className="card overflow-hidden">
        {isLoading ? (
          <div className="flex justify-center py-16"><Spinner /></div>
        ) : movements.length === 0 ? (
          <div className="flex flex-col items-center gap-3 py-16 text-center">
            <p className="text-sm font-medium text-ink-secondary">Sin movimientos</p>
            <p className="text-xs text-ink-muted">
              {selectedFund?.movements_count === 0
                ? 'Esta caja todavía no tiene movimientos. Captura el primero arriba.'
                : 'No hay movimientos para los filtros aplicados.'}
            </p>
          </div>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Fecha</th>
                <th>Tipo</th>
                <th>Categoría</th>
                <th>Descripción</th>
                <th>Capturó</th>
                <th className="text-center">Comprobante</th>
                <th className="text-right">Monto</th>
                {canCancel && <th></th>}
              </tr>
            </thead>
            <tbody>
              {movements.map(m => (
                <tr key={m.id}
                  className={clsx(m.status === 'cancelled' && 'opacity-50')}>
                  <td className="text-xs text-ink-secondary">{fmtDate(m.occurred_at)}</td>
                  <td>
                    <span className={clsx(
                      'text-[10px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded-full',
                      m.kind === 'in' ? 'bg-status-success/15 text-status-success'
                                      : 'bg-status-danger/15 text-status-danger'
                    )}>
                      {m.kind === 'in' ? 'Entrada' : 'Salida'}
                    </span>
                  </td>
                  <td className="text-xs">{m.category_name || <span className="text-ink-muted">—</span>}</td>
                  <td className="text-xs">
                    {m.description || <span className="text-ink-muted">—</span>}
                    {m.paid_to && (
                      <p className="text-[10px] text-ink-muted mt-0.5">
                        {m.kind === 'out' ? 'Entregado a' : 'Recibido de'}:{' '}
                        <span className="text-ink-secondary">{m.paid_to}</span>
                      </p>
                    )}
                    {m.status === 'cancelled' && (
                      <p className="text-[10px] text-status-danger italic mt-0.5">
                        Cancelado: {m.cancelled_reason}
                      </p>
                    )}
                  </td>
                  <td className="text-[11px] text-ink-secondary">{m.created_by_name || '—'}</td>
                  <td className="text-center">
                    {m.attachment_id ? (
                      <a href={pettyCashApi.getReceiptUrl(m.id)} target="_blank" rel="noreferrer"
                        title="Ver comprobante" className="text-status-info hover:text-status-info/80">
                        📎
                      </a>
                    ) : (
                      <span className="text-ink-muted text-xs">—</span>
                    )}
                  </td>
                  <td className={clsx('text-right font-mono tabular-nums font-semibold',
                    m.kind === 'in' ? 'text-status-success' : 'text-status-danger',
                    m.status === 'cancelled' && 'line-through')}>
                    {m.kind === 'in' ? '+' : '−'} {fmtMXN(m.amount)}
                  </td>
                  {canCancel && (
                    <td>
                      {m.status === 'active' && (
                        <button onClick={() => setShowCancel(m)}
                          title="Cancelar movimiento"
                          className="text-ink-muted hover:text-status-danger text-xs">
                          ✕
                        </button>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {showCapture && selectedFund && (
        <CaptureMovementModal
          fund={selectedFund} kind={showCapture}
          onClose={() => setShowCapture(null)}
        />
      )}

      {showCancel && (
        <CancelMovementModal
          movement={showCancel}
          onClose={() => setShowCancel(null)}
        />
      )}
    </div>
  )
}

function KpiCard({ label, value, tone = 'neutral' }) {
  const toneClass = {
    danger:  'text-status-danger',
    warning: 'text-status-warning',
    success: 'text-status-success',
    neutral: 'text-ink-primary',
  }[tone]
  return (
    <div className="card-sm">
      <p className="text-[10px] uppercase tracking-wide text-ink-muted">{label}</p>
      <p className={clsx('text-xl font-semibold mt-1 tabular-nums', toneClass)}>{value}</p>
    </div>
  )
}

// ── Modal de captura ──────────────────────────────────────────────────────
function CaptureMovementModal({ fund, kind, onClose }) {
  const qc = useQueryClient()
  const [amount, setAmount]           = useState('')
  const [categoryId, setCategoryId]   = useState('')
  const [description, setDescription] = useState('')
  const [paidTo, setPaidTo]           = useState('')
  const [occurredAt, setOccurredAt]   = useState(() => new Date().toISOString().slice(0, 10))
  const [receipt, setReceipt]         = useState(null)
  const [error, setError]             = useState(null)

  const { data: catsResp } = useQuery({
    queryKey: ['petty-cash', 'categories', kind],
    queryFn:  () => pettyCashApi.listCategories({ kind }),
  })
  const categories = catsResp?.data || []

  const mutation = useMutation({
    mutationFn: async () => {
      const amt = parseFloat(amount)
      if (!amt || amt <= 0) throw new Error('Captura un monto válido.')
      const paidToClean = paidTo.trim()
      if (kind === 'out' && !paidToClean) {
        throw new Error('Indica a quién se le entregó el dinero.')
      }
      const movement = await pettyCashApi.createMovement({
        fundId: fund.id, kind, amount: amt,
        categoryId: categoryId || null,
        description: description.trim() || null,
        paidTo: paidToClean || null,
        occurredAt,
      })
      if (receipt) {
        await pettyCashApi.uploadReceipt(movement.id, receipt)
      }
      return movement
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['petty-cash'] })
      onClose()
    },
    onError: (e) => setError(e.response?.data?.error || e.message || 'Error'),
  })

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}>
      <form onSubmit={e => { e.preventDefault(); setError(null); mutation.mutate() }}
        onClick={e => e.stopPropagation()}
        className="card w-full max-w-md p-6 flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold text-ink-primary">
              {kind === 'in' ? '+ Entrada a caja' : '− Salida de caja'}
            </h2>
            <p className="text-xs text-ink-muted mt-0.5">
              {fund.name} · Saldo actual: {fmtMXNf(fund.current_balance)}
            </p>
          </div>
          <button type="button" onClick={onClose} className="btn-ghost btn-icon text-ink-muted">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12"/>
            </svg>
          </button>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">Monto <span className="text-status-danger">*</span></label>
            <input type="number" step="0.01" min="0.01" className="input"
              inputMode="decimal" autoFocus
              value={amount} onChange={e => setAmount(e.target.value)} placeholder="0.00" />
          </div>
          <div>
            <label className="label">Fecha</label>
            <input type="date" className="input"
              value={occurredAt} onChange={e => setOccurredAt(e.target.value)} />
          </div>
        </div>

        <div>
          <label className="label">
            Categoría {categories.length === 0 && <span className="text-[10px] text-ink-muted">(sin categorías capturadas)</span>}
          </label>
          <select className="select" value={categoryId} onChange={e => setCategoryId(e.target.value)}>
            <option value="">— Sin categoría —</option>
            {categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>

        <div>
          <label className="label">
            {kind === 'out'
              ? <>Entregado a <span className="text-status-danger">*</span></>
              : <>Recibido de <span className="text-[10px] text-ink-muted">(opcional)</span></>}
          </label>
          <input type="text" className="input" maxLength={150}
            value={paidTo} onChange={e => setPaidTo(e.target.value)}
            placeholder={kind === 'out'
              ? 'Nombre del beneficiario (ej. Juan Pérez, Ferretería La Esquina)'
              : 'Quien repuso la caja (opcional)'} />
        </div>

        <div>
          <label className="label">Descripción</label>
          <textarea className="input" rows={2} value={description}
            onChange={e => setDescription(e.target.value)}
            placeholder={kind === 'in' ? 'Reabastecimiento, devolución, etc.' : 'Concepto del gasto'} />
        </div>

        <div>
          <label className="label">Comprobante <span className="text-[10px] text-ink-muted">(opcional · JPG/PNG/PDF, máx 5MB)</span></label>
          <input type="file" accept="image/jpeg,image/png,image/webp,application/pdf"
            onChange={e => setReceipt(e.target.files?.[0] || null)}
            className="text-xs" />
          {receipt && <p className="text-[10px] text-ink-muted mt-1">{receipt.name}</p>}
        </div>

        {error && <p className="field-error">{error}</p>}

        <div className="flex gap-2 pt-1">
          <button type="button" onClick={onClose} className="btn-secondary flex-1">Cancelar</button>
          <button type="submit" disabled={mutation.isPending}
            className={kind === 'in' ? 'btn-primary flex-1' : 'btn-danger flex-1'}>
            {mutation.isPending ? <Spinner size="sm" /> : 'Registrar'}
          </button>
        </div>
      </form>
    </div>,
    document.body
  )
}

// ── Modal de cancelación ──────────────────────────────────────────────────
function CancelMovementModal({ movement, onClose }) {
  const qc = useQueryClient()
  const [reason, setReason] = useState('')
  const [error, setError]   = useState(null)

  const mutation = useMutation({
    mutationFn: () => {
      if (!reason.trim()) throw new Error('El motivo es requerido.')
      return pettyCashApi.cancelMovement(movement.id, reason.trim())
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['petty-cash'] })
      onClose()
    },
    onError: (e) => setError(e.response?.data?.error || e.message || 'Error'),
  })

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}>
      <form onSubmit={e => { e.preventDefault(); setError(null); mutation.mutate() }}
        onClick={e => e.stopPropagation()}
        className="card w-full max-w-md p-6 flex flex-col gap-4">
        <h2 className="text-base font-semibold text-ink-primary">Cancelar movimiento</h2>
        <p className="text-sm text-ink-muted">
          {movement.kind === 'in' ? '+' : '−'} {fmtMXNf(movement.amount)} · {fmtDate(movement.occurred_at)}
          {movement.description && <span> · {movement.description}</span>}
        </p>
        <div className="bg-status-warning/10 border border-status-warning/30 rounded-md p-3 text-xs text-status-warning">
          ⚠ Esta acción no se puede deshacer. El movimiento queda con status "cancelado" y deja de contar para el saldo.
        </div>
        <div>
          <label className="label">Motivo de cancelación <span className="text-status-danger">*</span></label>
          <textarea className="input" rows={3} value={reason} autoFocus
            onChange={e => setReason(e.target.value)}
            placeholder="Ej. Error de captura, monto incorrecto, gasto no autorizado..." />
        </div>
        {error && <p className="field-error">{error}</p>}
        <div className="flex gap-2">
          <button type="button" onClick={onClose} className="btn-secondary flex-1">Volver</button>
          <button type="submit" disabled={mutation.isPending}
            className="btn-danger flex-1">
            {mutation.isPending ? <Spinner size="sm" /> : 'Cancelar movimiento'}
          </button>
        </div>
      </form>
    </div>,
    document.body
  )
}
