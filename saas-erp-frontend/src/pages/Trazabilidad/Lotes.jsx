import { useState, useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { traceabilityApi } from '@/api/traceability'
import { processConfigApi } from '@/api/processConfig'
import Badge from '@/components/ui/Badge'
import Spinner from '@/components/ui/Spinner'
import clsx from 'clsx'

const KIND_LABEL   = { raw_material: 'Materia prima', packaging: 'Embalaje', additive: 'Aditivo' }
const KIND_VARIANT = { raw_material: 'amber', packaging: 'teal', additive: 'purple' }

const fmtNum = (n, d = 2) =>
  n == null ? '—' : Number(n).toLocaleString('es-MX', { minimumFractionDigits: 0, maximumFractionDigits: d })

const fmtDate = (d) => d
  ? new Date(d).toLocaleDateString('es-MX', { day: 'numeric', month: 'short', year: 'numeric' })
  : '—'

const fmtDateTime = (d) => d
  ? new Date(d).toLocaleString('es-MX', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
  : '—'

// ═══════════════════════════════════════════════════════════════════════════
//  Página principal
// ═══════════════════════════════════════════════════════════════════════════
export default function Trazabilidad() {
  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [selected, setSelected] = useState(null) // { type: 'raw'|'product', id }

  // Cargar tenantConfig para mostrar aviso si uses_lots=false.
  const { data: tenantConfig } = useQuery({
    queryKey: ['tenant-process-config'],
    queryFn:  processConfigApi.getConfig,
    staleTime: 300000,
  })
  const usesLots = tenantConfig?.uses_lots ?? false

  // Debounce simple
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 300)
    return () => clearTimeout(t)
  }, [search])

  const { data: searchResults, isLoading: searching } = useQuery({
    queryKey: ['traceability-search', debouncedSearch],
    queryFn:  () => traceabilityApi.search(debouncedSearch),
    enabled:  usesLots && debouncedSearch.length >= 2,
  })

  if (!tenantConfig) {
    return <div className="flex justify-center py-16"><Spinner /></div>
  }

  if (!usesLots) {
    return (
      <div className="page-enter">
        <div className="page-header">
          <h1 className="page-title">Trazabilidad de lotes</h1>
        </div>
        <div className="bg-status-info/10 border border-status-info/40 rounded-xl px-4 py-4 text-sm text-status-info">
          <p className="font-medium mb-1">Tu tenant no maneja lotes</p>
          <p className="leading-relaxed">
            Para usar trazabilidad necesitas activar el flag <strong>"Usar lotes de MP"</strong> en
            Configuración → Flags de proceso. Solo aplica a industrias que requieren rastrear MP→PT→cliente
            (alimentos, farma, productos con caducidad).
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="page-enter">
      <div className="page-header">
        <div>
          <h1 className="page-title">Trazabilidad de lotes</h1>
          <p className="page-subtitle">Sigue la cadena MP → producto terminado → cliente</p>
        </div>
      </div>

      <div className="bg-status-info/10 border border-status-info/40 rounded-xl px-4 py-3 text-sm text-status-info mb-5">
        <p className="font-medium mb-1">¿Cómo funciona?</p>
        <p className="leading-relaxed">
          Busca un lote por su número (de MP o de PT). Te muestra:
        </p>
        <ul className="list-disc list-inside leading-relaxed mt-1 ml-1">
          <li><strong>Si es un lote de PT:</strong> qué materia prima entró + qué clientes lo recibieron.</li>
          <li><strong>Si es un lote de MP:</strong> qué productos terminados se hicieron con él + lista completa de clientes finales (para recall).</li>
        </ul>
      </div>

      <div className="mb-5">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Buscar por número de lote o lote del proveedor..."
          className="input max-w-xl text-base"
          autoFocus
        />
      </div>

      {/* Resultados de búsqueda */}
      {debouncedSearch.length >= 2 && !selected && (
        <SearchResults results={searchResults} isLoading={searching} onSelect={setSelected} />
      )}

      {/* Detalle del lote seleccionado */}
      {selected?.type === 'product' && (
        <ProductLotDetail id={selected.id} onClose={() => setSelected(null)} onJumpToRawLot={(id) => setSelected({ type: 'raw', id })} />
      )}
      {selected?.type === 'raw' && (
        <RawLotDetail id={selected.id} onClose={() => setSelected(null)} onJumpToProductLot={(id) => setSelected({ type: 'product', id })} />
      )}

      {!selected && debouncedSearch.length < 2 && (
        <div className="empty-state">
          <p className="font-medium text-ink-secondary">Empieza por buscar un lote</p>
          <p className="text-sm text-ink-muted mt-1">Captura al menos 2 caracteres del número de lote.</p>
        </div>
      )}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════
//  Resultados de búsqueda
// ═══════════════════════════════════════════════════════════════════════════
function SearchResults({ results, isLoading, onSelect }) {
  if (isLoading) return <div className="flex justify-center py-8"><Spinner /></div>
  const raw = results?.rawMaterialLots || []
  const prod = results?.productLots || []
  if (raw.length === 0 && prod.length === 0) {
    return (
      <div className="empty-state">
        <p className="font-medium text-ink-secondary">Sin resultados</p>
        <p className="text-sm text-ink-muted mt-1">No se encontraron lotes que coincidan.</p>
      </div>
    )
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      {prod.length > 0 && (
        <section>
          <h2 className="text-xs font-semibold text-ink-muted uppercase tracking-wide mb-2">
            Producto terminado ({prod.length})
          </h2>
          <div className="space-y-2">
            {prod.map(l => (
              <button key={l.id} onClick={() => onSelect({ type: 'product', id: l.id })}
                className="w-full card hover:border-brand-500/40 transition-colors text-left">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-ink-primary font-mono">{l.lot_number}</p>
                    <p className="text-xs text-ink-muted mt-0.5">
                      {l.product_name} · {l.product_sku}
                      {l.quality_grade_name && <> · {l.quality_grade_name}</>}
                    </p>
                    <p className="text-[11px] text-ink-muted mt-1">
                      Producido {fmtDate(l.production_date)}
                      {l.expiry_date && <> · vence {fmtDate(l.expiry_date)}</>}
                    </p>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="text-sm font-mono">{fmtNum(l.quantity_remaining, 2)} / {fmtNum(l.quantity_produced, 2)}</p>
                    <Badge variant={l.status === 'active' ? 'green' : 'gray'} label={l.status} />
                  </div>
                </div>
              </button>
            ))}
          </div>
        </section>
      )}

      {raw.length > 0 && (
        <section>
          <h2 className="text-xs font-semibold text-ink-muted uppercase tracking-wide mb-2">
            Materia prima ({raw.length})
          </h2>
          <div className="space-y-2">
            {raw.map(l => (
              <button key={l.id} onClick={() => onSelect({ type: 'raw', id: l.id })}
                className="w-full card hover:border-brand-500/40 transition-colors text-left">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-ink-primary font-mono">{l.lot_number}</p>
                    <p className="text-xs text-ink-muted mt-0.5">
                      {l.raw_material_name}
                      <Badge variant={KIND_VARIANT[l.item_kind] || 'gray'} label={KIND_LABEL[l.item_kind] || l.item_kind} className="ml-1.5" />
                    </p>
                    <p className="text-[11px] text-ink-muted mt-1">
                      Recibido {fmtDate(l.received_at)}
                      {l.supplier_name && <> · de {l.supplier_name}</>}
                      {l.expiry_date && <> · vence {fmtDate(l.expiry_date)}</>}
                    </p>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="text-sm font-mono">{fmtNum(l.quantity_remaining, 2)} / {fmtNum(l.quantity_received, 2)}</p>
                    <Badge variant={l.status === 'active' ? 'green' : 'gray'} label={l.status} />
                  </div>
                </div>
              </button>
            ))}
          </div>
        </section>
      )}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════
//  Detalle de lote PT — backward + forward
// ═══════════════════════════════════════════════════════════════════════════
function ProductLotDetail({ id, onClose, onJumpToRawLot }) {
  const { data, isLoading } = useQuery({
    queryKey: ['traceability-product-lot', id],
    queryFn:  () => traceabilityApi.getProductLot(id),
  })

  if (isLoading) return <div className="flex justify-center py-16"><Spinner /></div>
  if (!data) return null

  const { lot, backward, forward } = data

  return (
    <div className="space-y-4">
      <button onClick={onClose} className="btn-ghost btn-sm text-xs">← Volver a búsqueda</button>

      {/* Encabezado del lote */}
      <section className="card border-brand-500/40">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <p className="text-[10px] uppercase tracking-wider font-semibold text-brand-300">Lote de producto terminado</p>
            <p className="text-xl font-bold text-ink-primary font-mono mt-1">{lot.lot_number}</p>
            <p className="text-sm text-ink-secondary mt-1">
              {lot.product_name} <span className="font-mono text-ink-muted">· {lot.product_sku}</span>
            </p>
            {lot.quality_grade_name && (
              <Badge variant="blue" label={`Grado ${lot.grade_number} · ${lot.quality_grade_name}`} className="mt-2" />
            )}
          </div>
          <div className="text-right text-sm">
            <p><span className="text-ink-muted">Producido:</span> {fmtDate(lot.production_date)}</p>
            {lot.expiry_date && <p><span className="text-ink-muted">Vence:</span> {fmtDate(lot.expiry_date)}</p>}
            <p className="mt-1"><span className="text-ink-muted">Cantidad:</span> <strong>{fmtNum(lot.quantity_remaining, 2)} / {fmtNum(lot.quantity_produced, 2)}</strong></p>
            <Badge variant={lot.status === 'active' ? 'green' : 'gray'} label={lot.status} className="mt-1" />
          </div>
        </div>

        {(lot.order_number || lot.shift_number) && (
          <div className="mt-3 pt-3 border-t border-line-subtle text-xs text-ink-muted flex flex-wrap gap-x-4 gap-y-1">
            {lot.order_number && <span>Orden: <strong className="text-ink-secondary">{lot.order_number}</strong></span>}
            {lot.shift_number && <span>Turno: <strong className="text-ink-secondary">{lot.shift_number} · {fmtDate(lot.shift_date)}</strong></span>}
            {lot.operator_name && <span>Operador: <strong className="text-ink-secondary">{lot.operator_name}</strong></span>}
            {lot.warehouse_name && <span>Almacén: <strong className="text-ink-secondary">{lot.warehouse_name}</strong></span>}
          </div>
        )}
      </section>

      {/* Backward — qué MP entró */}
      <section>
        <h2 className="text-sm font-semibold text-ink-primary mb-2 flex items-center gap-2">
          <span className="w-1 h-4 bg-status-warning rounded" />
          Materia prima consumida ({backward.length})
          <span className="text-xs font-normal text-ink-muted">— qué entró en este lote</span>
        </h2>
        {backward.length === 0 ? (
          <p className="text-sm text-ink-muted italic px-3 py-4 bg-surface-elevated/30 rounded-lg">
            No hay registros de consumo de MP para este lote.
          </p>
        ) : (
          <div className="card p-0 overflow-x-auto">
            <table className="table text-xs">
              <thead>
                <tr>
                  <th>Material</th>
                  <th>Lote MP</th>
                  <th>Proveedor</th>
                  <th className="text-right">Consumido</th>
                  <th>Recepción</th>
                </tr>
              </thead>
              <tbody>
                {backward.map(b => (
                  <tr key={b.consumption_id}>
                    <td>
                      <p className="font-medium text-ink-primary">{b.raw_material_name}</p>
                      <Badge variant={KIND_VARIANT[b.item_kind] || 'gray'} label={KIND_LABEL[b.item_kind] || b.item_kind} />
                    </td>
                    <td>
                      <button onClick={() => onJumpToRawLot(b.raw_material_lot_id)}
                        className="font-mono text-brand-300 hover:underline text-xs">
                        {b.raw_material_lot_number}
                      </button>
                      {b.manufacturer_lot && (
                        <p className="text-[10px] text-ink-muted">prov: {b.manufacturer_lot}</p>
                      )}
                      {b.expiry_date && (
                        <p className="text-[10px] text-ink-muted">vence {fmtDate(b.expiry_date)}</p>
                      )}
                    </td>
                    <td className="text-xs text-ink-secondary">{b.supplier_name || '—'}</td>
                    <td className="text-right tabular-nums">
                      {fmtNum(b.quantity_consumed, 3)} {b.unit_symbol || b.unit_code || ''}
                    </td>
                    <td className="text-xs text-ink-muted">
                      {b.receipt_number ? <p className="font-mono">{b.receipt_number}</p> : null}
                      <p>{fmtDate(b.received_date || b.received_at)}</p>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Forward — qué clientes lo recibieron */}
      <section>
        <h2 className="text-sm font-semibold text-ink-primary mb-2 flex items-center gap-2">
          <span className="w-1 h-4 bg-status-success rounded" />
          Despachado a clientes ({forward.length})
          <span className="text-xs font-normal text-ink-muted">— a quién se entregó</span>
        </h2>
        {forward.length === 0 ? (
          <p className="text-sm text-ink-muted italic px-3 py-4 bg-surface-elevated/30 rounded-lg">
            Este lote aún no se ha despachado a ningún cliente.
          </p>
        ) : (
          <div className="card p-0 overflow-x-auto">
            <table className="table text-xs">
              <thead>
                <tr>
                  <th>Remisión</th>
                  <th>Cliente</th>
                  <th className="text-right">Cantidad</th>
                  <th>Fecha</th>
                  <th>Estado</th>
                </tr>
              </thead>
              <tbody>
                {forward.map(f => (
                  <tr key={f.delivery_line_id}>
                    <td className="font-mono text-xs">{f.document_number}</td>
                    <td className="font-medium">{f.partner_name}</td>
                    <td className="text-right tabular-nums">
                      {fmtNum(f.quantity_base || f.quantity_delivered, 2)} {f.unit}
                    </td>
                    <td className="text-xs text-ink-muted">{fmtDate(f.issue_date)}</td>
                    <td><Badge status={f.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════
//  Detalle de lote MP — forward (recall)
// ═══════════════════════════════════════════════════════════════════════════
function RawLotDetail({ id, onClose, onJumpToProductLot }) {
  const { data, isLoading } = useQuery({
    queryKey: ['traceability-raw-lot', id],
    queryFn:  () => traceabilityApi.getRawMaterialLot(id),
  })

  if (isLoading) return <div className="flex justify-center py-16"><Spinner /></div>
  if (!data) return null

  const { lot, productLots, customers } = data
  const customersByPartner = customers.reduce((acc, c) => {
    if (!acc[c.partner_id]) acc[c.partner_id] = { name: c.partner_name, count: 0, deliveries: [] }
    acc[c.partner_id].count += 1
    acc[c.partner_id].deliveries.push(c)
    return acc
  }, {})

  return (
    <div className="space-y-4">
      <button onClick={onClose} className="btn-ghost btn-sm text-xs">← Volver a búsqueda</button>

      {/* Encabezado del lote MP */}
      <section className="card border-status-warning/40">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <p className="text-[10px] uppercase tracking-wider font-semibold text-status-warning">Lote de materia prima</p>
            <p className="text-xl font-bold text-ink-primary font-mono mt-1">{lot.lot_number}</p>
            <p className="text-sm text-ink-secondary mt-1">
              {lot.raw_material_name}
              <Badge variant={KIND_VARIANT[lot.item_kind] || 'gray'} label={KIND_LABEL[lot.item_kind] || lot.item_kind} className="ml-2" />
            </p>
            {lot.manufacturer_lot && (
              <p className="text-xs text-ink-muted mt-1">Lote del proveedor: <span className="font-mono">{lot.manufacturer_lot}</span></p>
            )}
          </div>
          <div className="text-right text-sm">
            <p><span className="text-ink-muted">Recibido:</span> {fmtDate(lot.received_at)}</p>
            {lot.expiry_date && <p><span className="text-ink-muted">Vence:</span> {fmtDate(lot.expiry_date)}</p>}
            {lot.supplier_name && <p><span className="text-ink-muted">Proveedor:</span> <strong>{lot.supplier_name}</strong></p>}
            <p className="mt-1"><span className="text-ink-muted">Saldo:</span> <strong>{fmtNum(lot.quantity_remaining, 2)} / {fmtNum(lot.quantity_received, 2)}</strong></p>
            <Badge variant={lot.status === 'active' ? 'green' : 'gray'} label={lot.status} className="mt-1" />
          </div>
        </div>

        {(lot.receipt_number || lot.warehouse_name) && (
          <div className="mt-3 pt-3 border-t border-line-subtle text-xs text-ink-muted flex flex-wrap gap-x-4 gap-y-1">
            {lot.receipt_number && <span>Recepción: <strong className="text-ink-secondary font-mono">{lot.receipt_number}</strong></span>}
            {lot.warehouse_name && <span>Almacén: <strong className="text-ink-secondary">{lot.warehouse_name}</strong></span>}
          </div>
        )}
      </section>

      {/* PTs producidos */}
      <section>
        <h2 className="text-sm font-semibold text-ink-primary mb-2 flex items-center gap-2">
          <span className="w-1 h-4 bg-brand-500 rounded" />
          Productos terminados que lo usaron ({productLots.length})
        </h2>
        {productLots.length === 0 ? (
          <p className="text-sm text-ink-muted italic px-3 py-4 bg-surface-elevated/30 rounded-lg">
            Este lote aún no se ha consumido en producción.
          </p>
        ) : (
          <div className="card p-0 overflow-x-auto">
            <table className="table text-xs">
              <thead>
                <tr>
                  <th>Producto</th>
                  <th>Lote PT</th>
                  <th>Producción</th>
                  <th className="text-right">Consumido</th>
                  <th>Estado</th>
                </tr>
              </thead>
              <tbody>
                {productLots.map(p => (
                  <tr key={p.id}>
                    <td>
                      <p className="font-medium text-ink-primary">{p.product_name}</p>
                      <p className="text-[10px] font-mono text-ink-muted">{p.product_sku}</p>
                    </td>
                    <td>
                      <button onClick={() => onJumpToProductLot(p.id)}
                        className="font-mono text-brand-300 hover:underline">
                        {p.lot_number}
                      </button>
                    </td>
                    <td className="text-xs text-ink-muted">{fmtDate(p.production_date)}</td>
                    <td className="text-right tabular-nums">{fmtNum(p.total_consumed_from_this_mp_lot, 3)}</td>
                    <td><Badge variant={p.status === 'active' ? 'green' : 'gray'} label={p.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Clientes finales — para recall */}
      {customers.length > 0 && (
        <section>
          <h2 className="text-sm font-semibold text-status-danger mb-2 flex items-center gap-2">
            <span className="w-1 h-4 bg-status-danger rounded" />
            Clientes finales ({Object.keys(customersByPartner).length})
            <span className="text-xs font-normal text-ink-muted">— para alertas y recall</span>
          </h2>
          <div className="bg-status-danger/5 border border-status-danger/30 rounded-xl p-4 space-y-3">
            {Object.entries(customersByPartner).map(([partnerId, info]) => (
              <div key={partnerId} className="bg-surface-primary rounded-lg p-3">
                <p className="font-semibold text-ink-primary">{info.name}</p>
                <p className="text-xs text-ink-muted mt-0.5">{info.count} entrega(s)</p>
                <div className="mt-2 space-y-1 text-xs">
                  {info.deliveries.map((d, idx) => (
                    <div key={`${d.delivery_note_id}-${idx}`} className="flex items-center justify-between gap-3 text-ink-muted">
                      <span className="font-mono">{d.document_number}</span>
                      <span>{d.product_name} · lote <span className="font-mono">{d.product_lot_number}</span></span>
                      <span className="tabular-nums">{fmtNum(d.quantity_base, 2)} {d.unit}</span>
                      <span>{fmtDate(d.issue_date)}</span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  )
}
