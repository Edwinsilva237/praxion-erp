import { useState, useMemo, useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { salesApi } from '@/api/sales'
import { useDebounced } from '@/hooks/useDebounced'
import { useTableSort } from '@/hooks/useTableSort'
import { SortableHeader } from '@/components/ui/SortableHeader'
import Badge from '@/components/ui/Badge'
import Spinner from '@/components/ui/Spinner'
import Can from '@/components/auth/Can'
import { RemisionFormModal } from '@/components/ventas/RemisionFormModal'
import { RemisionDetallePanel } from '@/components/ventas/RemisionDetallePanel'
import CollapsibleFilters from '@/components/ui/CollapsibleFilters'
import { fmtMXN, fmtDate, fmtDateOnly} from '@/utils/fmt'
import { LIVE_LIST } from '@/config/livePolling'
import DocLink from '@/components/ui/DocLink'
import { useDeepLinkDoc } from '@/hooks/useDeepLinkDoc'
import clsx from 'clsx'

const STATUS_OPTS = [
  ['',                    'Todos los estados'],
  ['__invoiceable__',     '🧾 Listas para facturar'],
  ['issued',              'Emitida'],
  ['sent_by_email',       'Enviada por correo'],
  ['partially_delivered', 'Entrega parcial'],
  ['delivered',           'Entregada'],
  ['invoiced',            'Facturada'],
  ['cancelled',           'Cancelada'],
]

const PAGE_SIZE = 25

// ── Estatus "pendiente de entrega" para split de la tabla ──────────────────
const PENDING_STATUSES = ['issued', 'sent_by_email', 'partially_delivered']

// Calcula urgencia comparando issue_date (fecha de emisión) vs hoy.
// Una remisión emitida hace varios días y aún no entregada está atrasada.
function getDeliveryUrgency(issueDate) {
  if (!issueDate) return 'none'
  const today = new Date(); today.setHours(0, 0, 0, 0)
  const sched = new Date(issueDate); sched.setHours(0, 0, 0, 0)
  if (sched < today) return 'overdue'
  if (sched.getTime() === today.getTime()) return 'today'
  return 'future'
}

const URGENCY_ROW_CLASS = {
  overdue: 'bg-status-danger/10 hover:bg-status-danger/15',
  today:   'bg-status-warning/10 hover:bg-status-warning/15',
  future:  'bg-status-success/10 hover:bg-status-success/15',
  none:    'hover:bg-surface-elevated/40',
}

// ── Tag de facturación para quien factura (identificación visual rápida) ──────
// Estados mutuamente excluyentes, en orden de prioridad. Los accionables (listo /
// falta) van en chip SÓLIDO para que salten a la vista; los cerrados (facturada /
// no se factura) en chip sutil.
const CHIP_BASE = 'text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded'
function invoiceTag(n) {
  if (n.status === 'cancelled') return null                       // el Badge ya dice "Cancelada"
  if (n.invoice_id) {
    return { label: 'Facturada', cls: 'badge-teal',
             title: n.invoice_number ? `Factura ${n.invoice_number}` : 'Ya facturada' }
  }
  if (n.no_invoice) {
    return { label: 'No se factura', cls: 'badge-gray',
             title: 'Marcada como que no requiere factura' }
  }
  if (n.status !== 'delivered') {
    return { label: 'Falta entregar', cls: `${CHIP_BASE} bg-status-warning text-white`,
             title: 'Registra la entrega de la remisión antes de poder facturar' }
  }
  // Entregada y se va a facturar: ¿el cliente tiene los datos fiscales para timbrar?
  const missing = []
  if (!n.partner_rfc)             missing.push('RFC')
  if (!n.partner_tax_name)        missing.push('razón social')
  if (!n.partner_tax_regime_code) missing.push('régimen')
  if (!n.partner_zip)             missing.push('CP')
  if (missing.length) {
    return { label: `Falta ${missing.join(', ')}`, cls: `${CHIP_BASE} bg-status-warning text-white`,
             title: `Completa los datos fiscales del cliente para timbrar: ${missing.join(', ')}` }
  }
  return { label: 'Listo para facturar', cls: `${CHIP_BASE} bg-status-info text-white`,
           title: 'Entregada y con datos fiscales completos — lista para emitir factura' }
}

function InvoiceChip({ note }) {
  const t = invoiceTag(note)
  if (!t) return null
  return <span className={t.cls} title={t.title}>{t.label}</span>
}

export default function VentasRemisiones() {
  const [statusFilter, setStatusFilter] = useState('')
  const [search, setSearch]             = useState('')
  const [from, setFrom]                 = useState('')
  const [to, setTo]                     = useState('')
  const [page, setPage]                 = useState(1)

  const [showForm, setShowForm]         = useState(false)
  const { selectedId, setSelectedId, close: closeDoc, href: docHref } = useDeepLinkDoc('/remisiones')
  const [createdMsg, setCreatedMsg]     = useState(null)

  // Búsqueda server-side (sobre TODO el dataset, no solo la página actual).
  const searchDebounced = useDebounced(search, 300)

  // Al cambiar cualquier filtro, volver a la página 1 (si no, un filtro con
  // pocos resultados dejaría la tabla vacía estando en una página alta).
  const { sortBy, sortDir, onSort } = useTableSort('relevancia', 'desc')

  useEffect(() => { setPage(1) }, [statusFilter, from, to, searchDebounced, sortBy, sortDir])

  const queryParams = useMemo(() => {
    const p = { page, limit: PAGE_SIZE, type: 'sale', sortBy, sortDir }
    if (statusFilter === '__invoiceable__') p.invoiceable = true
    else if (statusFilter)                  p.status = statusFilter
    if (from)             p.from   = from
    if (to)               p.to     = to
    if (searchDebounced.trim()) p.search = searchDebounced.trim()
    return p
  }, [statusFilter, from, to, searchDebounced, page, sortBy, sortDir])

  const { data, isLoading, isFetching, error } = useQuery({
    queryKey: ['delivery-notes', queryParams],
    queryFn:  () => salesApi.listDeliveryNotes(queryParams),
    keepPreviousData: true,
    ...LIVE_LIST,
  })

  const notes = data?.data || []

  // Split: pendientes (issued/sent/partial) ordenados por fecha de emisión asc
  // (más viejas primero — sospecha de atraso). Entregadas/canceladas abajo.
  const { pendingNotes, doneNotes } = useMemo(() => {
    const pending = []
    const done    = []
    for (const n of notes) {
      if (PENDING_STATUSES.includes(n.status)) pending.push(n)
      else done.push(n)
    }
    // El orden lo decide el backend (default: por entregar primero, luego más
    // nuevas). Aquí solo separamos preservando ese orden.
    return { pendingNotes: pending, doneNotes: done }
  }, [notes])

  const total = data?.total || 0
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  return (
    <div className="page-enter flex flex-col gap-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold text-ink-primary">Remisiones</h1>
          <p className="text-xs text-ink-muted mt-0.5">Genera salidas de almacén y registra entregas a cliente con foto del documento firmado</p>
        </div>
        <Can do="sales:create">
          <button onClick={() => setShowForm(true)} className="btn-primary w-full justify-center sm:w-auto">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4"/>
            </svg>
            Nueva remisión
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

      <CollapsibleFilters
        activeCount={[search, statusFilter, from, to].filter(Boolean).length}>
        <div className="card p-4 flex flex-col sm:flex-row sm:flex-wrap gap-3 sm:items-end">
          <div className="sm:flex-1 sm:min-w-[200px]">
            <label className="label">Buscar</label>
            <input className="input" placeholder="Número, cliente, pedido o receptor..."
              value={search} onChange={e => setSearch(e.target.value)} />
          </div>
          <div>
            <label className="label">Estado</label>
            <select className="select" value={statusFilter}
              onChange={e => { setStatusFilter(e.target.value); setPage(1) }}>
              {STATUS_OPTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </div>
          {/* Desde + Hasta: par de 2 columnas en móvil, campos sueltos en escritorio */}
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
          {(statusFilter || from || to || search) && (
            <button onClick={() => { setStatusFilter(''); setFrom(''); setTo(''); setSearch(''); setPage(1) }}
              className="btn-ghost btn-sm text-ink-muted self-start sm:self-auto">
              Limpiar filtros
            </button>
          )}
        </div>
      </CollapsibleFilters>

      <div className="card overflow-hidden">
        {isLoading ? (
          <div className="flex justify-center py-16"><Spinner /></div>
        ) : error ? (
          <div className="p-8 text-center">
            <p className="text-sm text-status-danger">
              {error.response?.data?.error || error.message || 'Error al cargar remisiones'}
            </p>
          </div>
        ) : notes.length === 0 ? (
          <div className="flex flex-col items-center gap-3 py-16 text-center">
            <div className="w-12 h-12 rounded-xl bg-surface-elevated/60 flex items-center justify-center">
              <svg className="w-6 h-6 text-ink-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 17a2 2 0 11-4 0 2 2 0 014 0zM19 17a2 2 0 11-4 0 2 2 0 014 0zM13 16V6a1 1 0 00-1-1H4a1 1 0 00-1 1v10a1 1 0 001 1h1m8-1a1 1 0 01-1 1H9m4-1V8a1 1 0 011-1h2.586a1 1 0 01.707.293l3.414 3.414a1 1 0 01.293.707V16a1 1 0 01-1 1h-1m-6-1a1 1 0 001 1h1M5 17a2 2 0 104 0m-4 0a2 2 0 114 0m6 0a2 2 0 104 0m-4 0a2 2 0 114 0"/>
              </svg>
            </div>
            <div>
              <p className="text-sm font-medium text-ink-secondary">
                {search || statusFilter || from || to ? 'Sin resultados para los filtros aplicados' : 'Aún no hay remisiones'}
              </p>
              {!search && !statusFilter && !from && !to && (
                <button onClick={() => setShowForm(true)} className="btn-primary btn-sm mt-3">
                  Generar primera remisión
                </button>
              )}
            </div>
          </div>
        ) : (
          <>
            {/* ── Móvil: tarjetas (folio + cliente + razón social). Detalle al tocar. ── */}
            <div className="md:hidden flex flex-col gap-3">
              {pendingNotes.length > 0 && (
                <div className="flex flex-col gap-2">
                  <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-brand-500/10 border border-brand-500/30">
                    <span className="text-sm font-bold text-brand-300 uppercase tracking-wider">⏳ Por entregar · {pendingNotes.length}</span>
                  </div>
                  {pendingNotes.map(n => (
                    <button key={n.id} type="button" onClick={() => setSelectedId(n.id)}
                      className={clsx('w-full text-left border rounded-xl px-3 py-2.5 transition-colors',
                        selectedId === n.id ? 'border-brand-500 bg-brand-500/10'
                          : 'border-line-subtle bg-surface-primary hover:bg-surface-elevated/40')}>
                      <span className="font-mono font-semibold text-purple-300">{n.document_number}</span>
                      <p className="mt-0.5 font-medium text-ink-primary truncate">{n.partner_name}</p>
                      {n.partner_tax_name && n.partner_tax_name !== n.partner_name && (
                        <p className="text-[11px] text-ink-muted truncate">{n.partner_tax_name}</p>
                      )}
                      <div className="mt-1"><InvoiceChip note={n} /></div>
                    </button>
                  ))}
                </div>
              )}
              {doneNotes.length > 0 && (
                <div className="flex flex-col gap-2">
                  <p className="text-xs font-bold text-ink-muted uppercase tracking-wider px-1">✓ Entregadas y cerradas · {doneNotes.length}</p>
                  {doneNotes.map(n => (
                    <button key={n.id} type="button" onClick={() => setSelectedId(n.id)}
                      className={clsx('w-full text-left border rounded-xl px-3 py-2.5 transition-colors opacity-60',
                        selectedId === n.id ? 'border-brand-500 bg-brand-500/10 opacity-100'
                          : 'border-line-subtle bg-surface-elevated/30 hover:opacity-100')}>
                      <span className="font-mono font-semibold text-purple-300">{n.document_number}</span>
                      <p className="mt-0.5 font-medium text-ink-primary truncate">{n.partner_name}</p>
                      {n.partner_tax_name && n.partner_tax_name !== n.partner_name && (
                        <p className="text-[11px] text-ink-muted truncate">{n.partner_tax_name}</p>
                      )}
                      <div className="mt-1"><InvoiceChip note={n} /></div>
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* ── Escritorio: tabla completa ── */}
            <div className="table-wrap hidden md:block">
            <table className="table">
              <thead>
                <tr>
                  <SortableHeader sortKey="folio"   sortBy={sortBy} sortDir={sortDir} onSort={onSort}>Número</SortableHeader>
                  <SortableHeader sortKey="cliente" sortBy={sortBy} sortDir={sortDir} onSort={onSort} initialDir="asc">Cliente</SortableHeader>
                  <th>Pedido</th>
                  <SortableHeader sortKey="fecha"   sortBy={sortBy} sortDir={sortDir} onSort={onSort}>F. emisión</SortableHeader>
                  <th>Receptor</th>
                  <SortableHeader sortKey="estatus" sortBy={sortBy} sortDir={sortDir} onSort={onSort} initialDir="asc">Estado</SortableHeader>
                  <SortableHeader sortKey="total"   sortBy={sortBy} sortDir={sortDir} onSort={onSort} align="right">Total</SortableHeader>
                </tr>
              </thead>
              <tbody>
                {/* ── Sección: Pendientes de entrega ──────────────────── */}
                {pendingNotes.length > 0 && (
                  <tr className="bg-surface-elevated/60">
                    <td colSpan={7} className="px-4 py-2 text-xs font-bold text-brand-300 uppercase tracking-wider">
                      ⏳ Pendientes de entrega · {pendingNotes.length}
                      <span className="ml-3 text-[10px] font-medium text-ink-muted normal-case tracking-normal">
                        🔴 atrasada · 🟡 emitida hoy · 🟢 emitida con fecha futura
                      </span>
                    </td>
                  </tr>
                )}
                {pendingNotes.map(n => {
                  const urgency = getDeliveryUrgency(n.issue_date)
                  return (
                    <tr key={n.id}
                      onClick={() => setSelectedId(n.id)}
                      className={clsx(
                        'cursor-pointer transition-colors',
                        selectedId === n.id ? 'bg-brand-500/15' : URGENCY_ROW_CLASS[urgency]
                      )}>
                      <td className="font-mono font-semibold text-purple-300"><DocLink to={docHref(n.id)} onOpen={() => setSelectedId(n.id)}>{n.document_number}</DocLink></td>
                      <td>
                        <p className="font-medium text-ink-primary">{n.partner_name}</p>
                        {n.partner_tax_name && n.partner_tax_name !== n.partner_name && (
                          <p className="text-[11px] text-ink-secondary">{n.partner_tax_name}</p>
                        )}
                      </td>
                      <td className="font-mono text-xs text-ink-muted">{n.order_number || '—'}</td>
                      <td className={clsx('text-xs font-semibold',
                        urgency === 'overdue' ? 'text-status-danger' :
                        urgency === 'today'   ? 'text-status-warning' :
                        urgency === 'future'  ? 'text-status-success' : 'text-ink-secondary')}>
                        {fmtDateOnly(n.issue_date)}
                      </td>
                      <td className="text-xs text-ink-secondary">{n.receiver_name || '—'}</td>
                      <td>
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <Badge status={n.status} />
                          <InvoiceChip note={n} />
                          {n.price_adjusted && (
                            <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-status-info/15 text-status-info">
                              Precio corregido
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="text-right font-mono tabular-nums font-medium"
                        title="Total de la remisión sin IVA. El IVA se calcula al facturar.">
                        {fmtMXN(n.subtotal_mxn ?? n.total_mxn, n.currency)}
                      </td>
                    </tr>
                  )
                })}

                {/* ── Sección: Entregadas / facturadas / canceladas ───── */}
                {doneNotes.length > 0 && (
                  <tr className="bg-surface-elevated/60">
                    <td colSpan={7} className="px-4 py-2 text-xs font-bold text-ink-muted uppercase tracking-wider">
                      ✓ Entregadas, facturadas y canceladas · {doneNotes.length}
                    </td>
                  </tr>
                )}
                {doneNotes.map(n => (
                  <tr key={n.id}
                    onClick={() => setSelectedId(n.id)}
                    className={clsx(
                      'cursor-pointer transition-colors opacity-80',
                      selectedId === n.id ? 'bg-brand-500/15 opacity-100' : 'hover:bg-surface-elevated/40 hover:opacity-100'
                    )}>
                    <td className="font-mono font-semibold text-purple-300"><DocLink to={docHref(n.id)} onOpen={() => setSelectedId(n.id)}>{n.document_number}</DocLink></td>
                    <td>
                      <p className="font-medium text-ink-primary">{n.partner_name}</p>
                      {n.partner_tax_name && n.partner_tax_name !== n.partner_name && (
                        <p className="text-[11px] text-ink-secondary">{n.partner_tax_name}</p>
                      )}
                    </td>
                    <td className="font-mono text-xs text-ink-muted">{n.order_number || '—'}</td>
                    <td className="text-xs text-ink-secondary">{fmtDateOnly(n.issue_date)}</td>
                    <td className="text-xs text-ink-secondary">{n.receiver_name || '—'}</td>
                    <td>
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <Badge status={n.status} />
                        <InvoiceChip note={n} />
                        {n.price_adjusted && (
                          <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-status-info/15 text-status-info">
                            Precio corregido
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="text-right font-mono tabular-nums font-medium"
                      title="Total de la remisión sin IVA. El IVA se calcula al facturar.">
                      {fmtMXN(n.subtotal_mxn ?? n.total_mxn, n.currency)}
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

      {showForm && (
        <RemisionFormModal
          onClose={() => setShowForm(false)}
          onCreated={(note) => {
            setCreatedMsg(`Remisión ${note.document_number} generada en estado "Emitida".`)
            setSelectedId(note.id)
          }}
        />
      )}

      {selectedId && (
        <RemisionDetallePanel
          noteId={selectedId}
          onClose={closeDoc}
        />
      )}
    </div>
  )
}
