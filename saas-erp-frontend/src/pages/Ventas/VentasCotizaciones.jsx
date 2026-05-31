import { useState, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { quotationsApi } from '@/api/quotations'
import Badge from '@/components/ui/Badge'
import Spinner from '@/components/ui/Spinner'
import Can from '@/components/auth/Can'
import CollapsibleFilters from '@/components/ui/CollapsibleFilters'
import { CotizacionFormModal } from '@/components/cotizaciones/CotizacionFormModal'
import { CotizacionDetallePanel } from '@/components/cotizaciones/CotizacionDetallePanel'
import { fmtMXN, fmtDate, fmtDateOnly} from '@/utils/fmt'
import clsx from 'clsx'

const STATUS_OPTS = [
  ['',          'Todos los estados'],
  ['draft',     'Borrador'],
  ['sent',      'Enviada'],
  ['accepted',  'Aceptada'],
  ['converted', 'Convertida a pedido'],
  ['rejected',  'Rechazada'],
  ['expired',   'Expirada'],
  ['cancelled', 'Cancelada'],
]

const PAGE_SIZE = 25

// Cotizaciones "pendientes de respuesta del cliente"
const PENDING_STATUSES = ['draft', 'sent', 'accepted']

// Urgencia comparando valid_until vs hoy (vigencia)
function getValidityUrgency(validUntil) {
  if (!validUntil) return 'none'
  const today = new Date(); today.setHours(0, 0, 0, 0)
  const vu = new Date(validUntil); vu.setHours(0, 0, 0, 0)
  if (vu < today) return 'overdue'   // vencida (vamos a expirar en el próximo tick)
  if (vu.getTime() === today.getTime()) return 'today'
  // Si vence en <=3 días, también urgente
  const diff = (vu.getTime() - today.getTime()) / (1000 * 60 * 60 * 24)
  if (diff <= 3) return 'soon'
  return 'future'
}

const URGENCY_ROW_CLASS = {
  overdue: 'bg-status-danger/10 hover:bg-status-danger/15',
  today:   'bg-status-warning/10 hover:bg-status-warning/15',
  soon:    'bg-status-warning/10/60 hover:bg-status-warning/15',
  future:  'bg-status-success/10 hover:bg-status-success/15',
  none:    'hover:bg-surface-elevated/40',
}

export default function VentasCotizaciones() {
  const [statusFilter, setStatusFilter] = useState('')
  const [search, setSearch]             = useState('')
  const [from, setFrom]                 = useState('')
  const [to, setTo]                     = useState('')
  const [page, setPage]                 = useState(1)

  const [showForm, setShowForm]     = useState(false)
  const [selectedId, setSelectedId] = useState(null)
  const [createdMsg, setCreatedMsg] = useState(null)

  const queryParams = useMemo(() => {
    const p = { page, limit: PAGE_SIZE }
    if (statusFilter) p.status = statusFilter
    if (from)         p.from   = from
    if (to)           p.to     = to
    return p
  }, [statusFilter, from, to, page])

  const { data, isLoading, isFetching, error } = useQuery({
    queryKey: ['quotations', queryParams],
    queryFn:  () => quotationsApi.list(queryParams),
    keepPreviousData: true,
  })

  const quotations = useMemo(() => {
    const list = data?.data || []
    if (!search.trim()) return list
    const q = search.trim().toLowerCase()
    return list.filter(o =>
      (o.quotation_number || '').toLowerCase().includes(q) ||
      (o.partner_name     || '').toLowerCase().includes(q) ||
      (o.partner_rfc      || '').toLowerCase().includes(q)
    )
  }, [data, search])

  // Split: pendientes (draft/sent/accepted) ordenadas por valid_until asc
  // (las que están por expirar primero). Cerradas abajo.
  const { pendingQs, doneQs } = useMemo(() => {
    const pending = []
    const done    = []
    for (const q of quotations) {
      if (PENDING_STATUSES.includes(q.status)) pending.push(q)
      else done.push(q)
    }
    const FAR_FUTURE = 8640000000000000
    pending.sort((a, b) => {
      const da = a.valid_until ? new Date(a.valid_until).getTime() : FAR_FUTURE
      const db = b.valid_until ? new Date(b.valid_until).getTime() : FAR_FUTURE
      return da - db
    })
    return { pendingQs: pending, doneQs: done }
  }, [quotations])

  const total = data?.total || 0
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  return (
    <div className="page-enter flex flex-col gap-4">
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold text-ink-primary">Cotizaciones</h1>
          <p className="text-xs text-ink-muted mt-0.5">
            Cotiza productos a clientes con vigencia. Al aceptar se convierte automáticamente en pedido.
          </p>
        </div>
        <Can do="sales:create">
          <button onClick={() => setShowForm(true)} className="btn-primary w-full justify-center sm:w-auto">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4"/>
            </svg>
            Nueva cotización
          </button>
        </Can>
      </div>

      {/* Feedback */}
      {createdMsg && (
        <div className="flex items-center gap-2 bg-status-success/10 border border-status-success/40 rounded-lg px-3 py-2">
          <svg className="w-4 h-4 text-status-success shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7"/>
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
        activeCount={[search, statusFilter, from, to].filter(Boolean).length}>
        <div className="card p-4 flex flex-col sm:flex-row sm:flex-wrap gap-3 sm:items-end">
          <div className="sm:flex-1 sm:min-w-[200px]">
            <label className="label">Buscar</label>
            <input className="input" placeholder="Número, cliente o RFC..."
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

      {/* Tabla */}
      <div className="card overflow-hidden">
        {isLoading ? (
          <div className="flex justify-center py-16"><Spinner /></div>
        ) : error ? (
          <div className="p-8 text-center">
            <p className="text-sm text-status-danger">
              {error.response?.data?.error || error.message || 'Error al cargar cotizaciones'}
            </p>
          </div>
        ) : quotations.length === 0 ? (
          <div className="flex flex-col items-center gap-3 py-16 text-center">
            <div className="w-12 h-12 rounded-xl bg-surface-elevated/60 flex items-center justify-center">
              <svg className="w-6 h-6 text-ink-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                  d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/>
              </svg>
            </div>
            <div>
              <p className="text-sm font-medium text-ink-secondary">
                {search || statusFilter || from || to ? 'Sin resultados para los filtros aplicados' : 'Aún no hay cotizaciones'}
              </p>
              {!search && !statusFilter && !from && !to && (
                <button onClick={() => setShowForm(true)} className="btn-primary btn-sm mt-3">
                  Crear la primera cotización
                </button>
              )}
            </div>
          </div>
        ) : (
          <>
            <table className="table">
              <thead>
                <tr>
                  <th>Número</th>
                  <th>Cliente</th>
                  <th>F. emisión</th>
                  <th>Vigencia</th>
                  <th>Estado</th>
                  <th className="text-right">Total</th>
                </tr>
              </thead>
              <tbody>
                {/* ── Sección: Pendientes de respuesta ───────────────── */}
                {pendingQs.length > 0 && (
                  <tr className="bg-surface-elevated/60">
                    <td colSpan={6} className="px-4 py-2 text-xs font-bold text-brand-300 uppercase tracking-wider">
                      ⏳ En proceso · {pendingQs.length}
                      <span className="ml-3 text-[10px] font-medium text-ink-muted normal-case tracking-normal">
                        🔴 vencida · 🟡 vence pronto (≤3 días) · 🟢 vigente
                      </span>
                    </td>
                  </tr>
                )}
                {pendingQs.map(q => {
                  const urgency = getValidityUrgency(q.valid_until)
                  return (
                    <tr key={q.id}
                      onClick={() => setSelectedId(q.id)}
                      className={clsx(
                        'cursor-pointer transition-colors',
                        selectedId === q.id ? 'bg-brand-500/15' : URGENCY_ROW_CLASS[urgency]
                      )}>
                      <td className="font-mono font-semibold text-brand-300">{q.quotation_number}</td>
                      <td>
                        <p className="font-medium text-ink-primary">{q.partner_name}</p>
                        {q.partner_rfc && <p className="text-[10px] text-ink-muted font-mono">{q.partner_rfc}</p>}
                      </td>
                      <td className="text-xs text-ink-secondary">{fmtDate(q.created_at)}</td>
                      <td className={clsx('text-xs font-semibold',
                        urgency === 'overdue' ? 'text-status-danger' :
                        urgency === 'today' || urgency === 'soon' ? 'text-status-warning' :
                        urgency === 'future' ? 'text-status-success' : 'text-ink-muted')}>
                        {q.valid_until ? fmtDateOnly(q.valid_until) : 'Sin vigencia'}
                      </td>
                      <td><Badge status={q.status} /></td>
                      <td className="text-right font-mono tabular-nums font-medium"
                        title="Total de la cotización sin IVA. El IVA se calcula al facturar el pedido.">
                        {fmtMXN(q.subtotal_mxn ?? q.total_mxn, q.currency)}
                      </td>
                    </tr>
                  )
                })}

                {/* ── Sección: Cerradas ──────────────────────────────── */}
                {doneQs.length > 0 && (
                  <tr className="bg-surface-elevated/60">
                    <td colSpan={6} className="px-4 py-2 text-xs font-bold text-ink-muted uppercase tracking-wider">
                      ✓ Convertidas, rechazadas, expiradas y canceladas · {doneQs.length}
                    </td>
                  </tr>
                )}
                {doneQs.map(q => (
                  <tr key={q.id}
                    onClick={() => setSelectedId(q.id)}
                    className={clsx(
                      'cursor-pointer transition-colors opacity-80',
                      selectedId === q.id ? 'bg-brand-500/15 opacity-100' : 'hover:bg-surface-elevated/40 hover:opacity-100'
                    )}>
                    <td className="font-mono font-semibold text-brand-300">{q.quotation_number}</td>
                    <td>
                      <p className="font-medium text-ink-primary">{q.partner_name}</p>
                      {q.partner_rfc && <p className="text-[10px] text-ink-muted font-mono">{q.partner_rfc}</p>}
                    </td>
                    <td className="text-xs text-ink-secondary">{fmtDate(q.created_at)}</td>
                    <td className="text-xs text-ink-muted">{q.valid_until ? fmtDateOnly(q.valid_until) : '—'}</td>
                    <td>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Badge status={q.status} />
                        {q.converted_order_number && (
                          <span className="text-[10px] font-mono text-teal-300">→ {q.converted_order_number}</span>
                        )}
                      </div>
                    </td>
                    <td className="text-right font-mono tabular-nums font-medium">
                      {fmtMXN(q.subtotal_mxn ?? q.total_mxn, q.currency)}
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
                    className="btn-ghost btn-sm disabled:opacity-30">Anterior</button>
                  <span className="text-sm self-center px-2 text-ink-secondary">{page} / {totalPages}</span>
                  <button disabled={page === totalPages} onClick={() => setPage(p => p + 1)}
                    className="btn-ghost btn-sm disabled:opacity-30">Siguiente</button>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {showForm && (
        <CotizacionFormModal
          onClose={() => setShowForm(false)}
          onCreated={(q) => {
            setShowForm(false)
            setCreatedMsg(`Cotización ${q.quotation_number} creada en borrador.`)
            setSelectedId(q.id)
          }} />
      )}

      {selectedId && (
        <CotizacionDetallePanel
          quotationId={selectedId}
          onClose={() => setSelectedId(null)}
          onConverted={(orderInfo) => {
            setCreatedMsg(`Convertida a pedido ${orderInfo.order_number}.`)
            setSelectedId(null)
          }} />
      )}
    </div>
  )
}
