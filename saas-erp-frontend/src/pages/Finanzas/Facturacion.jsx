import { useState, useMemo, useCallback, useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { invoicingApi } from '@/api/invoicing'
import { useDebounced } from '@/hooks/useDebounced'
import { useTableSort } from '@/hooks/useTableSort'
import { SortableHeader } from '@/components/ui/SortableHeader'
import { partnersApi } from '@/api/partners'
import Autocomplete from '@/components/ui/Autocomplete'
import Badge from '@/components/ui/Badge'
import Spinner from '@/components/ui/Spinner'
import Can from '@/components/auth/Can'
import CollapsibleFilters from '@/components/ui/CollapsibleFilters'
import { FacturaFormModal } from '@/components/facturacion/FacturaFormModal'
import { FacturaDetallePanel } from '@/components/facturacion/FacturaDetallePanel'
import { fmtMXN, fmtDate, fmtDateOnly} from '@/utils/fmt'
import DocLink from '@/components/ui/DocLink'
import { useDeepLinkDoc } from '@/hooks/useDeepLinkDoc'
import clsx from 'clsx'

const STATUS_OPTS = [
  ['',           'Todos los estados'],
  ['draft',      'Borrador'],
  ['stamped',    'Timbrada'],
  ['cancelled',  'Cancelada'],
]

const PAGE_SIZE = 25

export default function Facturacion() {
  const [statusFilter, setStatusFilter] = useState('')
  const [partner, setPartner]           = useState(null)
  const [search, setSearch]             = useState('')
  const [from, setFrom]                 = useState('')
  const [to, setTo]                     = useState('')
  const [page, setPage]                 = useState(1)

  const [showForm, setShowForm]         = useState(false)
  const { selectedId, setSelectedId, close: closeDoc, href: docHref } = useDeepLinkDoc('/facturacion')
  const [createdMsg, setCreatedMsg]     = useState(null)

  // Búsqueda server-side (sobre TODO el dataset, no solo la página actual).
  const searchDebounced = useDebounced(search, 300)

  // Al cambiar cualquier filtro, volver a la página 1.
  const { sortBy, sortDir, onSort } = useTableSort('fecha', 'desc')
  useEffect(() => { setPage(1) }, [statusFilter, partner, from, to, searchDebounced, sortBy, sortDir])

  const queryParams = useMemo(() => {
    const p = { page, limit: PAGE_SIZE, sortBy, sortDir }
    if (statusFilter)  p.status    = statusFilter
    if (partner?.id)   p.partnerId = partner.id
    if (from)          p.from      = from
    if (to)            p.to        = to
    if (searchDebounced.trim()) p.search = searchDebounced.trim()
    return p
  }, [statusFilter, partner, from, to, searchDebounced, page, sortBy, sortDir])

  const { data, isLoading, isFetching, error } = useQuery({
    queryKey: ['invoices', queryParams],
    queryFn:  () => invoicingApi.list(queryParams),
    keepPreviousData: true,
  })

  const searchPartners = useCallback(async (q) => {
    const res = await partnersApi.list({ search: q, role: 'customer', limit: 20 })
    return (res.data || res).map(p => ({ id: p.id, label: p.name, sub: [p.rfc, p.tax_name && p.tax_name !== p.name ? p.tax_name : null].filter(Boolean).join(' · ') }))
  }, [])

  const invoices = data?.data || []

  const total = data?.total || 0
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  return (
    <div className="page-enter flex flex-col gap-4">
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold text-ink-primary">Facturación</h1>
          <p className="text-xs text-ink-muted mt-0.5">CFDI 4.0 — genera, timbra y envía facturas a tus clientes</p>
        </div>
        <Can do="invoicing:create">
          <button onClick={() => setShowForm(true)} className="btn-primary w-full justify-center sm:w-auto">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4"/>
            </svg>
            Nueva factura
          </button>
        </Can>
      </div>

      {createdMsg && (
        <div className="flex items-center gap-2 bg-status-success/10 border border-status-success/40 rounded-lg px-3 py-2">
          <svg className="w-4 h-4 text-status-success shrink-0" fill="currentColor" viewBox="0 0 24 24">
            <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/>
          </svg>
          <p className="text-sm text-status-success flex-1">{createdMsg}</p>
          <button onClick={() => setCreatedMsg(null)} className="text-status-success hover:text-status-success">
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12"/>
            </svg>
          </button>
        </div>
      )}

      {/* Filtros colapsables en móvil */}
      <CollapsibleFilters
        activeCount={[search, statusFilter, from, to, partner].filter(Boolean).length}>
        <div className="card p-4 flex flex-col sm:flex-row sm:flex-wrap gap-3 sm:items-end">
          <div className="sm:flex-1 sm:min-w-[200px]">
            <label className="label">Buscar</label>
            <input className="input" placeholder="Folio, cliente, RFC, UUID, remisión..."
              value={search} onChange={e => setSearch(e.target.value)} />
          </div>
          <div className="sm:min-w-[200px]">
            <label className="label">Cliente</label>
            <Autocomplete value={partner}
              onChange={(p) => { setPartner(p); setPage(1) }}
              onSearch={searchPartners}
              placeholder="Filtrar por cliente..." />
          </div>
          <div>
            <label className="label">Estado</label>
            <select className="select" value={statusFilter}
              onChange={e => { setStatusFilter(e.target.value); setPage(1) }}>
              {STATUS_OPTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </div>
          {/* Desde + Hasta: par de 2 columnas en móvil, sueltos en escritorio */}
          <div className="grid grid-cols-2 gap-3 sm:contents">
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
          </div>
          {(statusFilter || from || to || search || partner) && (
            <button onClick={() => { setStatusFilter(''); setFrom(''); setTo(''); setSearch(''); setPartner(null); setPage(1) }}
              className="btn-ghost btn-sm text-ink-muted self-start sm:self-auto">
              Limpiar filtros
            </button>
          )}
        </div>
      </CollapsibleFilters>

      {/* Tabla */}
      <div className="card overflow-hidden">
        {isLoading ? (
          <div className="flex justify-center py-16"><Spinner /></div>
        ) : error ? (
          <div className="p-8 text-center">
            <p className="text-sm text-status-danger">
              {error.response?.data?.error || error.message || 'Error al cargar facturas'}
            </p>
          </div>
        ) : invoices.length === 0 ? (
          <div className="flex flex-col items-center gap-3 py-16 text-center">
            <div className="w-12 h-12 rounded-xl bg-surface-elevated/60 flex items-center justify-center">
              <svg className="w-6 h-6 text-ink-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/>
              </svg>
            </div>
            <div>
              <p className="text-sm font-medium text-ink-secondary">
                {search || statusFilter || from || to || partner ? 'Sin resultados para los filtros' : 'Aún no hay facturas'}
              </p>
              {!search && !statusFilter && !from && !to && !partner && (
                <button onClick={() => setShowForm(true)} className="btn-primary btn-sm mt-3">
                  Generar primera factura
                </button>
              )}
            </div>
          </div>
        ) : (
          <>
            <table className="table">
              <thead>
                <tr>
                  <SortableHeader sortKey="folio"   sortBy={sortBy} sortDir={sortDir} onSort={onSort}>Folio</SortableHeader>
                  <SortableHeader sortKey="cliente" sortBy={sortBy} sortDir={sortDir} onSort={onSort} initialDir="asc">Cliente</SortableHeader>
                  <th>Origen</th>
                  <SortableHeader sortKey="fecha"   sortBy={sortBy} sortDir={sortDir} onSort={onSort}>F. emisión</SortableHeader>
                  <th>Pago</th>
                  <SortableHeader sortKey="estatus" sortBy={sortBy} sortDir={sortDir} onSort={onSort} initialDir="asc">Estado</SortableHeader>
                  <SortableHeader sortKey="total"   sortBy={sortBy} sortDir={sortDir} onSort={onSort} align="right">Total</SortableHeader>
                </tr>
              </thead>
              <tbody>
                {invoices.map(i => (
                  <tr key={i.id}
                    onClick={() => setSelectedId(i.id)}
                    className={clsx(
                      'cursor-pointer transition-colors',
                      selectedId === i.id ? 'bg-brand-500/10' : 'hover:bg-surface-elevated/40'
                    )}>
                    <td>
                      <p className="font-mono font-semibold text-teal-300"><DocLink to={docHref(i.id)} onOpen={() => setSelectedId(i.id)}>{i.document_number}</DocLink></p>
                      {i.cfdi_uuid && (
                        <p className="text-[10px] text-ink-muted font-mono break-all">
                          {i.cfdi_uuid.substring(0, 8)}…{i.cfdi_uuid.substring(i.cfdi_uuid.length - 4)}
                        </p>
                      )}
                    </td>
                    <td>
                      <p className="font-medium text-ink-primary">{i.partner_name}</p>
                      {i.partner_rfc && <p className="text-[10px] text-ink-muted font-mono">{i.partner_rfc}</p>}
                    </td>
                    <td className="text-xs">
                      {i.remission_number ? (
                        <span className="font-mono text-purple-300">{i.remission_number}</span>
                      ) : (
                        <span className="text-ink-muted italic">Directa</span>
                      )}
                    </td>
                    <td className="text-xs text-ink-secondary">{fmtDateOnly(i.issue_date)}</td>
                    <td>
                      <span className={clsx(
                        'text-[10px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded-full',
                        i.payment_method === 'PPD' ? 'bg-status-warning/15 text-status-warning' : 'bg-surface-elevated/60 text-ink-secondary'
                      )}>
                        {i.payment_method || '—'}
                      </span>
                    </td>
                    <td>
                      <Badge status={i.status} />
                      {i.email_sent_auto ? (
                        <span className="mt-1 block w-fit text-[10px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded-full bg-status-success/15 text-status-success"
                          title={`Enviada automáticamente al timbrar${i.email_sent_at ? ` · ${fmtDateOnly(i.email_sent_at)}` : ''}`}>
                          ✉ Auto-enviada
                        </span>
                      ) : i.email_sent_at ? (
                        <span className="mt-1 block w-fit text-[10px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded-full bg-status-info/15 text-status-info"
                          title={`Enviada por correo · ${fmtDateOnly(i.email_sent_at)}`}>
                          ✉ Enviada
                        </span>
                      ) : null}
                    </td>
                    <td className="text-right font-mono tabular-nums font-medium">
                      {fmtMXN(i.total, i.currency)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

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

      {showForm && (
        <FacturaFormModal
          onClose={() => setShowForm(false)}
          onCreated={(inv) => {
            setCreatedMsg(`Factura ${inv.document_number} generada. ${inv.message || 'Recuerda timbrarla para que sea válida.'}`)
            setSelectedId(inv.id)
          }}
        />
      )}

      {selectedId && (
        <FacturaDetallePanel
          invoiceId={selectedId}
          onClose={closeDoc}
        />
      )}
    </div>
  )
}
