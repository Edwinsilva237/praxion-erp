import { useState, useMemo, useCallback, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useSearchParams } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTableSort } from '@/hooks/useTableSort'
import { SortableHeader } from '@/components/ui/SortableHeader'
import { cxpApi } from '@/api/cxp'
import { partnersApi } from '@/api/partners'
import Autocomplete from '@/components/ui/Autocomplete'
import Spinner from '@/components/ui/Spinner'
import Can from '@/components/auth/Can'
import { fmtMXN, fmtDateOnly } from '@/utils/fmt'

const METHOD_OPTS = [
  ['',            'Todos'],
  ['transfer',    'Transferencia'],
  ['cash',        'Efectivo'],
  ['check',       'Cheque'],
  ['credit_card', 'Tarjeta de crédito'],
]

const METHOD_LABEL = {
  transfer:            'Transferencia',
  cash:                'Efectivo',
  check:               'Cheque',
  credit_card:         'Tarjeta de crédito',
  advance_application: 'Aplicación de anticipo',
}

const methodLabel = (m) => METHOD_LABEL[m] || m || '—'

const PAGE_SIZE = 25

export default function PagosEmitidos() {
  const [searchParams] = useSearchParams()
  const [partner, setPartner] = useState(null)
  const [from, setFrom]       = useState(searchParams.get('from') || '')
  const [to, setTo]           = useState(searchParams.get('to') || '')
  const [method, setMethod]   = useState('')
  const [page, setPage]       = useState(1)
  const [reverseTarget, setReverseTarget] = useState(null) // pago a reversar
  // ?open=<id> (desde "Pagos aplicados") abre el detalle del pago; clic en fila igual.
  const [detailId, setDetailId] = useState(searchParams.get('open') || null)

  // Al llegar desde "Pagos aplicados" de una CxP: ?highlight=<id> resalta la fila.
  const [highlightId, setHighlightId] = useState(searchParams.get('highlight') || null)
  const highlightRef = useRef(null)

  const { sortBy, sortDir, onSort } = useTableSort('fecha', 'desc')
  useEffect(() => { setPage(1) }, [partner, from, to, method, sortBy, sortDir])

  const queryParams = useMemo(() => {
    const p = { page, limit: PAGE_SIZE, sortBy, sortDir }
    if (partner?.id) p.partnerId = partner.id
    if (from)        p.from      = from
    if (to)          p.to        = to
    if (method)      p.method    = method
    return p
  }, [partner, from, to, method, page, sortBy, sortDir])

  const { data, isLoading, isFetching, error } = useQuery({
    queryKey: ['pagos-emitidos', queryParams],
    queryFn:  () => cxpApi.listPayments(queryParams),
    keepPreviousData: true,
  })

  const searchPartners = useCallback(async (q) => {
    const res = await partnersApi.list({ search: q, role: 'supplier', limit: 20 })
    return (res.data || res).map(p => ({ id: p.id, label: p.name, sub: p.rfc || '' }))
  }, [])

  const rows = data?.data || []
  const total = data?.total || 0
  const totalAmount = data?.totalAmount || 0
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  const hasFilters = partner || from || to || method

  // Scroll + destello a la fila resaltada cuando aparece en la lista cargada.
  useEffect(() => {
    if (!highlightId) return
    if (!rows.some(r => r.id === highlightId)) return
    highlightRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    const t = setTimeout(() => setHighlightId(null), 3500)
    return () => clearTimeout(t)
  }, [highlightId, rows])

  const partnerName = (r) => r.partner_name || r.generic_supplier || '—'

  return (
    <div className="page-enter flex flex-col gap-4">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-xl font-semibold text-ink-primary">Pagos emitidos</h1>
          <p className="text-xs text-ink-muted mt-0.5">Historial de pagos a proveedores</p>
        </div>
        {!isLoading && total > 0 && (
          <div className="card px-3 py-2">
            <p className="text-sm text-ink-secondary">
              <span className="font-semibold text-ink-primary">{total}</span> pago{total !== 1 ? 's' : ''}
              {' · '}
              <span className="font-mono font-semibold text-ink-primary">{fmtMXN(totalAmount)}</span> en total
            </p>
          </div>
        )}
      </div>

      {/* Filtros */}
      <div className="card p-4 flex flex-wrap gap-3 items-end">
        <div className="min-w-[220px] flex-1">
          <label className="label">Proveedor</label>
          <Autocomplete value={partner}
            onChange={(p) => { setPartner(p); setPage(1) }}
            onSearch={searchPartners}
            placeholder="Filtrar por proveedor..." />
        </div>
        <div>
          <label className="label">Desde</label>
          <input type="date" className="input" value={from}
            onChange={e => { setFrom(e.target.value); setPage(1) }} />
        </div>
        <div>
          <label className="label">Hasta</label>
          <input type="date" className="input" value={to}
            onChange={e => { setTo(e.target.value); setPage(1) }} />
        </div>
        <div>
          <label className="label">Método</label>
          <select className="select" value={method}
            onChange={e => { setMethod(e.target.value); setPage(1) }}>
            {METHOD_OPTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </div>
        {hasFilters && (
          <button onClick={() => { setPartner(null); setFrom(''); setTo(''); setMethod(''); setPage(1) }}
            className="btn-ghost btn-sm text-ink-muted">
            Limpiar filtros
          </button>
        )}
      </div>

      {/* Listado */}
      <div className="card overflow-hidden">
        {isLoading ? (
          <div className="flex justify-center py-16"><Spinner /></div>
        ) : error ? (
          <div className="p-8 text-center">
            <p className="text-sm text-status-danger">
              {error.response?.data?.error || error.message || 'Error al cargar los pagos'}
            </p>
          </div>
        ) : rows.length === 0 ? (
          <div className="flex flex-col items-center gap-3 py-16 text-center">
            <div className="w-12 h-12 rounded-xl bg-surface-elevated/60 flex items-center justify-center">
              <svg className="w-6 h-6 text-ink-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>
              </svg>
            </div>
            <p className="text-sm font-medium text-ink-secondary">Sin pagos en el periodo.</p>
          </div>
        ) : (
          <>
            {/* ── Móvil: tarjetas ── */}
            <div className="md:hidden flex flex-col gap-3 p-3">
              {rows.map(r => (
                <div key={r.id}
                  ref={r.id === highlightId ? highlightRef : null}
                  onClick={() => setDetailId(r.id)}
                  className={`rounded-xl bg-surface-primary px-3 py-2.5 border transition-all cursor-pointer ${
                    r.id === highlightId ? 'border-brand-400 ring-2 ring-brand-400/50' : 'border-line-subtle'}`}>
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="font-medium text-ink-primary truncate">{partnerName(r)}</p>
                      {r.partner_tax_name && r.partner_tax_name !== r.partner_name && (
                        <p className="text-[11px] text-ink-muted truncate">{r.partner_tax_name}</p>
                      )}
                    </div>
                    <p className="font-mono tabular-nums font-semibold text-ink-primary shrink-0">
                      {fmtMXN(r.amount_mxn)}
                    </p>
                  </div>
                  <div className="mt-1.5 flex items-center gap-2 flex-wrap text-[11px] text-ink-muted">
                    <span>{fmtDateOnly(r.payment_date)}</span>
                    {r.applied_docs && (
                      <span className="text-ink-secondary">· {r.applied_docs}</span>
                    )}
                    <span>· {methodLabel(r.payment_method)}</span>
                    {(r.bank_alias || r.bank_name) && (
                      <span>· {r.bank_alias || r.bank_name}</span>
                    )}
                  </div>
                  {r.payment_method !== 'advance_application' && (
                    <Can do="purchases:reverse_payment">
                      <div className="mt-2">
                        <button onClick={(e) => { e.stopPropagation(); setReverseTarget(r) }}
                          className="btn-ghost btn-sm text-status-danger">
                          Reversar
                        </button>
                      </div>
                    </Can>
                  )}
                </div>
              ))}
            </div>

            {/* ── Escritorio: tabla ── */}
            <div className="table-wrap hidden md:block">
              <table className="table">
                <thead>
                  <tr>
                    <SortableHeader sortKey="fecha"     sortBy={sortBy} sortDir={sortDir} onSort={onSort}>Fecha</SortableHeader>
                    <SortableHeader sortKey="proveedor" sortBy={sortBy} sortDir={sortDir} onSort={onSort} initialDir="asc">Proveedor</SortableHeader>
                    <th>Documentos</th>
                    <SortableHeader sortKey="metodo"    sortBy={sortBy} sortDir={sortDir} onSort={onSort} initialDir="asc">Método</SortableHeader>
                    <th>Banco</th>
                    <SortableHeader sortKey="monto"     sortBy={sortBy} sortDir={sortDir} onSort={onSort} align="right">Monto</SortableHeader>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(r => (
                    <tr key={r.id}
                      ref={r.id === highlightId ? highlightRef : null}
                      onClick={() => setDetailId(r.id)}
                      className={`cursor-pointer transition-colors ${
                        r.id === highlightId
                          ? 'bg-brand-500/10 ring-2 ring-inset ring-brand-400/60'
                          : 'hover:bg-surface-elevated/40'}`}>
                      <td className="text-xs text-ink-secondary whitespace-nowrap">{fmtDateOnly(r.payment_date)}</td>
                      <td>
                        <p className="font-medium text-ink-primary">{partnerName(r)}</p>
                        {r.partner_tax_name && r.partner_tax_name !== r.partner_name && (
                          <p className="text-[10px] text-ink-muted">{r.partner_tax_name}</p>
                        )}
                      </td>
                      <td className="text-xs text-ink-secondary">{r.applied_docs || '—'}</td>
                      <td className="text-xs text-ink-secondary">{methodLabel(r.payment_method)}</td>
                      <td className="text-xs text-ink-secondary">{r.bank_alias || r.bank_name || '—'}</td>
                      <td className="text-right font-mono tabular-nums font-semibold text-ink-primary">
                        {fmtMXN(r.amount_mxn)}
                      </td>
                      <td className="text-right" onClick={(e) => e.stopPropagation()}>
                        {r.payment_method !== 'advance_application' && (
                          <Can do="purchases:reverse_payment">
                            <button onClick={() => setReverseTarget(r)}
                              className="btn-ghost btn-sm text-status-danger">
                              Reversar
                            </button>
                          </Can>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {totalPages > 1 && (
              <div className="border-t border-line-subtle px-4 py-3 flex items-center justify-between">
                <p className="text-xs text-ink-muted">
                  Mostrando {((page - 1) * PAGE_SIZE) + 1}–{Math.min(page * PAGE_SIZE, total)} de {total}
                  {isFetching && <span className="ml-2 italic text-ink-muted">Actualizando…</span>}
                </p>
                <div className="flex gap-1">
                  <button disabled={page === 1} onClick={() => setPage(p => p - 1)}
                    className="btn-ghost btn-sm disabled:opacity-30">
                    Anterior
                  </button>
                  <span className="text-sm self-center px-2 text-ink-secondary">
                    {page} / {totalPages}
                  </span>
                  <button disabled={page === totalPages} onClick={() => setPage(p => p + 1)}
                    className="btn-ghost btn-sm disabled:opacity-30">
                    Siguiente
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {reverseTarget && (
        <ReversePaymentModal
          payment={reverseTarget}
          onClose={() => setReverseTarget(null)}
        />
      )}

      {detailId && (
        <SupplierPaymentDetailModal
          paymentId={detailId}
          onClose={() => setDetailId(null)}
          onReverse={(p) => { setDetailId(null); setReverseTarget(p) }}
        />
      )}
    </div>
  )
}

// ── Modal: detalle de un pago emitido ────────────────────────────────────────
function SupplierPaymentDetailModal({ paymentId, onClose, onReverse }) {
  const { data: p, isLoading, error } = useQuery({
    queryKey: ['supplier-payment', paymentId],
    queryFn:  () => cxpApi.getPayment(paymentId),
  })

  return createPortal(
    <div className="fixed inset-0 z-[9998] flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="card w-full max-w-lg max-h-[90vh] overflow-y-auto p-5" onClick={e => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="eyebrow">PAGO EMITIDO</p>
            <h2 className="text-lg font-semibold text-ink-primary mt-0.5">
              {isLoading ? 'Cargando…' : fmtMXN(p?.amount_mxn)}
            </h2>
            {p && <p className="text-xs text-ink-muted mt-0.5">{p.partner_name || p.generic_supplier || '—'}</p>}
          </div>
          <button onClick={onClose} className="text-ink-muted hover:text-ink-secondary text-xl leading-none">×</button>
        </div>

        {error ? (
          <p className="field-error mt-4">{error.response?.data?.error || 'No se pudo cargar el pago.'}</p>
        ) : isLoading ? (
          <div className="flex justify-center py-10"><Spinner /></div>
        ) : (
          <div className="mt-4 flex flex-col gap-4">
            {p.reversed_at && (
              <div className="bg-status-danger/10 border border-status-danger/40 rounded-xl p-3 text-sm text-status-danger">
                Pago reversado. {p.reversal_reason && <span className="text-xs">Motivo: {p.reversal_reason}</span>}
              </div>
            )}
            <dl className="grid grid-cols-2 gap-3 text-sm">
              <Field label="Fecha"      value={fmtDateOnly(p.payment_date)} />
              <Field label="Método"     value={methodLabel(p.payment_method)} />
              <Field label="Referencia" value={p.reference || '—'} mono />
              <Field label="Banco"      value={p.bank_alias || p.bank_name || '—'} />
              <Field label="Importe"    value={`${fmtMXN(p.amount)} ${p.currency || 'MXN'}`} />
              <Field label="Registró"   value={p.created_by_name || '—'} />
            </dl>

            <div>
              <p className="text-xs font-bold text-brand-300 uppercase tracking-wider mb-1.5">Documentos pagados</p>
              {(!p.applications || p.applications.length === 0) ? (
                <p className="text-sm text-ink-muted italic">Sin documentos ligados.</p>
              ) : (
                <div className="border border-line-subtle rounded-xl overflow-x-auto">
                  <table className="table text-xs min-w-full">
                    <thead><tr><th>Documento</th><th className="text-right">Aplicado</th></tr></thead>
                    <tbody>
                      {p.applications.map((a, i) => (
                        <tr key={i}>
                          <td className="font-mono text-brand-300">{a.document_number || '—'}</td>
                          <td className="text-right font-mono tabular-nums font-semibold">{fmtMXN(a.amount_applied)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* Complementos de pago (REP) del proveedor por este pago. Solo se
                avisa "falta" cuando el pago liquidó facturas PPD (las únicas
                que exigen REP). */}
            {(() => {
              const hasPPD = (p.applications || []).some(a => a.metodo_pago_sat === 'PPD')
              if (!p.complements?.length && !hasPPD) return null
              return (
                <div>
                  <p className="text-xs font-bold text-brand-300 uppercase tracking-wider mb-1.5">Complemento de pago (REP)</p>
                  {p.complements?.length ? (
                    <div className="flex flex-col gap-1.5">
                      {p.complements.map(c => (
                        <div key={c.id} className="flex items-center justify-between gap-2 border border-status-success/40 bg-status-success/5 rounded-xl px-3 py-2 text-sm">
                          <span className="text-ink-primary">
                            Recibido · pago del {fmtDateOnly(c.payment_date)}
                            {(c.serie || c.folio) && <span className="text-ink-muted text-xs"> ({[c.serie, c.folio].filter(Boolean).join('-')})</span>}
                          </span>
                          <span className="font-mono tabular-nums font-semibold">{fmtMXN(c.amount)}</span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="border border-status-warning/40 bg-status-warning/5 rounded-xl px-3 py-2 text-sm text-status-warning">
                      Sin complemento recibido — este pago liquidó factura(s) PPD; el proveedor debe emitirte el REP.
                    </div>
                  )}
                </div>
              )
            })()}

            {p.notes && <p className="text-xs text-ink-muted">Notas: {p.notes}</p>}

            {!p.reversed_at && p.payment_method !== 'advance_application' && (
              <Can do="purchases:reverse_payment">
                <div className="flex justify-end pt-1">
                  <button onClick={() => onReverse?.(p)} className="btn-ghost btn-sm text-status-danger">
                    Reversar pago
                  </button>
                </div>
              </Can>
            )}
          </div>
        )}
      </div>
    </div>,
    document.body
  )
}

function Field({ label, value, mono }) {
  return (
    <div>
      <dt className="text-[11px] text-ink-muted uppercase tracking-wide">{label}</dt>
      <dd className={`text-ink-primary ${mono ? 'font-mono text-xs' : ''}`}>{value}</dd>
    </div>
  )
}

// ── Modal: reversar un pago a proveedor ──────────────────────────────────────
function ReversePaymentModal({ payment, onClose }) {
  const qc = useQueryClient()
  const [reason, setReason] = useState('')
  const [error, setError]   = useState(null)

  const mutation = useMutation({
    mutationFn: () => cxpApi.reversePayment(payment.id, reason.trim()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['pagos-emitidos'] })
      qc.invalidateQueries({ queryKey: ['cxp'] })
      onClose()
    },
    onError: (e) => setError(e.response?.data?.error || e.message || 'Error al reversar'),
  })

  const partnerName = payment.partner_name || payment.generic_supplier || 'proveedor'

  return createPortal(
    <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}>
      <div className="card w-full max-w-md p-5" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-1">
          <h3 className="text-base font-semibold text-ink-primary">Reversar pago</h3>
          <button onClick={onClose} className="text-ink-muted hover:text-ink-secondary">×</button>
        </div>
        <p className="text-xs text-ink-muted mb-4">
          Se revertirá el pago de <strong>{fmtMXN(payment.amount_mxn)}</strong> a {partnerName}
          {payment.applied_docs ? <> aplicado a <strong>{payment.applied_docs}</strong></> : null}.
          El saldo de esas cuentas por pagar volverá a quedar pendiente. El pago queda registrado como reversado.
        </p>

        <label className="block text-xs text-ink-muted mb-1">Razón de la reversa</label>
        <textarea className="input min-h-[72px]" value={reason}
          onChange={e => setReason(e.target.value)}
          placeholder="Ej. pago aplicado al documento equivocado" />

        {error && <p className="field-error mt-3">{error}</p>}

        <div className="flex gap-2 mt-4">
          <button onClick={onClose} className="btn-secondary flex-1" disabled={mutation.isPending}>
            Cancelar
          </button>
          <button
            onClick={() => { setError(null); mutation.mutate() }}
            disabled={mutation.isPending || !reason.trim()}
            className="btn-primary flex-1 !bg-status-danger hover:!bg-status-danger/90">
            {mutation.isPending ? <Spinner size="sm" /> : 'Reversar pago'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
