import { useState, useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate, useLocation } from 'react-router-dom'
import { purchasesApi } from '@/api/purchases'
import Badge from '@/components/ui/Badge'
import Spinner from '@/components/ui/Spinner'
import Can from '@/components/auth/Can'
import { OCTypeSelector, OCFormModal } from '@/components/compras/OCFormModal'
import { OCDetallePanel } from '@/components/compras/OCDetallePanel'
import { fmtMXN, fmtDate, fmtNum } from '@/utils/fmt'
import clsx from 'clsx'

// ── Mini barra de progreso de recepción ───────────────────────────────────────
function ReceiptProgress({ ordered, received, status }) {
  if (!ordered || parseFloat(ordered) === 0) return null
  if (['draft', 'cancelled'].includes(status)) return (
    <span className="text-xs text-ink-muted">—</span>
  )
  const pct      = Math.min((parseFloat(received) / parseFloat(ordered)) * 100, 100)
  const complete = pct >= 100
  return (
    <div className="flex flex-col gap-1 min-w-[90px]">
      <div className="flex items-center justify-between gap-1">
        <div className="flex-1 h-1.5 bg-surface-elevated/60 rounded-full overflow-hidden">
          <div
            className={clsx('h-full rounded-full transition-all', complete ? 'bg-green-500' : 'bg-brand-500')}
            style={{ width: `${pct}%` }}
          />
        </div>
        <span className={clsx('text-[11px] font-semibold tabular-nums shrink-0', complete ? 'text-status-success' : 'text-brand-300')}>
          {Math.round(pct)}%
        </span>
      </div>
    </div>
  )
}

// ── Chip de tipo de OC ─────────────────────────────────────────────────────
function TipoChip({ type }) {
  const isMP = type === 'raw_material'
  return (
    <span className={clsx(
      'inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wide',
      isMP ? 'bg-status-warning/15 text-status-warning' : 'bg-brand-500/15 text-brand-300'
    )}>
      {isMP ? 'MP' : 'PT'}
    </span>
  )
}

// ── Filtros ────────────────────────────────────────────────────────────────
const TYPE_OPTS   = [['', 'Todos los tipos'], ['raw_material', 'Materia Prima'], ['product', 'Producto Terminado']]
const STATUS_OPTS = [
  ['', 'Todos los estados'],
  ['draft', 'Borrador'],
  ['authorized', 'Autorizada'],
  ['sent', 'Enviada'],
  ['partially_received', 'Parc. recibida'],
  ['received', 'Recibida'],
  ['invoiced', 'Facturada'],
  ['cancelled', 'Cancelada'],
]

export default function ComprasOrdenes() {
  const navigate = useNavigate()
  const location = useLocation()

  // UI state
  const [showTypeSelector, setShowTypeSelector] = useState(false)
  const [formType, setFormType]                 = useState(null)   // 'raw_material' | 'product'
  const [prefilledItem, setPrefilledItem]       = useState(null)   // viene desde Inventario
  const [selectedOcId, setSelectedOcId]         = useState(null)
  const [createdMsg, setCreatedMsg]             = useState(null)

  // Filtros
  const [typeFilter, setTypeFilter]   = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [search, setSearch]           = useState('')
  const [page, setPage]               = useState(1)

  // ── Detectar prefillOC desde Inventario ────────────────────────────────────
  // Cuando el usuario hace clic en "Solicitar reposición" desde Inventario,
  // se navega aquí con location.state.prefillOC. Abrimos el form directamente
  // (saltándonos el OCTypeSelector) con el item pre-cargado.
  useEffect(() => {
    const prefill = location.state?.prefillOC
    if (prefill && !formType) {
      setFormType(prefill.type)
      setPrefilledItem(prefill)
      // Limpiar el state para que no se reabra al refrescar.
      navigate(location.pathname, { replace: true, state: {} })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.state])

  const { data, isLoading, isFetching } = useQuery({
    queryKey: ['purchase-orders', typeFilter, statusFilter, search, page],
    queryFn: () => purchasesApi.listOrders({
      order_type: typeFilter   || undefined,
      status:     statusFilter || undefined,
      search:     search       || undefined,
      page,
      limit: 20,
    }),
    keepPreviousData: true,
  })

  const orders = data?.data || []
  const total  = data?.total || 0

  function handleSelectType(type) {
    setShowTypeSelector(false)
    setFormType(type)
  }

  function handleCreated(oc) {
    setCreatedMsg(`OC ${oc.order_number} creada correctamente.`)
    setTimeout(() => setCreatedMsg(null), 5000)
  }

  function handleGoToRecepcion(oc) {
    setSelectedOcId(null)
    // Navega a recepciones con la OC preseleccionada como parámetro
    navigate(`/compras/recepciones?oc=${oc.id}`)
  }

  function resetFilters() {
    setTypeFilter(''); setStatusFilter(''); setSearch(''); setPage(1)
  }

  const hasFilters = typeFilter || statusFilter || search

  return (
    <div className="page-enter flex flex-col gap-6">
      {/* Header */}
      <div className="page-header">
        <div>
          <h1 className="page-title">Órdenes de compra</h1>
          <p className="page-subtitle">Gestión de órdenes a proveedores</p>
        </div>
        <Can do="purchases:create">
          <button onClick={() => setShowTypeSelector(true)} className="btn-primary">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4"/>
            </svg>
            Nueva OC
          </button>
        </Can>
      </div>

      {/* Mensaje de éxito */}
      {createdMsg && (
        <div className="bg-status-success/10 border border-status-success/40 rounded-xl px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <svg className="w-4 h-4 text-green-500" fill="currentColor" viewBox="0 0 24 24">
              <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/>
            </svg>
            <p className="text-sm text-status-success">{createdMsg}</p>
          </div>
          <button onClick={() => setCreatedMsg(null)} className="text-green-400 hover:text-status-success text-xs">✕</button>
        </div>
      )}

      {/* Filtros */}
      <div className="flex flex-wrap items-center gap-3">
        {/* Buscador */}
        <div className="relative flex-1 min-w-[200px] max-w-xs">
          <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"/>
          </svg>
          <input
            type="text"
            className="input pl-9"
            placeholder="Buscar por número o proveedor..."
            value={search}
            onChange={e => { setSearch(e.target.value); setPage(1) }}
          />
        </div>

        <select className="select w-44" value={typeFilter} onChange={e => { setTypeFilter(e.target.value); setPage(1) }}>
          {TYPE_OPTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>

        <select className="select w-52" value={statusFilter} onChange={e => { setStatusFilter(e.target.value); setPage(1) }}>
          {STATUS_OPTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>

        {hasFilters && (
          <button onClick={resetFilters} className="btn-ghost btn-sm text-ink-muted">
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12"/>
            </svg>
            Limpiar
          </button>
        )}

        {isFetching && !isLoading && (
          <div className="ml-auto"><Spinner size="sm" /></div>
        )}
      </div>

      {/* Tabla */}
      {isLoading ? (
        <div className="flex justify-center py-20"><Spinner /></div>
      ) : !orders.length ? (
        <div className="empty-state">
          {hasFilters ? (
            <>
              <p className="font-medium text-ink-secondary">Sin resultados</p>
              <p className="text-sm text-ink-muted">Prueba ajustando los filtros</p>
              <button onClick={resetFilters} className="btn-secondary btn-sm mt-3">Limpiar filtros</button>
            </>
          ) : (
            <>
              <div className="w-14 h-14 rounded-2xl bg-surface-elevated/60 flex items-center justify-center mb-3">
                <svg className="w-7 h-7 text-ink-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"/>
                </svg>
              </div>
              <p className="font-medium text-ink-secondary">Sin órdenes de compra</p>
              <p className="text-sm text-ink-muted">Crea tu primera OC para comenzar</p>
              <button onClick={() => setShowTypeSelector(true)} className="btn-primary btn-sm mt-3">
                + Nueva OC
              </button>
            </>
          )}
        </div>
      ) : (
        <>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Número</th>
                  <th>Tipo</th>
                  <th>Proveedor</th>
                  <th>F. Entrega est.</th>
                  <th>Total</th>
                  <th>Estado</th>
                  <th>Creada</th>
                </tr>
              </thead>
              <tbody>
                {orders.map(o => {
                  const isUSD = o.currency === 'USD'
                  const isMP  = o.order_type === 'raw_material' || (!o.order_type && o.lines?.some?.(l => l.item_type === 'raw_material'))
                  return (
                    <tr
                      key={o.id}
                      className="cursor-pointer"
                      onClick={() => setSelectedOcId(o.id)}
                    >
                      <td className="font-mono text-sm font-semibold text-brand-300">{o.order_number}</td>
                      <td><TipoChip type={isMP ? 'raw_material' : 'product'} /></td>
                      <td className="font-medium text-ink-primary">
                        {o.partner_name || <span className="text-ink-muted font-normal">Sin proveedor</span>}
                      </td>
                      <td className="text-ink-muted text-sm">{fmtDate(o.expected_date)}</td>
                      <td>
                        <div className="flex flex-col">
                          <span className="font-mono text-sm font-medium">
                            {fmtMXN(o.total_mxn || o.total, isUSD ? 'USD' : 'MXN')}
                          </span>
                          {isUSD && o.total_mxn_converted && (
                            <span className="font-mono text-[11px] text-ink-muted">
                              ≈ {fmtMXN(o.total_mxn_converted, 'MXN')}
                            </span>
                          )}
                        </div>
                      </td>
                      <td><Badge status={o.status} /></td>
                      <td className="text-ink-muted text-xs">{fmtDate(o.created_at)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          {/* Paginación */}
          {total > 20 && (
            <div className="flex items-center justify-between">
              <p className="text-sm text-ink-muted">
                Mostrando {(page - 1) * 20 + 1}–{Math.min(page * 20, total)} de {total}
              </p>
              <div className="flex gap-2">
                <button disabled={page === 1} onClick={() => setPage(p => p - 1)} className="btn-secondary btn-sm disabled:opacity-40">
                  ← Anterior
                </button>
                <button disabled={page * 20 >= total} onClick={() => setPage(p => p + 1)} className="btn-secondary btn-sm disabled:opacity-40">
                  Siguiente →
                </button>
              </div>
            </div>
          )}
        </>
      )}

      {/* Modales */}
      {showTypeSelector && (
        <OCTypeSelector
          onSelect={handleSelectType}
          onClose={() => setShowTypeSelector(false)}
        />
      )}

      {formType && (
        <OCFormModal
          type={formType}
          prefilledItem={prefilledItem}
          onClose={() => { setFormType(null); setPrefilledItem(null) }}
          onCreated={(oc) => { handleCreated(oc); setPrefilledItem(null) }}
        />
      )}

      {selectedOcId && (
        <OCDetallePanel
          ocId={selectedOcId}
          onClose={() => setSelectedOcId(null)}
          onGoToRecepcion={handleGoToRecepcion}
        />
      )}
    </div>
  )
}
