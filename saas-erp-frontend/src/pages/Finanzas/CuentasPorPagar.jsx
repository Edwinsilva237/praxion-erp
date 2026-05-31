import { useState, useMemo, useCallback } from 'react'
import { useQuery } from '@tanstack/react-query'
import { cxpApi } from '@/api/cxp'
import { partnersApi } from '@/api/partners'
import Autocomplete from '@/components/ui/Autocomplete'
import Badge from '@/components/ui/Badge'
import Spinner from '@/components/ui/Spinner'
import Can from '@/components/auth/Can'
import { PagoProveedorModal } from '@/components/finanzas/PagoProveedorModal'
import { CxPDetallePanel } from '@/components/finanzas/CxPDetallePanel'
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

const RECON_LABELS = {
  reconciled:  { text: 'Conciliada',     cls: 'bg-emerald-100 text-emerald-700', title: 'Factura concilia con recepciones ligadas' },
  with_diff:   { text: 'Con diferencia', cls: 'bg-status-warning/15 text-status-warning',     title: 'Hay diferencia entre el total de la factura y las recepciones' },
  pending:     { text: 'Sin recepción',  cls: 'bg-surface-elevated/60 text-ink-muted',       title: 'Factura sin recepciones vinculadas todavía' },
}

const PAGE_SIZE = 25

export default function CuentasPorPagar() {
  const [statusFilter, setStatusFilter] = useState('')
  const [partner, setPartner]           = useState(null)
  const [search, setSearch]             = useState('')
  const [from, setFrom]                 = useState('')
  const [to, setTo]                     = useState('')
  const [page, setPage]                 = useState(1)

  const [showPagoModal, setShowPagoModal] = useState(false)
  const [selectedApId, setSelectedApId]   = useState(null)
  const [paidMsg, setPaidMsg]             = useState(null)

  const queryParams = useMemo(() => {
    const p = { page, limit: PAGE_SIZE }
    if (statusFilter) p.status    = statusFilter
    if (partner?.id)  p.partnerId = partner.id
    if (from)         p.from      = from
    if (to)           p.to        = to
    return p
  }, [statusFilter, partner, from, to, page])

  const { data, isLoading, isFetching, error } = useQuery({
    queryKey: ['cxp', queryParams],
    queryFn:  () => cxpApi.listCXP(queryParams),
    keepPreviousData: true,
  })

  const searchPartners = useCallback(async (q) => {
    const res = await partnersApi.list({ search: q, type: 'supplier', limit: 20 })
    return (res.data || res).map(p => ({ id: p.id, label: p.name, sub: p.rfc || '' }))
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
    // Anticipos: sumamos solo una vez por proveedor para no duplicar.
    const seen = new Set()
    let advances = 0
    for (const d of arr) {
      if (seen.has(d.partner_id || '')) continue
      seen.add(d.partner_id || '')
      advances += parseFloat(d.partner_advance_available || 0)
    }
    return {
      count:    arr.length,
      total:    arr.reduce((s, d) => s + parseFloat(d.amount_total || 0), 0),
      paid:     arr.reduce((s, d) => s + parseFloat(d.amount_paid || 0), 0),
      pending:  arr.reduce((s, d) => s + parseFloat(d.amount_pending || 0), 0),
      overdue:  arr.filter(d => d.is_overdue).length,
      advances,
    }
  }, [data])

  return (
    <div className="page-enter flex flex-col gap-4">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-xl font-semibold text-ink-primary">Pagos emitidos</h1>
          <p className="text-xs text-ink-muted mt-0.5">Facturas y remisiones de proveedor pendientes de pago</p>
        </div>
        <div className="flex gap-2">
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
        <div className={clsx('grid gap-3',
          summary.advances > 0 ? 'grid-cols-2 md:grid-cols-5' : 'grid-cols-2 md:grid-cols-4')}>
          <div className="card p-3">
            <p className="text-[10px] text-ink-muted uppercase tracking-wide">Documentos</p>
            <p className="text-lg font-semibold text-ink-primary mt-0.5">{summary.count}</p>
          </div>
          <div className="card p-3">
            <p className="text-[10px] text-ink-muted uppercase tracking-wide">Total recibido</p>
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
          {summary.advances > 0 && (
            <div className="card p-3 bg-emerald-50/40">
              <p className="text-[10px] text-emerald-600 uppercase tracking-wide">💰 Anticipos</p>
              <p className="text-lg font-mono font-semibold text-emerald-700 mt-0.5">
                {fmtMXN(summary.advances)}
              </p>
              <p className="text-[10px] text-emerald-600 mt-0.5">saldo a favor</p>
            </div>
          )}
        </div>
      )}

      {/* Filtros */}
      <div className="card p-4 flex flex-wrap gap-3 items-end">
        <div className="flex-1 min-w-[200px]">
          <label className="label">Buscar</label>
          <input className="input" placeholder="Número de documento, proveedor, RFC..."
            value={search} onChange={e => setSearch(e.target.value)} />
        </div>
        {/* Filtros adicionales — ocultos en móvil (allí solo se busca) */}
        <div className="hidden sm:contents">
          <div className="min-w-[200px]">
            <label className="label">Proveedor</label>
            <Autocomplete value={partner}
              onChange={(p) => { setPartner(p); setPage(1) }}
              onSearch={searchPartners}
              placeholder="Filtrar por proveedor..." />
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
      <div className="card overflow-hidden">
        {isLoading ? (
          <div className="flex justify-center py-16"><Spinner /></div>
        ) : error ? (
          <div className="p-8 text-center">
            <p className="text-sm text-status-danger">
              {error.response?.data?.error || error.message || 'Error al cargar pagos emitidos'}
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
              {search || statusFilter || from || to || partner ? 'Sin resultados para los filtros aplicados' : 'No hay pagos pendientes de emitir'}
            </p>
          </div>
        ) : (
          <>
            <table className="table">
              <thead>
                <tr>
                  <th>Documento</th>
                  <th>Proveedor</th>
                  <th>F. emisión</th>
                  <th>Vence</th>
                  <th>Estado</th>
                  <th>Conciliación</th>
                  <th title="Evidencias adjuntas">📎</th>
                  <th className="text-right">Total</th>
                  <th className="text-right">Pendiente</th>
                </tr>
              </thead>
              <tbody>
                {docs.map(d => {
                  const reconInfo = RECON_LABELS[d.reconciliation_status] || RECON_LABELS.pending
                  return (
                  <tr key={d.id}
                    onClick={() => setSelectedApId(d.id)}
                    className={clsx(
                      'cursor-pointer transition-colors',
                      selectedApId === d.id ? 'bg-brand-500/10' : 'hover:bg-surface-elevated/40',
                      d.is_overdue && 'bg-status-danger/10/30'
                    )}>
                    <td>
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] font-bold uppercase tracking-wide bg-surface-elevated/60 text-ink-secondary px-1.5 py-0.5 rounded-full">
                          {DOC_TYPE_LABEL[d.document_type] || d.document_type}
                        </span>
                        <span className="font-mono font-semibold text-brand-300">{d.document_number}</span>
                        {d.uuid_sat && (
                          <span className="text-[10px] font-bold uppercase bg-emerald-100 text-emerald-700 px-1.5 py-0.5 rounded-full"
                            title="Factura con UUID SAT registrado">
                            CFDI
                          </span>
                        )}
                      </div>
                    </td>
                    <td>
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <p className="font-medium text-ink-primary">{d.partner_name}</p>
                        {parseFloat(d.partner_advance_available || 0) > 0 && (
                          <span
                            title={`Saldo a favor del tenant: ${fmtMXN(d.partner_advance_available)} en anticipos`}
                            className="inline-flex items-center gap-1 text-[10px] font-bold bg-emerald-100 text-emerald-700 px-1.5 py-0.5 rounded-full"
                          >
                            💰 {fmtMXN(d.partner_advance_available)}
                          </span>
                        )}
                      </div>
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
                        title={reconInfo.title}
                        className={clsx(
                          'text-[10px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded-full',
                          reconInfo.cls
                        )}>
                        {reconInfo.text}
                      </span>
                    </td>
                    <td>
                      {d.attachment_count > 0 ? (
                        <span
                          title={`${d.attachment_count} evidencia${d.attachment_count !== 1 ? 's' : ''} adjunta${d.attachment_count !== 1 ? 's' : ''}`}
                          className="inline-flex items-center gap-1 text-[10px] font-bold bg-status-info/15 text-status-info px-1.5 py-0.5 rounded-full"
                        >
                          📎 {d.attachment_count}
                        </span>
                      ) : (
                        <span className="text-[10px] text-ink-muted" title="Sin evidencias">—</span>
                      )}
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
        <PagoProveedorModal
          onClose={() => setShowPagoModal(false)}
          onSaved={(res) => {
            setPaidMsg(`Pago de ${fmtMXN(res.amount)} registrado. Aplicado ${fmtMXN(res.total_applied || res.totalApplied || 0)}.`)
          }}
        />
      )}

      {selectedApId && (
        <CxPDetallePanel
          apId={selectedApId}
          onClose={() => setSelectedApId(null)}
        />
      )}
    </div>
  )
}
