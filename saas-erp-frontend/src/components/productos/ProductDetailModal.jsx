import { createPortal } from 'react-dom'
import { useQuery } from '@tanstack/react-query'
import { productsApi } from '@/api/products'
import Spinner from '@/components/ui/Spinner'
import Badge from '@/components/ui/Badge'
import Can from '@/components/auth/Can'

const fmtMXN = (n) => new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 6 }).format(n || 0)
const fmtNum = (n) => new Intl.NumberFormat('es-MX', { maximumFractionDigits: 4 }).format(n || 0)

function Row({ label, children }) {
  return (
    <div className="flex items-start justify-between gap-4 py-1.5">
      <span className="text-xs text-ink-muted shrink-0">{label}</span>
      <span className="text-sm text-ink-primary text-right min-w-0 break-words">{children ?? '—'}</span>
    </div>
  )
}

function Sect({ title, children }) {
  return (
    <div className="border-t border-line-subtle pt-3 mt-3 first:border-0 first:pt-0 first:mt-0">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-secondary mb-1">{title}</p>
      {children}
    </div>
  )
}

/**
 * Detalle de PRODUCTO en solo lectura. Se abre al hacer clic en una fila del
 * catálogo, sin entrar a editar (no requiere products:update). Incluye botón
 * "Editar" para quien sí tenga permiso.
 */
export default function ProductDetailModal({ productId, onClose, onEdit }) {
  const { data: p, isLoading } = useQuery({
    queryKey: ['product-detail', productId],
    queryFn:  () => productsApi.get(productId),
    enabled:  !!productId,
    staleTime: 30000,
  })

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40 p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="card w-full max-w-lg p-0 max-h-[90vh] flex flex-col">
        {isLoading || !p ? (
          <div className="flex justify-center py-16"><Spinner /></div>
        ) : (
          <>
            <div className="px-6 pt-5 pb-3 border-b border-line-subtle">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="eyebrow">PRODUCTO</p>
                  <h2 className="text-base font-semibold text-ink-primary mt-0.5 break-words">{p.name}</h2>
                  <p className="text-xs font-mono text-ink-muted mt-0.5">{p.sku}</p>
                </div>
                <Badge status={p.is_active ? 'confirmed' : 'cancelled'} label={p.is_active ? 'Activo' : 'Inactivo'} />
              </div>
            </div>

            <div className="px-6 py-4 overflow-y-auto">
              <Sect title="Identificación">
                <Row label="¿Se fabrica?">{p.is_produced ? 'Sí' : 'No (reventa)'}</Row>
                {p.product_kind_name && <Row label="Clasificación">{p.product_kind_name}</Row>}
                <Row label="Unidad de venta">{p.sale_unit}</Row>
                <Row label="Lead time">{(p.lead_time_days ?? 7)} días</Row>
                {p.description && <Row label="Descripción">{p.description}</Row>}
              </Sect>

              <Sect title="Precio">
                <Row label="Precio base">{p.base_price != null ? `${fmtMXN(p.base_price)} ${p.base_currency || 'MXN'}` : '—'}</Row>
                {p.expected_sale_price != null && <Row label="Precio esperado (NRV)">{fmtMXN(p.expected_sale_price)}</Row>}
              </Sect>

              <Sect title="Costo">
                <Row label="Costo estimado">{p.standard_cost != null ? fmtMXN(p.standard_cost) : '—'}</Row>
                <Row label="Costo prom. inventario">{p.weightedAvgCost != null ? fmtMXN(p.weightedAvgCost) : '—'}</Row>
                {Array.isArray(p.stockCosts) && p.stockCosts.length > 0 && (
                  <div className="mt-1.5 rounded-lg bg-surface-elevated/40 border border-line-subtle px-3 py-2 space-y-1">
                    {p.stockCosts.map((s, i) => (
                      <div key={i} className="flex items-center justify-between gap-3 text-[13px]">
                        <span className="text-ink-secondary truncate">
                          {s.warehouse_name}{s.status !== 'available' && <span className="text-ink-muted"> · {s.status}</span>}
                        </span>
                        <span className="text-ink-primary tabular-nums whitespace-nowrap">
                          {fmtNum(s.quantity)} · {fmtMXN(s.avg_cost)}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </Sect>

              {p.second_quality_product_id && (
                <Sect title="Segunda calidad">
                  <Row label="Producto de 2ª por defecto">
                    {p.second_quality_product_name || '—'}
                    {p.second_quality_product_sku ? <span className="text-ink-muted"> · {p.second_quality_product_sku}</span> : null}
                  </Row>
                </Sect>
              )}

              <Sect title="Fiscal (SAT)">
                <Row label="Clave producto">{p.sat_product_code}</Row>
                <Row label="Clave unidad">{p.sat_unit_code}</Row>
                <Row label="Objeto de impuesto">{p.objeto_imp}</Row>
                <Row label="IVA">{p.tax_rate != null ? `${p.tax_rate}%` : '—'}</Row>
              </Sect>

              {Array.isArray(p.packOptions) && p.packOptions.length > 0 && (
                <Sect title="Presentaciones">
                  {p.packOptions.map((o) => (
                    <Row key={o.id} label={`${o.pack_unit}${o.is_default ? ' (default)' : ''}`}>
                      {fmtNum(o.base_per_pack)} × unidad base
                    </Row>
                  ))}
                </Sect>
              )}
            </div>

            <div className="px-6 py-4 border-t border-line-subtle flex gap-2">
              <button onClick={onClose} className="btn-secondary flex-1">Cerrar</button>
              <Can do="products:update">
                <button onClick={() => onEdit?.(p)} className="btn-primary flex-1">Editar</button>
              </Can>
            </div>
          </>
        )}
      </div>
    </div>,
    document.body
  )
}
