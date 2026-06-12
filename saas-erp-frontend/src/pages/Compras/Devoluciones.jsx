import { useState } from 'react'
import { createPortal } from 'react-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { purchasesApi } from '@/api/purchases'
import { partnersApi } from '@/api/partners'
import { useTableSort } from '@/hooks/useTableSort'
import { SortableHeader } from '@/components/ui/SortableHeader'
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
const FISCAL = {
  none:         'Sin resolver',
  credit_note:  'Nota de crédito',
  cancellation: 'Cancelación de CFDI',
  substitution: 'Sustitución de CFDI',
}
const money = (n) => `$${Number(n || 0).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

export default function Devoluciones() {
  const qc = useQueryClient()
  const [showNew, setShowNew] = useState(false)
  const [detailId, setDetailId] = useState(null)
  const [msg, setMsg] = useState(null)

  const { sortBy, sortDir, onSort } = useTableSort('fecha', 'desc')

  const { data: returns = [], isLoading } = useQuery({
    queryKey: ['supplier-returns', sortBy, sortDir],
    queryFn: () => purchasesApi.listReturns({ sortBy, sortDir }),
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
                <SortableHeader sortKey="folio" sortBy={sortBy} sortDir={sortDir} onSort={onSort}>Folio</SortableHeader>
                <SortableHeader sortKey="proveedor" sortBy={sortBy} sortDir={sortDir} onSort={onSort} initialDir="asc">Proveedor</SortableHeader>
                <SortableHeader sortKey="fecha" sortBy={sortBy} sortDir={sortDir} onSort={onSort}>Fecha</SortableHeader>
                <th>Motivo</th>
                <SortableHeader sortKey="total" sortBy={sortBy} sortDir={sortDir} onSort={onSort} align="right">Total</SortableHeader>
                <SortableHeader sortKey="estatus" sortBy={sortBy} sortDir={sortDir} onSort={onSort} initialDir="asc">Estado</SortableHeader><th>Crédito</th>
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
                  <td>
                    <Badge {...(CREDIT[r.credit_status] || CREDIT.pending)} />
                    {r.credit_status === 'resolved' && r.fiscal_resolution !== 'none' && (
                      <div className="text-[11px] text-ink-muted mt-0.5">{FISCAL[r.fiscal_resolution]}</div>
                    )}
                  </td>
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

              {/* Resolución fiscal (Fase 2) */}
              {ret.credit_status === 'resolved' ? (
                <FiscalResolutionSummary ret={ret} />
              ) : ret.status === 'confirmed' ? (
                <FiscalResolutionForm ret={ret} onResolved={() => { setError(null); refresh() }} onError={setError} />
              ) : (
                <div className="text-xs text-ink-muted bg-surface-elevated/40 rounded-lg px-3 py-2">
                  Crédito fiscal: <b>{(CREDIT[ret.credit_status] || CREDIT.pending).label}</b>. Confirma la
                  devolución para registrar la resolución fiscal del CFDI (nota de crédito, cancelación o
                  sustitución que emite el proveedor).
                </div>
              )}
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

// ── Resumen de resolución fiscal (solo lectura, cuando ya está resuelta) ──────
function FiscalResolutionSummary({ ret }) {
  return (
    <div className="rounded-lg border border-status-success/30 bg-status-success/5 px-3 py-2.5 text-sm flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <span className="text-ink-muted">Resolución fiscal:</span>
        <b className="text-ink-primary">{FISCAL[ret.fiscal_resolution] || '—'}</b>
      </div>
      {ret.fiscal_resolution === 'credit_note' && ret.credit_note_number && (
        <div className="text-xs text-ink-secondary">
          Nota de crédito <b>{ret.credit_note_number}</b>
          {ret.credit_note_uuid ? <> · UUID <span className="font-mono">{ret.credit_note_uuid}</span></> : null}
          {ret.source_invoice_number ? <> · aplicada a la factura <b>{ret.source_invoice_number}</b></> : null}
        </div>
      )}
      {ret.fiscal_resolution === 'cancellation' && ret.cancelled_invoice_number && (
        <div className="text-xs text-ink-secondary">Se canceló el CFDI <b>{ret.cancelled_invoice_number}</b>.</div>
      )}
      {ret.fiscal_resolution === 'substitution' && (
        <div className="text-xs text-ink-secondary">
          El CFDI <b>{ret.cancelled_invoice_number}</b> se sustituyó por <b>{ret.substitute_invoice_number}</b>.
        </div>
      )}
    </div>
  )
}

// ── Formulario de resolución fiscal (devolución confirmada, crédito pendiente) ─
function FiscalResolutionForm({ ret, onResolved, onError }) {
  const [resolution, setResolution] = useState('credit_note')
  const [supplierInvoiceId, setSupplierInvoiceId] = useState(ret.supplier_invoice_id || '')
  const [cn, setCn] = useState({ invoiceNumber: '', uuidSat: '', folio: '', invoiceDate: '', subtotal: '', tax: '', total: '' })
  const [sub, setSub] = useState({ invoiceNumber: '', uuidSat: '', invoiceDate: '', subtotal: '', tax: '', total: '' })

  const { data: invoices = [] } = useQuery({
    queryKey: ['supplier-invoices', ret.partner_id],
    queryFn: () => purchasesApi.listInvoices({ supplierId: ret.partner_id, limit: 100 }),
    select: (r) => (r?.data || []).filter(i => i.status !== 'cancelled'),
    enabled: !!ret.partner_id,
  })

  const selected = invoices.find(i => i.id === supplierInvoiceId)
  const cnTotal = parseFloat(cn.total) || 0
  const pending = selected ? parseFloat(selected.ap_amount_pending || 0) : 0
  const reduces = Math.min(cnTotal, pending)
  const toAdvance = Math.max(0, cnTotal - reduces)

  const mut = useMutation({
    mutationFn: () => {
      const body = { resolution, supplierInvoiceId }
      if (resolution === 'credit_note') {
        body.creditNote = {
          invoiceNumber: cn.invoiceNumber || null, uuidSat: cn.uuidSat || null, folio: cn.folio || null,
          invoiceDate: cn.invoiceDate || null,
          subtotal: cn.subtotal === '' ? null : parseFloat(cn.subtotal),
          tax: cn.tax === '' ? 0 : parseFloat(cn.tax),
          total: parseFloat(cn.total),
        }
      } else if (resolution === 'substitution') {
        body.substitute = {
          invoiceNumber: sub.invoiceNumber, uuidSat: sub.uuidSat || null, invoiceDate: sub.invoiceDate || null,
          subtotal: sub.subtotal === '' ? null : parseFloat(sub.subtotal),
          tax: sub.tax === '' ? 0 : parseFloat(sub.tax),
          total: parseFloat(sub.total),
        }
      }
      return purchasesApi.resolveReturn(ret.id, body)
    },
    onSuccess: onResolved,
    onError: (e) => onError?.(e.response?.data?.error || 'No se pudo registrar la resolución.'),
  })

  const canResolve = supplierInvoiceId &&
    (resolution === 'cancellation' ||
     (resolution === 'credit_note' && cnTotal > 0) ||
     (resolution === 'substitution' && sub.invoiceNumber && parseFloat(sub.total) > 0))

  const numInput = (val, set, ph) => (
    <input type="number" min={0} step="0.01" placeholder={ph} className="input" value={val} onChange={e => set(e.target.value)} />
  )

  return (
    <div className="rounded-lg border border-line-subtle bg-surface-elevated/40 px-3 py-3 flex flex-col gap-3">
      <p className="text-sm font-semibold text-ink-primary">Resolución fiscal del CFDI</p>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className="label">Vía</label>
          <select className="select" value={resolution} onChange={e => setResolution(e.target.value)}>
            <option value="credit_note">Nota de crédito (CFDI de egreso)</option>
            <option value="cancellation">Cancelación del CFDI</option>
            <option value="substitution">Sustitución del CFDI</option>
          </select>
        </div>
        <div>
          <label className="label">Factura del proveedor *</label>
          <select className="select" value={supplierInvoiceId} onChange={e => setSupplierInvoiceId(e.target.value)}>
            <option value="">Seleccionar factura…</option>
            {invoices.map(i => (
              <option key={i.id} value={i.id}>
                {i.invoice_number} · {money(i.total_mxn)} · saldo {money(i.ap_amount_pending || 0)}
              </option>
            ))}
          </select>
        </div>
      </div>

      {resolution === 'credit_note' && (
        <div className="flex flex-col gap-2">
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            <div><label className="label">Folio NC</label><input className="input" placeholder="NC-123" value={cn.invoiceNumber} onChange={e => setCn(p => ({ ...p, invoiceNumber: e.target.value }))} /></div>
            <div><label className="label">Fecha</label><input type="date" className="input" value={cn.invoiceDate} onChange={e => setCn(p => ({ ...p, invoiceDate: e.target.value }))} /></div>
            <div className="col-span-2 sm:col-span-1"><label className="label">UUID SAT</label><input className="input" placeholder="(opcional)" value={cn.uuidSat} onChange={e => setCn(p => ({ ...p, uuidSat: e.target.value }))} /></div>
          </div>
          <div className="grid grid-cols-3 gap-2">
            <div><label className="label">Subtotal</label>{numInput(cn.subtotal, v => setCn(p => ({ ...p, subtotal: v })), '0.00')}</div>
            <div><label className="label">IVA</label>{numInput(cn.tax, v => setCn(p => ({ ...p, tax: v })), '0.00')}</div>
            <div><label className="label">Total *</label>{numInput(cn.total, v => setCn(p => ({ ...p, total: v })), '0.00')}</div>
          </div>
          {selected && cnTotal > 0 && (
            <p className="text-xs text-ink-muted">
              Reduce la cuenta por pagar en <b>{money(reduces)}</b>
              {toAdvance > 0.005 ? <> y deja <b>{money(toAdvance)}</b> como saldo a favor del proveedor.</> : '.'}
            </p>
          )}
        </div>
      )}

      {resolution === 'cancellation' && (
        <p className="text-xs text-ink-muted">
          Anula la factura seleccionada y su cuenta por pagar. Si ya la habías pagado, lo pagado queda como
          saldo a favor del proveedor.
        </p>
      )}

      {resolution === 'substitution' && (
        <div className="flex flex-col gap-2">
          <p className="text-xs text-ink-muted">Cancela la factura seleccionada y registra la nueva que la sustituye.</p>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            <div><label className="label">Folio nueva *</label><input className="input" placeholder="F-124" value={sub.invoiceNumber} onChange={e => setSub(p => ({ ...p, invoiceNumber: e.target.value }))} /></div>
            <div><label className="label">Fecha</label><input type="date" className="input" value={sub.invoiceDate} onChange={e => setSub(p => ({ ...p, invoiceDate: e.target.value }))} /></div>
            <div className="col-span-2 sm:col-span-1"><label className="label">UUID SAT</label><input className="input" placeholder="(opcional)" value={sub.uuidSat} onChange={e => setSub(p => ({ ...p, uuidSat: e.target.value }))} /></div>
          </div>
          <div className="grid grid-cols-3 gap-2">
            <div><label className="label">Subtotal</label>{numInput(sub.subtotal, v => setSub(p => ({ ...p, subtotal: v })), '0.00')}</div>
            <div><label className="label">IVA</label>{numInput(sub.tax, v => setSub(p => ({ ...p, tax: v })), '0.00')}</div>
            <div><label className="label">Total *</label>{numInput(sub.total, v => setSub(p => ({ ...p, total: v })), '0.00')}</div>
          </div>
        </div>
      )}

      <div className="flex justify-end">
        <button onClick={() => mut.mutate()} disabled={!canResolve || mut.isPending} className="btn-primary btn-sm">
          {mut.isPending ? <Spinner className="w-3 h-3" /> : null} Registrar resolución
        </button>
      </div>
    </div>
  )
}
