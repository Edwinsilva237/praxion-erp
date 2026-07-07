import { useState, useMemo, useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { salesApi } from '@/api/sales'
import { useDebounced } from '@/hooks/useDebounced'
import { useTableSort } from '@/hooks/useTableSort'
import { SortableHeader } from '@/components/ui/SortableHeader'
import Badge from '@/components/ui/Badge'
import Spinner from '@/components/ui/Spinner'
import Can from '@/components/auth/Can'
import { PedidoFormModal } from '@/components/ventas/PedidoFormModal'
import { PedidoDetallePanel } from '@/components/ventas/PedidoDetallePanel'
import CollapsibleFilters from '@/components/ui/CollapsibleFilters'
import ScanButton from '@/components/scanner/ScanButton'
import { fmtMXN, fmtDate, fmtDateOnly, parseDateOnly } from '@/utils/fmt'
import { LIVE_LIST } from '@/config/livePolling'
import DocLink from '@/components/ui/DocLink'
import { useDeepLinkDoc } from '@/hooks/useDeepLinkDoc'
import clsx from 'clsx'

// Mini barra de progreso de entrega con dos segmentos:
//   - Verde: porcentaje YA entregado (remisiones con status=delivered)
//   - Ámbar: porcentaje remisionado pero todavía no entregado
//   - Gris claro: pendiente de remisionar
function DeliveryProgress({ delivered, remisioned, total }) {
  const d = parseFloat(delivered || 0)
  const r = parseFloat(remisioned || 0)
  const t = parseFloat(total || 0)
  if (t <= 0) return null
  const pctDelivered  = Math.min(Math.round((d / t) * 100), 100)
  const pctRemisionedOnly = Math.max(0, Math.min(Math.round(((r - d) / t) * 100), 100 - pctDelivered))
  return (
    <div className="flex items-center gap-2 mt-1 min-w-[140px]"
      title={`Entregado ${pctDelivered}% · Remisionado ${Math.round((r / t) * 100)}%`}>
      <div className="flex-1 h-1.5 bg-surface-elevated/60 rounded-full overflow-hidden flex">
        <div className="h-full bg-green-500 transition-all"
          style={{ width: `${pctDelivered}%` }} />
        <div className="h-full bg-amber-400 transition-all"
          style={{ width: `${pctRemisionedOnly}%` }} />
      </div>
      <span className="text-[10px] font-semibold tabular-nums text-ink-muted shrink-0">
        {pctDelivered}%
      </span>
    </div>
  )
}

// Decide si la fecha programada debe verse en rojo:
//   - Pedido entregado pero llegó después de la fecha programada
//   - Pedido NO entregado y la fecha programada ya pasó (vencido)
function isOrderLate(order) {
  if (!order.scheduled_date) return false
  // scheduled_date es una columna DATE (sin hora). new Date("2026-07-07") la
  // parsearía como medianoche UTC → en México (UTC−6) cae un día antes, así que
  // un pedido "para hoy" se veía vencido. parseDateOnly la ancla a medianoche
  // LOCAL para que el día de calendario no se mueva.
  const scheduled = parseDateOnly(order.scheduled_date)
  if (order.status === 'delivered') {
    if (!order.last_delivered_at) return false
    // last_delivered_at SÍ es un timestamp real: comparamos su día de calendario
    // local contra el programado (entregar el mismo día NO es tarde).
    const deliveredDay = new Date(order.last_delivered_at)
    deliveredDay.setHours(0, 0, 0, 0)
    return deliveredDay > scheduled
  }
  if (['draft', 'cancelled'].includes(order.status)) return false
  // En flujo activo: vencido si la fecha programada ya pasó
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  return scheduled < today
}

const STATUS_OPTS = [
  ['',            'Todos los estados'],
  ['draft',       'Borrador'],
  ['confirmed',   'Confirmado'],
  ['in_delivery', 'En reparto'],
  ['delivered',   'Entregado'],
  ['cancelled',   'Cancelado'],
]

const PAGE_SIZE = 25

// ── Estatus "pendiente de entrega" para split de la tabla ──────────────────
// Todo lo que no esté aquí cae a la sección "Entregados / cerrados".
const PENDING_STATUSES = ['confirmed', 'in_delivery', 'partially_delivered']

// Calcula urgencia de entrega: comparar scheduled_date contra hoy.
// - overdue:  ya pasó (vencido)
// - today:    es hoy
// - tomorrow: es mañana
// - future:   a más de un día
// - none:     sin fecha programada
function getDeliveryUrgency(scheduledDate) {
  if (!scheduledDate) return 'none'
  const today = new Date(); today.setHours(0, 0, 0, 0)
  // parseDateOnly ancla la fecha DATE a medianoche LOCAL (ver isOrderLate); sin
  // esto un pedido programado para HOY se clasificaba 'overdue' en vez de 'today'.
  const sched = parseDateOnly(scheduledDate)
  if (!sched) return 'none'
  const tomorrow = new Date(today); tomorrow.setDate(tomorrow.getDate() + 1)
  if (sched < today) return 'overdue'
  if (sched.getTime() === today.getTime())    return 'today'
  if (sched.getTime() === tomorrow.getTime()) return 'tomorrow'
  return 'future'
}

// Color de fondo de la fila por urgencia (escritorio).
const URGENCY_ROW_CLASS = {
  overdue:  'bg-status-danger/20 hover:bg-status-danger/25',
  today:    'bg-status-warning/20 hover:bg-status-warning/25',
  tomorrow: 'bg-status-info/20 hover:bg-status-info/25',
  future:   'bg-status-success/15 hover:bg-status-success/20',
  none:     'hover:bg-surface-elevated/40',
}

// Borde izquierdo de color por urgencia (tarjetas móviles).
const URGENCY_BORDER = {
  overdue:  'border-l-4 border-l-status-danger',
  today:    'border-l-4 border-l-status-warning',
  tomorrow: 'border-l-4 border-l-status-info',
  future:   'border-l-4 border-l-status-success',
  none:     '',
}

// Color del texto de la fecha por urgencia.
const URGENCY_TEXT_CLASS = {
  overdue:  'text-status-danger',
  today:    'text-status-warning',
  tomorrow: 'text-status-info',
  future:   'text-status-success',
  none:     'text-ink-secondary',
}

export default function VentasPedidos() {
  // Filtros
  const [statusFilter, setStatusFilter] = useState('')
  const [search, setSearch]             = useState('')
  const [from, setFrom]                 = useState('')
  const [to, setTo]                     = useState('')
  const [page, setPage]                 = useState(1)
  // Mostramos entregados/cerrados por defecto: el backend ya ordena activos
  // primero, así que la página no esconde renglones (causaba que se vieran
  // "saltados" entre páginas). El usuario puede colapsarlos con el toggle.
  const [showDone, setShowDone]         = useState(true)

  // Modal y panel. selectedId + deep-link: si la URL es /ventas/:id (nueva
  // pestaña) el panel abre solo; el clic normal lo abre in-app.
  const [showForm, setShowForm]         = useState(false)
  const { selectedId, setSelectedId, close: closeDoc, href: docHref } = useDeepLinkDoc('/ventas')
  const [createdMsg, setCreatedMsg]     = useState(null)

  // Búsqueda server-side (sobre TODO el dataset, no solo la página actual).
  const searchDebounced = useDebounced(search, 300)

  const { sortBy, sortDir, onSort } = useTableSort('relevancia', 'desc')

  // Al cambiar cualquier filtro u orden, volver a la página 1.
  useEffect(() => { setPage(1) }, [statusFilter, from, to, searchDebounced, sortBy, sortDir])

  const queryParams = useMemo(() => {
    const p = { page, limit: PAGE_SIZE, sortBy, sortDir }
    if (statusFilter) p.status = statusFilter
    if (from)         p.from   = from
    if (to)           p.to     = to
    if (searchDebounced.trim()) p.search = searchDebounced.trim()
    return p
  }, [statusFilter, from, to, searchDebounced, page, sortBy, sortDir])

  const { data, isLoading, isFetching, error } = useQuery({
    queryKey: ['sales-orders', queryParams],
    queryFn:  () => salesApi.listOrders(queryParams),
    keepPreviousData: true,
    ...LIVE_LIST,
  })

  const orders = data?.data || []

  // Split: pendientes de entrega arriba (ordenados por fecha programada asc),
  // entregados / cerrados abajo. Asignamos también la urgencia para colorear.
  const { pendingOrders, doneOrders } = useMemo(() => {
    const pending = []
    const done    = []
    for (const o of orders) {
      if (PENDING_STATUSES.includes(o.status)) pending.push(o)
      else done.push(o)
    }
    // El orden lo decide el backend (sortBy/sortDir, default fecha de creación
    // desc). Aquí solo separamos pendientes/listos preservando ese orden.
    return { pendingOrders: pending, doneOrders: done }
  }, [orders])

  // Si no hay pendientes, mostramos los entregados de una (si no, se vería vacío).
  const showDoneEffective = showDone || pendingOrders.length === 0

  const total = data?.total || 0
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  return (
    <div className="page-enter flex flex-col gap-4">
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold text-ink-primary">Pedidos de venta</h1>
          <p className="text-xs text-ink-muted mt-0.5">Captura, confirma y da seguimiento a los pedidos de tus clientes</p>
        </div>
        <Can do="sales:create">
          <button onClick={() => setShowForm(true)} className="btn-primary w-full justify-center sm:w-auto">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4"/>
            </svg>
            Nuevo pedido
          </button>
        </Can>
      </div>

      {/* Feedback de creación */}
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

      {/* Filtros */}
      <CollapsibleFilters
        activeCount={[search, statusFilter, from, to].filter(Boolean).length}>
        <div className="card p-4 flex flex-col sm:flex-row sm:flex-wrap gap-3 sm:items-end">
          <div className="sm:flex-1 sm:min-w-[200px]">
            <label className="label">Buscar</label>
            <div className="flex gap-2">
              <input className="input flex-1" placeholder="Número, cliente o RFC..."
                value={search} onChange={e => setSearch(e.target.value)} />
              <ScanButton onScan={code => setSearch(code)} title="Escanear código" />
            </div>
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
              {error.response?.data?.error || error.message || 'Error al cargar pedidos'}
            </p>
          </div>
        ) : orders.length === 0 ? (
          <div className="flex flex-col items-center gap-3 py-16 text-center">
            <div className="w-12 h-12 rounded-xl bg-surface-elevated/60 flex items-center justify-center">
              <svg className="w-6 h-6 text-ink-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"/>
              </svg>
            </div>
            <div>
              <p className="text-sm font-medium text-ink-secondary">
                {search || statusFilter || from || to ? 'Sin resultados para los filtros aplicados' : 'Aún no hay pedidos'}
              </p>
              {!search && !statusFilter && !from && !to && (
                <button onClick={() => setShowForm(true)} className="btn-primary btn-sm mt-3">
                  Crear el primer pedido
                </button>
              )}
            </div>
          </div>
        ) : (
          <>
            {/* ── Móvil: tarjetas con secciones ── */}
            <div className="md:hidden flex flex-col gap-3">
              {pendingOrders.length > 0 && (
                <div className="flex flex-col gap-2">
                  <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-brand-500/10 border border-brand-500/30">
                    <span className="text-sm font-bold text-brand-300 uppercase tracking-wider">⏳ Por entregar · {pendingOrders.length}</span>
                  </div>
                  {pendingOrders.map(o => {
                    const urgency = getDeliveryUrgency(o.scheduled_date)
                    const urgWord = urgency === 'overdue' ? ' · vencido'
                                  : urgency === 'today'    ? ' · hoy'
                                  : urgency === 'tomorrow' ? ' · mañana' : ''
                    return (
                    <button key={o.id} type="button" onClick={() => setSelectedId(o.id)}
                      className={clsx('w-full text-left border rounded-xl px-3 py-2.5 transition-colors',
                        selectedId === o.id ? 'border-brand-500 bg-brand-500/10'
                          : clsx('border-line-subtle bg-surface-primary hover:bg-surface-elevated/40', URGENCY_BORDER[urgency]))}>
                      <span className="font-mono font-semibold text-brand-300">{o.order_number}</span>
                      <p className="mt-0.5 font-medium text-ink-primary truncate">{o.partner_name}</p>
                      {o.partner_tax_name && o.partner_tax_name !== o.partner_name && (
                        <p className="text-[11px] text-ink-muted truncate">{o.partner_tax_name}</p>
                      )}
                      {o.scheduled_date && (
                        <p className={clsx('text-[11px] font-semibold mt-0.5', URGENCY_TEXT_CLASS[urgency])}>
                          Entrega: {fmtDateOnly(o.scheduled_date)}{urgWord}
                        </p>
                      )}
                    </button>
                  )})}
                </div>
              )}
              {doneOrders.length > 0 && (
                <div className="flex flex-col gap-2">
                  <button type="button" onClick={() => setShowDone(s => !s)}
                    className="flex items-center justify-between gap-2 px-3 py-2 rounded-lg bg-surface-elevated/50 hover:bg-surface-elevated/70">
                    <span className="text-xs font-bold text-ink-muted uppercase tracking-wider">✓ Entregados y cerrados · {doneOrders.length}</span>
                    <span className="text-[11px] font-semibold text-ink-muted">{showDoneEffective ? '▾ ocultar' : '▸ mostrar'}</span>
                  </button>
                  {showDoneEffective && doneOrders.map(o => (
                    <button key={o.id} type="button" onClick={() => setSelectedId(o.id)}
                      className={clsx('w-full text-left border rounded-xl px-3 py-2.5 transition-colors',
                        selectedId === o.id ? 'border-brand-500 bg-brand-500/10'
                          : 'border-line-subtle bg-surface-elevated/30 opacity-60 hover:opacity-100')}>
                      <span className="font-mono font-semibold text-brand-300">{o.order_number}</span>
                      <p className="mt-0.5 font-medium text-ink-primary truncate">{o.partner_name}</p>
                      {o.partner_tax_name && o.partner_tax_name !== o.partner_name && (
                        <p className="text-[11px] text-ink-muted truncate">{o.partner_tax_name}</p>
                      )}
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
                  <SortableHeader sortKey="folio"      sortBy={sortBy} sortDir={sortDir} onSort={onSort}>Número</SortableHeader>
                  <SortableHeader sortKey="cliente"    sortBy={sortBy} sortDir={sortDir} onSort={onSort} initialDir="asc">Cliente</SortableHeader>
                  <SortableHeader sortKey="fecha"      sortBy={sortBy} sortDir={sortDir} onSort={onSort}>F. creación</SortableHeader>
                  <SortableHeader sortKey="programada" sortBy={sortBy} sortDir={sortDir} onSort={onSort}>F. programada</SortableHeader>
                  <SortableHeader sortKey="estatus"    sortBy={sortBy} sortDir={sortDir} onSort={onSort} initialDir="asc">Estado</SortableHeader>
                  <SortableHeader sortKey="total"      sortBy={sortBy} sortDir={sortDir} onSort={onSort} align="right">Total</SortableHeader>
                </tr>
              </thead>
              <tbody>
                {/* ── Sección: Pendientes de entrega ──────────────────── */}
                {pendingOrders.length > 0 && (
                  <tr className="bg-brand-500/10">
                    <td colSpan={6} className="px-4 py-2.5 text-sm font-bold text-brand-300 uppercase tracking-wider">
                      ⏳ Por entregar · {pendingOrders.length}
                      <span className="ml-3 text-[10px] font-medium text-ink-muted normal-case tracking-normal">
                        🔴 vencido · 🟡 hoy · 🔵 mañana · 🟢 + de 1 día
                      </span>
                    </td>
                  </tr>
                )}
                {pendingOrders.map(o => {
                  const urgency = getDeliveryUrgency(o.scheduled_date)
                  const late = isOrderLate(o)
                  return (
                    <tr key={o.id}
                      onClick={() => setSelectedId(o.id)}
                      className={clsx(
                        'cursor-pointer transition-colors',
                        selectedId === o.id ? 'bg-brand-500/15' : URGENCY_ROW_CLASS[urgency]
                      )}>
                      <td className="font-mono font-semibold text-brand-300"><DocLink to={docHref(o.id)} onOpen={() => setSelectedId(o.id)}>{o.order_number}</DocLink></td>
                      <td>
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <p className="font-medium text-ink-primary">{o.partner_name}</p>
                          {o.pickup_in_warehouse && (
                            <span title="Cliente recoge en bodega"
                              className="text-[10px] font-bold bg-amber-200 text-status-warning px-1.5 py-0.5 rounded-full">
                              🏪 Recoge
                            </span>
                          )}
                          {!o.pickup_in_warehouse && o.driver_name && (
                            <span title={`Repartidor: ${o.driver_name}`}
                              className="text-[10px] font-bold bg-purple-200 text-purple-300 px-1.5 py-0.5 rounded-full">
                              🚚 {o.driver_name.split(' ')[0]}
                            </span>
                          )}
                        </div>
                        {o.partner_tax_name && o.partner_tax_name !== o.partner_name && (
                          <p className="text-[11px] text-ink-secondary">{o.partner_tax_name}</p>
                        )}
                        {o.partner_rfc && <p className="text-[10px] text-ink-muted font-mono">{o.partner_rfc}</p>}
                      </td>
                      <td className="text-xs text-ink-secondary">{fmtDate(o.created_at)}</td>
                      <td className={clsx('text-xs font-semibold', URGENCY_TEXT_CLASS[urgency])}
                        title={late ? 'Fecha programada vencida' : undefined}>
                        {fmtDateOnly(o.scheduled_date)}
                        {urgency === 'overdue' && (
                          <svg className="inline-block w-3 h-3 ml-1 -mt-0.5" fill="currentColor" viewBox="0 0 24 24">
                            <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/>
                          </svg>
                        )}
                      </td>
                      <td>
                        <Badge status={o.status} />
                        {(o.status === 'in_delivery' || o.status === 'partially_delivered') && (
                          <DeliveryProgress
                            delivered={o.delivered_total_mxn}
                            remisioned={o.remisioned_total_mxn}
                            total={o.total_mxn}
                          />
                        )}
                      </td>
                      <td className="text-right font-mono tabular-nums font-medium"
                        title="Total del pedido sin IVA. El IVA se calcula al facturar.">
                        {fmtMXN(o.subtotal_mxn ?? o.total_mxn, o.currency)}
                      </td>
                    </tr>
                  )
                })}

                {/* ── Sección: Entregados / cerrados ───────────────────── */}
                {doneOrders.length > 0 && (
                  <tr className="bg-surface-elevated/60 cursor-pointer hover:bg-surface-elevated/80"
                    onClick={() => setShowDone(s => !s)}>
                    <td colSpan={6} className="px-4 py-2 text-xs font-bold text-ink-muted uppercase tracking-wider">
                      <span className="inline-block w-4">{showDoneEffective ? '▾' : '▸'}</span>
                      ✓ Entregados, facturados y cerrados · {doneOrders.length}
                      <span className="ml-2 text-[10px] font-medium text-ink-muted normal-case tracking-normal">
                        ({showDoneEffective ? 'clic para ocultar' : 'clic para mostrar'})
                      </span>
                    </td>
                  </tr>
                )}
                {showDoneEffective && doneOrders.map(o => {
                  const late = isOrderLate(o)
                  return (
                    <tr key={o.id}
                      onClick={() => setSelectedId(o.id)}
                      className={clsx(
                        'cursor-pointer transition-colors',
                        selectedId === o.id ? 'bg-brand-500/15' : 'bg-surface-elevated/40 opacity-60 hover:opacity-100 hover:bg-surface-elevated/60'
                      )}>
                      <td className="font-mono font-semibold text-brand-300"><DocLink to={docHref(o.id)} onOpen={() => setSelectedId(o.id)}>{o.order_number}</DocLink></td>
                      <td>
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <p className="font-medium text-ink-primary">{o.partner_name}</p>
                        </div>
                        {o.partner_tax_name && o.partner_tax_name !== o.partner_name && (
                          <p className="text-[11px] text-ink-secondary">{o.partner_tax_name}</p>
                        )}
                        {o.partner_rfc && <p className="text-[10px] text-ink-muted font-mono">{o.partner_rfc}</p>}
                      </td>
                      <td className="text-xs text-ink-secondary">{fmtDate(o.created_at)}</td>
                      <td className={clsx('text-xs', late ? 'text-status-danger font-semibold' : 'text-ink-secondary')}
                        title={late
                          ? (o.status === 'delivered' ? 'Entregado después de la fecha programada' : 'Fecha programada vencida')
                          : undefined}>
                        {fmtDateOnly(o.scheduled_date)}
                        {late && (
                          <svg className="inline-block w-3 h-3 ml-1 -mt-0.5" fill="currentColor" viewBox="0 0 24 24">
                            <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/>
                          </svg>
                        )}
                      </td>
                      <td>
                        <Badge status={o.status} />
                      </td>
                      <td className="text-right font-mono tabular-nums font-medium"
                        title="Total del pedido sin IVA. El IVA se calcula al facturar.">
                        {fmtMXN(o.subtotal_mxn ?? o.total_mxn, o.currency)}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
            </div>

            {/* Paginación */}
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

      {/* Modal de captura */}
      {showForm && (
        <PedidoFormModal
          onClose={() => setShowForm(false)}
          onCreated={(order) => {
            setCreatedMsg(`Pedido ${order.order_number} creado en borrador.`)
            setSelectedId(order.id)
          }}
        />
      )}

      {/* Panel de detalle */}
      {selectedId && (
        <PedidoDetallePanel
          orderId={selectedId}
          onClose={closeDoc}
        />
      )}
    </div>
  )
}
