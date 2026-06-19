import { useState, useMemo, useCallback, useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTableSort } from '@/hooks/useTableSort'
import { SortableHeader } from '@/components/ui/SortableHeader'
import { financialsApi } from '@/api/financials'
import { partnersApi } from '@/api/partners'
import Autocomplete from '@/components/ui/Autocomplete'
import Badge from '@/components/ui/Badge'
import Spinner from '@/components/ui/Spinner'
import Can from '@/components/auth/Can'
import { PagoModal } from '@/components/finanzas/PagoModal'
import { IdentificarPagoModal } from '@/components/finanzas/IdentificarPagoModal'
import { CxCDetallePanel } from '@/components/finanzas/CxCDetallePanel'
import { fmtMXN, fmtDate, fmtDateOnly} from '@/utils/fmt'
import clsx from 'clsx'

const STATUS_OPTS = [
  ['',           'Todos los estados'],
  ['pending',    'Pendiente'],
  ['partial',    'Parcial'],
  ['paid',       'Pagado'],
  ['cancelled',  'Cancelado'],
]

const DOC_TYPE_LABEL = {
  invoice:      'Factura',
  remission:    'Remisión',
  credit_note:  'Nota de crédito',
}

const COMPLEMENT_LABELS = {
  not_applicable: { text: 'No aplica',     cls: 'bg-surface-elevated/60 text-ink-muted',     title: 'Documento no fiscal (no requiere complemento)' },
  not_required:   { text: 'No requiere',   cls: 'bg-surface-elevated/60 text-ink-muted',     title: 'Factura PUE — no necesita complemento de pago' },
  cancelled:      { text: '—',             cls: 'bg-surface-elevated/60 text-ink-muted',     title: 'Factura cancelada' },
  draft:          { text: 'Borrador',      cls: 'bg-status-warning/15 text-status-warning',   title: 'Factura aún sin timbrar' },
  pending:        { text: 'Sin complemento', cls: 'bg-status-warning/15 text-status-warning', title: 'PPD sin pago aplicado todavía' },
  partial:        { text: 'Parcial',       cls: 'bg-status-warning/15 text-status-warning',   title: 'PPD con cobro parcial cubierto por complementos' },
  complete:       { text: 'Completo',      cls: 'bg-emerald-100 text-emerald-700', title: 'Todos los pagos tienen complemento timbrado' },
}

const PAGE_SIZE = 25

export default function CuentasPorCobrar() {
  const [statusFilter, setStatusFilter] = useState('')
  const [partner, setPartner]           = useState(null)
  const [search, setSearch]             = useState('')
  const [from, setFrom]                 = useState('')
  const [to, setTo]                     = useState('')
  const [page, setPage]                 = useState(1)

  const [showPagoModal, setShowPagoModal] = useState(false)
  const [showMatcherModal, setShowMatcherModal] = useState(false)
  const [selectedArId, setSelectedArId]   = useState(null)
  const [paidMsg, setPaidMsg]             = useState(null)

  const { sortBy, sortDir, onSort } = useTableSort('vencimiento', 'asc')
  useEffect(() => { setPage(1) }, [statusFilter, partner, from, to, sortBy, sortDir])

  const queryParams = useMemo(() => {
    const p = { page, limit: PAGE_SIZE, sortBy, sortDir }
    if (statusFilter)  p.status    = statusFilter
    if (partner?.id)   p.partnerId = partner.id
    if (from)          p.from      = from
    if (to)            p.to        = to
    return p
  }, [statusFilter, partner, from, to, page, sortBy, sortDir])

  const { data, isLoading, isFetching, error } = useQuery({
    queryKey: ['cxc', queryParams],
    queryFn:  () => financialsApi.listCXC(queryParams),
    keepPreviousData: true,
  })

  const searchPartners = useCallback(async (q) => {
    const res = await partnersApi.list({ search: q, role: 'customer', limit: 20 })
    return (res.data || res).map(p => ({ id: p.id, label: p.name, sub: [p.rfc, p.tax_name && p.tax_name !== p.name ? p.tax_name : null].filter(Boolean).join(' · ') }))
  }, [])

  // Filtro local por búsqueda libre
  const docs = useMemo(() => {
    const list = data?.data || []
    if (!search.trim()) return list
    const q = search.trim().toLowerCase()
    return list.filter(d =>
      (d.document_number || '').toLowerCase().includes(q) ||
      (d.partner_name    || '').toLowerCase().includes(q) ||
      (d.partner_rfc     || '').toLowerCase().includes(q)
    )
  }, [data, search])

  const total = data?.total || 0
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  // Resumen sobre los documentos en la página actual
  const summary = useMemo(() => {
    const arr = data?.data || []
    return {
      count:    arr.length,
      total:    arr.reduce((s, d) => s + parseFloat(d.amount_total || 0), 0),
      paid:     arr.reduce((s, d) => s + parseFloat(d.amount_paid || 0), 0),
      pending:  arr.reduce((s, d) => s + parseFloat(d.amount_pending || 0), 0),
      overdue:  arr.filter(d => d.is_overdue).length,
    }
  }, [data])

  return (
    <div className="page-enter flex flex-col gap-4">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-xl font-semibold text-ink-primary">Pagos recibidos</h1>
          <p className="text-xs text-ink-muted mt-0.5">Documentos pendientes de cobro, aplicación de pagos y anticipos</p>
        </div>
        <div className="flex gap-2">
          <Can do="financials:create">
            <button onClick={() => setShowMatcherModal(true)} className="btn-secondary"
              title="Identificar un depósito bancario sin emisor conocido">
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"/>
              </svg>
              Identificar pago
            </button>
          </Can>
          <Can do="financials:create">
            <button onClick={() => setShowPagoModal(true)} className="btn-primary">
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>
              </svg>
              Registrar pago
            </button>
          </Can>
        </div>
      </div>

      {paidMsg && (
        <div className="flex items-center gap-2 bg-status-success/10 border border-status-success/40 rounded-lg px-3 py-2">
          <svg className="w-4 h-4 text-status-success shrink-0" fill="currentColor" viewBox="0 0 24 24">
            <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/>
          </svg>
          <p className="text-sm text-status-success flex-1">{paidMsg}</p>
          <button onClick={() => setPaidMsg(null)} className="text-status-success hover:text-status-success">
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12"/>
            </svg>
          </button>
        </div>
      )}

      {/* Resumen */}
      {!isLoading && data?.data?.length > 0 && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <div className="card p-3">
            <p className="text-[10px] text-ink-muted uppercase tracking-wide">Documentos</p>
            <p className="text-lg font-semibold text-ink-primary mt-0.5">{summary.count}</p>
          </div>
          <div className="card p-3">
            <p className="text-[10px] text-ink-muted uppercase tracking-wide">Total emitido</p>
            <p className="text-lg font-mono font-semibold text-ink-primary mt-0.5">{fmtMXN(summary.total)}</p>
          </div>
          <div className="card p-3 bg-status-success/10/40">
            <p className="text-[10px] text-green-500 uppercase tracking-wide">Pagado</p>
            <p className="text-lg font-mono font-semibold text-status-success mt-0.5">{fmtMXN(summary.paid)}</p>
          </div>
          <div className={clsx('card p-3', summary.overdue > 0 ? 'bg-status-danger/10/40' : 'bg-status-warning/10/40')}>
            <p className={clsx('text-[10px] uppercase tracking-wide',
              summary.overdue > 0 ? 'text-status-danger' : 'text-amber-500')}>
              Pendiente {summary.overdue > 0 && `· ${summary.overdue} vencido${summary.overdue !== 1 ? 's' : ''}`}
            </p>
            <p className={clsx('text-lg font-mono font-semibold mt-0.5',
              summary.overdue > 0 ? 'text-status-danger' : 'text-status-warning')}>
              {fmtMXN(summary.pending)}
            </p>
          </div>
        </div>
      )}

      {/* Filtros */}
      <div className="card p-4 flex flex-wrap gap-3 items-end">
        <div className="flex-1 min-w-[200px]">
          <label className="label">Buscar</label>
          <input className="input" placeholder="Número de documento, cliente, RFC..."
            value={search} onChange={e => setSearch(e.target.value)} />
        </div>
        {/* Filtros adicionales — ocultos en móvil (allí solo se busca) */}
        <div className="hidden sm:contents">
          <div className="min-w-[200px]">
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
          {(statusFilter || from || to || search || partner) && (
            <button onClick={() => { setStatusFilter(''); setFrom(''); setTo(''); setSearch(''); setPartner(null); setPage(1) }}
              className="btn-ghost btn-sm text-ink-muted">
              Limpiar filtros
            </button>
          )}
        </div>
      </div>

      {/* Tabla */}
      <div className="card p-0 overflow-x-auto">
        {isLoading ? (
          <div className="flex justify-center py-16"><Spinner /></div>
        ) : error ? (
          <div className="p-8 text-center">
            <p className="text-sm text-status-danger">
              {error.response?.data?.error || error.message || 'Error al cargar pagos recibidos'}
            </p>
          </div>
        ) : docs.length === 0 ? (
          <div className="flex flex-col items-center gap-3 py-16 text-center">
            <div className="w-12 h-12 rounded-xl bg-surface-elevated/60 flex items-center justify-center">
              <svg className="w-6 h-6 text-ink-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>
              </svg>
            </div>
            <p className="text-sm font-medium text-ink-secondary">
              {search || statusFilter || from || to || partner ? 'Sin resultados para los filtros aplicados' : 'No hay pagos pendientes de recibir'}
            </p>
          </div>
        ) : (
          <>
            <table className="table">
              <thead>
                <tr>
                  <SortableHeader sortKey="folio"       sortBy={sortBy} sortDir={sortDir} onSort={onSort}>Documento</SortableHeader>
                  <SortableHeader sortKey="cliente"     sortBy={sortBy} sortDir={sortDir} onSort={onSort} initialDir="asc">Cliente</SortableHeader>
                  <SortableHeader sortKey="fecha"       sortBy={sortBy} sortDir={sortDir} onSort={onSort}>F. emisión</SortableHeader>
                  <SortableHeader sortKey="vencimiento" sortBy={sortBy} sortDir={sortDir} onSort={onSort} initialDir="asc">Vence</SortableHeader>
                  <SortableHeader sortKey="estatus"     sortBy={sortBy} sortDir={sortDir} onSort={onSort} initialDir="asc">Estado</SortableHeader>
                  <th>Complemento</th>
                  <SortableHeader sortKey="total"       sortBy={sortBy} sortDir={sortDir} onSort={onSort} align="right">Total</SortableHeader>
                  <SortableHeader sortKey="pendiente"   sortBy={sortBy} sortDir={sortDir} onSort={onSort} align="right">Pendiente</SortableHeader>
                </tr>
              </thead>
              <tbody>
                {docs.map(d => {
                  const compInfo = COMPLEMENT_LABELS[d.complement_status]
                                || COMPLEMENT_LABELS.not_applicable
                  return (
                  <tr key={d.id}
                    onClick={() => setSelectedArId(d.id)}
                    className={clsx(
                      'cursor-pointer transition-colors',
                      selectedArId === d.id ? 'bg-brand-500/10' : 'hover:bg-surface-elevated/40',
                      d.is_overdue && 'bg-status-danger/10/30'
                    )}>
                    <td>
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] font-bold uppercase tracking-wide bg-surface-elevated/60 text-ink-secondary px-1.5 py-0.5 rounded-full">
                          {DOC_TYPE_LABEL[d.document_type] || d.document_type}
                        </span>
                        <span className="font-mono font-semibold text-brand-300">{d.document_number}</span>
                        {d.invoice_payment_method === 'PPD' && (
                          <span className="text-[10px] font-bold uppercase bg-status-warning/15 text-status-warning px-1.5 py-0.5 rounded-full">
                            PPD
                          </span>
                        )}
                      </div>
                    </td>
                    <td>
                      <p className="font-medium text-ink-primary">{d.partner_name}</p>
                      {d.partner_rfc && <p className="text-[10px] text-ink-muted font-mono">{d.partner_rfc}</p>}
                    </td>
                    <td className="text-xs text-ink-secondary">{fmtDateOnly(d.issue_date)}</td>
                    <td className={clsx('text-xs',
                      d.is_overdue ? 'text-status-danger font-semibold' : 'text-ink-secondary')}>
                      {fmtDateOnly(d.due_date)}
                    </td>
                    <td><Badge status={d.is_overdue ? 'overdue' : d.status} /></td>
                    <td>
                      <span
                        title={compInfo.title}
                        className={clsx(
                          'text-[10px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded-full',
                          compInfo.cls
                        )}>
                        {compInfo.text}
                      </span>
                    </td>
                    <td className="text-right font-mono tabular-nums">{fmtMXN(d.amount_total)}</td>
                    <td className={clsx('text-right font-mono tabular-nums font-semibold',
                      parseFloat(d.amount_pending) <= 0.01 ? 'text-status-success' :
                        (d.is_overdue ? 'text-status-danger' : 'text-status-warning'))}>
                      {fmtMXN(d.amount_pending)}
                    </td>
                  </tr>
                  )
                })}
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

      {showPagoModal && (
        <PagoModal
          onClose={() => setShowPagoModal(false)}
          onSaved={(res) => {
            const parts = [`Pago de ${fmtMXN(res.amount)} registrado. Aplicado ${fmtMXN(res.totalApplied)}`]
            if (res.advanceGenerated) parts.push(`+ anticipo ${fmtMXN(res.advanceGenerated)}`)
            if (res.complementsIssued?.length) {
              parts.push(`· ${res.complementsIssued.length} complemento(s) timbrado(s)`)
            }
            if (res.complementsPending?.length) {
              const pend = res.complementsPending.map(p => p.document_number).join(', ')
              parts.push(`· ⚠️ ${res.complementsPending.length} complemento(s) PENDIENTE(S) de timbrar (${pend}). El cobro quedó registrado; timbra el complemento desde el detalle del documento cuando Facturapi esté disponible.`)
            }
            if (res.complementsSkipped?.length) {
              const reasons = res.complementsSkipped
                .map(s => `${s.document_number}: ${s.reason}`)
                .join(' · ')
              parts.push(`· Sin complemento: ${reasons}`)
            }
            setPaidMsg(parts.join(' '))
          }}
        />
      )}

      {showMatcherModal && (
        <IdentificarPagoModal
          onClose={() => setShowMatcherModal(false)}
          onSaved={(res) => {
            const m = res.match
            let msg =
              `Pago de ${fmtMXN(res.amount)} identificado para ${m.partner_name}: ` +
              `${m.invoices.map(i => i.document_number).join(', ')}.`
            if (res.complementsPending?.length) {
              const pend = res.complementsPending.map(p => p.document_number).join(', ')
              msg += ` ⚠️ ${res.complementsPending.length} complemento(s) PENDIENTE(S) de timbrar (${pend}); el cobro quedó registrado, timbra el complemento desde el detalle cuando Facturapi esté disponible.`
            }
            setPaidMsg(msg)
          }}
        />
      )}

      {selectedArId && (
        <CxCDetallePanel
          arId={selectedArId}
          onClose={() => setSelectedArId(null)}
        />
      )}
    </div>
  )
}
