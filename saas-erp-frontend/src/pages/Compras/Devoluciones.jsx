import { useState } from 'react'
import { createPortal } from 'react-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { purchasesApi } from '@/api/purchases'
import { partnersApi } from '@/api/partners'
import Spinner from '@/components/ui/Spinner'
import Badge from '@/components/ui/Badge'
import Can from '@/components/auth/Can'
import { fmtDateOnly } from '@/utils/fmt'

const STATUS = {
  draft:     { label: 'Borrador',  variant: 'gray'  },
  confirmed: { label: 'Confirmada', variant: 'green' },
  cancelled: { label: 'Cancelada', variant: 'red'   },
}
const CREDIT = {
  pending:        { label: 'Crédito pendiente', variant: 'amber' },
  resolved:       { label: 'Crédito aplicado',  variant: 'green' },
  not_applicable: { label: 'Sin crédito',       variant: 'gray'  },
}
const money = (n) => `$${Number(n || 0).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

export default function Devoluciones() {
  const qc = useQueryClient()
  const [showNew, setShowNew] = useState(false)
  const [detailId, setDetailId] = useState(null)
  const [msg, setMsg] = useState(null)

  const { data: returns = [], isLoading } = useQuery({
    queryKey: ['supplier-returns'],
    queryFn: () => purchasesApi.listReturns(),
  })

  const flash = (m) => { setMsg(m); setTimeout(() => setMsg(null), 2500) }

  return (
    <div className="page-enter flex flex-col gap-6">
      <div className="page-header">
        <div>
          <h1 className="page-title">Devoluciones a proveedor</h1>
          <p className="page-subtitle">Devuelve material recibido y registra el crédito con el proveedor</p>
        </div>
        <Can do="purchases:return">
          <button onClick={() => setShowNew(true)} className="btn-primary">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4"/>
            </svg>
            Nueva devolución
          </button>
        </Can>
      </div>

      {msg && (
        <div className="bg-status-success/10 border border-status-success/40 rounded-xl px-4 py-3 text-sm text-status-success">
          {msg}
        </div>
      )}

      {isLoading ? (
        <div className="flex justify-center py-16"><Spinner /></div>
      ) : returns.length === 0 ? (
        <div className="empty-state">
          <p className="font-medium text-ink-secondary">Sin devoluciones registradas</p>
          <p className="text-sm text-ink-muted mt-1">Crea una devolución cuando regreses material a un proveedor.</p>
        </div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Folio</th><th>Proveedor</th><th>Fecha</th><th>Motivo</th>
                <th className="text-right">Total</th><th>Estado</th><th>Crédito</th>
              </tr>
            </thead>
            <tbody>
              {returns.map(r => (
                <tr key={r.id} className="cursor-pointer" onClick={() => setDetailId(r.id)}>
                  <td className="font-mono text-xs">{r.return_number}</td>
                  <td className="text-sm">{r.partner_name}</td>
                  <td className="text-sm text-ink-secondary">{fmtDateOnly(r.return_date)}</td>
                  <td className="text-sm text-ink-secondary">{r.reason_name || '—'}</td>
                  <td className="text-right font-mono text-sm">{money(r.total_mxn)}</td>
                  <td><Badge {...(STATUS[r.status] || STATUS.draft)} /></td>
                  <td><Badge {...(CREDIT[r.credit_status] || CREDIT.pending)} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showNew && (
        <NewReturnModal
          onClose={() => setShowNew(false)}
          onSaved={() => { qc.invalidateQueries({ queryKey: ['supplier-returns'] }); setShowNew(false); flash('Devolución creada en borrador.') }}
        />
      )}
      {detailId && (
        <ReturnDetailModal
          returnId={detailId}
          onClose={() => setDetailId(null)}
          onChanged={() => { qc.invalidateQueries({ queryKey: ['supplier-returns'] }); flash('Actualizada.') }}
        />
      )}
    </div>
  )
}

// ── Modal: nueva devolución ──────────────────────────────────────────────────
function NewReturnModal({ onClose, onSaved }) {
  const [partnerId, setPartnerId] = useState('')
  const [reasonId, setReasonId] = useState('')
  const [notes, setNotes] = useState('')
  const [lines, setLines] = useState([])  // { lotId, label, material, warehouseId, itemId, unitCost, remaining, quantity }
  const [error, setError] = useState(null)

  const { data: suppliers = [] } = useQuery({
    queryKey: ['partners', 'supplier'],
    queryFn: () => partnersApi.list({ role: 'supplier', limit: 200 }).then(r => r.data || r),
  })
  const { data: reasons = [] } = useQuery({
    queryKey: ['return-reasons'],
    queryFn: () => purchasesApi.listReturnReasons(),
  })
  const { data: lots = [] } = useQuery({
    queryKey: ['returnable-lots', partnerId],
    queryFn: () => purchasesApi.listReturnableLots(partnerId ? { partnerId } : {}),
    enabled: !!partnerId,
  })

  const availableLots = lots.filter(l => !lines.some(ln => ln.lotId === l.id))

  const addLot = (lot) => {
    setLines(p => [...p, {
      lotId: lot.id, label: `${lot.material_name} · ${lot.lot_number}`,
      itemId: lot.raw_material_id, warehouseId: lot.warehouse_id,
      unitCost: parseFloat(lot.unit_cost || 0), remaining: parseFloat(lot.quantity_remaining),
      unit: lot.material_unit || 'kg', quantity: '',
    }])
  }
  const setQty = (i, v) => setLines(p => p.map((l, idx) => idx === i ? { ...l, quantity: v } : l))
  const removeLine = (i) => setLines(p => p.filter((_, idx) => idx !== i))

  const total = lines.reduce((s, l) => s + (parseFloat(l.quantity) || 0) * l.unitCost, 0)

  const mut = useMutation({
    mutationFn: () => purchasesApi.createReturn({
      partnerId, reasonId: reasonId || null, notes: notes || null,
      lines: lines.map(l => ({
        itemType: 'raw_material', itemId: l.itemId, warehouseId: l.warehouseId,
        rawMaterialLotId: l.lotId, quantity: parseFloat(l.quantity), unit: l.unit, unitCost: l.unitCost,
      })),
    }),
    onSuccess: onSaved,
    onError: (e) => setError(e.response?.data?.error || 'No se pudo crear.'),
  })

  const canSave = partnerId && lines.length > 0 && lines.every(l => parseFloat(l.quantity) > 0 && parseFloat(l.quantity) <= l.remaining + 1e-6)

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40 p-4">
      <div className="card w-full max-w-2xl p-0 flex flex-col max-h-[92vh]">
        <div className="flex items-center justify-between px-5 py-4 border-b border-line-subtle shrink-0">
          <h2 className="text-base font-semibold text-ink-primary">Nueva devolución a proveedor</h2>
          <button onClick={onClose} className="btn-ghost btn-icon text-ink-muted">✕</button>
        </div>

        <div className="p-5 flex flex-col gap-4 overflow-y-auto min-h-0">
          {error && <div className="bg-status-danger/10 border border-status-danger/40 rounded-lg px-3 py-2 text-sm text-status-danger">{error}</div>}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="label">Proveedor *</label>
              <select className="select" value={partnerId} onChange={e => { setPartnerId(e.target.value); setLines([]) }}>
                <option value="">Seleccionar proveedor…</option>
                {suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
            <div>
              <label className="label">Motivo</label>
              <select className="select" value={reasonId} onChange={e => setReasonId(e.target.value)}>
                <option value="">Sin especificar</option>
                {reasons.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
              </select>
            </div>
          </div>

          {partnerId && (
            <div>
              <label className="label">Agregar lote a devolver</label>
              <select className="select" value="" onChange={e => { const lot = lots.find(l => l.id === e.target.value); if (lot) addLot(lot) }}>
                <option value="">{availableLots.length ? 'Elegir lote con saldo…' : 'Sin lotes disponibles de este proveedor'}</option>
                {availableLots.map(l => (
                  <option key={l.id} value={l.id}>
                    {l.material_name} · {l.lot_number} · saldo {parseFloat(l.quantity_remaining)} {l.material_unit} · {l.warehouse_name}
                  </option>
                ))}
              </select>
            </div>
          )}

          {lines.length > 0 && (
            <div className="flex flex-col gap-2">
              {lines.map((l, i) => (
                <div key={l.lotId} className="flex items-center gap-2 border border-line-subtle rounded-lg px-3 py-2">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-ink-primary truncate">{l.label}</p>
                    <p className="text-[11px] text-ink-muted">Saldo {l.remaining} {l.unit} · costo {money(l.unitCost)}/{l.unit}</p>
                  </div>
                  <input type="number" min={0} max={l.remaining} step="0.01" placeholder="Cantidad"
                    className="input w-28" value={l.quantity} onChange={e => setQty(i, e.target.value)} />
                  <button onClick={() => removeLine(i)} className="text-ink-muted hover:text-red-400" title="Quitar">✕</button>
                </div>
              ))}
              <div className="text-right text-sm font-semibold text-ink-primary">Total: {money(total)}</div>
            </div>
          )}

          <div>
            <label className="label">Notas (opcional)</label>
            <textarea className="input min-h-16 resize-y" value={notes} onChange={e => setNotes(e.target.value)}
              placeholder="Detalle de la devolución…" />
          </div>
        </div>

        <div className="flex items-center justify-end gap-3 px-5 py-4 border-t border-line-subtle shrink-0">
          <button onClick={onClose} className="btn-ghost btn-sm">Cancelar</button>
          <button onClick={() => mut.mutate()} disabled={!canSave || mut.isPending} className="btn-primary btn-sm">
            {mut.isPending ? <Spinner className="w-3 h-3" /> : null} Crear borrador
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}

// ── Modal: detalle + confirmar/cancelar ──────────────────────────────────────
function ReturnDetailModal({ returnId, onClose, onChanged }) {
  const qc = useQueryClient()
  const [error, setError] = useState(null)
  const { data: ret, isLoading } = useQuery({
    queryKey: ['supplier-return', returnId],
    queryFn: () => purchasesApi.getReturn(returnId),
  })

  const refresh = () => { qc.invalidateQueries({ queryKey: ['supplier-return', returnId] }); onChanged() }
  const confirmMut = useMutation({
    mutationFn: () => purchasesApi.confirmReturn(returnId),
    onSuccess: refresh, onError: (e) => setError(e.response?.data?.error || 'Error'),
  })
  const cancelMut = useMutation({
    mutationFn: () => purchasesApi.cancelReturn(returnId),
    onSuccess: refresh, onError: (e) => setError(e.response?.data?.error || 'Error'),
  })

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40 p-4">
      <div className="card w-full max-w-2xl p-0 flex flex-col max-h-[92vh]">
        <div className="flex items-center justify-between px-5 py-4 border-b border-line-subtle shrink-0">
          <h2 className="text-base font-semibold text-ink-primary">
            {ret ? `Devolución ${ret.return_number}` : 'Devolución'}
          </h2>
          <button onClick={onClose} className="btn-ghost btn-icon text-ink-muted">✕</button>
        </div>

        <div className="p-5 flex flex-col gap-3 overflow-y-auto min-h-0">
          {error && <div className="bg-status-danger/10 border border-status-danger/40 rounded-lg px-3 py-2 text-sm text-status-danger">{error}</div>}
          {isLoading || !ret ? <div className="flex justify-center py-8"><Spinner /></div> : (
            <>
              <div className="grid grid-cols-2 gap-3 text-sm">
                <div><span className="text-ink-muted">Proveedor:</span> {ret.partner_name}</div>
                <div><span className="text-ink-muted">Fecha:</span> {fmtDateOnly(ret.return_date)}</div>
                <div><span className="text-ink-muted">Motivo:</span> {ret.reason_name || '—'}</div>
                <div><span className="text-ink-muted">Estado:</span> <Badge {...(STATUS[ret.status] || STATUS.draft)} /></div>
              </div>
              {ret.notes && <p className="text-sm text-ink-secondary">{ret.notes}</p>}

              <div className="table-wrap">
                <table className="table">
                  <thead><tr><th>Artículo</th><th>Lote</th><th>Almacén</th><th className="text-right">Cant.</th><th className="text-right">Costo</th><th className="text-right">Subtotal</th></tr></thead>
                  <tbody>
                    {(ret.lines || []).map(l => (
                      <tr key={l.id}>
                        <td className="text-sm">{l.item_name}</td>
                        <td className="font-mono text-xs">{l.lot_number || '—'}</td>
                        <td className="text-sm text-ink-secondary">{l.warehouse_name}</td>
                        <td className="text-right font-mono text-sm">{parseFloat(l.quantity)} {l.unit}</td>
                        <td className="text-right font-mono text-sm">{money(l.unit_cost)}</td>
                        <td className="text-right font-mono text-sm">{money(l.subtotal)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="text-right text-sm font-semibold text-ink-primary">Total: {money(ret.total_mxn)}</div>

              <div className="text-xs text-ink-muted bg-surface-elevated/40 rounded-lg px-3 py-2">
                Crédito fiscal: <b>{(CREDIT[ret.credit_status] || CREDIT.pending).label}</b>. La nota de crédito,
                cancelación o sustitución del CFDI se registra en la Fase 2 (la emite el proveedor).
              </div>
            </>
          )}
        </div>

        <div className="flex items-center justify-end gap-3 px-5 py-4 border-t border-line-subtle shrink-0">
          {ret?.status === 'draft' && (
            <Can do="purchases:return">
              <button onClick={() => cancelMut.mutate()} disabled={cancelMut.isPending} className="btn-ghost btn-sm text-status-danger">Cancelar devolución</button>
              <button onClick={() => confirmMut.mutate()} disabled={confirmMut.isPending} className="btn-primary btn-sm">
                {confirmMut.isPending ? <Spinner className="w-3 h-3" /> : null} Confirmar (mueve inventario)
              </button>
            </Can>
          )}
          {ret?.status === 'confirmed' && (
            <Can do="purchases:return">
              <button onClick={() => { if (window.confirm('Cancelar y revertir el inventario de esta devolución?')) cancelMut.mutate() }}
                disabled={cancelMut.isPending} className="btn-secondary btn-sm text-status-danger">
                Cancelar (revertir inventario)
              </button>
            </Can>
          )}
          <button onClick={onClose} className="btn-ghost btn-sm">Cerrar</button>
        </div>
      </div>
    </div>,
    document.body
  )
}
