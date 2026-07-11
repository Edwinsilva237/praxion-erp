import { useQuery } from '@tanstack/react-query'
import { salesApi } from '@/api/sales'
import { fmtNum } from '@/utils/fmt'
import clsx from 'clsx'

// Semáforo de niveles configurados (inventory_levels): solo mostramos los estados
// que importan al vender (poco stock). "normal"/sin nivel no ensucian la vista.
const STATUS_META = {
  below_min:  { dot: 'bg-status-danger',  text: 'text-status-danger',  label: 'bajo mínimo' },
  at_reorder: { dot: 'bg-status-warning', text: 'text-status-warning', label: 'en reorden' },
  overstock:  { dot: 'bg-status-info',    text: 'text-status-info',    label: 'sobrestock' },
}

/**
 * Indicador de stock disponible al capturar la cantidad de un producto en un
 * pedido. Como el pedido no fija almacén, muestra el TOTAL disponible y el
 * desglose por almacén, marcando los niveles configurados si los hay.
 *
 * Props:
 *   productId — id del producto seleccionado
 *   qtyBase   — cantidad pedida en UNIDAD BASE (quantity × pack_factor)
 *   baseUnit  — etiqueta de la unidad base (para el texto)
 */
export function StockDisponible({ productId, qtyBase = 0, baseUnit = '' }) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['product-stock', productId],
    queryFn:  () => salesApi.productStockByWarehouse(productId),
    enabled:  !!productId,
    staleTime: 30_000,
    retry: false,   // 403 (usuario sin acceso a inventario) → no reintentar ni romper
  })

  // Degradación elegante: sin producto o sin acceso → no se muestra nada.
  if (!productId || isError) return null
  if (isLoading) {
    return <p className="px-1 text-[11px] text-ink-muted">Consultando existencias…</p>
  }

  const warehouses   = data?.warehouses || []
  const total        = parseFloat(data?.total_available || 0)
  const unit         = baseUnit || data?.unit || ''
  const req          = parseFloat(qtyBase || 0)
  const insufficient = req > 0 && req > total + 0.0001
  const faltan       = insufficient ? req - total : 0

  if (warehouses.length === 0) {
    return (
      <div className="rounded-lg border border-status-warning/40 bg-status-warning/10 px-3 py-2 text-[11px] text-status-warning">
        Sin existencias registradas de este producto.
      </div>
    )
  }

  // Con un solo almacén el total ya lo dice todo; el desglose solo agrega valor
  // cuando hay varios almacenes o algún nivel configurado que avisar.
  const showBreakdown = warehouses.length > 1 || warehouses.some(w => STATUS_META[w.status_calc])

  return (
    <div className={clsx('flex flex-col gap-1.5 rounded-lg border px-3 py-2',
      insufficient ? 'border-status-danger/40 bg-status-danger/10' : 'border-line-subtle bg-surface-elevated/50')}>
      {/* Total disponible */}
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-ink-secondary">
          <svg className="w-3.5 h-3.5 text-ink-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
              d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-14L4 7m8 4v10M4 7v10l8 4" />
          </svg>
          Disponible
          {warehouses.length > 1 && (
            <span className="font-normal normal-case text-ink-muted">
              · {warehouses.length} almacenes
            </span>
          )}
        </span>
        <span className={clsx('font-mono text-sm font-bold tabular-nums',
          insufficient ? 'text-status-danger' : 'text-status-success')}>
          {fmtNum(total, 2)} {unit}
        </span>
      </div>

      {/* Desglose por almacén */}
      {showBreakdown && (
        <div className="flex flex-col gap-0.5 border-t border-line-subtle/60 pt-1">
          {warehouses.map(w => {
            const meta = STATUS_META[w.status_calc]
            return (
              <div key={w.warehouse_id} className="flex items-center justify-between gap-2 text-[11px]">
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className="truncate text-ink-secondary">{w.warehouse_name}</span>
                  {meta && (
                    <span className={clsx('inline-flex shrink-0 items-center gap-1', meta.text)}
                      title={
                        w.min_stock != null
                          ? `mín ${fmtNum(w.min_stock, 2)} · reorden ${fmtNum(w.reorder_point, 2)}`
                          : undefined
                      }>
                      <span className={clsx('h-1.5 w-1.5 rounded-full', meta.dot)} />
                      {meta.label}
                    </span>
                  )}
                </span>
                <span className={clsx('shrink-0 font-mono tabular-nums',
                  parseFloat(w.quantity) > 0 ? 'text-ink-primary' : 'text-ink-muted')}>
                  {fmtNum(w.quantity, 2)} {w.unit || unit}
                </span>
              </div>
            )
          })}
        </div>
      )}

      {/* Aviso de faltante */}
      {insufficient && (
        <p className="border-t border-status-danger/30 pt-1 text-[11px] font-medium text-status-danger">
          Pides {fmtNum(req, 2)} {unit} · faltan {fmtNum(faltan, 2)} {unit}
        </p>
      )}
    </div>
  )
}
