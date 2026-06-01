import { useState, useCallback, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { salesApi } from '@/api/sales'
import { partnersApi } from '@/api/partners'
import { productsApi } from '@/api/products'
import { exchangeRatesApi } from '@/api/exchangeRates'
import Autocomplete from '@/components/ui/Autocomplete'
import Spinner from '@/components/ui/Spinner'
import { fmtMXN, fmtNum, fmtDate, fmtDateOnly} from '@/utils/fmt'
import clsx from 'clsx'

const EMPTY_LINE = () => ({
  product: null,
  quantity: '',
  unit: 'paquete',
  unit_price: '',
  discount_pct: '',
  notes: '',
  price_source: null,   // 'negotiated' | 'catalog' | 'manual'
  pack_options: [],     // presentaciones cargadas del producto
  pack_option_id: null,
  pack_factor: 1,
  base_unit: '',
  base_price_ref: null, // precio por unidad base — para recalcular al cambiar presentación
})

// ── Bloque de totales (SIN IVA — se agrega al facturar) ──────────────────────
// El pedido es un documento pre-fiscal. El IVA se calcula automáticamente
// cuando se emite la factura (CFDI). No mostramos IVA aquí porque hay
// pedidos que nunca se facturan.
function TotalesBlock({ lines, currency, exchangeRate }) {
  const subtotal = lines.reduce((s, l) => {
    const qty = parseFloat(l.quantity || 0)
    const price = parseFloat(l.unit_price || 0)
    const disc = parseFloat(l.discount_pct || 0)
    return s + qty * price * (1 - disc / 100)
  }, 0)

  if (subtotal === 0) return null

  return (
    <div className="bg-surface-elevated/60 border border-line-subtle rounded-xl p-4 flex flex-col gap-2.5">
      <div className="flex flex-col gap-1">
        <div className="flex justify-between text-base font-semibold text-ink-primary">
          <span>Total del pedido</span>
          <span className="font-mono text-brand-300">{fmtMXN(subtotal, currency)}</span>
        </div>
        {currency === 'USD' && exchangeRate > 0 && (
          <div className="flex justify-between text-xs text-ink-muted mt-0.5">
            <span>Equivalente MXN (TC ${fmtNum(exchangeRate, 4)})</span>
            <span className="font-mono">{fmtMXN(subtotal * exchangeRate, 'MXN')}</span>
          </div>
        )}
      </div>
      <p className="flex items-start gap-1.5 text-xs text-status-warning bg-status-warning/10 border border-status-warning/40 rounded-md px-2.5 py-1.5">
        <svg className="w-3.5 h-3.5 shrink-0 mt-0.5" fill="currentColor" viewBox="0 0 20 20">
          <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clipRule="evenodd"/>
        </svg>
        <span>El IVA (16%) se calculará automáticamente al facturar.</span>
      </p>
    </div>
  )
}

// ── Chip de origen de precio ─────────────────────────────────────────────────
function PriceSourceChip({ source }) {
  if (!source || source === 'manual') return null
  const isNeg = source === 'negotiated'
  return (
    <span className={clsx(
      'text-[10px] font-bold px-1.5 py-0.5 rounded-full uppercase tracking-wide ml-1.5',
      isNeg ? 'bg-status-success/15 text-status-success' : 'bg-status-info/15 text-status-info'
    )}>
      {isNeg ? 'Negociado' : 'Catálogo'}
    </span>
  )
}

// ── Modal de captura ─────────────────────────────────────────────────────────
function PedidoForm({ onClose, onCreated }) {
  const qc = useQueryClient()

  const [partner, setPartner]           = useState(null)
  const [addressId, setAddressId]       = useState('')
  const [currency, setCurrency]         = useState('MXN')
  const [poNumber, setPoNumber]         = useState('')
  const [scheduledDate, setScheduledDate] = useState('')
  const [directInvoice, setDirectInvoice] = useState(false)
  const [notes, setNotes]               = useState('')
  const [lines, setLines]               = useState([EMPTY_LINE()])
  const [error, setError]               = useState(null)
  const [customTC, setCustomTC]         = useState('')

  // Cargar TC USD si aplica
  const { data: tcData } = useQuery({
    queryKey: ['exchange-rate-usd'],
    queryFn: () => exchangeRatesApi.getRate('USD'),
    staleTime: 5 * 60 * 1000,
    enabled: currency === 'USD',
  })
  const exchangeRate = parseFloat(customTC || tcData || 0)

  // Cargar perfil del cliente seleccionado (preferencias)
  const { data: partnerProfile } = useQuery({
    queryKey: ['partner-profile', partner?.id],
    queryFn: () => partnersApi.get(partner.id),
    enabled: !!partner?.id,
  })

  // Cargar domicilios del cliente
  const { data: addresses = [] } = useQuery({
    queryKey: ['partner-addresses', partner?.id],
    queryFn: () => partnersApi.listAddresses(partner.id),
    enabled: !!partner?.id,
  })

  // Al cargar perfil, prellenar moneda preferida y domicilio default
  useEffect(() => {
    if (!partnerProfile) return
    if (partnerProfile.preferred_currency) setCurrency(partnerProfile.preferred_currency)
    if (partnerProfile.default_address_id) setAddressId(partnerProfile.default_address_id)
  }, [partnerProfile])

  // Búsquedas
  const searchPartners = useCallback(async (q) => {
    const res = await partnersApi.list({ search: q, type: 'customer', limit: 20 })
    return (res.data || res).map(p => ({ id: p.id, label: p.name, sub: [p.rfc, p.tax_name && p.tax_name !== p.name ? p.tax_name : null].filter(Boolean).join(' · ') }))
  }, [])

  const searchProducts = useCallback(async (q) => {
    const res = await productsApi.list({ search: q, limit: 20 })
    return (res.data || res).map(p => ({
      id: p.id, label: p.name,
      sub: p.sku || '',
      sku: p.sku,
      unit: p.unit || 'paquete',
      catalog_price: p.unit_price || p.price || null,
    }))
  }, [])

  // Cuando se selecciona un producto, intentar traer precio sugerido y pack_options
  async function handleProductSelect(idx, product) {
    setLines(prev => prev.map((l, i) => {
      if (i !== idx) return l
      return { ...l, product, unit: product?.unit || 'paquete', unit_price: '',
               price_source: null, original_unit_price: null,
               original_currency: null, applied_exchange_rate: null,
               applied_exchange_rate_date: null,
               pack_options: [], pack_option_id: null, pack_factor: 1, base_unit: '',
               base_price_ref: null }
    }))
    if (!product || !partner?.id) return

    // Cargar pack_options del producto (independiente del precio sugerido)
    try {
      const [opts, fullProduct] = await Promise.all([
        productsApi.listPackOptions(product.id),
        productsApi.get(product.id),
      ])
      const def = (opts || []).find(o => o.is_default) || opts?.[0]
      setLines(prev => prev.map((l, i) => {
        if (i !== idx || l.product?.id !== product.id) return l
        // Si ya teníamos base_price_ref del suggested-price, aplicar factor
        const factor = def ? parseFloat(def.base_per_pack) : 1
        const recalcPrice = l.base_price_ref != null && l.price_source !== 'manual'
          ? (l.base_price_ref * factor).toFixed(4)
          : l.unit_price
        return {
          ...l,
          pack_options: opts || [],
          pack_option_id: def?.id || null,
          pack_factor:    factor,
          unit:           def?.pack_unit || l.unit,
          base_unit:      fullProduct?.base_unit || '',
          unit_price:     recalcPrice,
        }
      }))
    } catch { /* silencio */ }

    try {
      const res = await salesApi.suggestedPrice(partner.id, product.id, currency)
      if (res?.unit_price) {
        setLines(prev => prev.map((l, i) => {
          if (i !== idx || l.product?.id !== product.id) return l
          // res.unit_price viene por UNIDAD BASE — multiplicamos por el factor
          // actual de la línea (que ya pudo haberse asignado al cargar pack_options).
          const base = parseFloat(res.unit_price)
          const factor = l.pack_factor || 1
          return {
            ...l,
            unit_price:                  (base * factor).toFixed(4),
            base_price_ref:              base,
            price_source:                res.source || 'negotiated',
            original_unit_price:         res.originalUnitPrice       ?? null,
            original_currency:           res.originalCurrency        ?? null,
            applied_exchange_rate:       res.appliedExchangeRate     ?? null,
            applied_exchange_rate_date:  res.appliedExchangeRateDate ?? null,
          }
        }))
      } else if (product.catalog_price) {
        // Fallback al precio de catálogo (sin conversión)
        setLines(prev => prev.map((l, i) => {
          if (i !== idx || l.product?.id !== product.id) return l
          return { ...l, unit_price: String(product.catalog_price), price_source: 'catalog' }
        }))
      }
    } catch {
      // Silencio: el usuario captura el precio manualmente
    }
  }

  function updateLine(idx, key, val) {
    setLines(prev => prev.map((l, i) => {
      if (i !== idx) return l
      const next = { ...l, [key]: val }
      if (key === 'unit_price') {
        next.price_source = 'manual'
        // Capturar manualmente invalida la trazabilidad de moneda original
        next.original_unit_price        = null
        next.original_currency          = null
        next.applied_exchange_rate      = null
        next.applied_exchange_rate_date = null
        // y la referencia al precio base — no se recalcula al cambiar presentación
        next.base_price_ref             = null
      }
      return next
    }))
  }

  const mutation = useMutation({
    mutationFn: () => {
      const validLines = lines.filter(l => l.product?.id && l.quantity && l.unit_price)
      if (!partner?.id)         throw new Error('Selecciona un cliente.')
      if (!validLines.length)   throw new Error('Agrega al menos una línea con cantidad y precio.')
      // requires_po: en el pedido es solo advertencia visual (el cliente puede entregar
      // la OC más tarde). El bloqueo duro ocurre al timbrar factura.
      if (currency === 'USD' && !(exchangeRate > 0)) {
        throw new Error('Captura un tipo de cambio válido para pedidos en USD.')
      }
      return salesApi.createOrder({
        partnerId:         partner.id,
        deliveryAddressId: addressId || null,
        currency,
        poNumber:          poNumber || null,
        scheduledDate:     scheduledDate || null,
        directInvoice,
        notes:             notes || null,
        lines: validLines.map(l => ({
          productId:               l.product.id,
          quantity:                parseFloat(l.quantity),
          unit:                    l.unit,
          unitPrice:               parseFloat(l.unit_price),
          discountPct:             parseFloat(l.discount_pct || 0),
          notes:                   l.notes || null,
          originalUnitPrice:       l.original_unit_price        ?? null,
          originalCurrency:        l.original_currency          ?? null,
          appliedExchangeRate:     l.applied_exchange_rate      ?? null,
          appliedExchangeRateDate: l.applied_exchange_rate_date ?? null,
          packOptionId:            l.pack_option_id             ?? null,
          packFactor:              l.pack_factor                ?? 1,
        })),
      })
    },
    onSuccess: (order) => {
      qc.invalidateQueries({ queryKey: ['sales-orders'] })
      onCreated?.(order)
      onClose()
    },
    onError: (e) => setError(e.response?.data?.error || e.message || 'Error al crear el pedido'),
  })

  function handleSubmit(e) { e.preventDefault(); setError(null); mutation.mutate() }

  const showQuotationWarning = partnerProfile?.requires_quotation

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-5">
      {/* Datos generales */}
      <div className="bg-surface-elevated/60 border border-line-subtle rounded-xl p-4 flex flex-col gap-3">
        <p className="text-xs font-bold text-brand-300 uppercase tracking-wider">Datos generales</p>

        <div>
          <label className="label">Cliente <span className="text-status-danger">*</span></label>
          <Autocomplete
            value={partner}
            onChange={setPartner}
            onSearch={searchPartners}
            placeholder="Buscar cliente..."
            error={!partner && !!error}
          />
        </div>

        {showQuotationWarning && (
          <div className="flex items-start gap-2 bg-status-warning/10 border border-status-warning/40 rounded-lg p-2.5">
            <svg className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" fill="currentColor" viewBox="0 0 24 24">
              <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/>
            </svg>
            <p className="text-xs text-status-warning">
              Este cliente normalmente requiere <strong>cotización previa</strong>. Verifica que ya la haya aceptado antes de capturar el pedido.
            </p>
          </div>
        )}

        {addresses.length > 0 && (
          <div>
            <label className="label">Domicilio de entrega</label>
            <select className="select" value={addressId} onChange={e => setAddressId(e.target.value)}>
              <option value="">— Sin domicilio específico —</option>
              {addresses.map(a => (
                <option key={a.id} value={a.id}>
                  {a.alias ? `${a.alias} · ` : ''}{a.address}, {a.city}
                  {a.is_default ? ' (default)' : ''}
                </option>
              ))}
            </select>
          </div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="label">Moneda</label>
            <select className="select" value={currency} onChange={e => setCurrency(e.target.value)}>
              <option value="MXN">MXN — Peso mexicano</option>
              <option value="USD">USD — Dólar</option>
            </select>
          </div>
          <div>
            <label className="label">Fecha programada de entrega</label>
            <input type="date" className="input" value={scheduledDate} onChange={e => setScheduledDate(e.target.value)} />
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

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="label">Número de OC del cliente</label>
            <input className="input"
              placeholder={partnerProfile?.requires_po
                ? 'Recomendada — la podrás capturar también al facturar'
                : 'Opcional'}
              value={poNumber} onChange={e => setPoNumber(e.target.value)} />
            {partnerProfile?.requires_po && !poNumber && (
              <p className="text-[11px] text-status-warning mt-1 flex items-center gap-1">
                <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/>
                </svg>
                Este cliente requiere OC. Si aún no la tienes, podrás capturarla al timbrar la factura (donde sí es obligatoria).
              </p>
            )}
          </div>
          <div>
            <label className="label flex items-center gap-2 cursor-pointer select-none">
              <input
                type="checkbox" className="w-4 h-4 accent-brand-600 rounded"
                checked={directInvoice} onChange={e => setDirectInvoice(e.target.checked)}
              />
              <span>Facturar directo (sin remisión)</span>
            </label>
            <p className="text-[11px] text-ink-muted mt-1.5">Marca si el cliente no requiere entrega física previa</p>
          </div>
        </div>

        <div>
          <label className="label">Notas</label>
          <input className="input" placeholder="Instrucciones, condiciones..." value={notes} onChange={e => setNotes(e.target.value)} />
        </div>
      </div>

      {/* Artículos */}
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <p className="text-xs font-bold text-brand-300 uppercase tracking-wider">Artículos</p>
          <button type="button" onClick={() => setLines(p => [...p, EMPTY_LINE()])} className="btn-ghost btn-sm text-brand-300">
            + Agregar artículo
          </button>
        </div>

        {lines.map((line, idx) => (
          <div key={idx} className="border border-line-subtle rounded-xl p-4 flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <p className="text-xs font-medium text-ink-muted">
                Línea {idx + 1}
                <PriceSourceChip source={line.price_source} />
              </p>
              {lines.length > 1 && (
                <button type="button" onClick={() => setLines(p => p.filter((_, i) => i !== idx))} className="text-xs text-red-400 hover:text-status-danger">
                  Quitar
                </button>
              )}
            </div>

            <div>
              <label className="label">Producto <span className="text-status-danger">*</span></label>
              <Autocomplete
                value={line.product}
                onChange={p => handleProductSelect(idx, p)}
                onSearch={searchProducts}
                placeholder="Buscar producto..."
              />
            </div>

            <div className="grid grid-cols-12 gap-2">
              <div className="col-span-7 sm:col-span-5">
                <label className="label">Cantidad <span className="text-status-danger">*</span></label>
                <input type="number" step="0.001" min="0" inputMode="decimal" value={line.quantity}
                  onChange={e => updateLine(idx, 'quantity', e.target.value)}
                  className="input text-base" placeholder="0" />
              </div>
              <div className="col-span-5 sm:col-span-2">
                <label className="label">Presentación</label>
                {line.pack_options && line.pack_options.length > 0 ? (
                  <select className="select" value={line.pack_option_id || ''}
                    onChange={e => {
                      const opt = line.pack_options.find(o => o.id === e.target.value)
                      if (!opt) return
                      const newFactor = parseFloat(opt.base_per_pack)
                      setLines(prev => prev.map((l, i) => {
                        if (i !== idx) return l
                        // Recalcular unit_price desde base_price_ref si existe
                        // y el usuario no editó a mano
                        const recalcPrice = l.base_price_ref != null && l.price_source !== 'manual'
                          ? (l.base_price_ref * newFactor).toFixed(4)
                          : l.unit_price
                        return { ...l,
                          pack_option_id: opt.id,
                          pack_factor:    newFactor,
                          unit:           opt.pack_unit,
                          unit_price:     recalcPrice,
                        }
                      }))
                    }}>
                    {line.pack_options.map(opt => (
                      <option key={opt.id} value={opt.id}>
                        {opt.pack_unit}{Number(opt.base_per_pack) !== 1 ? ` (×${opt.base_per_pack})` : ''}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input className="input" value={line.unit} onChange={e => updateLine(idx, 'unit', e.target.value)} />
                )}
              </div>
              <div className="col-span-7 sm:col-span-3">
                <label className="label">P. Unit. <span className="text-status-danger">*</span></label>
                <input type="number" step="0.0001" min="0" inputMode="decimal" value={line.unit_price}
                  onChange={e => updateLine(idx, 'unit_price', e.target.value)}
                  className="input text-base" placeholder="0.0000" />
                {line.original_currency && line.original_unit_price != null && line.applied_exchange_rate != null && (
                  <p className="text-[10px] text-ink-muted mt-0.5 leading-tight">
                    <span className="font-medium text-status-warning">
                      {line.original_currency} ${Number(line.original_unit_price).toFixed(2)}
                    </span>
                    {' × TC '}
                    <span className="font-mono">${Number(line.applied_exchange_rate).toFixed(4)}</span>
                    {line.applied_exchange_rate_date && (
                      <span className="text-ink-muted"> ({fmtDateOnly(line.applied_exchange_rate_date)})</span>
                    )}
                    <br />
                    <span className="text-ink-muted">Se revaluará al timbrar.</span>
                  </p>
                )}
              </div>
              <div className="col-span-5 sm:col-span-2">
                <label className="label">Desc. %</label>
                <input type="number" step="0.01" min="0" max="100" inputMode="decimal" value={line.discount_pct}
                  onChange={e => updateLine(idx, 'discount_pct', e.target.value)}
                  className="input text-base" placeholder="0" />
              </div>
            </div>
            {line.pack_factor > 1 && line.base_unit && (
              <div className="bg-status-warning/10 border border-status-warning/40 rounded-lg px-3 py-1.5 text-[11px] text-status-warning">
                <span className="font-medium">Inventario:</span>{' '}
                {parseFloat(line.quantity || 0).toLocaleString('es-MX')} {line.unit}
                {' × '}{line.pack_factor}{' = '}
                <span className="font-mono font-semibold">
                  {(parseFloat(line.quantity || 0) * line.pack_factor).toLocaleString('es-MX')} {line.base_unit}
                </span>
              </div>
            )}

            <div className="flex items-center justify-between bg-surface-elevated/40 rounded-lg px-3 py-1.5">
              <span className="text-xs text-ink-muted uppercase tracking-wide">Subtotal línea</span>
              <span className="font-mono font-semibold text-brand-300">
                {fmtMXN(
                  parseFloat(line.quantity || 0) * parseFloat(line.unit_price || 0) *
                  (1 - parseFloat(line.discount_pct || 0) / 100),
                  currency
                )}
              </span>
            </div>

            <input
              className="input text-xs"
              placeholder="Notas de la línea (opcional)"
              value={line.notes}
              onChange={e => updateLine(idx, 'notes', e.target.value)}
            />
          </div>
        ))}

        <button type="button" onClick={() => setLines(p => [...p, EMPTY_LINE()])}
          className="w-full border border-dashed border-line-base rounded-xl py-2.5 text-sm font-medium text-brand-300 hover:bg-brand-500/5 transition-colors">
          + Agregar artículo
        </button>

        <TotalesBlock lines={lines} currency={currency} exchangeRate={exchangeRate} />
      </div>

      {error && <p className="field-error">{error}</p>}
      <div className="flex gap-2 pt-1">
        <button type="button" onClick={onClose} className="btn-secondary flex-1 justify-center">Cancelar</button>
        <button type="submit" disabled={mutation.isPending} className="btn-primary flex-1 justify-center">
          {mutation.isPending ? <Spinner size="sm" /> : 'Crear pedido'}
        </button>
      </div>
    </form>
  )
}

// ── Wrapper del modal ────────────────────────────────────────────────────────
export function PedidoFormModal({ onClose, onCreated }) {
  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40 p-4">
      <div className="card w-full max-w-2xl p-6 max-h-[92vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-5">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-brand-500/15 flex items-center justify-center shrink-0">
              <svg className="w-4 h-4 text-brand-300" fill="currentColor" viewBox="0 0 24 24">
                <path d="M19 3H5c-1.11 0-2 .89-2 2v14c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.11-.9-2-2-2zm-5 14H7v-2h7v2zm3-4H7v-2h10v2zm0-4H7V7h10v2z"/>
              </svg>
            </div>
            <div>
              <h2 className="text-base font-semibold text-ink-primary">Nuevo pedido</h2>
              <p className="text-xs text-ink-muted mt-0.5">Cliente, líneas y precios — el pedido inicia en borrador</p>
            </div>
          </div>
          <button onClick={onClose} className="btn-ghost btn-icon text-ink-muted">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12"/>
            </svg>
          </button>
        </div>

        <PedidoForm onClose={onClose} onCreated={onCreated} />
      </div>
    </div>,
    document.body
  )
}
