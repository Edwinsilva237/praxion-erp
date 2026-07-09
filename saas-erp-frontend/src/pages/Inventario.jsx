import { useState, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { inventoryApi } from '@/api/inventory'
import Spinner from '@/components/ui/Spinner'
import Can from '@/components/auth/Can'
import Badge from '@/components/ui/Badge'
import AdjustmentModal        from '@/components/inventario/AdjustmentModal'
import AdjustmentDetallePanel from '@/components/inventario/AdjustmentDetallePanel'
import ItemDetailPanel        from '@/components/inventario/ItemDetailPanel'
import RecomputeStockModal    from '@/components/inventario/RecomputeStockModal'
import EditCostModal          from '@/components/inventario/EditCostModal'
import ReleaseBlockedModal    from '@/components/inventario/ReleaseBlockedModal'
import ScanButton             from '@/components/scanner/ScanButton'
import clsx from 'clsx'

// ── Catálogos ─────────────────────────────────────────────────────────────────

const MOVEMENT_LABELS = {
  purchase_entry:            'Compra',
  production_mp_consumption: 'Consumo MP',
  production_mp_reserve:     'MP → WIP',
  production_mp_return:      'Devolución MP',
  production_pt_entry:       'Entrada PT',
  production_wip_entry:      'Entrada WIP',
  production_wip_to_pt:      'WIP → PT',
  sale_exit:                 'Venta',
  adjustment_in:             'Ajuste entrada',
  adjustment_out:            'Ajuste salida',
  scrap_entry:               'Entrada merma',
  scrap_disposal:            'Baja merma',
  scrap_to_regrind:          'Merma → Regrind',
  transfer_in:               'Transferencia entrada',
  transfer_out:              'Transferencia salida',
}

const MOVEMENT_BADGE = {
  purchase_entry:            'green',
  production_mp_consumption: 'red',
  production_mp_reserve:     'amber',
  production_mp_return:      'blue',
  production_pt_entry:       'green',
  production_wip_entry:      'blue',
  production_wip_to_pt:      'purple',
  adjustment_in:             'blue',
  adjustment_out:            'amber',
  sale_exit:                 'purple',
  scrap_entry:               'gray',
  scrap_disposal:            'gray',
  scrap_to_regrind:          'amber',
  transfer_in:               'blue',
  transfer_out:              'amber',
  default:                   'gray',
}

// Etiquetas legibles para la columna "Referencia" del kardex
const REFERENCE_LABELS = {
  supplier_receipt:               'Recepción',
  supplier_invoice:               'Factura proveedor',
  shift_progress:                 'Captura turno',
  production_shift:               'Turno producción',
  production_order:               'Orden producción',
  inventory_adjustment:           'Ajuste',
  inventory_adjustment_reversal:  'Reversión ajuste',
  manual_adjustment:              'Ajuste manual',
  sales_order:                    'Pedido',
  delivery_note:                  'Remisión',
  invoice:                        'Factura',
}

// ── Helpers de formato ────────────────────────────────────────────────────────
function fmtNum(n, decimals = 2) {
  if (n == null) return '—'
  return Number(n).toLocaleString('es-MX', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
}
function fmtMXN(n) {
  if (n == null) return '—'
  return `$${fmtNum(n)}`
}
function fmtDate(d) {
  if (!d) return '—'
  return new Date(d).toLocaleDateString('es-MX', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}
function fmtDateShort(d) {
  if (!d) return '—'
  return new Date(d).toLocaleDateString('es-MX', { day: '2-digit', month: 'short', year: 'numeric' })
}

// ── Sub-componente: tarjeta resumen ───────────────────────────────────────────
function SummaryCard({ warehouse, rows }) {
  const total = rows.reduce((s, r) => s + parseFloat(r.total_value || 0), 0)
  const items = rows.reduce((s, r) => s + parseInt(r.item_count || 0), 0)
  return (
    <div className="card p-4 flex flex-col gap-3 col-span-2 md:col-span-1">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-ink-primary break-words">{warehouse}</p>
          <p className="text-xs text-ink-muted">{items} artículo{items !== 1 ? 's' : ''}</p>
        </div>
        <span className="text-base font-bold text-ink-primary whitespace-nowrap shrink-0">{fmtMXN(total)}</span>
      </div>
      {rows.map((r) => (
        <div
          key={`${r.warehouse_id}-${r.item_type}`}
          className="flex items-center justify-between text-xs text-ink-secondary border-t border-line-subtle pt-2"
        >
          <span>{r.item_type === 'raw_material' ? 'Materias primas' : 'Productos terminados'}</span>
          <span className="font-medium">
            {fmtNum(r.total_quantity, 2)} {r.item_type === 'raw_material' ? 'kg' : 'pzas'}
          </span>
        </div>
      ))}
    </div>
  )
}

// ── Subcomponente: card de nivel (clickable) ─────────────────────────────────
function LevelCard({ color, icon, label, count, description, active, onClick }) {
  const colorClasses = {
    red:   active ? 'bg-status-danger/10 border-status-danger/40 ring-2 ring-status-danger/40'     : 'bg-surface-primary border-line-subtle hover:border-status-danger/40',
    amber: active ? 'bg-status-warning/10 border-status-warning/40 ring-2 ring-amber-200' : 'bg-surface-primary border-line-subtle hover:border-status-warning/40',
    green: active ? 'bg-status-success/10 border-status-success/40 ring-2 ring-green-200' : 'bg-surface-primary border-line-subtle hover:border-status-success/40',
    blue:  active ? 'bg-status-info/10 border-status-info/40 ring-2 ring-blue-200'   : 'bg-surface-primary border-line-subtle hover:border-status-info/40',
  }
  const textColor = {
    red: 'text-status-danger', amber: 'text-status-warning', green: 'text-status-success', blue: 'text-status-info',
  }
  return (
    <button
      onClick={onClick}
      className={clsx(
        'border rounded-xl p-3 text-left transition-all cursor-pointer',
        colorClasses[color] || colorClasses.green
      )}
    >
      <div className="flex items-baseline justify-between mb-1">
        <span className="text-base">{icon}</span>
        <span className={clsx('text-2xl font-bold', textColor[color] || 'text-ink-primary')}>
          {count ?? 0}
        </span>
      </div>
      <p className="text-xs font-medium text-ink-secondary">{label}</p>
      <p className="text-[10px] text-ink-muted">{description}</p>
    </button>
  )
}

// ── Subcomponente: punto de color por estado de nivel ────────────────────────
function LevelDot({ status }) {
  const config = {
    below_min:  { color: 'bg-red-500',   title: 'Bajo mínimo' },
    at_reorder: { color: 'bg-amber-500', title: 'En reorden' },
    normal:     { color: 'bg-green-500', title: 'Normal' },
    overstock:  { color: 'bg-blue-500',  title: 'Sobrestock' },
  }
  const c = config[status]
  if (!c) return null
  return (
    <span
      className={clsx('inline-block w-2 h-2 rounded-full', c.color)}
      title={c.title}
    />
  )
}

// ── Componente principal ──────────────────────────────────────────────────────
export default function Inventario() {
  const [tab, setTab]                 = useState('stock')
  const [warehouseFilter, setWH]      = useState('')
  const [itemTypeFilter, setItemType] = useState('')
  const [search, setSearch]           = useState('')
  const [searchInput, setSearchInput] = useState('')

  // Filtros kardex
  const [movType, setMovType]   = useState('')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo]     = useState('')
  const [movPage, setMovPage]   = useState(1)

  // Filtros ajustes
  const [adjStatus, setAdjStatus] = useState('')   // '' | 'active' | 'cancelled'
  const [adjFrom, setAdjFrom]     = useState('')
  const [adjTo, setAdjTo]         = useState('')
  const [adjSearch, setAdjSearch] = useState('')
  const [adjPage, setAdjPage]     = useState(1)

  // Filtros stock - niveles
  const [levelFilter, setLevelFilter] = useState('')   // '' | 'below_min' | 'at_reorder' | 'normal' | 'overstock'
  const [includeZero, setIncludeZero] = useState(false) // incluir artículos del catálogo sin existencia

  // UI state
  const [showAdjustModal, setShowAdjustModal] = useState(false)
  const [showRecompute, setShowRecompute] = useState(false)
  const [editCostRow, setEditCostRow] = useState(null)
  const [releaseRow, setReleaseRow] = useState(null)
  const [selectedAdjustId, setSelectedAdjustId] = useState(null)
  const [selectedStockItem, setSelectedStockItem] = useState(null)  // {itemType, itemId, warehouseId}
  const [createdMsg, setCreatedMsg] = useState(null)

  // ── Queries ─────────────────────────────────────────────────────────────
  const { data: warehouses = [] } = useQuery({
    queryKey: ['inv-warehouses'],
    queryFn:  inventoryApi.getWarehouses,
  })

  const { data: summary = [] } = useQuery({
    queryKey: ['inv-summary'],
    queryFn:  inventoryApi.getSummary,
  })

  // Resumen de niveles por estado (cards 🔴🟡🟢🔵)
  const { data: levelsSummary } = useQuery({
    queryKey: ['inv-levels-summary'],
    queryFn:  inventoryApi.getLevelsSummary,
  })

  // Listado de niveles configurados (con estado calculado)
  const { data: levelsList = [] } = useQuery({
    queryKey: ['inv-levels'],
    queryFn:  () => inventoryApi.listLevels({}),
  })

  const { data: stockData, isLoading: loadingStock } = useQuery({
    queryKey: ['inv-stock', warehouseFilter, itemTypeFilter, search, includeZero],
    queryFn:  () => inventoryApi.getStock({
      warehouse_id: warehouseFilter || undefined,
      item_type:    itemTypeFilter  || undefined,
      search:       search          || undefined,
      include_zero: includeZero ? 'true' : undefined,
      limit:        includeZero ? 1000 : 100,
    }),
    enabled: tab === 'stock',
  })

  const { data: movData, isLoading: loadingMov } = useQuery({
    queryKey: ['inv-movements', warehouseFilter, movType, dateFrom, dateTo, movPage],
    queryFn:  () => inventoryApi.getMovements({
      warehouse_id:  warehouseFilter || undefined,
      movement_type: movType         || undefined,
      date_from:     dateFrom        || undefined,
      date_to:       dateTo          || undefined,
      page:          movPage,
      limit: 50,
    }),
    enabled: tab === 'movimientos',
  })

  const { data: adjData, isLoading: loadingAdj } = useQuery({
    queryKey: ['inv-adjustments', warehouseFilter, adjStatus, adjFrom, adjTo, adjSearch, adjPage],
    queryFn:  () => inventoryApi.listAdjustments({
      warehouse_id: warehouseFilter || undefined,
      status:       adjStatus       || undefined,
      date_from:    adjFrom         || undefined,
      date_to:      adjTo           || undefined,
      search:       adjSearch       || undefined,
      page:         adjPage,
      limit: 25,
    }),
    enabled: tab === 'ajustes',
  })

  // ── Resumen agrupado por almacén ─────────────────────────────────────────
  const summaryByWarehouse = useMemo(() => {
    const map = {}
    for (const row of summary) {
      if (!map[row.warehouse_name]) map[row.warehouse_name] = []
      map[row.warehouse_name].push(row)
    }
    return map
  }, [summary])

  const totalValue = summary.reduce((s, r) => s + parseFloat(r.total_value || 0), 0)

  // Lookup de niveles por (item_type, item_id, warehouse_id) → status calculado
  // + en tránsito (cantidad pendiente de recibir por OCs activas a este almacén).
  const levelStatusMap = useMemo(() => {
    const map = {}
    for (const lvl of levelsList) {
      const key = `${lvl.item_type}|${lvl.item_id}|${lvl.warehouse_id}`
      map[key] = { status: lvl.status_calc, inTransit: parseFloat(lvl.in_transit || 0) }
    }
    return map
  }, [levelsList])

  const filteredStockData = useMemo(() => {
    // Sin filtro de nivel: usar stockData directamente (incluye solo items con quantity > 0)
    if (!levelFilter) return stockData

    // Con filtro de nivel: usar levelsList (incluye items con quantity = 0,
    // que también pueden estar bajo mínimo y no aparecen en inventory_stock).
    const filtered = levelsList.filter(lvl => lvl.status_calc === levelFilter)
    return {
      data: filtered.map(lvl => ({
        id:               lvl.id,
        item_id:          lvl.item_id,
        item_type:        lvl.item_type,
        item_name:        lvl.item_name,
        sku:              lvl.sku,
        warehouse_id:     lvl.warehouse_id,
        warehouse_name:   lvl.warehouse_name,
        status:           'available',
        quantity:         parseFloat(lvl.current_stock || 0),
        unit:             lvl.unit,
        avg_cost:         parseFloat(lvl.avg_cost || 0),
        total_value:      parseFloat(lvl.current_stock || 0) * parseFloat(lvl.avg_cost || 0),
        last_movement_at: null,
      })),
      total: filtered.length,
    }
  }, [stockData, levelFilter, levelsList])

  const handleSearch = (e) => {
    e.preventDefault()
    setSearch(searchInput)
  }

  // Escaneo: el código leído se vuelve el término de búsqueda y filtra de una vez.
  const handleScan = (code) => {
    setSearchInput(code)
    setSearch(code)
  }

  function handleAdjustmentSaved(adj) {
    setCreatedMsg(`Ajuste ${adj.adjustment_number} guardado correctamente.`)
    setTimeout(() => setCreatedMsg(null), 5000)
    setTab('ajustes')
  }

  return (
    <div className="page-enter flex flex-col gap-6">
      {/* ── Header ─────────────────────────────────────────────────── */}
      <div className="page-header">
        <div>
          <h1 className="page-title">Inventario</h1>
          <p className="page-subtitle">Stock actual, kardex y documentos de ajuste</p>
        </div>
        <Can do="inventory:adjust">
          <div className="flex gap-2">
            <button onClick={() => setShowRecompute(true)} className="btn-secondary"
              title="Recalcula los saldos a partir del kardex (suma de movimientos). Revela negativos por sobreventa.">
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
              Recalcular saldos
            </button>
            <button onClick={() => setShowAdjustModal(true)} className="btn-primary">
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
              Nuevo ajuste
            </button>
          </div>
        </Can>
      </div>

      {/* ── Mensaje de éxito ────────────────────────────────────────── */}
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

      {/* ── Tarjetas resumen ────────────────────────────────────────── */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="card p-4 col-span-2 md:col-span-1 flex flex-col gap-1">
          <p className="text-xs text-ink-muted">Valor total inventario</p>
          <p className="text-2xl font-bold text-ink-primary">{fmtMXN(totalValue)}</p>
        </div>
        {Object.entries(summaryByWarehouse).map(([wh, rows]) => (
          <SummaryCard key={wh} warehouse={wh} rows={rows} />
        ))}
      </div>

      {/* ── Cards de niveles de inventario ────────────────────────────── */}
      {levelsSummary && levelsSummary.total_configured > 0 && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <LevelCard
            color="red"   icon="🔴" label="Bajo mínimo"
            count={levelsSummary.below_min}
            description="Reabastecer urgente"
            active={levelFilter === 'below_min'}
            onClick={() => { setTab('stock'); setLevelFilter(levelFilter === 'below_min' ? '' : 'below_min') }}
          />
          <LevelCard
            color="amber" icon="🟡" label="En reorden"
            count={levelsSummary.at_reorder}
            description="Hacer pedido pronto"
            active={levelFilter === 'at_reorder'}
            onClick={() => { setTab('stock'); setLevelFilter(levelFilter === 'at_reorder' ? '' : 'at_reorder') }}
          />
          <LevelCard
            color="green" icon="🟢" label="Normal"
            count={levelsSummary.normal}
            description="Stock adecuado"
            active={levelFilter === 'normal'}
            onClick={() => { setTab('stock'); setLevelFilter(levelFilter === 'normal' ? '' : 'normal') }}
          />
          <LevelCard
            color="blue"  icon="🔵" label="Sobrestock"
            count={levelsSummary.overstock}
            description="Excede el máximo"
            active={levelFilter === 'overstock'}
            onClick={() => { setTab('stock'); setLevelFilter(levelFilter === 'overstock' ? '' : 'overstock') }}
          />
        </div>
      )}

      {/* ── Tabs ───────────────────────────────────────────────────── */}
      <div className="border-b border-line-subtle flex gap-6">
        {[
          ['stock',       'Stock actual'],
          ['movimientos', 'Kardex (movimientos)'],
          ['ajustes',     'Ajustes'],
        ].map(([key, label]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={clsx(
              'pb-2 text-sm font-medium border-b-2 transition-colors',
              tab === key
                ? 'border-brand-600 text-brand-300'
                : 'border-transparent text-ink-muted hover:text-ink-secondary'
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {/* ── Filtros ──────────────────────────────────────────────────── */}
      <div className="flex flex-wrap gap-3">
        <select
          className="select w-44 hidden sm:block"
          value={warehouseFilter}
          onChange={e => { setWH(e.target.value); setMovPage(1); setAdjPage(1) }}
        >
          <option value="">Todos los almacenes</option>
          {warehouses.map(w => (
            <option key={w.id} value={w.id}>{w.name}</option>
          ))}
        </select>

        {tab === 'stock' && (
          <>
            <select
              className="select w-44 hidden sm:block"
              value={itemTypeFilter}
              onChange={e => setItemType(e.target.value)}
            >
              <option value="">Todo tipo</option>
              <option value="raw_material">Materia prima</option>
              <option value="product">Producto terminado</option>
            </select>
            <select
              className="select w-44 hidden sm:block"
              value={levelFilter}
              onChange={e => setLevelFilter(e.target.value)}
            >
              <option value="">Todos los niveles</option>
              <option value="below_min">🔴 Bajo mínimo</option>
              <option value="at_reorder">🟡 En reorden</option>
              <option value="normal">🟢 Normal</option>
              <option value="overstock">🔵 Sobrestock</option>
            </select>
            <form onSubmit={handleSearch} className="flex gap-2 w-full sm:w-auto">
              <input
                className="input flex-1 sm:w-52"
                placeholder="Buscar o escanear artículo..."
                value={searchInput}
                onChange={e => setSearchInput(e.target.value)}
              />
              <ScanButton onScan={handleScan} title="Escanear código de barras" />
              <button type="submit" className="btn-secondary btn-sm">Buscar</button>
            </form>
            <label className="flex items-center gap-2 text-xs text-ink-secondary cursor-pointer select-none"
              title="Muestra TODO el catálogo (productos + MP), incluso los artículos sin existencia (en 0).">
              <input type="checkbox" className="w-4 h-4 accent-brand-500"
                checked={includeZero} onChange={e => setIncludeZero(e.target.checked)} />
              Incluir artículos en cero
            </label>
          </>
        )}

        {tab === 'movimientos' && (
          <>
            <select
              className="select w-44"
              value={movType}
              onChange={e => { setMovType(e.target.value); setMovPage(1) }}
            >
              <option value="">Todos los tipos</option>
              {Object.entries(MOVEMENT_LABELS).map(([k, v]) => (
                <option key={k} value={k}>{v}</option>
              ))}
            </select>
            <input
              type="date"
              className="input w-36"
              value={dateFrom}
              onChange={e => { setDateFrom(e.target.value); setMovPage(1) }}
              title="Desde"
            />
            <input
              type="date"
              className="input w-36"
              value={dateTo}
              onChange={e => { setDateTo(e.target.value); setMovPage(1) }}
              title="Hasta"
            />
          </>
        )}

        {tab === 'ajustes' && (
          <>
            <select
              className="select w-44"
              value={adjStatus}
              onChange={e => { setAdjStatus(e.target.value); setAdjPage(1) }}
            >
              <option value="">Todos los estados</option>
              <option value="active">Activos</option>
              <option value="cancelled">Cancelados</option>
            </select>
            <input
              type="date"
              className="input w-36"
              value={adjFrom}
              onChange={e => { setAdjFrom(e.target.value); setAdjPage(1) }}
              title="Desde"
            />
            <input
              type="date"
              className="input w-36"
              value={adjTo}
              onChange={e => { setAdjTo(e.target.value); setAdjPage(1) }}
              title="Hasta"
            />
            <input
              className="input w-52"
              placeholder="Buscar folio o motivo..."
              value={adjSearch}
              onChange={e => { setAdjSearch(e.target.value); setAdjPage(1) }}
            />
          </>
        )}
      </div>

      {/* ── TAB: Stock ──────────────────────────────────────────────── */}
      {tab === 'stock' && (
        loadingStock ? (
          <div className="flex justify-center py-16"><Spinner /></div>
        ) : !filteredStockData?.data?.length ? (
          <div className="empty-state">
            <p className="font-medium text-ink-secondary">
              {levelFilter ? 'Sin artículos en este nivel' : 'Sin stock registrado'}
            </p>
            <p className="text-sm text-ink-muted">
              {levelFilter
                ? 'Intenta quitar el filtro de nivel o configura niveles desde el detalle del producto/MP.'
                : 'El inventario se actualiza automáticamente al validar turnos de producción o al registrar compras.'}
            </p>
          </div>
        ) : (
          <>
          {/* ── Móvil: tarjetas (la tabla ancha vive solo en escritorio) ── */}
          <div className="md:hidden flex flex-col gap-2">
            {filteredStockData.data.map(row => {
              const lvlKey = `${row.item_type}|${row.item_id}|${row.warehouse_id}`
              const lvlInfo = levelStatusMap[lvlKey]
              const inTransit = lvlInfo?.inTransit || 0
              const statusVariant =
                row.status === 'available' ? 'green'
                : row.status === 'wip'     ? 'blue'
                : row.status === 'blocked' ? 'red'
                : 'gray'
              const statusLabel =
                row.status === 'available' ? 'Disponible'
                : row.status === 'wip'     ? 'En proceso'
                : row.status === 'blocked' ? 'Bloqueado'
                : row.status
              return (
                <button
                  key={row.id}
                  type="button"
                  disabled={!row.warehouse_id}
                  onClick={() => row.warehouse_id && setSelectedStockItem({
                    itemType: row.item_type, itemId: row.item_id, warehouseId: row.warehouse_id,
                  })}
                  className={clsx(
                    'w-full text-left bg-surface-primary border border-line-subtle rounded-xl p-3 transition-colors',
                    row.warehouse_id ? 'hover:bg-surface-elevated/40' : 'opacity-70 cursor-default'
                  )}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex items-center gap-2">
                      {lvlInfo && <LevelDot status={lvlInfo.status} />}
                      <div className="min-w-0">
                        <p className="font-medium text-ink-primary truncate">
                          {row.item_name}
                          {row.sku && <span className="ml-1 text-xs text-ink-muted">#{row.sku}</span>}
                        </p>
                        <p className="text-xs text-ink-muted truncate">{row.warehouse_name || 'Sin existencia'}</p>
                      </div>
                    </div>
                    <Badge
                      variant={row.item_type === 'raw_material' ? 'amber' : 'blue'}
                      label={row.item_type === 'raw_material' ? 'MP' : 'PT'}
                    />
                  </div>
                  <div className="mt-2 flex items-end justify-between gap-2">
                    <div>
                      <p className={clsx('font-mono text-base font-semibold',
                        parseFloat(row.quantity) < 0 ? 'text-status-danger' : 'text-ink-primary')}>
                        {fmtNum(row.quantity)} <span className="text-ink-muted text-xs">{row.unit}</span>
                      </p>
                      {inTransit > 0 && (
                        <p className="text-[11px] text-status-warning">+{fmtNum(inTransit)} en tránsito</p>
                      )}
                    </div>
                    <div className="text-right">
                      <Badge variant={statusVariant} label={statusLabel} />
                      <p className="text-xs text-ink-secondary font-mono mt-1">{fmtMXN(row.total_value)}</p>
                      {row.status === 'blocked' && parseFloat(row.quantity) > 0 && row.warehouse_id && (
                        <Can do="inventory:adjust">
                          <span role="button" tabIndex={0}
                            onClick={e => { e.stopPropagation(); setReleaseRow(row) }}
                            className="inline-block mt-1 text-[11px] text-brand-300 underline decoration-dotted cursor-pointer">
                            Liberar a disponible
                          </span>
                        </Can>
                      )}
                    </div>
                  </div>
                </button>
              )
            })}
          </div>

          {/* ── Escritorio: tabla completa ── */}
          <div className="table-wrap-scroll hidden md:block">
            <table className="table">
              <thead>
                <tr>
                  <th></th>
                  <th>Artículo</th>
                  <th>Tipo</th>
                  <th>Almacén</th>
                  <th>Estado</th>
                  <th className="text-right">Cantidad</th>
                  <th className="text-right" title="Cantidad pendiente de recibir en OCs activas (sent / partially_received)">
                    En tránsito
                  </th>
                  <th className="text-right">Costo prom.</th>
                  <th className="text-right">Valor total</th>
                  <th>Último mov.</th>
                </tr>
              </thead>
              <tbody>
                {filteredStockData.data.map(row => {
                  const lvlKey = `${row.item_type}|${row.item_id}|${row.warehouse_id}`
                  const lvlInfo = levelStatusMap[lvlKey]
                  const inTransit = lvlInfo?.inTransit || 0
                  return (
                  <tr
                    key={row.id}
                    onClick={() => row.warehouse_id && setSelectedStockItem({
                      itemType:    row.item_type,
                      itemId:      row.item_id,
                      warehouseId: row.warehouse_id,
                    })}
                    className={clsx('transition-colors',
                      row.warehouse_id ? 'cursor-pointer hover:bg-surface-elevated/40' : 'opacity-70')}
                  >
                    <td className="w-6 px-1">
                      {lvlInfo && <LevelDot status={lvlInfo.status} />}
                    </td>
                    <td className="font-medium text-ink-primary">
                      {row.item_name}
                      {row.sku && <span className="ml-1 text-xs text-ink-muted">#{row.sku}</span>}
                      {row.resin_type && (
                        <span className="ml-1 text-[10px] text-ink-muted">
                          {[row.resin_type, row.material_type].filter(Boolean).join(' ')}
                        </span>
                      )}
                    </td>
                    <td>
                      <Badge
                        variant={row.item_type === 'raw_material' ? 'amber' : 'blue'}
                        label={row.item_type === 'raw_material' ? 'MP' : 'PT'}
                      />
                    </td>
                    <td className="text-ink-secondary">{row.warehouse_name || 'Sin existencia'}</td>
                    <td>
                      <Badge
                        variant={
                          row.status === 'available' ? 'green'
                          : row.status === 'wip'     ? 'blue'
                          : row.status === 'blocked' ? 'red'
                          : 'gray'
                        }
                        label={
                          row.status === 'available' ? 'Disponible'
                          : row.status === 'wip'     ? 'En proceso'
                          : row.status === 'blocked' ? 'Bloqueado'
                          : row.status
                        }
                      />
                      {row.status === 'blocked' && parseFloat(row.quantity) > 0 && row.warehouse_id && (
                        <Can do="inventory:adjust">
                          <button onClick={e => { e.stopPropagation(); setReleaseRow(row) }}
                            className="ml-2 align-middle text-[11px] text-brand-300 hover:text-brand-200 underline decoration-dotted"
                            title="Liberar a disponible para poder venderlo">
                            Liberar
                          </button>
                        </Can>
                      )}
                    </td>
                    <td className={clsx('text-right font-mono text-sm',
                      parseFloat(row.quantity) < 0 && 'text-status-danger font-semibold')}>
                      {fmtNum(row.quantity)} <span className="text-ink-muted text-xs">{row.unit}</span>
                    </td>
                    <td className="text-right font-mono text-sm">
                      {inTransit > 0
                        ? <span className="text-status-warning">+{fmtNum(inTransit)} <span className="text-ink-muted text-xs">{row.unit}</span></span>
                        : <span className="text-ink-muted">—</span>}
                    </td>
                    <td className="text-right font-mono text-sm text-ink-secondary" onClick={e => e.stopPropagation()}>
                      <span className={clsx(parseFloat(row.avg_cost) === 0 && row.warehouse_id && 'text-status-warning')}>
                        {fmtMXN(row.avg_cost)}
                      </span>
                      {row.warehouse_id && (
                        <Can do="inventory:adjust">
                          <button onClick={() => setEditCostRow(row)}
                            className="ml-1.5 align-middle text-ink-muted hover:text-brand-300"
                            title="Editar costo unitario">
                            <svg className="w-3.5 h-3.5 inline" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                            </svg>
                          </button>
                        </Can>
                      )}
                    </td>
                    <td className="text-right font-mono text-sm font-semibold">{fmtMXN(row.total_value)}</td>
                    <td className="text-xs text-ink-muted">{fmtDate(row.last_movement_at)}</td>
                  </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          </>
        )
      )}

      {/* ── TAB: Kardex ─────────────────────────────────────────────── */}
      {tab === 'movimientos' && (
        loadingMov ? (
          <div className="flex justify-center py-16"><Spinner /></div>
        ) : !movData?.data?.length ? (
          <div className="empty-state">
            <p className="font-medium text-ink-secondary">Sin movimientos registrados</p>
            <p className="text-sm text-ink-muted">Los movimientos aparecen aquí al validar turnos, registrar compras o hacer ajustes.</p>
          </div>
        ) : (
          <>
            {/* ── Móvil: tarjetas de movimiento ── */}
            <div className="md:hidden flex flex-col gap-2">
              {movData.data.map(m => {
                const isPositive = parseFloat(m.quantity) >= 0
                return (
                  <div key={m.id} className="bg-surface-primary border border-line-subtle rounded-xl p-3">
                    <div className="flex items-start justify-between gap-2">
                      <p className="font-medium text-ink-primary text-sm truncate min-w-0">{m.item_name}</p>
                      <span className={clsx(
                        'font-mono text-sm font-semibold shrink-0',
                        isPositive ? 'text-status-success' : 'text-status-danger'
                      )}>
                        {isPositive ? '+' : ''}{fmtNum(m.quantity, 4)} <span className="text-xs font-normal text-ink-muted">{m.unit}</span>
                      </span>
                    </div>
                    <div className="mt-1.5 flex items-center justify-between gap-2 flex-wrap">
                      <Badge
                        variant={MOVEMENT_BADGE[m.movement_type] || MOVEMENT_BADGE.default}
                        label={MOVEMENT_LABELS[m.movement_type] || m.movement_type}
                      />
                      <span className="text-[11px] text-ink-muted">{fmtDate(m.created_at)}</span>
                    </div>
                    <div className="mt-1 flex items-center justify-between gap-2 text-[11px] text-ink-muted">
                      <span className="truncate min-w-0">
                        {m.warehouse_name}
                        {m.reference_type ? ` · ${REFERENCE_LABELS[m.reference_type] || m.reference_type}` : ''}
                      </span>
                      <span className="font-mono shrink-0">Saldo: {fmtNum(m.balance_after, 4)}</span>
                    </div>
                    {m.notes && (
                      <p className="mt-1 text-[11px] text-ink-muted truncate" title={m.notes}>{m.notes}</p>
                    )}
                  </div>
                )
              })}
            </div>

            {/* ── Escritorio: tabla completa ── */}
            <div className="table-wrap hidden md:block">
              <table className="table">
                <thead>
                  <tr>
                    <th>Fecha</th>
                    <th>Artículo</th>
                    <th>Tipo movimiento</th>
                    <th>Almacén</th>
                    <th className="text-right">Cantidad</th>
                    <th className="text-right">Costo unit.</th>
                    <th className="text-right">Saldo</th>
                    <th>Referencia</th>
                    <th>Notas</th>
                  </tr>
                </thead>
                <tbody>
                  {movData.data.map(m => {
                    const isPositive = parseFloat(m.quantity) >= 0
                    return (
                      <tr key={m.id}>
                        <td className="text-xs text-ink-muted whitespace-nowrap">{fmtDate(m.created_at)}</td>
                        <td className="font-medium text-ink-primary text-sm">{m.item_name}</td>
                        <td>
                          <Badge
                            variant={MOVEMENT_BADGE[m.movement_type] || MOVEMENT_BADGE.default}
                            label={MOVEMENT_LABELS[m.movement_type] || m.movement_type}
                          />
                        </td>
                        <td className="text-xs text-ink-muted">{m.warehouse_name}</td>
                        <td className={clsx(
                          'text-right font-mono text-sm font-semibold',
                          isPositive ? 'text-status-success' : 'text-status-danger'
                        )}>
                          {isPositive ? '+' : ''}{fmtNum(m.quantity, 4)} <span className="text-xs font-normal text-ink-muted">{m.unit}</span>
                        </td>
                        <td className="text-right font-mono text-xs text-ink-muted">{fmtMXN(m.unit_cost)}</td>
                        <td className="text-right font-mono text-xs text-ink-secondary">{fmtNum(m.balance_after, 4)}</td>
                        <td className="text-xs text-ink-muted">
                          {m.reference_type ? (REFERENCE_LABELS[m.reference_type] || m.reference_type) : '—'}
                        </td>
                        <td className="text-xs text-ink-muted max-w-[160px] truncate" title={m.notes || ''}>
                          {m.notes || '—'}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>

            {movData.total > 50 && (
              <div className="flex items-center justify-between">
                <p className="text-sm text-ink-muted">
                  Mostrando {(movPage - 1) * 50 + 1}–{Math.min(movPage * 50, movData.total)} de {movData.total}
                </p>
                <div className="flex gap-2">
                  <button
                    disabled={movPage === 1}
                    onClick={() => setMovPage(p => p - 1)}
                    className="btn-secondary btn-sm disabled:opacity-40"
                  >Anterior</button>
                  <button
                    disabled={movPage * 50 >= movData.total}
                    onClick={() => setMovPage(p => p + 1)}
                    className="btn-secondary btn-sm disabled:opacity-40"
                  >Siguiente</button>
                </div>
              </div>
            )}
          </>
        )
      )}

      {/* ── TAB: Ajustes ────────────────────────────────────────────── */}
      {tab === 'ajustes' && (
        loadingAdj ? (
          <div className="flex justify-center py-16"><Spinner /></div>
        ) : !adjData?.data?.length ? (
          <div className="empty-state">
            <div className="w-14 h-14 rounded-2xl bg-surface-elevated/60 flex items-center justify-center mb-3">
              <svg className="w-7 h-7 text-ink-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 10h18M3 14h18m-9-4v8m-7 0h14a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z"/>
              </svg>
            </div>
            <p className="font-medium text-ink-secondary">Sin documentos de ajuste</p>
            <p className="text-sm text-ink-muted">Crea tu primer ajuste para corregir saldos de inventario.</p>
            <button onClick={() => setShowAdjustModal(true)} className="btn-primary btn-sm mt-3">
              + Nuevo ajuste
            </button>
          </div>
        ) : (
          <>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Folio</th>
                    <th>Estado</th>
                    <th>Fecha</th>
                    <th>Almacén</th>
                    <th>Motivo</th>
                    <th className="text-right">Líneas</th>
                    <th className="text-right">Entradas</th>
                    <th className="text-right">Salidas</th>
                    <th className="text-right">Neto</th>
                    <th>Capturado por</th>
                  </tr>
                </thead>
                <tbody>
                  {adjData.data.map(a => {
                    const net          = parseFloat(a.net_value)
                    const isCancelled  = a.status === 'cancelled'
                    return (
                      <tr
                        key={a.id}
                        className={clsx('cursor-pointer', isCancelled && 'opacity-60')}
                        onClick={() => setSelectedAdjustId(a.id)}
                      >
                        <td className={clsx(
                          'font-mono text-sm font-semibold',
                          isCancelled ? 'text-ink-muted line-through' : 'text-brand-300'
                        )}>
                          {a.adjustment_number}
                        </td>
                        <td>
                          <Badge
                            variant={isCancelled ? 'red' : 'green'}
                            label={isCancelled ? 'Cancelado' : 'Activo'}
                          />
                        </td>
                        <td className="text-ink-secondary text-sm">{fmtDateShort(a.adjustment_date)}</td>
                        <td className="text-ink-secondary">{a.warehouse_name}</td>
                        <td className="text-sm text-ink-secondary max-w-[260px] truncate" title={a.reason}>{a.reason}</td>
                        <td className="text-right font-mono text-sm">{a.total_lines}</td>
                        <td className="text-right font-mono text-sm text-status-success">+{fmtMXN(a.total_in_value)}</td>
                        <td className="text-right font-mono text-sm text-status-danger">−{fmtMXN(a.total_out_value)}</td>
                        <td className={clsx(
                          'text-right font-mono text-sm font-semibold',
                          net >= 0 ? 'text-status-info' : 'text-status-warning'
                        )}>
                          {net >= 0 ? '+' : '−'}{fmtMXN(Math.abs(net))}
                        </td>
                        <td className="text-xs text-ink-muted">{a.created_by_name || '—'}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>

            {adjData.total > 25 && (
              <div className="flex items-center justify-between">
                <p className="text-sm text-ink-muted">
                  Mostrando {(adjPage - 1) * 25 + 1}–{Math.min(adjPage * 25, adjData.total)} de {adjData.total}
                </p>
                <div className="flex gap-2">
                  <button
                    disabled={adjPage === 1}
                    onClick={() => setAdjPage(p => p - 1)}
                    className="btn-secondary btn-sm disabled:opacity-40"
                  >Anterior</button>
                  <button
                    disabled={adjPage * 25 >= adjData.total}
                    onClick={() => setAdjPage(p => p + 1)}
                    className="btn-secondary btn-sm disabled:opacity-40"
                  >Siguiente</button>
                </div>
              </div>
            )}
          </>
        )
      )}

      {/* ── Modal: nuevo ajuste ─────────────────────────────────────── */}
      {showAdjustModal && (
        <AdjustmentModal
          warehouses={warehouses}
          onClose={() => setShowAdjustModal(false)}
          onSaved={handleAdjustmentSaved}
        />
      )}

      {/* ── Modal: recalcular saldos desde el kardex ─────────────────── */}
      {showRecompute && (
        <RecomputeStockModal
          onClose={() => setShowRecompute(false)}
          onApplied={(res) => {
            setCreatedMsg(`Saldos recalculados: ${res.count} ajuste(s) aplicado(s) desde el kardex.`)
            setTimeout(() => setCreatedMsg(null), 6000)
            setShowRecompute(false)
          }}
        />
      )}

      {/* ── Modal: editar costo promedio de un artículo ──────────────── */}
      {editCostRow && (
        <EditCostModal
          row={editCostRow}
          onClose={() => setEditCostRow(null)}
          onSaved={() => {
            setCreatedMsg(`Costo actualizado para ${editCostRow.item_name}.`)
            setTimeout(() => setCreatedMsg(null), 5000)
            setEditCostRow(null)
          }}
        />
      )}

      {/* ── Modal: liberar 2ª calidad (blocked → available) ──────────── */}
      {releaseRow && (
        <ReleaseBlockedModal
          row={releaseRow}
          onClose={() => setReleaseRow(null)}
          onSaved={() => {
            setCreatedMsg(`2ª calidad liberada a disponible para ${releaseRow.item_name}.`)
            setTimeout(() => setCreatedMsg(null), 5000)
            setReleaseRow(null)
          }}
        />
      )}

      {/* ── Panel: detalle ajuste ───────────────────────────────────── */}
      {selectedAdjustId && (
        <AdjustmentDetallePanel
          adjustmentId={selectedAdjustId}
          onClose={() => setSelectedAdjustId(null)}
        />
      )}

      {/* ── Panel: detalle de item de stock ──────────────────────────── */}
      {selectedStockItem && (
        <ItemDetailPanel
          itemType={selectedStockItem.itemType}
          itemId={selectedStockItem.itemId}
          warehouseId={selectedStockItem.warehouseId}
          onClose={() => setSelectedStockItem(null)}
        />
      )}
    </div>
  )
}
