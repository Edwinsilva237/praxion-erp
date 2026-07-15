import { useState, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { salesApi } from '@/api/sales'
import Autocomplete from '@/components/ui/Autocomplete'
import Spinner from '@/components/ui/Spinner'
import Badge from '@/components/ui/Badge'
import Can from '@/components/auth/Can'
import { fmtDateOnly, fmtMXN } from '@/utils/fmt'

const STATUS = {
  draft:     { label: 'Borrador',   variant: 'gray'  },
  confirmed: { label: 'Confirmada', variant: 'green' },
  cancelled: { label: 'Cancelada',  variant: 'red'   },
}
const CREDIT = {
  pending:        { label: 'NC por emitir',  variant: 'amber' },
  resolved:       { label: 'NC emitida',     variant: 'green' },
  not_applicable: { label: 'Sin factura',    variant: 'gray'  },
}

export default function DevolucionesVenta() {
  const qc = useQueryClient()
  const [showNew, setShowNew] = useState(false)
  const [detailId, setDetailId] = useState(null)
  const [msg, setMsg] = useState(null)
  const flash = (m) => { setMsg(m); setTimeout(() => setMsg(null), 2500) }

  const { data: returns = [], isLoading } = useQuery({
    queryKey: ['sales-returns'],
    queryFn: () => salesApi.listReturns(),
  })

  return (
    <div className="page-enter flex flex-col gap-6">
      <div className="page-header flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="page-title text-xl font-semibold text-ink-primary">Devoluciones de venta</h1>
          <p className="page-subtitle text-xs text-ink-muted mt-0.5">
            El cliente regresa mercancía ya entregada. Reingresa inventario y ajusta la CXC o emite nota de crédito.
          </p>
        </div>
        <Can do="sales:return">
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
        <div className="flex flex-col items-center gap-1 py-16 text-center">
          <p className="font-medium text-ink-secondary">Sin devoluciones registradas</p>
          <p className="text-sm text-ink-muted">Crea una devolución cuando el cliente regrese mercancía entregada.</p>
        </div>
      ) : (
        <div className="card p-0 overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th>Folio</th><th>Cliente</th><th>Remisión</th><th>Factura</th>
                <th>Fecha</th><th className="text-right">Total</th><th>Estado</th><th>Crédito</th>
              </tr>
            </thead>
            <tbody>
              {returns.map(r => (
                <tr key={r.id} className="cursor-pointer hover:bg-surface-elevated/40" onClick={() => setDetailId(r.id)}>
                  <td className="font-mono text-xs text-brand-300">{r.return_number}</td>
                  <td className="text-sm">{r.partner_name}</td>
                  <td className="font-mono text-xs text-ink-secondary">{r.delivery_note_number || '—'}</td>
                  <td className="font-mono text-xs text-ink-secondary">{r.invoice_number || '—'}</td>
                  <td className="text-sm text-ink-secondary">{fmtDateOnly(r.return_date)}</td>
                  <td className="text-right font-mono text-sm">{fmtMXN(r.total_mxn)}</td>
                  <td><Badge {...(STATUS[r.status] || STATUS.draft)} /></td>
                  <td><Badge {...(CREDIT[r.credit_status] || CREDIT.not_applicable)} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showNew && (
        <NewReturnModal
          onClose={() => setShowNew(false)}
          onSaved={() => { qc.invalidateQueries({ queryKey: ['sales-returns'] }); setShowNew(false); flash('Devolución creada en borrador.') }}
        />
      )}
      {detailId && (
        <ReturnDetailModal
          returnId={detailId}
          onClose={() => setDetailId(null)}
          onChanged={() => { qc.invalidateQueries({ queryKey: ['sales-returns'] }) }}
          flash={flash}
        />
      )}
    </div>
  )
}

// ── Modal: nueva devolución ──────────────────────────────────────────────────
function NewReturnModal({ onClose, onSaved }) {
  const [note, setNote] = useState(null)     // { id, label }
  const [notes, setNotes] = useState('')
  const [qty, setQty] = useState({})         // { [dnlId]: string }
  const [error, setError] = useState(null)

  const { data: returnable } = useQuery({
    queryKey: ['returnable', note?.id],
    queryFn: () => salesApi.getReturnable(note.id),
    enabled: !!note?.id,
  })
  const lines = returnable?.lines || []
  const invoice = returnable?.invoice || null

  // Buscar remisiones ENTREGADAS por folio/cliente.
  const searchNotes = useCallback(async (q) => {
    const res = await salesApi.listDeliveryNotes({ search: q, limit: 20 })
    return (res.data || res)
      .filter(n => ['delivered', 'partially_delivered', 'invoiced'].includes(n.status))
      .map(n => ({ id: n.id, label: `${n.document_number} · ${n.partner_name}`, sub: n.status }))
  }, [])

  const mut = useMutation({
    mutationFn: () => {
      const payload = lines
        .filter(l => parseFloat(qty[l.delivery_note_line_id]) > 0)
        .map(l => ({ deliveryNoteLineId: l.delivery_note_line_id, quantity: parseFloat(qty[l.delivery_note_line_id]) }))
      if (!payload.length) throw new Error('Captura al menos una cantidad a devolver.')
      return salesApi.createReturn({ deliveryNoteId: note.id, notes: notes || null, lines: payload })
    },
    onSuccess: onSaved,
    onError: (e) => setError(e.response?.data?.error || e.message || 'No se pudo crear.'),
  })

  const total = lines.reduce((s, l) => {
    const q = parseFloat(qty[l.delivery_note_line_id]) || 0
    return s + q * parseFloat(l.unit_price) * (1 - parseFloat(l.discount_pct || 0) / 100)
  }, 0)

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40 p-4">
      <div className="card w-full max-w-2xl p-0 flex flex-col max-h-[92vh]">
        <div className="flex items-center justify-between px-5 py-4 border-b border-line-subtle shrink-0">
          <h2 className="text-base font-semibold text-ink-primary">Nueva devolución de venta</h2>
          <button onClick={onClose} className="btn-ghost btn-icon text-ink-muted">✕</button>
        </div>

        <div className="p-5 flex flex-col gap-4 overflow-y-auto min-h-0">
          {error && <div className="bg-status-danger/10 border border-status-danger/40 rounded-lg px-3 py-2 text-sm text-status-danger">{error}</div>}

          <div>
            <label className="label">Remisión entregada</label>
            <Autocomplete value={note} onChange={setNote} onSearch={searchNotes}
              placeholder="Busca por folio o cliente..." />
          </div>

          {note && (
            <>
              {invoice ? (
                <div className="bg-status-info/10 border border-status-info/40 rounded-lg px-3 py-2 text-xs text-status-info">
                  Con factura <span className="font-mono">{invoice.document_number}</span>: al confirmar se reingresa
                  inventario; luego podrás <strong>emitir la nota de crédito</strong> que baja la CXC de la factura.
                </div>
              ) : (
                <div className="bg-surface-elevated/40 border border-line-subtle rounded-lg px-3 py-2 text-xs text-ink-secondary">
                  Sin factura: al confirmar se reingresa inventario y se <strong>reduce la CXC de la remisión</strong>.
                </div>
              )}

              <div className="border border-line-subtle rounded-lg overflow-hidden">
                <table className="table">
                  <thead>
                    <tr><th>Producto</th><th className="text-right">Entregado</th><th className="text-right">Devolvible</th><th className="text-right">A devolver</th></tr>
                  </thead>
                  <tbody>
                    {lines.map(l => (
                      <tr key={l.delivery_note_line_id}>
                        <td>
                          <p className="text-sm text-ink-primary">{l.product_name}</p>
                          {l.sku && <p className="text-[10px] text-ink-muted font-mono">{l.sku}</p>}
                        </td>
                        <td className="text-right font-mono text-xs text-ink-secondary">{parseFloat(l.quantity_delivered)} {l.unit}</td>
                        <td className="text-right font-mono text-xs">{l.returnable} {l.unit}</td>
                        <td className="text-right">
                          <input type="number" min="0" max={l.returnable} step="any"
                            className="input w-24 text-right text-sm"
                            disabled={l.returnable <= 0}
                            value={qty[l.delivery_note_line_id] || ''}
                            onChange={e => setQty(m => ({ ...m, [l.delivery_note_line_id]: e.target.value }))} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div>
                <label className="label">Motivo / notas (opcional)</label>
                <input className="input" value={notes} onChange={e => setNotes(e.target.value)}
                  placeholder="Ej: producto dañado, no cumple calidad..." />
              </div>
            </>
          )}
        </div>

        <div className="flex items-center justify-between gap-3 px-5 py-4 border-t border-line-subtle shrink-0">
          <span className="text-sm text-ink-secondary">Total: <span className="font-mono font-semibold text-ink-primary">{fmtMXN(total)}</span></span>
          <div className="flex gap-2">
            <button onClick={onClose} className="btn-secondary" disabled={mut.isPending}>Cancelar</button>
            <button onClick={() => mut.mutate()} className="btn-primary" disabled={mut.isPending || !note}>
              {mut.isPending ? <Spinner size="sm" /> : 'Crear devolución'}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  )
}

// ── Modal: detalle + acciones ────────────────────────────────────────────────
function ReturnDetailModal({ returnId, onClose, onChanged, flash }) {
  const qc = useQueryClient()
  const [error, setError] = useState(null)
  const { data: ret, isLoading } = useQuery({
    queryKey: ['sales-return', returnId],
    queryFn: () => salesApi.getReturn(returnId),
  })

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['sales-return', returnId] })
    onChanged?.()
  }
  const mkOpts = (okMsg) => ({
    onSuccess: () => { refresh(); flash?.(okMsg) },
    onError: (e) => setError(e.response?.data?.error || 'No se pudo completar.'),
  })
  const confirmMut = useMutation({ mutationFn: () => salesApi.confirmReturn(returnId), ...mkOpts('Devolución confirmada — inventario reingresado.') })
  const ncMut      = useMutation({ mutationFn: () => salesApi.emitReturnCreditNote(returnId), ...mkOpts('Nota de crédito emitida.') })
  const cancelMut  = useMutation({ mutationFn: () => salesApi.cancelReturn(returnId), ...mkOpts('Devolución cancelada.') })

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40 p-4">
      <div className="card w-full max-w-xl p-0 flex flex-col max-h-[92vh]">
        <div className="flex items-center justify-between px-5 py-4 border-b border-line-subtle shrink-0">
          <h2 className="text-base font-semibold text-ink-primary">
            Devolución {ret?.return_number || ''}
          </h2>
          <button onClick={onClose} className="btn-ghost btn-icon text-ink-muted">✕</button>
        </div>

        {isLoading || !ret ? (
          <div className="flex justify-center py-16"><Spinner /></div>
        ) : (
          <>
            <div className="p-5 flex flex-col gap-3 overflow-y-auto min-h-0">
              {error && <div className="bg-status-danger/10 border border-status-danger/40 rounded-lg px-3 py-2 text-sm text-status-danger">{error}</div>}
              <div className="grid grid-cols-2 gap-3 text-sm">
                <div><span className="text-ink-muted text-xs">Cliente</span><p>{ret.partner_name}</p></div>
                <div><span className="text-ink-muted text-xs">Remisión</span><p className="font-mono">{ret.delivery_note_number || '—'}</p></div>
                <div><span className="text-ink-muted text-xs">Factura</span><p className="font-mono">{ret.invoice_number || 'Sin factura'}</p></div>
                <div><span className="text-ink-muted text-xs">Estado</span><p><Badge {...(STATUS[ret.status] || STATUS.draft)} /></p></div>
                <div><span className="text-ink-muted text-xs">Crédito</span><p><Badge {...(CREDIT[ret.credit_status] || CREDIT.not_applicable)} /></p></div>
                {ret.credit_note_number && (
                  <div><span className="text-ink-muted text-xs">Nota de crédito</span><p className="font-mono">{ret.credit_note_number}</p></div>
                )}
              </div>
              {ret.notes && <p className="text-xs text-ink-muted italic">{ret.notes}</p>}

              <div className="border border-line-subtle rounded-lg overflow-hidden mt-1">
                <table className="table">
                  <thead><tr><th>Producto</th><th className="text-right">Cantidad</th><th className="text-right">Importe</th></tr></thead>
                  <tbody>
                    {(ret.lines || []).map(l => (
                      <tr key={l.id}>
                        <td className="text-sm">{l.product_name}<span className="text-[10px] text-ink-muted font-mono block">{l.sku}</span></td>
                        <td className="text-right font-mono text-sm">{parseFloat(l.quantity)} {l.unit}</td>
                        <td className="text-right font-mono text-sm">{fmtMXN(l.subtotal)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="flex justify-between text-sm font-semibold">
                <span>Total</span><span className="font-mono text-brand-300">{fmtMXN(ret.total_mxn)}</span>
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-line-subtle shrink-0">
              {ret.status === 'draft' && (
                <Can do="sales:return">
                  <button onClick={() => confirmMut.mutate()} className="btn-primary" disabled={confirmMut.isPending}>
                    {confirmMut.isPending ? <Spinner size="sm" /> : 'Confirmar (reingresar inventario)'}
                  </button>
                </Can>
              )}
              {ret.status === 'confirmed' && ret.source_invoice_id && ret.credit_status === 'pending' && (
                <Can do="sales:return">
                  <button onClick={() => ncMut.mutate()} className="btn-primary" disabled={ncMut.isPending}>
                    {ncMut.isPending ? <Spinner size="sm" /> : 'Emitir nota de crédito'}
                  </button>
                </Can>
              )}
              {ret.status !== 'cancelled' && ret.credit_status !== 'resolved' && (
                <Can do="sales:return">
                  <button onClick={() => cancelMut.mutate()} className="btn-secondary text-status-danger" disabled={cancelMut.isPending}>
                    {cancelMut.isPending ? <Spinner size="sm" /> : 'Cancelar devolución'}
                  </button>
                </Can>
              )}
            </div>
          </>
        )}
      </div>
    </div>,
    document.body
  )
}
