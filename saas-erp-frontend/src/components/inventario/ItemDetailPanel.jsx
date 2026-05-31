import { useState } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { inventoryApi } from '@/api/inventory'
import Spinner from '@/components/ui/Spinner'
import Badge from '@/components/ui/Badge'
import QuickLevelsModal from './QuickLevelsModal'
import clsx from 'clsx'

// ─── Helpers ──────────────────────────────────────────────────────────────────
function fmtNum(n, decimals = 2) {
  if (n == null) return '—'
  return Number(n).toLocaleString('es-MX', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
}
function fmtMXN(n) {
  if (n == null) return '—'
  return `$${fmtNum(n)}`
}
function fmtDateShort(d) {
  if (!d) return '—'
  const date = new Date(d)
  const today = new Date()
  const yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1)
  const isToday = date.toDateString() === today.toDateString()
  const isYesterday = date.toDateString() === yesterday.toDateString()
  const time = date.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' })
  if (isToday) return `hoy ${time}`
  if (isYesterday) return `ayer ${time}`
  return date.toLocaleDateString('es-MX', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
}

const MOVEMENT_LABELS = {
  purchase_entry:               'Compra',
  production_mp_consumption:    'Consumo MP',
  production_mp_reserve:        'MP → WIP',
  production_mp_return:         'Devolución MP',
  production_pt_entry:          'Entrada PT',
  production_wip_entry:         'Entrada WIP',
  production_wip_to_pt:         'WIP → PT',
  sale_exit:                    'Venta',
  adjustment_in:                'Ajuste +',
  adjustment_out:               'Ajuste −',
  scrap_entry:                  'Merma',
  scrap_disposal:               'Baja merma',
  scrap_to_regrind:             'Merma → Regrind',
  transfer_in:                  'Transferencia +',
  transfer_out:                 'Transferencia −',
}

const STATUS_CONFIG = {
  below_min:  { color: 'red',   label: 'Bajo mínimo',   icon: '🔴', tone: 'bg-status-danger/10 border-status-danger/40 text-status-danger' },
  at_reorder: { color: 'amber', label: 'En reorden',    icon: '🟡', tone: 'bg-status-warning/10 border-status-warning/40 text-status-warning' },
  normal:     { color: 'green', label: 'Normal',        icon: '🟢', tone: 'bg-status-success/10 border-status-success/40 text-status-success' },
  overstock:  { color: 'blue',  label: 'Sobrestock',    icon: '🔵', tone: 'bg-status-info/10 border-status-info/40 text-status-info' },
}

// ─── Componente principal ────────────────────────────────────────────────────
export default function ItemDetailPanel({ itemType, itemId, warehouseId, onClose }) {
  const navigate = useNavigate()
  const [showQuickLevels, setShowQuickLevels] = useState(false)

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['inv-item-detail', itemType, itemId, warehouseId],
    queryFn:  () => inventoryApi.getItemDetail(itemType, itemId, warehouseId),
    enabled:  !!(itemType && itemId && warehouseId),
  })

  function handleSolicitarReposicion() {
    if (!data) return
    const { item, warehouse, suggestedQty, stock } = data
    // Tipo de OC se mapea: raw_material → MP, product → PT
    const ocType = itemType  // 'raw_material' o 'product'
    navigate('/compras/ordenes', {
      state: {
        prefillOC: {
          type: ocType,
          itemId: item.id,
          itemName: item.name,
          sku: item.sku || null,
          unit: stock.unit || (itemType === 'raw_material' ? 'kg' : 'pza'),
          suggestedQty: suggestedQty || 0,
          warehouseId: warehouse.id,
          warehouseName: warehouse.name,
        },
      },
    })
    onClose()
  }

  function handleVerKardex() {
    // Notifica al padre que cambie a tab Kardex y filtre
    onClose()
    // El padre (Inventario.jsx) recibira una callback en una version futura.
    // Por ahora solo cerramos.
  }

  return createPortal(
    <div className="fixed inset-0 z-[9998] flex">
      {/* Backdrop */}
      <div className="hidden sm:block flex-1 bg-black/30" onClick={onClose} />

      {/* Panel */}
      <div className="w-full max-w-md bg-surface-primary h-full overflow-y-auto shadow-card flex flex-col">

        {/* Header */}
        <div className="sticky top-0 bg-surface-primary border-b border-line-subtle px-5 py-4 flex items-start gap-3 z-10"
          style={{ paddingTop: 'calc(1rem + env(safe-area-inset-top))' }}>
          <button onClick={onClose} className="btn-ghost btn-icon text-ink-muted -ml-1 mt-0.5 shrink-0">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
          </button>
          <div className="flex-1 min-w-0">
            {isLoading ? (
              <div className="flex flex-col gap-2">
                <div className="skeleton h-5 w-48" />
                <div className="skeleton h-3 w-32" />
              </div>
            ) : error ? (
              <p className="text-sm text-status-danger">Error: {error.response?.data?.error || error.message}</p>
            ) : data ? (
              <>
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-base font-bold text-ink-primary truncate">{data.item.name}</span>
                  <span className={clsx(
                    'text-[10px] font-bold px-2 py-0.5 rounded-full uppercase tracking-wide shrink-0',
                    itemType === 'raw_material' ? 'bg-status-warning/15 text-status-warning' : 'bg-brand-500/15 text-brand-300'
                  )}>
                    {itemType === 'raw_material' ? 'MP' : 'PT'}
                  </span>
                </div>
                <p className="text-xs text-ink-muted mt-1 truncate">
                  {data.warehouse.name}
                  {data.item.sku && <> · <span className="font-mono">{data.item.sku}</span></>}
                  {data.item.resin_type && <> · {[data.item.resin_type, data.item.material_type].filter(Boolean).join(' ')}</>}
                </p>
              </>
            ) : null}
          </div>
        </div>

        {/* Contenido */}
        {isLoading ? (
          <div className="flex justify-center py-16"><Spinner /></div>
        ) : data ? (
          <div className="flex-1 px-5 py-4 flex flex-col gap-5">

            {/* ── Stock actual (card destacada) ── */}
            {(() => {
              const status = data.level ? STATUS_CONFIG[data.level.status_calc] : null
              return (
                <div className={clsx(
                  'rounded-xl border-2 p-4 transition-colors',
                  status ? status.tone : 'bg-surface-elevated/40 border-line-subtle'
                )}>
                  <div className="flex items-baseline justify-between mb-2">
                    <span className="text-[10px] uppercase tracking-wider font-semibold opacity-70">
                      Stock actual
                    </span>
                    {status && (
                      <span className="text-[10px] font-semibold flex items-center gap-1">
                        {status.icon} {status.label}
                      </span>
                    )}
                  </div>
                  <p className="text-3xl font-bold tabular-nums">
                    {fmtNum(data.stock.quantity, 2)}
                    <span className="text-base font-normal ml-1 opacity-60">{data.stock.unit}</span>
                  </p>
                  <div className="grid grid-cols-2 gap-2 mt-3 text-xs">
                    <div>
                      <span className="opacity-60">Costo prom.</span>
                      <p className="font-medium tabular-nums">{fmtMXN(data.stock.avg_cost)}</p>
                    </div>
                    <div>
                      <span className="opacity-60">Valor total</span>
                      <p className="font-medium tabular-nums">{fmtMXN(data.stock.total_value)}</p>
                    </div>
                  </div>
                </div>
              )
            })()}

            {/* ── En tránsito (OCs pendientes de recibir) ── */}
            {data.inTransit > 0 && (
              <div className="rounded-xl border-2 border-status-warning/40 bg-status-warning/10/40 p-4">
                <div className="flex items-baseline justify-between mb-2">
                  <span className="text-[10px] uppercase tracking-wider font-semibold text-status-warning">
                    En tránsito · OCs activas
                  </span>
                  <span className="text-[10px] font-semibold text-status-warning">
                    📦 {data.pendingOrders?.length || 0} OC(s)
                  </span>
                </div>
                <p className="text-2xl font-bold tabular-nums text-status-warning">
                  +{fmtNum(data.inTransit, 2)}
                  <span className="text-sm font-normal ml-1 opacity-70">{data.stock.unit}</span>
                </p>
                <p className="text-[11px] text-status-warning/80 mt-1">
                  Llegará a {data.warehouse.name} cuando se registre la recepción
                </p>

                {data.pendingOrders?.length > 0 && (
                  <div className="mt-3 pt-3 border-t border-status-warning/40 space-y-1.5">
                    {data.pendingOrders.map(o => (
                      <div key={o.id} className="flex items-center justify-between text-xs">
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="font-mono font-semibold text-status-warning shrink-0">{o.order_number}</span>
                          {o.partner_name && (
                            <span className="text-ink-secondary truncate">· {o.partner_name}</span>
                          )}
                        </div>
                        <div className="flex items-center gap-3 shrink-0">
                          {o.expected_date && (
                            <span className="text-status-warning/70 text-[10px]">
                              {new Date(o.expected_date).toLocaleDateString('es-MX',
                                { day: '2-digit', month: 'short' })}
                            </span>
                          )}
                          <span className="font-mono font-medium text-status-warning">
                            +{fmtNum(o.qty_pending, 2)}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* ── Niveles configurados ── */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-[10px] uppercase tracking-wider font-semibold text-ink-muted">
                  Niveles configurados
                </h3>
                <button
                  onClick={() => setShowQuickLevels(true)}
                  className="text-[11px] text-brand-300 hover:underline"
                >
                  ⚙ Editar
                </button>
              </div>
              {data.level ? (
                <div className="bg-surface-elevated/40 rounded-xl p-3 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                  <div>
                    <span className="text-xs text-ink-muted">Stock mínimo</span>
                    <p className="font-medium tabular-nums">
                      {fmtNum(data.level.min_stock, 2)} {data.stock.unit}
                    </p>
                  </div>
                  <div>
                    <span className="text-xs text-ink-muted">Stock máximo</span>
                    <p className="font-medium tabular-nums">
                      {data.level.max_stock != null
                        ? `${fmtNum(data.level.max_stock, 2)} ${data.stock.unit}`
                        : <span className="text-ink-muted font-normal">Sin definir</span>}
                    </p>
                  </div>
                  <div>
                    <span className="text-xs text-ink-muted">Punto reorden</span>
                    <p className="font-medium tabular-nums">
                      {fmtNum(data.level.reorder_point, 2)} {data.stock.unit}
                    </p>
                  </div>
                  <div>
                    <span className="text-xs text-ink-muted">Stock seguridad</span>
                    <p className="font-medium tabular-nums">
                      {fmtNum(data.level.safety_stock, 2)} {data.stock.unit}
                    </p>
                  </div>
                  <div className="col-span-2 border-t border-line-subtle pt-2 mt-1">
                    <span className="text-xs text-ink-muted">Lead time del proveedor</span>
                    <p className="font-medium">{data.item.lead_time_days ?? 7} días</p>
                  </div>
                </div>
              ) : (
                <div className="bg-surface-elevated/40 border border-dashed border-line-subtle rounded-xl p-4 text-center">
                  <p className="text-xs text-ink-muted mb-2">Sin niveles configurados para este almacén.</p>
                  <button
                    onClick={() => setShowQuickLevels(true)}
                    className="btn-secondary btn-sm"
                  >
                    + Configurar niveles
                  </button>
                </div>
              )}
            </div>

            {/* ── Solicitar reposición ── */}
            {data.level && (data.level.status_calc === 'below_min' || data.level.status_calc === 'at_reorder') && (
              <div className="bg-brand-500/10 border border-brand-500/40 rounded-xl p-4">
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-base">📦</span>
                  <h3 className="text-sm font-semibold text-brand-300">Reposición sugerida</h3>
                </div>
                <p className="text-xs text-brand-300/80 mb-3">
                  Cantidad a pedir para llevar el stock al nivel óptimo:
                </p>
                <p className="text-2xl font-bold text-brand-300 tabular-nums mb-3">
                  {fmtNum(data.suggestedQty, 2)} {data.stock.unit}
                </p>
                <button
                  onClick={handleSolicitarReposicion}
                  className="btn-primary w-full text-sm"
                >
                  Solicitar reposición →
                </button>
                <p className="text-[10px] text-brand-300/70 text-center mt-2">
                  Te llevará a Compras con el producto y cantidad pre-cargados.
                </p>
              </div>
            )}

            {/* ── Últimos movimientos ── */}
            <div>
              <h3 className="text-[10px] uppercase tracking-wider font-semibold text-ink-muted mb-2">
                Últimos movimientos
              </h3>
              {data.movements.length === 0 ? (
                <p className="text-xs text-ink-muted italic">Sin movimientos registrados.</p>
              ) : (
                <div className="bg-surface-primary border border-line-subtle rounded-xl divide-y divide-line-subtle">
                  {data.movements.map(m => {
                    const isPositive = parseFloat(m.quantity) >= 0
                    return (
                      <div key={m.id} className="flex items-center gap-3 px-3 py-2 text-xs">
                        <span className="text-ink-muted w-20 shrink-0 tabular-nums">{fmtDateShort(m.created_at)}</span>
                        <span className="flex-1 truncate text-ink-secondary">
                          {MOVEMENT_LABELS[m.movement_type] || m.movement_type}
                        </span>
                        <span className={clsx(
                          'font-mono font-semibold tabular-nums shrink-0',
                          isPositive ? 'text-status-success' : 'text-status-danger'
                        )}>
                          {isPositive ? '+' : ''}{fmtNum(m.quantity, 2)}
                        </span>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          </div>
        ) : null}
      </div>

      {/* Modal de edición rápida de niveles */}
      {showQuickLevels && data && (
        <QuickLevelsModal
          itemType={itemType}
          itemId={itemId}
          itemName={data.item.name}
          warehouseId={warehouseId}
          warehouseName={data.warehouse.name}
          unit={data.stock.unit}
          leadTimeDays={data.item.lead_time_days ?? 7}
          onClose={() => {
            setShowQuickLevels(false)
            refetch()
          }}
        />
      )}
    </div>,
    document.body
  )
}
