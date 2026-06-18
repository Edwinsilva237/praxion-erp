import { useState, useMemo, useCallback, useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTableSort } from '@/hooks/useTableSort'
import { SortableHeader } from '@/components/ui/SortableHeader'
import { cxpApi } from '@/api/cxp'
import { partnersApi } from '@/api/partners'
import Autocomplete from '@/components/ui/Autocomplete'
import Spinner from '@/components/ui/Spinner'
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
  const [partner, setPartner] = useState(null)
  const [from, setFrom]       = useState('')
  const [to, setTo]           = useState('')
  const [method, setMethod]   = useState('')
  const [page, setPage]       = useState(1)

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
                  className="border border-line-subtle rounded-xl bg-surface-primary px-3 py-2.5">
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
                  </tr>
                </thead>
                <tbody>
                  {rows.map(r => (
                    <tr key={r.id} className="hover:bg-surface-elevated/40">
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
    </div>
  )
}
