import { useState, useCallback, useMemo } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { createPortal } from 'react-dom'
import { productsApi } from '@/api/products'
import { exchangeRatesApi } from '@/api/exchangeRates'
import Autocomplete from '@/components/ui/Autocomplete'
import Spinner from '@/components/ui/Spinner'
import { fmtMXN, fmtNum } from '@/utils/fmt'
import clsx from 'clsx'

/**
 * Paquetes de productos — combos fijos de catálogo con precio especial.
 *
 * El paquete es un constructo COMERCIAL: al capturarlo en un pedido se
 * explota en líneas componente con precio prorrateado (mismo % de descuento
 * implícito), el inventario se descuenta por componente y la utilidad por
 * producto sale del reporte existente sin cambios.
 */
export default function Paquetes() {
  const qc = useQueryClient()
  const [search, setSearch]   = useState('')
  const [showForm, setShowForm] = useState(false)   // true = nuevo
  const [editId, setEditId]   = useState(null)      // id = editar
  const [msg, setMsg]         = useState(null)

  const { data, isLoading } = useQuery({
    queryKey: ['product-bundles'],
    queryFn:  () => productsApi.listBundles({ limit: 100 }),
  })
  const bundles = data?.data || []

  const deleteMutation = useMutation({
    mutationFn: (id) => productsApi.deleteBundle(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['product-bundles'] })
      setMsg('Paquete eliminado. Los pedidos históricos no se tocan.')
    },
    onError: (e) => setMsg(e.response?.data?.error || 'No se pudo eliminar el paquete.'),
  })

  const filtered = useMemo(() => {
    if (!search.trim()) return bundles
    const q = search.trim().toLowerCase()
    return bundles.filter(b =>
      (b.name || '').toLowerCase().includes(q) ||
      (b.items_summary || '').toLowerCase().includes(q)
    )
  }, [bundles, search])

  const closeForm = () => { setShowForm(false); setEditId(null) }

  return (
    <div className="page-enter flex flex-col gap-4">
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold text-ink-primary">Paquetes de productos</h1>
          <p className="text-xs text-ink-muted mt-0.5">
            Combos con <strong className="text-ink-secondary">precio especial</strong>. Al venderlos,
            el precio se prorratea entre los productos (mismo % de descuento), el inventario se
            descuenta por producto y la utilidad sale en el reporte de ventas como siempre.
          </p>
        </div>
        <button onClick={() => setShowForm(true)} className="btn-primary btn-sm shrink-0">
          <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
            <path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/>
          </svg>
          Nuevo paquete
        </button>
      </div>

      {msg && (
        <div className="flex items-center gap-2 bg-status-info/10 border border-status-info/40 rounded-lg px-3 py-2">
          <p className="text-sm text-status-info flex-1">{msg}</p>
          <button onClick={() => setMsg(null)} className="text-status-info">
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12"/>
            </svg>
          </button>
        </div>
      )}

      {/* Búsqueda */}
      {bundles.length > 3 && (
        <div className="card p-3">
          <input className="input" placeholder="Buscar paquete o producto..."
            value={search} onChange={e => setSearch(e.target.value)} />
        </div>
      )}

      {/* Lista */}
      {isLoading ? (
        <div className="card flex justify-center py-16"><Spinner /></div>
      ) : filtered.length === 0 ? (
        <div className="card flex flex-col items-center gap-3 py-16 text-center px-4">
          <p className="text-sm font-medium text-ink-secondary">
            {search ? 'Sin resultados para la búsqueda' : 'Aún no tienes paquetes'}
          </p>
          {!search && (
            <>
              <p className="text-xs text-ink-muted max-w-md">
                Crea tu primer paquete: eliges los productos, sus cantidades y el precio especial
                del combo. Después lo agregas a cualquier pedido con un clic.
              </p>
              <button onClick={() => setShowForm(true)} className="btn-primary btn-sm">
                Crear primer paquete
              </button>
            </>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {filtered.map(b => (
            <div key={b.id} className={clsx('card p-4 flex flex-col gap-2', !b.is_active && 'opacity-60')}>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-semibold text-ink-primary flex items-center gap-2">
                    <span className="truncate">📦 {b.name}</span>
                    {!b.is_active && (
                      <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-surface-elevated text-ink-muted uppercase shrink-0">
                        Inactivo
                      </span>
                    )}
                  </p>
                  {b.description && <p className="text-xs text-ink-muted mt-0.5 line-clamp-2">{b.description}</p>}
                </div>
                <p className="font-mono font-semibold text-brand-300 whitespace-nowrap">
                  {fmtMXN(b.bundle_price, b.currency)}
                </p>
              </div>
              <p className="text-xs text-ink-secondary line-clamp-2">
                <span className="text-ink-muted">{b.items_count} producto{b.items_count === 1 ? '' : 's'}:</span>{' '}
                {b.items_summary || '—'}
              </p>
              <div className="flex items-center justify-end gap-1 pt-1 border-t border-line-subtle">
                <button onClick={() => setEditId(b.id)} className="btn-ghost btn-sm text-ink-muted hover:text-brand-300">
                  Editar
                </button>
                <button
                  onClick={() => {
                    if (confirm(`¿Eliminar el paquete "${b.name}"?\n\nLos pedidos ya capturados no se modifican.`)) {
                      deleteMutation.mutate(b.id)
                    }
                  }}
                  disabled={deleteMutation.isPending}
                  className="btn-ghost btn-sm text-ink-muted hover:text-status-danger">
                  Eliminar
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {(showForm || editId) && (
        <BundleFormModal
          bundleId={editId}
          onClose={closeForm}
          onSaved={() => {
            qc.invalidateQueries({ queryKey: ['product-bundles'] })
            setMsg(editId ? 'Paquete actualizado.' : 'Paquete creado.')
            closeForm()
          }}
        />
      )}
    </div>
  )
}

// ── Modal crear/editar paquete ───────────────────────────────────────────────
const EMPTY_ITEM = () => ({
  product: null,        // { id, label, basePrice, baseCurrency, baseUnit }
  pack_options: [],
  pack_option_id: null,
  pack_factor: 1,
  unit: '',
  quantity: '',
})

function BundleFormModal({ bundleId, onClose, onSaved }) {
  const isEdit = !!bundleId

  const [name, setName]               = useState('')
  const [description, setDescription] = useState('')
  const [price, setPrice]             = useState('')
  const [currency, setCurrency]       = useState('MXN')
  const [isActive, setIsActive]       = useState(true)
  const [items, setItems]             = useState([EMPTY_ITEM(), EMPTY_ITEM()])
  const [error, setError]             = useState(null)
  const [loaded, setLoaded]           = useState(!isEdit)

  // TC para mostrar la suma de lista cuando se mezclan monedas (solo display;
  // el prorrateo real lo calcula el backend al capturar el pedido)
  const { data: tcData } = useQuery({
    queryKey: ['exchange-rate-usd'],
    queryFn: () => exchangeRatesApi.getRate('USD'),
    staleTime: 5 * 60 * 1000,
  })
  const tc = parseFloat(tcData || 0)

  // Cargar el paquete en edición
  useQuery({
    queryKey: ['product-bundle', bundleId],
    queryFn: async () => {
      const b = await productsApi.getBundle(bundleId)
      setName(b.name || '')
      setDescription(b.description || '')
      setPrice(String(b.bundle_price ?? ''))
      setCurrency(b.currency || 'MXN')
      setIsActive(!!b.is_active)
      const mapped = await Promise.all((b.items || []).map(async (it) => {
        let opts = []
        try { opts = await productsApi.listPackOptions(it.product_id) } catch { /* noop */ }
        return {
          product: {
            id: it.product_id, label: it.product_name, sub: it.sku,
            basePrice: it.base_price, baseCurrency: it.base_currency || 'MXN',
            baseUnit: it.base_unit,
          },
          pack_options: opts || [],
          pack_option_id: it.pack_option_id || null,
          pack_factor: it.base_per_pack != null ? parseFloat(it.base_per_pack) : 1,
          unit: it.pack_unit || it.base_unit || '',
          quantity: String(it.quantity ?? ''),
        }
      }))
      setItems(mapped.length ? mapped : [EMPTY_ITEM(), EMPTY_ITEM()])
      setLoaded(true)
      return b
    },
    enabled: isEdit,
    staleTime: 0,
    refetchOnMount: 'always',
  })

  const searchProducts = useCallback(async (q) => {
    const res = await productsApi.list({ search: q, isActive: true, limit: 20 })
    return (res.data || res).map(p => ({
      id: p.id, label: p.name, sub: p.sku,
      basePrice: p.base_price, baseCurrency: p.base_currency || 'MXN',
      baseUnit: p.base_unit,
    }))
  }, [])

  async function handleProductSelect(idx, product) {
    setItems(prev => prev.map((it, i) => i !== idx ? it : {
      ...EMPTY_ITEM(), product, quantity: it.quantity, unit: product?.baseUnit || '',
    }))
    if (!product?.id) return
    try {
      const opts = await productsApi.listPackOptions(product.id)
      const def = (opts || []).find(o => o.is_default) || opts?.[0]
      setItems(prev => prev.map((it, i) => {
        if (i !== idx || it.product?.id !== product.id) return it
        return {
          ...it,
          pack_options: opts || [],
          pack_option_id: def?.id || null,
          pack_factor: def ? parseFloat(def.base_per_pack) : 1,
          unit: def?.pack_unit || product.baseUnit || '',
        }
      }))
    } catch { /* sin presentaciones: unidad base */ }
  }

  // ── Matemática en vivo: suma de lista + % de descuento implícito ──────────
  const math = useMemo(() => {
    const valid = items.filter(it => it.product?.id && parseFloat(it.quantity) > 0)
    let listTotal = 0
    let missingPrice = []
    let needsTc = false
    for (const it of valid) {
      const bp = it.product.basePrice != null ? parseFloat(it.product.basePrice) : null
      if (!(bp > 0)) { missingPrice.push(it.product.label); continue }
      let unitList = bp * (it.pack_factor || 1)
      const pc = it.product.baseCurrency || 'MXN'
      if (pc !== currency) {
        needsTc = true
        if (tc > 0) unitList = pc === 'USD' ? unitList * tc : unitList / tc
        else continue
      }
      listTotal += unitList * parseFloat(it.quantity)
    }
    const p = parseFloat(price || 0)
    const discountPct = listTotal > 0 && p > 0 ? (1 - p / listTotal) * 100 : null
    return { validCount: valid.length, listTotal, discountPct, missingPrice, needsTc }
  }, [items, price, currency, tc])

  const mutation = useMutation({
    mutationFn: () => {
      const validItems = items.filter(it => it.product?.id && parseFloat(it.quantity) > 0)
      if (!name.trim())                  throw new Error('Ponle nombre al paquete.')
      if (!(parseFloat(price) > 0))      throw new Error('Captura el precio del paquete.')
      if (validItems.length === 0)       throw new Error('Agrega al menos un producto con cantidad.')
      if (math.missingPrice.length) {
        throw new Error(`Sin precio de lista: ${math.missingPrice.join(', ')}. Captúralo en Productos primero — es la base del prorrateo.`)
      }
      const ids = validItems.map(it => it.product.id)
      if (new Set(ids).size !== ids.length) {
        throw new Error('Un producto no puede repetirse dentro del paquete.')
      }
      const body = {
        name: name.trim(),
        description: description.trim() || null,
        bundlePrice: parseFloat(price),
        currency,
        items: validItems.map(it => ({
          productId:    it.product.id,
          packOptionId: it.pack_option_id || null,
          quantity:     parseFloat(it.quantity),
        })),
      }
      return isEdit
        ? productsApi.updateBundle(bundleId, { ...body, isActive })
        : productsApi.createBundle(body)
    },
    onSuccess: onSaved,
    onError: (e) => setError(e.response?.data?.error || e.message),
  })

  const submit = (e) => { e.preventDefault(); setError(null); mutation.mutate() }

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="card w-full max-w-2xl p-0 max-h-[92vh] flex flex-col" onClick={e => e.stopPropagation()}>
        <form onSubmit={submit} className="flex flex-col min-h-0">
          {/* Header */}
          <div className="px-5 py-4 border-b border-line-subtle flex items-center justify-between shrink-0">
            <div>
              <h2 className="text-base font-semibold text-ink-primary">
                {isEdit ? 'Editar paquete' : 'Nuevo paquete'}
              </h2>
              <p className="text-xs text-ink-muted mt-0.5">
                Productos + cantidades + precio especial. El descuento se prorratea solo.
              </p>
            </div>
            <button type="button" onClick={onClose} className="btn-ghost btn-icon btn-sm">
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12"/>
              </svg>
            </button>
          </div>

          {!loaded ? (
            <div className="flex justify-center py-16"><Spinner /></div>
          ) : (
          <div className="p-5 flex flex-col gap-4 overflow-y-auto">
            {/* Datos generales */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="sm:col-span-2">
                <label className="label">Nombre del paquete <span className="text-status-danger">*</span></label>
                <input className="input" placeholder="Ej. Kit de empaque chico"
                  value={name} onChange={e => setName(e.target.value)} autoFocus={!isEdit} />
              </div>
              <div>
                <label className="label">Precio del paquete <span className="text-status-danger">*</span></label>
                <input type="number" step="0.01" min="0" inputMode="decimal"
                  className="input text-right font-mono" placeholder="0.00"
                  value={price} onChange={e => setPrice(e.target.value)} />
              </div>
              <div>
                <label className="label">Moneda</label>
                <select className="select" value={currency} onChange={e => setCurrency(e.target.value)}>
                  <option value="MXN">MXN — Peso mexicano</option>
                  <option value="USD">USD — Dólar</option>
                </select>
                <p className="text-[10px] text-ink-muted mt-1">
                  El paquete solo se puede agregar a pedidos en esta moneda.
                </p>
              </div>
              <div className="sm:col-span-2">
                <label className="label">Descripción (opcional)</label>
                <input className="input" placeholder="Qué incluye, condiciones..."
                  value={description} onChange={e => setDescription(e.target.value)} />
              </div>
              {isEdit && (
                <label className="label flex items-center gap-2 cursor-pointer select-none sm:col-span-2">
                  <input type="checkbox" className="w-4 h-4 accent-brand-600 rounded"
                    checked={isActive} onChange={e => setIsActive(e.target.checked)} />
                  <span>Paquete activo (disponible para venderse)</span>
                </label>
              )}
            </div>

            {/* Componentes */}
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <p className="text-xs font-bold text-brand-300 uppercase tracking-wider">Productos del paquete</p>
                <button type="button" onClick={() => setItems(p => [...p, EMPTY_ITEM()])}
                  className="btn-ghost btn-sm text-brand-300">+ Agregar producto</button>
              </div>

              {items.map((it, idx) => {
                const bp = it.product?.basePrice != null ? parseFloat(it.product.basePrice) : null
                const noPrice = it.product && !(bp > 0)
                return (
                  <div key={idx} className={clsx('border rounded-xl p-3 flex flex-col gap-2',
                    noPrice ? 'border-status-danger/50 bg-status-danger/5' : 'border-line-subtle')}>
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex-1 min-w-0">
                        <Autocomplete
                          value={it.product}
                          onChange={p => handleProductSelect(idx, p)}
                          onSearch={searchProducts}
                          placeholder="Buscar producto..."
                        />
                      </div>
                      {items.length > 1 && (
                        <button type="button" onClick={() => setItems(p => p.filter((_, i) => i !== idx))}
                          className="text-xs text-red-400 hover:text-status-danger shrink-0">Quitar</button>
                      )}
                    </div>
                    {it.product && (
                      <div className="grid grid-cols-12 gap-2 items-end">
                        <div className="col-span-5 sm:col-span-4">
                          <label className="label">Cantidad por paquete</label>
                          <input type="number" step="0.001" min="0" inputMode="decimal"
                            className="input" placeholder="0"
                            value={it.quantity}
                            onChange={e => setItems(prev => prev.map((x, i) => i === idx ? { ...x, quantity: e.target.value } : x))} />
                        </div>
                        <div className="col-span-7 sm:col-span-4">
                          <label className="label">Presentación</label>
                          {it.pack_options.length > 0 ? (
                            <select className="select" value={it.pack_option_id || ''}
                              onChange={e => {
                                const opt = it.pack_options.find(o => o.id === e.target.value)
                                if (!opt) return
                                setItems(prev => prev.map((x, i) => i === idx ? {
                                  ...x, pack_option_id: opt.id,
                                  pack_factor: parseFloat(opt.base_per_pack),
                                  unit: opt.pack_unit,
                                } : x))
                              }}>
                              {it.pack_options.map(opt => (
                                <option key={opt.id} value={opt.id}>
                                  {opt.pack_unit}{Number(opt.base_per_pack) !== 1 ? ` (×${opt.base_per_pack})` : ''}
                                </option>
                              ))}
                            </select>
                          ) : (
                            <input className="input" value={it.unit} disabled />
                          )}
                        </div>
                        <div className="col-span-12 sm:col-span-4 text-right">
                          {noPrice ? (
                            <p className="text-[11px] text-status-danger font-medium">
                              Sin precio de lista — captúralo en Productos
                            </p>
                          ) : (
                            <p className="text-[11px] text-ink-muted">
                              Lista: <span className="font-mono">{fmtMXN(bp * (it.pack_factor || 1), it.product.baseCurrency)}</span>
                              {' /'}{it.unit || 'u'}
                            </p>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>

            {/* Matemática en vivo */}
            {math.validCount > 0 && (
              <div className="bg-surface-elevated/60 border border-line-subtle rounded-xl p-4 flex flex-col gap-1.5">
                <div className="flex justify-between text-xs text-ink-muted">
                  <span>Suma de precios de lista{math.needsTc && tc > 0 ? ` (TC $${fmtNum(tc, 4)})` : ''}</span>
                  <span className="font-mono">{math.listTotal > 0 ? fmtMXN(math.listTotal, currency) : '—'}</span>
                </div>
                <div className="flex justify-between text-base font-semibold text-ink-primary">
                  <span>Precio del paquete</span>
                  <span className="font-mono text-brand-300">{parseFloat(price) > 0 ? fmtMXN(parseFloat(price), currency) : '—'}</span>
                </div>
                {math.discountPct != null && (
                  <div className={clsx('flex justify-between text-sm font-medium',
                    math.discountPct >= 0 ? 'text-status-success' : 'text-status-warning')}>
                    <span>{math.discountPct >= 0 ? 'Descuento implícito' : 'Sobreprecio vs lista'}</span>
                    <span className="font-mono">{Math.abs(math.discountPct).toFixed(1)}%</span>
                  </div>
                )}
                {math.needsTc && !(tc > 0) && (
                  <p className="text-[11px] text-status-warning">
                    Hay productos en otra moneda y no hay tipo de cambio cargado — la suma de lista es parcial.
                  </p>
                )}
                <p className="text-[11px] text-ink-muted mt-1">
                  Al venderlo, cada producto se registra con su parte del precio (mismo % para todos)
                  — así la utilidad por producto sale correcta en los reportes.
                </p>
              </div>
            )}

            {error && <p className="field-error">{error}</p>}
          </div>
          )}

          {/* Footer */}
          <div className="px-5 py-3 border-t border-line-subtle flex justify-end gap-2 shrink-0">
            <button type="button" onClick={onClose} className="btn-secondary btn-sm">Cancelar</button>
            <button type="submit" disabled={mutation.isPending || !loaded} className="btn-primary btn-sm">
              {mutation.isPending ? <Spinner size="sm" /> : (isEdit ? 'Guardar cambios' : 'Crear paquete')}
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body
  )
}
