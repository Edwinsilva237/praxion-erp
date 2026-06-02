import { useState, useCallback, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { purchasesApi } from '@/api/purchases'
import { partnersApi } from '@/api/partners'
import { rawMaterialsApi } from '@/api/rawMaterials'
import { productsApi } from '@/api/products'
import { exchangeRatesApi } from '@/api/exchangeRates'
import { inventoryApi } from '@/api/inventory'
import Autocomplete from '@/components/ui/Autocomplete'
import Spinner from '@/components/ui/Spinner'
import { fmtMXN, fmtNum } from '@/utils/fmt'
import clsx from 'clsx'

// ── Constantes ─────────────────────────────────────────────────────────────
const EMPTY_LINE_MP = () => ({
  item: null, quantity: '', unit: 'kg', unit_price: '', warehouse_id: '', is_estimated: true,
  price_source: null,
})
const EMPTY_LINE_PT = () => ({
  item: null, quantity: '', unit: 'pza', unit_price: '', warehouse_id: '', product_meta: null,
  price_source: null,
})

// Chip que indica de dónde salió el precio sugerido del proveedor (espejo del
// chip de ventas). `source` puede traer sufijo `_converted` (USD→MXN).
function SupplierPriceChip({ source }) {
  if (!source) return null
  const map = {
    manual:    ['Negociado',      'bg-status-success/15 text-status-success'],
    po:        ['Última OC',      'bg-status-info/15 text-status-info'],
    receipt:   ['Última compra',  'bg-status-info/15 text-status-info'],
    item_cost: ['Costo estándar', 'bg-surface-elevated/80 text-ink-muted'],
  }
  const found = map[String(source).replace('_converted', '')]
  if (!found) return null
  return (
    <span className={clsx('text-[10px] font-bold px-1.5 py-0.5 rounded-full uppercase tracking-wide', found[1])}>
      {found[0]}
    </span>
  )
}

// Consulta el precio sugerido del proveedor para una línea. Devuelve el patch a
// aplicar ({ unit_price, price_source, supplier_sku }) o null. Best-effort.
async function fetchSupplierLinePrice(supplierId, itemType, itemId, currency) {
  if (!supplierId || !itemId) return null
  try {
    const res = await purchasesApi.suggestedSupplierPrice(supplierId, itemType, itemId, currency)
    if (res?.unit_price != null) {
      return { unit_price: String(res.unit_price), price_source: res.source || null, supplier_sku: res.supplierSku || null }
    }
  } catch { /* sin precio previo → captura manual */ }
  return null
}

// ── Selección de almacén destino para una línea de OC ──────────────────────
// El cálculo de "en tránsito" requiere que cada línea apunte a un almacén:
// (item × almacén) es la llave del LEFT JOIN contra inventory_levels.
function WarehouseSelect({ warehouses, allowedTypes, value, onChange, error }) {
  const opts = warehouses.filter(w => allowedTypes.includes(w.type) && w.is_active !== false)
  if (opts.length === 0) {
    return (
      <p className="text-xs text-status-danger">
        No hay almacenes activos de tipo {allowedTypes.join(' / ')}. Crea uno en Configuración → Almacenes.
      </p>
    )
  }
  return (
    <select
      className={clsx('select', error && 'border-status-danger/40')}
      value={value || ''}
      onChange={e => onChange(e.target.value)}
    >
      <option value="">Selecciona almacén destino…</option>
      {opts.map(w => (
        <option key={w.id} value={w.id}>
          {w.name}{w.is_default ? ' · default' : ''}
        </option>
      ))}
    </select>
  )
}

function pickDefaultWarehouse(warehouses, allowedTypes) {
  const candidates = warehouses.filter(w => allowedTypes.includes(w.type) && w.is_active !== false)
  return (candidates.find(w => w.is_default) || candidates[0])?.id || ''
}

// ── Tarjeta de validación de producto terminado ────────────────────────────
function ProductCard({ meta, onClear }) {
  if (!meta) return null
  return (
    <div className="mt-2 flex items-start gap-3 bg-brand-500/10 border border-brand-100 rounded-xl p-3">
      <div className="w-8 h-8 rounded-lg bg-brand-500/15 flex items-center justify-center shrink-0">
        <svg className="w-4 h-4 text-brand-300" fill="currentColor" viewBox="0 0 24 24">
          <path d="M20 6h-2.18c.07-.44.18-.88.18-1.33C18 2.54 16.46 1 14.67 1c-1.08 0-1.9.5-2.59 1.28L12 2.41l-.08-.13C11.22 1.5 10.4 1 9.33 1 7.54 1 6 2.54 6 4.33c0 .45.1.89.18 1.33H4c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2z"/>
        </svg>
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-xs font-semibold text-brand-300 mb-1">✓ Producto cargado</p>
        <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-xs">
          {meta.sku        && <><span className="text-ink-muted">SKU</span><span className="font-mono text-ink-secondary">{meta.sku}</span></>}
          {meta.unit       && <><span className="text-ink-muted">Unidad</span><span className="text-ink-secondary">{meta.unit}</span></>}
          {meta.price      && <><span className="text-ink-muted">Precio lista</span><span className="font-medium text-ink-secondary">{fmtMXN(meta.price)}/{meta.unit || 'pza'}</span></>}
          {meta.warehouse  && <><span className="text-ink-muted">Almacén dest.</span><span className="text-ink-secondary">{meta.warehouse}</span></>}
        </div>
      </div>
      <button type="button" onClick={onClear} className="text-ink-muted hover:text-ink-secondary p-0.5">
        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12"/>
        </svg>
      </button>
    </div>
  )
}

// ── Selector de tipo antes de abrir el form ────────────────────────────────
export function OCTypeSelector({ onSelect, onClose }) {
  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40 p-4">
      <div className="card w-full max-w-md p-6">
        <div className="flex items-center justify-between mb-5">
          <div>
            <h2 className="text-base font-semibold text-ink-primary">Nueva orden de compra</h2>
            <p className="text-xs text-ink-muted mt-0.5">Selecciona el tipo de compra</p>
          </div>
          <button onClick={onClose} className="btn-ghost btn-icon text-ink-muted">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12"/>
            </svg>
          </button>
        </div>
        <div className="flex flex-col gap-3">
          <button
            onClick={() => onSelect('raw_material')}
            className="group flex items-center gap-4 p-4 rounded-xl border-2 border-line-subtle hover:border-status-warning/40 hover:bg-status-warning/10 transition-all text-left"
          >
            <div className="w-11 h-11 rounded-xl bg-status-warning/15 group-hover:bg-amber-200 flex items-center justify-center shrink-0 transition-colors">
              <svg className="w-5 h-5 text-status-warning" fill="currentColor" viewBox="0 0 24 24">
                <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/>
              </svg>
            </div>
            <div>
              <p className="text-sm font-semibold text-ink-primary">Materia Prima</p>
              <p className="text-xs text-ink-muted mt-0.5">Insumos para producción — cantidades estimadas confirmadas en recepción</p>
            </div>
            <svg className="w-4 h-4 text-ink-muted group-hover:text-amber-400 ml-auto shrink-0 transition-colors" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7"/>
            </svg>
          </button>

          <button
            onClick={() => onSelect('product')}
            className="group flex items-center gap-4 p-4 rounded-xl border-2 border-line-subtle hover:border-brand-500/40 hover:bg-brand-500/10 transition-all text-left"
          >
            <div className="w-11 h-11 rounded-xl bg-brand-500/15 group-hover:bg-brand-200 flex items-center justify-center shrink-0 transition-colors">
              <svg className="w-5 h-5 text-brand-300" fill="currentColor" viewBox="0 0 24 24">
                <path d="M20 6h-2.18c.07-.44.18-.88.18-1.33C18 2.54 16.46 1 14.67 1c-1.08 0-1.9.5-2.59 1.28L12 2.41l-.08-.13C11.22 1.5 10.4 1 9.33 1 7.54 1 6 2.54 6 4.33c0 .45.1.89.18 1.33H4c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2z"/>
              </svg>
            </div>
            <div>
              <p className="text-sm font-semibold text-ink-primary">Producto Terminado</p>
              <p className="text-xs text-ink-muted mt-0.5">Compra de productos para reventa o distribución — cantidades firmes</p>
            </div>
            <svg className="w-4 h-4 text-ink-muted group-hover:text-brand-400 ml-auto shrink-0 transition-colors" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7"/>
            </svg>
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}

// ── Bloque de totales compartido ───────────────────────────────────────────
function TotalesBlock({ lines, qtyField = 'quantity', currency, exchangeRate, applyTax, setApplyTax }) {
  const subtotal = lines.reduce((s, l) => {
    const qty = parseFloat(l[qtyField] || 0)
    return s + qty * parseFloat(l.unit_price || 0)
  }, 0)
  const tax   = applyTax ? subtotal * 0.16 : 0
  const total = subtotal + tax

  if (subtotal === 0) return null

  return (
    <div className="bg-surface-elevated/60 border border-line-subtle rounded-xl p-4 flex flex-col gap-2.5">
      <label className="flex items-center gap-2.5 cursor-pointer select-none">
        <input
          type="checkbox"
          className="w-4 h-4 accent-brand-600 rounded"
          checked={applyTax}
          onChange={e => setApplyTax(e.target.checked)}
        />
        <span className="text-sm text-ink-secondary">Incluir IVA 16%</span>
      </label>

      <div className="border-t border-line-subtle pt-2 flex flex-col gap-1">
        <div className="flex justify-between text-sm text-ink-muted">
          <span>Subtotal</span>
          <span className="font-mono">{fmtMXN(subtotal, currency)}</span>
        </div>
        {applyTax && (
          <div className="flex justify-between text-sm text-ink-muted">
            <span>IVA 16%</span>
            <span className="font-mono">{fmtMXN(tax, currency)}</span>
          </div>
        )}
        <div className="flex justify-between text-sm font-semibold text-ink-primary border-t border-line-subtle pt-1.5 mt-0.5">
          <span>Total</span>
          <span className="font-mono text-brand-300">{fmtMXN(total, currency)}</span>
        </div>
        {currency === 'USD' && exchangeRate > 0 && (
          <div className="flex justify-between text-xs text-ink-muted mt-0.5">
            <span>Equivalente MXN (TC ${fmtNum(exchangeRate, 2)})</span>
            <span className="font-mono">{fmtMXN(total * exchangeRate, 'MXN')}</span>
          </div>
        )}
      </div>
    </div>
  )
}

// ── Modal OC Materia Prima ─────────────────────────────────────────────────
function OCFormMP({ onClose, onCreated, prefilledItem = null }) {
  const qc = useQueryClient()
  const [partner, setPartner]     = useState(null)
  const [expectedDate, setDate]   = useState('')
  const [currency, setCurrency]   = useState('MXN')
  const [notes, setNotes]         = useState('')
  const [applyTax, setApplyTax]   = useState(false)
  const [error, setError]         = useState(null)
  const [customTC, setCustomTC]   = useState('')

  const { data: warehouses = [] } = useQuery({
    queryKey: ['inv-warehouses'],
    queryFn:  inventoryApi.getWarehouses,
  })
  const defaultWh = pickDefaultWarehouse(warehouses, ['raw_material'])

  const [lines, setLines]         = useState(() => {
    if (prefilledItem) {
      return [{
        item: {
          id:    prefilledItem.itemId,
          label: prefilledItem.itemName,
          unit:  prefilledItem.unit,
        },
        quantity:     prefilledItem.suggestedQty?.toString() || '',
        unit:         prefilledItem.unit || 'kg',
        unit_price:   '',
        warehouse_id: prefilledItem.warehouseId || '',
        is_estimated: true,
      }]
    }
    return [EMPTY_LINE_MP()]
  })

  // Hidrata el almacén default en líneas que aún no lo tengan
  // (cuando warehouses[] carga después del primer render).
  useEffect(() => {
    if (!defaultWh) return
    setLines(prev =>
      prev.some(l => !l.warehouse_id)
        ? prev.map(l => l.warehouse_id ? l : { ...l, warehouse_id: defaultWh })
        : prev
    )
  }, [defaultWh])

  const { data: tcData } = useQuery({
    queryKey: ['exchange-rate-usd'],
    queryFn: () => exchangeRatesApi.getRate('USD'),
    staleTime: 5 * 60 * 1000,
  })
  const exchangeRate = parseFloat(customTC || tcData || 0)

  const searchPartners = useCallback(async (q) => {
    const res = await partnersApi.list({ search: q, type: 'supplier', limit: 20 })
    return (res.data || res).map(p => ({ id: p.id, label: p.name, sub: p.rfc || '' }))
  }, [])

  const searchMP = useCallback(async (q) => {
    const res = await rawMaterialsApi.list({ search: q, limit: 20 })
    return (res.data || res).map(r => ({
      id: r.id, label: r.name,
      sub: [r.resin_type, r.material_type].filter(Boolean).join(' '),
      unit: r.unit || 'kg',
    }))
  }, [])

  function updateLine(idx, key, val) {
    setLines(prev => prev.map((l, i) => {
      if (i !== idx) return l
      if (key === 'item') return { ...l, item: val, unit: val?.unit || 'kg' }
      if (key === 'unit_price') return { ...l, unit_price: val, price_source: null }
      return { ...l, [key]: val }
    }))
  }

  // Al elegir la MP, precargar el precio del proveedor (negociado/aprendido/costo).
  async function handlePickMP(idx, item) {
    updateLine(idx, 'item', item)
    if (!item?.id || !partner?.id) return
    const patch = await fetchSupplierLinePrice(partner.id, 'raw_material', item.id, currency)
    if (patch) setLines(prev => prev.map((l, i) => (i === idx && l.item?.id === item.id) ? { ...l, ...patch } : l))
  }

  const mutation = useMutation({
    mutationFn: () => {
      const validLines = lines.filter(l => l.item?.id && l.quantity)
      if (!partner?.id) throw new Error('Selecciona un proveedor.')
      if (!validLines.length) throw new Error('Agrega al menos un artículo con cantidad.')
      const missingWh = validLines.findIndex(l => !l.warehouse_id)
      if (missingWh >= 0) throw new Error(`Línea ${missingWh + 1}: falta seleccionar almacén destino.`)
      return purchasesApi.createOrder({
        partnerId:    partner.id,
        expectedDate: expectedDate || null,
        currency,
        exchangeRate: currency === 'USD' ? exchangeRate : null,
        notes:        notes || null,
        taxRate:      applyTax ? 0.16 : 0,
        orderType:    'raw_material',
        lines: validLines.map(l => ({
          itemType:    'raw_material',
          itemId:      l.item.id,
          quantity:    parseFloat(l.quantity),
          unit:        l.unit,
          unitPrice:   parseFloat(l.unit_price || 0),
          warehouseId: l.warehouse_id,
          isEstimated: true,
        })),
      })
    },
    onSuccess: (oc) => { qc.invalidateQueries({ queryKey: ['purchase-orders'] }); onCreated(oc); onClose() },
    onError: (e) => setError(e.response?.data?.error || e.message || 'Error al crear la orden'),
  })

  function handleSubmit(e) { e.preventDefault(); setError(null); mutation.mutate() }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-5">
      {/* Datos generales */}
      <div className="bg-surface-elevated/60 border border-line-subtle rounded-xl p-4 flex flex-col gap-3">
        <p className="text-xs font-bold text-brand-300 uppercase tracking-wider">Datos generales</p>
        <div>
          <label className="label">Proveedor <span className="text-status-danger">*</span></label>
          <Autocomplete value={partner} onChange={setPartner} onSearch={searchPartners} placeholder="Buscar proveedor..." error={!partner && !!error} />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="label">Fecha estimada de entrega</label>
            <input type="date" className="input" value={expectedDate} onChange={e => setDate(e.target.value)} />
          </div>
          <div>
            <label className="label">Moneda</label>
            <select className="select" value={currency} onChange={e => setCurrency(e.target.value)}>
              <option value="MXN">MXN — Peso mexicano</option>
              <option value="USD">USD — Dólar</option>
            </select>
          </div>
        </div>
        {currency === 'USD' && (
          <div className="flex items-center gap-3 bg-status-warning/10 border border-status-warning/40 rounded-lg p-3">
            <svg className="w-4 h-4 text-amber-500 shrink-0" fill="currentColor" viewBox="0 0 24 24">
              <path d="M11.8 10.9c-2.27-.59-3-1.2-3-2.15 0-1.09 1.01-1.85 2.7-1.85 1.78 0 2.44.85 2.5 2.1h2.21c-.07-1.72-1.12-3.3-3.21-3.81V3h-3v2.16c-1.94.42-3.5 1.68-3.5 3.61 0 2.31 1.91 3.46 4.7 4.13 2.5.6 3 1.48 3 2.41 0 .69-.49 1.79-2.7 1.79-2.06 0-2.87-.92-2.98-2.1h-2.2c.12 2.19 1.76 3.42 3.68 3.83V21h3v-2.15c1.95-.37 3.5-1.5 3.5-3.55 0-2.84-2.43-3.81-4.7-4.4z"/>
            </svg>
            <div className="flex-1">
              <p className="text-xs text-status-warning font-medium">
                Tipo de cambio oficial: <strong>{tcData ? `$${fmtNum(tcData, 4)} MXN/USD` : 'Cargando...'}</strong>
              </p>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="text-xs text-status-warning">TC:</span>
              <input
                type="number" step="0.0001" min="1"
                value={customTC}
                onChange={e => setCustomTC(e.target.value)}
                placeholder={tcData ? fmtNum(tcData, 4) : '19.8500'}
                className="input w-28 h-7 text-xs py-0 border-status-warning/40 bg-surface-primary"
              />
            </div>
          </div>
        )}
        <div>
          <label className="label">Notas al proveedor</label>
          <input className="input" placeholder="Instrucciones de entrega, condiciones..." value={notes} onChange={e => setNotes(e.target.value)} />
        </div>
      </div>

      {/* Artículos */}
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <p className="text-xs font-bold text-brand-300 uppercase tracking-wider">Artículos</p>
          <button type="button" onClick={() => setLines(p => [...p, EMPTY_LINE_MP()])} className="btn-ghost btn-sm text-brand-300">
            + Agregar artículo
          </button>
        </div>

        {lines.map((line, idx) => (
          <div key={idx} className="border border-line-subtle rounded-xl p-4 flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <p className="text-xs font-medium text-ink-muted">Línea {idx + 1}</p>
              {lines.length > 1 && (
                <button type="button" onClick={() => setLines(p => p.filter((_, i) => i !== idx))} className="text-xs text-red-400 hover:text-status-danger">
                  Quitar
                </button>
              )}
            </div>

            <div>
              <label className="label">Materia prima <span className="text-status-danger">*</span></label>
              <Autocomplete value={line.item} onChange={item => handlePickMP(idx, item)} onSearch={searchMP} placeholder="Buscar en catálogo de materias primas..." />
            </div>

            <div>
              <label className="label">Almacén destino <span className="text-status-danger">*</span></label>
              <WarehouseSelect
                warehouses={warehouses}
                allowedTypes={['raw_material']}
                value={line.warehouse_id}
                onChange={val => updateLine(idx, 'warehouse_id', val)}
                error={!line.warehouse_id && !!error}
              />
              <p className="text-[10px] text-ink-muted mt-1">
                Define a qué almacén llegará la mercancía — necesario para calcular el inventario en tránsito.
              </p>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="col-span-1">
                <label className="label flex items-center gap-1.5">
                  Cantidad
                  <span className="text-[10px] font-medium text-status-warning bg-status-warning/10 px-1.5 py-0.5 rounded-full border border-status-warning/40">~ estimada</span>
                  <span className="relative group cursor-default">
                    <svg className="w-3.5 h-3.5 text-ink-muted" fill="currentColor" viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/></svg>
                    <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1.5 w-48 bg-gray-800 text-white text-[11px] rounded-lg px-2.5 py-1.5 hidden group-hover:block z-10 leading-snug">
                      La cantidad se confirma al registrar la recepción en almacén
                    </div>
                  </span>
                </label>
                <div className="flex gap-2">
                  <input type="number" step="0.001" min="0" value={line.quantity}
                    onChange={e => updateLine(idx, 'quantity', e.target.value)}
                    className="input flex-1 border-status-warning/40 bg-status-warning/10 text-status-warning placeholder-amber-400"
                    placeholder="0.000" />
                  <select className="select w-20" value={line.unit} onChange={e => updateLine(idx, 'unit', e.target.value)}>
                    <option value="kg">kg</option>
                    <option value="ton">ton</option>
                    <option value="l">l</option>
                    <option value="pza">pza</option>
                  </select>
                </div>
              </div>
              <div>
                <label className="label flex items-center gap-1.5">
                  Precio unitario <SupplierPriceChip source={line.price_source} />
                </label>
                <input type="number" step="0.0001" min="0" value={line.unit_price}
                  onChange={e => updateLine(idx, 'unit_price', e.target.value)}
                  className="input" placeholder="0.0000" />
              </div>
              <div>
                <label className="label">Subtotal</label>
                <div className="input bg-surface-elevated/40 text-ink-muted font-mono text-sm cursor-default">
                  {fmtMXN(parseFloat(line.quantity || 0) * parseFloat(line.unit_price || 0), currency)}
                </div>
              </div>
            </div>
          </div>
        ))}

        <button type="button" onClick={() => setLines(p => [...p, EMPTY_LINE_MP()])}
          className="w-full border border-dashed border-line-base rounded-xl py-2.5 text-sm font-medium text-brand-300 hover:bg-brand-500/5 transition-colors">
          + Agregar artículo
        </button>

        <TotalesBlock lines={lines} currency={currency} exchangeRate={exchangeRate} applyTax={applyTax} setApplyTax={setApplyTax} />
      </div>

      {error && <p className="field-error">{error}</p>}
      <div className="flex gap-2 pt-1">
        <button type="button" onClick={onClose} className="btn-secondary flex-1">Cancelar</button>
        <button type="submit" disabled={mutation.isPending} className="btn-primary flex-1">
          {mutation.isPending ? <Spinner size="sm" /> : 'Crear orden de compra'}
        </button>
      </div>
    </form>
  )
}

// ── Modal OC Producto Terminado ────────────────────────────────────────────
function OCFormPT({ onClose, onCreated, prefilledItem = null }) {
  const qc = useQueryClient()
  const [partner, setPartner]   = useState(null)
  const [expectedDate, setDate] = useState('')
  const [currency, setCurrency] = useState('MXN')
  const [notes, setNotes]       = useState('')
  const [applyTax, setApplyTax] = useState(false)
  const [error, setError]       = useState(null)
  const [customTC, setCustomTC] = useState('')

  const { data: warehouses = [] } = useQuery({
    queryKey: ['inv-warehouses'],
    queryFn:  inventoryApi.getWarehouses,
  })
  const defaultWh = pickDefaultWarehouse(warehouses, ['finished_product', 'resale'])

  const [lines, setLines]       = useState(() => {
    if (prefilledItem) {
      return [{
        item: {
          id:    prefilledItem.itemId,
          label: prefilledItem.itemName,
          unit:  prefilledItem.unit,
        },
        quantity:     prefilledItem.suggestedQty?.toString() || '',
        unit:         prefilledItem.unit || 'pza',
        unit_price:   '',
        warehouse_id: prefilledItem.warehouseId || '',
        product_meta: null,
      }]
    }
    return [EMPTY_LINE_PT()]
  })

  useEffect(() => {
    if (!defaultWh) return
    setLines(prev =>
      prev.some(l => !l.warehouse_id)
        ? prev.map(l => l.warehouse_id ? l : { ...l, warehouse_id: defaultWh })
        : prev
    )
  }, [defaultWh])

  const { data: tcData } = useQuery({
    queryKey: ['exchange-rate-usd'],
    queryFn: () => exchangeRatesApi.getRate('USD'),
    staleTime: 5 * 60 * 1000,
  })
  const exchangeRate = parseFloat(customTC || tcData || 0)

  const searchPartners = useCallback(async (q) => {
    const res = await partnersApi.list({ search: q, type: 'supplier', limit: 20 })
    return (res.data || res).map(p => ({ id: p.id, label: p.name, sub: p.rfc || '' }))
  }, [])

  const searchProducts = useCallback(async (q) => {
    const res = await productsApi.list({ search: q, limit: 20 })
    return (res.data || res).map(p => ({
      id: p.id, label: p.name,
      sub: p.sku || '',
      unit: p.unit || 'pza',
      price: p.unit_price || p.price || null,
      sku: p.sku || null,
      warehouse: p.default_warehouse_name || null,
    }))
  }, [])

  function updateLine(idx, key, val) {
    setLines(prev => prev.map((l, i) => {
      if (i !== idx) return l
      if (key === 'item') {
        return {
          ...l,
          item: val,
          unit: val?.unit || 'pza',
          unit_price: val?.price?.toString() || l.unit_price,
          product_meta: val ? {
            sku: val.sku, unit: val.unit, price: val.price, warehouse: val.warehouse,
          } : null,
          price_source: null,
        }
      }
      if (key === 'unit_price') return { ...l, unit_price: val, price_source: null }
      return { ...l, [key]: val }
    }))
  }

  // Al elegir el producto, sobre el precio de lista precargamos el del proveedor
  // (negociado/aprendido) si existe — más específico que el de catálogo.
  async function handlePickPT(idx, item) {
    updateLine(idx, 'item', item)
    if (!item?.id || !partner?.id) return
    const patch = await fetchSupplierLinePrice(partner.id, 'product', item.id, currency)
    if (patch) setLines(prev => prev.map((l, i) => (i === idx && l.item?.id === item.id) ? { ...l, ...patch } : l))
  }

  const mutation = useMutation({
    mutationFn: () => {
      const validLines = lines.filter(l => l.item?.id && l.quantity)
      if (!partner?.id) throw new Error('Selecciona un proveedor.')
      if (!validLines.length) throw new Error('Agrega al menos un artículo con cantidad.')
      const missingWh = validLines.findIndex(l => !l.warehouse_id)
      if (missingWh >= 0) throw new Error(`Línea ${missingWh + 1}: falta seleccionar almacén destino.`)
      return purchasesApi.createOrder({
        partnerId:    partner.id,
        expectedDate: expectedDate || null,
        currency,
        exchangeRate: currency === 'USD' ? exchangeRate : null,
        notes:        notes || null,
        taxRate:      applyTax ? 0.16 : 0,
        orderType:    'product',
        lines: validLines.map(l => ({
          itemType:    'product',
          itemId:      l.item.id,
          quantity:    parseFloat(l.quantity),
          unit:        l.unit,
          unitPrice:   parseFloat(l.unit_price || 0),
          warehouseId: l.warehouse_id,
          isEstimated: false,
        })),
      })
    },
    onSuccess: (oc) => { qc.invalidateQueries({ queryKey: ['purchase-orders'] }); onCreated(oc); onClose() },
    onError: (e) => setError(e.response?.data?.error || e.message || 'Error al crear la orden'),
  })

  function handleSubmit(e) { e.preventDefault(); setError(null); mutation.mutate() }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-5">
      {/* Datos generales */}
      <div className="bg-surface-elevated/60 border border-line-subtle rounded-xl p-4 flex flex-col gap-3">
        <p className="text-xs font-bold text-brand-300 uppercase tracking-wider">Datos generales</p>
        <div>
          <label className="label">Proveedor <span className="text-status-danger">*</span></label>
          <Autocomplete value={partner} onChange={setPartner} onSearch={searchPartners} placeholder="Buscar proveedor..." error={!partner && !!error} />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="label">Fecha estimada de entrega</label>
            <input type="date" className="input" value={expectedDate} onChange={e => setDate(e.target.value)} />
          </div>
          <div>
            <label className="label">Moneda</label>
            <select className="select" value={currency} onChange={e => setCurrency(e.target.value)}>
              <option value="MXN">MXN — Peso mexicano</option>
              <option value="USD">USD — Dólar</option>
            </select>
          </div>
        </div>
        {currency === 'USD' && (
          <div className="flex items-center gap-3 bg-status-warning/10 border border-status-warning/40 rounded-lg p-3">
            <svg className="w-4 h-4 text-amber-500 shrink-0" fill="currentColor" viewBox="0 0 24 24">
              <path d="M11.8 10.9c-2.27-.59-3-1.2-3-2.15 0-1.09 1.01-1.85 2.7-1.85 1.78 0 2.44.85 2.5 2.1h2.21c-.07-1.72-1.12-3.3-3.21-3.81V3h-3v2.16c-1.94.42-3.5 1.68-3.5 3.61 0 2.31 1.91 3.46 4.7 4.13 2.5.6 3 1.48 3 2.41 0 .69-.49 1.79-2.7 1.79-2.06 0-2.87-.92-2.98-2.1h-2.2c.12 2.19 1.76 3.42 3.68 3.83V21h3v-2.15c1.95-.37 3.5-1.5 3.5-3.55 0-2.84-2.43-3.81-4.7-4.4z"/>
            </svg>
            <div className="flex-1">
              <p className="text-xs text-status-warning font-medium">
                Tipo de cambio oficial: <strong>{tcData ? `$${fmtNum(tcData, 4)} MXN/USD` : 'Cargando...'}</strong>
              </p>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="text-xs text-status-warning">TC:</span>
              <input
                type="number" step="0.0001" min="1"
                value={customTC}
                onChange={e => setCustomTC(e.target.value)}
                placeholder={tcData ? fmtNum(tcData, 4) : '19.8500'}
                className="input w-28 h-7 text-xs py-0 border-status-warning/40 bg-surface-primary"
              />
            </div>
          </div>
        )}
        <div>
          <label className="label">Notas al proveedor</label>
          <input className="input" placeholder="Instrucciones de entrega, condiciones..." value={notes} onChange={e => setNotes(e.target.value)} />
        </div>
      </div>

      {/* Artículos */}
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <p className="text-xs font-bold text-brand-300 uppercase tracking-wider">Artículos</p>
          <button type="button" onClick={() => setLines(p => [...p, EMPTY_LINE_PT()])} className="btn-ghost btn-sm text-brand-300">
            + Agregar artículo
          </button>
        </div>

        {lines.map((line, idx) => (
          <div key={idx} className="border border-line-subtle rounded-xl p-4 flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <p className="text-xs font-medium text-ink-muted">Línea {idx + 1}</p>
              {lines.length > 1 && (
                <button type="button" onClick={() => setLines(p => p.filter((_, i) => i !== idx))} className="text-xs text-red-400 hover:text-status-danger">
                  Quitar
                </button>
              )}
            </div>

            <div>
              <label className="label">Producto terminado <span className="text-status-danger">*</span></label>
              <Autocomplete value={line.item} onChange={item => handlePickPT(idx, item)} onSearch={searchProducts} placeholder="Buscar en catálogo de productos..." />
              <ProductCard meta={line.product_meta} onClear={() => updateLine(idx, 'item', null)} />
            </div>

            <div>
              <label className="label">Almacén destino <span className="text-status-danger">*</span></label>
              <WarehouseSelect
                warehouses={warehouses}
                allowedTypes={['finished_product', 'resale']}
                value={line.warehouse_id}
                onChange={val => updateLine(idx, 'warehouse_id', val)}
                error={!line.warehouse_id && !!error}
              />
              <p className="text-[10px] text-ink-muted mt-1">
                Define a qué almacén llegará la mercancía — necesario para calcular el inventario en tránsito.
              </p>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <label className="label">Cantidad <span className="text-status-danger">*</span></label>
                <div className="flex gap-2">
                  <input type="number" step="1" min="0" value={line.quantity}
                    onChange={e => updateLine(idx, 'quantity', e.target.value)}
                    className="input flex-1" placeholder="0" />
                  <select className="select w-20" value={line.unit} onChange={e => updateLine(idx, 'unit', e.target.value)}>
                    <option value="pza">pza</option>
                    <option value="caja">caja</option>
                    <option value="kg">kg</option>
                    <option value="l">l</option>
                  </select>
                </div>
              </div>
              <div>
                <label className="label flex items-center gap-1.5">
                  Precio unitario <SupplierPriceChip source={line.price_source} />
                </label>
                <input type="number" step="0.0001" min="0" value={line.unit_price}
                  onChange={e => updateLine(idx, 'unit_price', e.target.value)}
                  className="input" placeholder="0.0000" />
              </div>
              <div>
                <label className="label">Subtotal</label>
                <div className="input bg-surface-elevated/40 text-ink-muted font-mono text-sm cursor-default">
                  {fmtMXN(parseFloat(line.quantity || 0) * parseFloat(line.unit_price || 0), currency)}
                </div>
              </div>
            </div>
          </div>
        ))}

        <button type="button" onClick={() => setLines(p => [...p, EMPTY_LINE_PT()])}
          className="w-full border border-dashed border-line-base rounded-xl py-2.5 text-sm font-medium text-brand-300 hover:bg-brand-500/5 transition-colors">
          + Agregar artículo
        </button>

        <TotalesBlock lines={lines} currency={currency} exchangeRate={exchangeRate} applyTax={applyTax} setApplyTax={setApplyTax} />
      </div>

      {error && <p className="field-error">{error}</p>}
      <div className="flex gap-2 pt-1">
        <button type="button" onClick={onClose} className="btn-secondary flex-1">Cancelar</button>
        <button type="submit" disabled={mutation.isPending} className="btn-primary flex-1">
          {mutation.isPending ? <Spinner size="sm" /> : 'Crear orden de compra'}
        </button>
      </div>
    </form>
  )
}

// ── Modal wrapper con título y tipo ────────────────────────────────────────
export function OCFormModal({ type, onClose, onCreated, prefilledItem = null }) {
  const isMP = type === 'raw_material'

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40 p-4">
      <div className="card w-full max-w-2xl p-6 max-h-[92vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-5">
          <div className="flex items-center gap-3">
            <div className={clsx(
              'w-8 h-8 rounded-lg flex items-center justify-center shrink-0',
              isMP ? 'bg-status-warning/15' : 'bg-brand-500/15'
            )}>
              <svg className={clsx('w-4 h-4', isMP ? 'text-status-warning' : 'text-brand-300')} fill="currentColor" viewBox="0 0 24 24">
                {isMP
                  ? <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/>
                  : <path d="M20 6h-2.18c.07-.44.18-.88.18-1.33C18 2.54 16.46 1 14.67 1c-1.08 0-1.9.5-2.59 1.28L12 2.41l-.08-.13C11.22 1.5 10.4 1 9.33 1 7.54 1 6 2.54 6 4.33c0 .45.1.89.18 1.33H4c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2z"/>
                }
              </svg>
            </div>
            <div>
              <h2 className="text-base font-semibold text-ink-primary">
                Nueva OC — {isMP ? 'Materia Prima' : 'Producto Terminado'}
              </h2>
              <p className="text-xs text-ink-muted mt-0.5">
                {prefilledItem
                  ? `Reposición sugerida desde Inventario · ${prefilledItem.itemName}`
                  : (isMP ? 'Cantidades estimadas · se confirman en recepción' : 'Cantidades firmes · almacén y precio precargados')}
              </p>
            </div>
          </div>
          <button onClick={onClose} className="btn-ghost btn-icon text-ink-muted">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12"/>
            </svg>
          </button>
        </div>

        {isMP
          ? <OCFormMP onClose={onClose} onCreated={onCreated} prefilledItem={prefilledItem} />
          : <OCFormPT onClose={onClose} onCreated={onCreated} prefilledItem={prefilledItem} />
        }
      </div>
    </div>,
    document.body
  )
}
