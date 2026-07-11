import { useState, useCallback, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { salesApi } from '@/api/sales'
import { productsApi } from '@/api/products'
import Autocomplete from '@/components/ui/Autocomplete'
import Spinner from '@/components/ui/Spinner'
import { StockDisponible } from '@/components/ventas/StockDisponible'
import { ProductImageThumb } from '@/components/productos/ProductImageThumb'
import { fmtMXN, fmtDate } from '@/utils/fmt'
import clsx from 'clsx'

/**
 * Modal compacto para agregar o editar una línea de pedido en draft.
 *
 * Props:
 *   order          — pedido (necesita id, partner_id, currency)
 *   line           — null para crear, o la línea existente para editar
 *   onClose, onSaved
 */
export function PedidoLineaModal({ order, line, onClose, onSaved }) {
  const qc = useQueryClient()
  const isEdit = !!line

  const [product, setProduct]       = useState(() => line ? {
    id: line.product_id, label: line.product_name, sku: line.sku, unit: line.unit,
    image_attachment_id: line.image_attachment_id || null,
  } : null)
  const [quantity, setQuantity]     = useState(line?.quantity?.toString() || '')
  const [unit, setUnit]             = useState(line?.unit || 'paquete')
  const [unitPrice, setUnitPrice]   = useState(line?.unit_price?.toString() || '')
  const [discountPct, setDiscountPct] = useState(line?.discount_pct?.toString() || '')
  const [notes, setNotes]           = useState(line?.notes || '')
  const [priceSource, setPriceSource] = useState(isEdit ? 'manual' : null)
  const [origUnitPrice, setOrigUnitPrice] = useState(line?.original_unit_price ?? null)
  const [origCurrency,  setOrigCurrency]  = useState(line?.original_currency  ?? null)
  const [appliedRate,   setAppliedRate]   = useState(line?.applied_exchange_rate ?? null)
  const [appliedRateDate, setAppliedRateDate] = useState(line?.applied_exchange_rate_date ?? null)
  const [packOptions, setPackOptions]   = useState([])
  const [packOptionId, setPackOptionId] = useState(line?.pack_option_id ?? null)
  const [packFactor, setPackFactor]     = useState(line?.pack_factor != null ? parseFloat(line.pack_factor) : 1)
  const [baseUnit, setBaseUnit]         = useState(line?.base_unit || '')
  // Precio "puro" por unidad base (antes de multiplicar por pack_factor).
  // Permite recalcular el unit_price al cambiar de presentación sin re-fetch.
  // Se invalida (null) cuando el usuario edita el precio a mano.
  const [basePriceRef, setBasePriceRef] = useState(null)
  const [error, setError]           = useState(null)

  const searchProducts = useCallback(async (q) => {
    const res = await productsApi.list({ search: q, limit: 20 })
    return (res.data || res).map(p => ({
      id: p.id, label: p.name, sub: p.sku || '',
      sku: p.sku, unit: p.unit || 'paquete',
      catalog_price: p.unit_price || p.price || null,
      image_attachment_id: p.image_attachment_id || null,
    }))
  }, [])

  // Carga presentaciones cuando hay un producto seleccionado (al montar en edición o al elegir uno nuevo)
  useEffect(() => {
    if (!product?.id) { setPackOptions([]); return }
    let active = true
    Promise.all([
      productsApi.listPackOptions(product.id),
      productsApi.get(product.id),
    ]).then(([opts, prod]) => {
      if (!active) return
      setPackOptions(opts || [])
      setBaseUnit(prod?.base_unit || '')
      // En modo edición conservar la elegida; en modo nuevo aplicar default
      if (!isEdit || !packOptionId) {
        const def = (opts || []).find(o => o.is_default) || opts?.[0]
        if (def) {
          setPackOptionId(def.id)
          setPackFactor(parseFloat(def.base_per_pack))
          setUnit(def.pack_unit)
          // Si ya tenemos un basePriceRef del suggested-price, aplicar el factor
          setBasePriceRef(prev => {
            if (prev != null) {
              setUnitPrice((prev * parseFloat(def.base_per_pack)).toFixed(4))
            }
            return prev
          })
        }
      }
    }).catch(() => { /* silencio */ })
    return () => { active = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [product?.id])

  function onPackChange(packId) {
    const opt = packOptions.find(o => o.id === packId)
    if (!opt) return
    const newFactor = parseFloat(opt.base_per_pack)
    setPackOptionId(opt.id)
    setPackFactor(newFactor)
    setUnit(opt.pack_unit)
    // Si tenemos el precio base de referencia, recalcular el unit_price.
    // Si el usuario lo había editado a mano (basePriceRef=null), respetar.
    if (basePriceRef != null) {
      setUnitPrice((basePriceRef * newFactor).toFixed(4))
    }
  }

  // Al elegir producto nuevo, intentar precio sugerido (solo en modo crear o al cambiar de producto)
  async function handleProductChange(p) {
    setProduct(p)
    if (!p) return
    setUnit(p.unit || unit)
    if (isEdit && p.id === line.product_id) return // editando, no resetear precio

    // Reset trazabilidad de moneda original al cambiar producto
    setOrigUnitPrice(null); setOrigCurrency(null); setAppliedRate(null); setAppliedRateDate(null)
    setPackOptionId(null); setPackFactor(1); setBasePriceRef(null)

    try {
      const res = await salesApi.suggestedPrice(order.partner_id, p.id, order.currency)
      if (res?.unit_price) {
        // res.unit_price viene por UNIDAD BASE — multiplicamos por el factor
        // actual (puede ser 1 si aún no cargaron las pack_options, y el
        // useEffect de pack_options ajustará al setear basePriceRef).
        const base = parseFloat(res.unit_price)
        setBasePriceRef(base)
        setUnitPrice((base * (packFactor || 1)).toFixed(4))
        setPriceSource(res.source || 'negotiated')
        setOrigUnitPrice(res.originalUnitPrice       ?? null)
        setOrigCurrency(res.originalCurrency         ?? null)
        setAppliedRate(res.appliedExchangeRate       ?? null)
        setAppliedRateDate(res.appliedExchangeRateDate ?? null)
        return
      }
    } catch { /* ignore */ }
    if (p.catalog_price) {
      setUnitPrice(String(p.catalog_price))
      setPriceSource('catalog')
    } else {
      setUnitPrice('')
      setPriceSource(null)
    }
  }

  const mutation = useMutation({
    mutationFn: () => {
      if (!product?.id)   throw new Error('Selecciona un producto.')
      if (!quantity || parseFloat(quantity) <= 0) throw new Error('Captura una cantidad válida.')
      if (!unitPrice || parseFloat(unitPrice) <= 0) throw new Error('Captura un precio unitario válido.')

      const body = {
        productId:               product.id,
        quantity:                parseFloat(quantity),
        unit,
        unitPrice:               parseFloat(unitPrice),
        discountPct:             parseFloat(discountPct || 0),
        notes:                   notes || null,
        originalUnitPrice:       origUnitPrice    ?? null,
        originalCurrency:        origCurrency     ?? null,
        appliedExchangeRate:     appliedRate      ?? null,
        appliedExchangeRateDate: appliedRateDate  ?? null,
        packOptionId:            packOptionId     ?? null,
        packFactor:              packFactor       ?? 1,
      }

      return isEdit
        ? salesApi.updateLine(order.id, line.id, body)
        : salesApi.addLine(order.id, body)
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sales-order', order.id] })
      qc.invalidateQueries({ queryKey: ['sales-orders'] })
      onSaved?.()
      onClose()
    },
    onError: (e) => setError(e.response?.data?.error || e.message || 'Error al guardar la línea'),
  })

  function handleSubmit(e) { e.preventDefault(); setError(null); mutation.mutate() }

  const subtotal = parseFloat(quantity || 0) * parseFloat(unitPrice || 0) *
                   (1 - parseFloat(discountPct || 0) / 100)

  return createPortal(
    <div className="fixed inset-0 z-[10001] flex items-center justify-center bg-black/40 p-4">
      <form onSubmit={handleSubmit} className="card w-full max-w-md p-5 flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <h3 className="text-base font-semibold text-ink-primary">
            {isEdit ? 'Editar línea' : 'Agregar línea'}
          </h3>
          <button type="button" onClick={onClose} className="btn-ghost btn-icon text-ink-muted">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12"/>
            </svg>
          </button>
        </div>

        <div>
          <label className="label flex items-center justify-between gap-2">
            <span>Producto <span className="text-status-danger">*</span></span>
            {product?.id && (
              <ProductImageThumb
                productId={product.id}
                imageAttachmentId={product.image_attachment_id}
                caption={product.label || product.name}
                size="md" />
            )}
          </label>
          <Autocomplete
            value={product}
            onChange={handleProductChange}
            onSearch={searchProducts}
            placeholder="Buscar producto..."
          />
          {priceSource && priceSource !== 'manual' && (
            <p className="text-[11px] mt-1.5">
              <span className={clsx(
                'inline-block px-1.5 py-0.5 rounded-full font-bold uppercase tracking-wide text-[10px]',
                priceSource === 'negotiated' ? 'bg-status-success/15 text-status-success' : 'bg-status-info/15 text-status-info'
              )}>
                {priceSource === 'negotiated' ? 'Precio negociado' : 'Precio de catálogo'}
              </span>
              <span className="text-ink-muted ml-1.5">aplicado automáticamente</span>
            </p>
          )}
        </div>

        <div className="grid grid-cols-12 gap-2">
          <div className="col-span-7">
            <label className="label">Cantidad <span className="text-status-danger">*</span></label>
            <input type="number" step="0.001" min="0" inputMode="decimal" value={quantity}
              onChange={e => setQuantity(e.target.value)}
              className="input text-base" placeholder="0" autoFocus={!isEdit} />
          </div>
          <div className="col-span-5">
            <label className="label">Presentación</label>
            {packOptions.length > 0 ? (
              <select className="select" value={packOptionId || ''} onChange={e => onPackChange(e.target.value)}>
                {packOptions.map(opt => (
                  <option key={opt.id} value={opt.id}>
                    {opt.pack_unit}{Number(opt.base_per_pack) !== 1 ? ` (×${opt.base_per_pack})` : ''}
                  </option>
                ))}
              </select>
            ) : (
              <input className="input" value={unit} onChange={e => setUnit(e.target.value)} />
            )}
          </div>
          <div className="col-span-7">
            <label className="label">P. Unit. <span className="text-status-danger">*</span></label>
            <input type="number" step="0.0001" min="0" inputMode="decimal" value={unitPrice}
              onChange={e => {
                setUnitPrice(e.target.value); setPriceSource('manual')
                // editar a mano rompe la trazabilidad de moneda original
                setOrigUnitPrice(null); setOrigCurrency(null); setAppliedRate(null); setAppliedRateDate(null)
                // y la referencia al precio base — al cambiar presentación ya no se recalcula
                setBasePriceRef(null)
              }}
              className="input text-base" placeholder="0.0000" />
            {origCurrency && origUnitPrice != null && appliedRate != null && (
              <p className="text-[11px] text-ink-muted mt-1 leading-tight">
                <span className="font-medium text-status-warning">{origCurrency} ${Number(origUnitPrice).toFixed(2)}</span>
                {' × TC '}
                <span className="font-mono">${Number(appliedRate).toFixed(4)}</span>
                {appliedRateDate && (
                  <span className="text-ink-muted"> ({fmtDate(appliedRateDate)})</span>
                )}
                {' = '}
                <span className="font-mono">{order.currency} ${Number(unitPrice).toFixed(2)}</span>
                <br />
                <span className="text-ink-muted">Se revaluará al timbrar la factura con el TC del día.</span>
              </p>
            )}
          </div>
          <div className="col-span-5">
            <label className="label">Desc. %</label>
            <input type="number" step="0.01" min="0" max="100" inputMode="decimal" value={discountPct}
              onChange={e => setDiscountPct(e.target.value)}
              className="input text-base" placeholder="0" />
          </div>
        </div>

        <div>
          <label className="label">Notas</label>
          <input className="input" placeholder="Opcional" value={notes} onChange={e => setNotes(e.target.value)} />
        </div>

        {packFactor > 1 && baseUnit && (
          <div className="bg-status-warning/10 border border-status-warning/40 rounded-lg px-3 py-1.5 text-[11px] text-status-warning">
            <span className="font-medium">Inventario:</span>{' '}
            {parseFloat(quantity || 0).toLocaleString('es-MX')} {unit}
            {' × '}{packFactor}{' = '}
            <span className="font-mono font-semibold">
              {(parseFloat(quantity || 0) * packFactor).toLocaleString('es-MX')} {baseUnit}
            </span>
          </div>
        )}

        {product?.id && (
          <StockDisponible
            productId={product.id}
            qtyBase={parseFloat(quantity || 0) * (packFactor || 1)}
            baseUnit={baseUnit || unit}
          />
        )}

        <div className="bg-surface-elevated/40 rounded-lg px-3 py-2 flex justify-between items-center">
          <span className="text-xs text-ink-muted uppercase tracking-wide">Subtotal</span>
          <span className="font-mono font-semibold text-brand-300">{fmtMXN(subtotal, order.currency)}</span>
        </div>

        {error && <p className="field-error">{error}</p>}

        <div className="flex gap-2">
          <button type="button" onClick={onClose} className="btn-secondary flex-1" disabled={mutation.isPending}>
            Cancelar
          </button>
          <button type="submit" className="btn-primary flex-1" disabled={mutation.isPending}>
            {mutation.isPending ? <Spinner size="sm" /> : (isEdit ? 'Guardar cambios' : 'Agregar línea')}
          </button>
        </div>
      </form>
    </div>,
    document.body
  )
}
