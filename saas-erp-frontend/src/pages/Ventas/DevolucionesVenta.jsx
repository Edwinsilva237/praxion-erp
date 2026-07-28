import { useState, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { salesApi } from '@/api/sales'
import { partnersApi } from '@/api/partners'
import { productsApi } from '@/api/products'
import Autocomplete from '@/components/ui/Autocomplete'
import Spinner from '@/components/ui/Spinner'
import Badge from '@/components/ui/Badge'
import Can from '@/components/auth/Can'
import SatCatalogSelect from '@/components/fiscal/SatCatalogSelect'
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

// "hace N días" — para reconocer la venta sin hacer cuentas mentales.
function daysAgoLabel(d) {
  if (!d) return ''
  const n = Math.floor((Date.now() - new Date(d).getTime()) / 86400000)
  if (n <= 0) return 'hoy'
  return n === 1 ? 'hace 1 día' : `hace ${n} días`
}

const summarizeProducts = (products) =>
  (products || []).map(p => `${parseFloat(p.qty)} ${p.name}`).join(' · ')

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
  const [partner, setPartner] = useState(null)   // { id, label } — cliente
  const [product, setProduct] = useState(null)   // { id, label } — filtro opcional
  const [note, setNote] = useState(null)         // { id, label } — remisión elegida
  const [reasonId, setReasonId] = useState('')
  const [notes, setNotes] = useState('')
  const [qty, setQty] = useState({})             // { [dnlId]: string }
  const [error, setError] = useState(null)

  const { data: returnable } = useQuery({
    queryKey: ['returnable', note?.id],
    queryFn: () => salesApi.getReturnable(note.id),
    enabled: !!note?.id,
  })
  const lines = returnable?.lines || []
  const invoice = returnable?.invoice || null

  // Últimas ventas ENTREGADAS del cliente (acotadas al producto si se eligió):
  // el caso real es "el cliente X me regresó tal producto, no sé de qué remisión
  // salió" — la lista identifica la venta sin conocer el folio.
  const { data: candidates = [], isFetching: searching } = useQuery({
    queryKey: ['return-candidates', partner?.id, product?.id],
    queryFn: () => salesApi.listReturnCandidates({
      partnerId: partner.id, productId: product?.id || undefined,
    }),
    enabled: !!partner?.id && !note,
  })

  const { data: reasons = [] } = useQuery({
    queryKey: ['return-reasons'],
    queryFn: () => salesApi.listReturnReasons(),
    staleTime: 5 * 60 * 1000,
  })

  const searchPartners = useCallback(async (q) => {
    const res = await partnersApi.list({ search: q, role: 'customer', limit: 20 })
    return (res.data || res).map(p => ({ id: p.id, label: p.name, sub: p.rfc || '' }))
  }, [])

  const searchProducts = useCallback(async (q) => {
    const res = await productsApi.list({ search: q, limit: 20 })
    return (res.data || res).map(p => ({ id: p.id, label: p.name, sub: p.sku || '' }))
  }, [])

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
      return salesApi.createReturn({
        deliveryNoteId: note.id, reasonId: reasonId || null,
        notes: notes || null, lines: payload,
      })
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

          {!note ? (
            <>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="label">Cliente</label>
                  <Autocomplete value={partner} onChange={setPartner} onSearch={searchPartners}
                    placeholder="Busca el cliente..." />
                </div>
                <div>
                  <label className="label">Producto (opcional)</label>
                  <Autocomplete value={product} onChange={setProduct} onSearch={searchProducts}
                    placeholder="Acota por producto devuelto..." disabled={!partner} />
                </div>
              </div>

              {partner && (
                <div className="border border-line-subtle rounded-lg overflow-hidden">
                  <div className="px-3 py-2 bg-surface-elevated/40 text-xs font-medium text-ink-secondary border-b border-line-subtle">
                    Últimas ventas entregadas de {partner.label}{product ? ` con ${product.label}` : ''}
                  </div>
                  {searching ? (
                    <div className="flex justify-center py-6"><Spinner size="sm" /></div>
                  ) : candidates.length === 0 ? (
                    <p className="px-3 py-4 text-sm text-ink-muted">
                      Este cliente no tiene remisiones entregadas{product ? ' con ese producto' : ''}.
                    </p>
                  ) : (
                    <ul className="divide-y divide-line-subtle max-h-72 overflow-y-auto">
                      {candidates.map(c => {
                        const exhausted = !!product && c.product_returnable != null
                          && parseFloat(c.product_returnable) <= 0
                        return (
                          <li key={c.id}>
                            <button type="button" disabled={exhausted}
                              onClick={() => setNote({ id: c.id, label: c.document_number })}
                              className="w-full text-left px-3 py-2.5 hover:bg-surface-elevated/40 disabled:opacity-45 disabled:cursor-not-allowed flex flex-col gap-1">
                              <div className="flex items-center justify-between gap-2">
                                <span className="font-mono text-xs text-brand-300">{c.document_number}</span>
                                <span className="text-[11px] text-ink-muted shrink-0">
                                  {fmtDateOnly(c.sale_date)} · {daysAgoLabel(c.sale_date)}
                                </span>
                              </div>
                              <div className="flex items-center justify-between gap-2">
                                <span className="text-xs text-ink-secondary truncate">{summarizeProducts(c.products)}</span>
                                <span className="font-mono text-xs shrink-0">{fmtMXN(c.total_amount)}</span>
                              </div>
                              <div className="flex items-center gap-2">
                                <Badge variant={c.has_invoice ? 'blue' : 'gray'}
                                  label={c.has_invoice ? 'Con factura' : 'Sin factura'} />
                                {product && c.product_returnable != null && (
                                  exhausted
                                    ? <Badge variant="red" label="Ya devuelto por completo" />
                                    : <span className="text-[11px] text-ink-muted">
                                        Devolvible: {parseFloat(c.product_returnable)} {c.product_unit || ''}
                                      </span>
                                )}
                              </div>
                            </button>
                          </li>
                        )
                      })}
                    </ul>
                  )}
                </div>
              )}

              <div>
                <label className="label">¿Conoces el folio? Búscalo directo</label>
                <Autocomplete value={note} onChange={setNote} onSearch={searchNotes}
                  placeholder="Busca por folio o cliente..." />
              </div>
            </>
          ) : (
            <div className="flex items-center justify-between gap-2 bg-surface-elevated/40 border border-line-subtle rounded-lg px-3 py-2">
              <p className="text-sm text-ink-primary">
                Remisión <span className="font-mono text-brand-300">{note.label}</span>
              </p>
              <button type="button" className="btn-ghost text-xs"
                onClick={() => { setNote(null); setQty({}) }}>
                Cambiar
              </button>
            </div>
          )}

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
                    {lines.map(l => {
                      // Si se llegó filtrando por producto, esa línea viene resaltada
                      // y con el cursor listo para capturar.
                      const isSearched = !!product && l.product_id === product.id
                      return (
                        <tr key={l.delivery_note_line_id} className={isSearched ? 'bg-brand-500/5' : undefined}>
                          <td>
                            <p className={`text-sm ${isSearched ? 'text-brand-300 font-medium' : 'text-ink-primary'}`}>{l.product_name}</p>
                            {l.sku && <p className="text-[10px] text-ink-muted font-mono">{l.sku}</p>}
                          </td>
                          <td className="text-right font-mono text-xs text-ink-secondary">{parseFloat(l.quantity_delivered)} {l.unit}</td>
                          <td className="text-right font-mono text-xs">{l.returnable} {l.unit}</td>
                          <td className="text-right">
                            <input type="number" min="0" max={l.returnable} step="any"
                              className="input w-24 text-right text-sm"
                              disabled={l.returnable <= 0}
                              autoFocus={isSearched && l.returnable > 0}
                              value={qty[l.delivery_note_line_id] || ''}
                              onChange={e => setQty(m => ({ ...m, [l.delivery_note_line_id]: e.target.value }))} />
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="label">Motivo</label>
                  <select className="input" value={reasonId} onChange={e => setReasonId(e.target.value)}>
                    <option value="">— Sin especificar —</option>
                    {reasons.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
                  </select>
                </div>
                <div>
                  <label className="label">Notas (opcional)</label>
                  <input className="input" value={notes} onChange={e => setNotes(e.target.value)}
                    placeholder="Ej: caja dañada en el flete..." />
                </div>
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
  const [showNcForm, setShowNcForm] = useState(false)
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
  const ncMut      = useMutation({
    mutationFn: (body) => salesApi.emitReturnCreditNote(returnId, body),
    onSuccess: () => { setShowNcForm(false); refresh(); flash?.('Nota de crédito emitida.') },
    onError: (e) => setError(e.response?.data?.error || 'No se pudo emitir la nota de crédito.'),
  })
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
                {ret.reason_name && (
                  <div><span className="text-ink-muted text-xs">Motivo</span><p>{ret.reason_name}</p></div>
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
                  <button onClick={() => { setError(null); setShowNcForm(true) }}
                    className="btn-primary" disabled={ncMut.isPending}>
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

            {showNcForm && (
              <NcPreviewModal
                ret={ret}
                loading={ncMut.isPending}
                onConfirm={(body) => ncMut.mutate(body)}
                onClose={() => setShowNcForm(false)}
              />
            )}
          </>
        )}
      </div>
    </div>,
    document.body
  )
}

// ── Modal: validar la NC ANTES de timbrar ────────────────────────────────────
// Precargado con los defaults correctos (monto de la devolución, uso CFDI G02
// de egresos, forma de pago 03, IVA 16%, relación SAT 01) — todo editable.
const USO_CFDI_OPTS = [
  ['G02', 'G02 — Devoluciones, descuentos o bonificaciones'],
  ['G01', 'G01 — Adquisición de mercancías'],
  ['S01', 'S01 — Sin efectos fiscales'],
]
const RELACION_OPTS = [
  ['01', '01 — Nota de crédito de los documentos relacionados'],
  ['03', '03 — Devolución de mercancía sobre facturas previas'],
]
const IVA_OPTS = [16, 8, 0]

function NcPreviewModal({ ret, loading, onConfirm, onClose }) {
  const [amount, setAmount]           = useState(String(parseFloat(ret.total_mxn)))
  const [taxRate, setTaxRate]         = useState(16)
  const [description, setDescription] = useState(`Devolución de venta ${ret.return_number}`)
  const [paymentForm, setPaymentForm] = useState('03')
  const [useCfdi, setUseCfdi]         = useState('G02')
  const [relationship, setRelationship] = useState('01')

  const numAmount = parseFloat(amount) || 0
  const tax   = numAmount * (taxRate / 100)
  const total = numAmount + tax
  const amountChanged = Math.abs(numAmount - parseFloat(ret.total_mxn)) > 0.005

  return createPortal(
    <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/40 p-4">
      <div className="card w-full max-w-lg p-5 max-h-[92vh] overflow-y-auto">
        <h3 className="text-base font-semibold text-ink-primary mb-1">
          Nota de crédito · factura {ret.invoice_number}
        </h3>
        <p className="text-xs text-ink-muted mb-4">
          Valida los datos del CFDI antes de timbrar. Cliente: {ret.partner_name}.
        </p>

        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label">Monto sin IVA <span className="text-status-danger">*</span></label>
              <input type="number" step="0.01" min="0" className="input"
                value={amount} onChange={e => setAmount(e.target.value)} disabled={loading} />
              {amountChanged && (
                <p className="text-[11px] text-status-warning mt-1">
                  Distinto al total de la devolución ({fmtMXN(ret.total_mxn)}).
                </p>
              )}
            </div>
            <div>
              <label className="label">Tasa de IVA</label>
              <select className="input" value={taxRate}
                onChange={e => setTaxRate(parseInt(e.target.value, 10))} disabled={loading}>
                {IVA_OPTS.map(r => <option key={r} value={r}>{r}%</option>)}
              </select>
            </div>
          </div>

          <div>
            <label className="label">Concepto del CFDI</label>
            <input className="input" value={description}
              onChange={e => setDescription(e.target.value)} disabled={loading} />
          </div>

          <div>
            <label className="label">Forma de pago</label>
            <SatCatalogSelect endpoint="forma-pago" value={paymentForm}
              onChange={code => setPaymentForm(code)} placeholder="Buscar forma de pago…"
              disabled={loading} />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="label">Uso CFDI</label>
              <select className="input" value={useCfdi}
                onChange={e => setUseCfdi(e.target.value)} disabled={loading}>
                {USO_CFDI_OPTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </div>
            <div>
              <label className="label">Tipo de relación SAT</label>
              <select className="input" value={relationship}
                onChange={e => setRelationship(e.target.value)} disabled={loading}>
                {RELACION_OPTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </div>
          </div>

          <div className="bg-surface-elevated/40 border border-line-subtle rounded-lg px-3 py-2 text-sm flex flex-col gap-0.5">
            <div className="flex justify-between"><span className="text-ink-muted">Subtotal</span><span className="font-mono">{fmtMXN(numAmount)}</span></div>
            <div className="flex justify-between"><span className="text-ink-muted">IVA ({taxRate}%)</span><span className="font-mono">{fmtMXN(tax)}</span></div>
            <div className="flex justify-between font-semibold"><span>Total de la NC</span><span className="font-mono text-brand-300">{fmtMXN(total)}</span></div>
          </div>

          <p className="text-[11px] text-status-warning">
            Al confirmar se timbra ante el SAT: consume un timbre y la devolución ya no podrá cancelarse.
          </p>
        </div>

        <div className="flex justify-end gap-2 mt-4">
          <button className="btn-secondary" onClick={onClose} disabled={loading}>Cancelar</button>
          <button className="btn-primary" disabled={loading || !(numAmount > 0)}
            onClick={() => onConfirm({
              amount: numAmount, taxRate, description: description.trim() || undefined,
              paymentForm, useCfdi, relationship,
            })}>
            {loading ? <Spinner size="sm" /> : 'Timbrar nota de crédito'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
