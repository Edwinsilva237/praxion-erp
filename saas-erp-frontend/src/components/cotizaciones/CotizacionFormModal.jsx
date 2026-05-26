import { useState, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { quotationsApi } from '@/api/quotations'
import { partnersApi } from '@/api/partners'
import { productsApi } from '@/api/products'
import Autocomplete from '@/components/ui/Autocomplete'
import Spinner from '@/components/ui/Spinner'
import { ProductImageThumb } from '@/components/productos/ProductImageThumb'
import { fmtMXN } from '@/utils/fmt'
import clsx from 'clsx'

const EMPTY_LINE = () => ({
  product: null,   // { id, label, sku, image_attachment_id }
  quantity: '',
  unit: 'paquete',
  unit_price: '',
  discount_pct: '',
  notes: '',
})

function defaultValidUntil() {
  // Vigencia por defecto: 30 días.
  const d = new Date()
  d.setDate(d.getDate() + 30)
  return d.toISOString().slice(0, 10)
}

export function CotizacionFormModal({ onClose, onCreated }) {
  const qc = useQueryClient()

  const [partner, setPartner]         = useState(null)
  const [validUntil, setValidUntil]   = useState(defaultValidUntil())
  const [notes, setNotes]             = useState('')
  const [lines, setLines]             = useState([EMPTY_LINE()])
  const [error, setError]             = useState(null)

  const searchPartners = useCallback(async (q) => {
    const res = await partnersApi.list({ search: q, type: 'customer', limit: 20 })
    return (res.data || res).map(p => ({
      id: p.id, label: p.name, sub: p.rfc || '',
      email: p.email || '',
    }))
  }, [])

  const searchProducts = useCallback(async (q) => {
    const res = await productsApi.list({ search: q, limit: 20 })
    return (res.data || res).map(p => ({
      id: p.id, label: p.name, sub: p.sku || '',
      sku: p.sku, unit: p.unit || 'paquete',
      catalog_price: p.unit_price || p.price || null,
      image_attachment_id: p.image_attachment_id || null,
    }))
  }, [])

  function updateLine(idx, patch) {
    setLines(prev => prev.map((l, i) => i === idx ? { ...l, ...patch } : l))
  }

  function selectProductForLine(idx, product) {
    updateLine(idx, {
      product,
      unit: product?.unit || 'paquete',
      // Si trae precio de catálogo y la línea está vacía, lo prellena.
      unit_price: product?.catalog_price && !lines[idx].unit_price
        ? String(product.catalog_price)
        : lines[idx].unit_price,
    })
  }

  function addLine() {
    setLines(prev => [...prev, EMPTY_LINE()])
  }

  function removeLine(idx) {
    setLines(prev => prev.length === 1 ? prev : prev.filter((_, i) => i !== idx))
  }

  const subtotal = lines.reduce((s, l) => {
    const qty = parseFloat(l.quantity || 0)
    const price = parseFloat(l.unit_price || 0)
    const disc = parseFloat(l.discount_pct || 0)
    return s + qty * price * (1 - disc / 100)
  }, 0)

  const createMut = useMutation({
    mutationFn: () => quotationsApi.create({
      partnerId: partner.id,
      currency: 'MXN',
      validUntil: validUntil || null,
      notes:      notes || null,
      lines: lines.map(l => ({
        productId:   l.product.id,
        quantity:    parseFloat(l.quantity),
        unit:        l.unit || 'paquete',
        unitPrice:   parseFloat(l.unit_price),
        discountPct: parseFloat(l.discount_pct || 0),
        notes:       l.notes || null,
      })),
    }),
    onSuccess: (q) => {
      qc.invalidateQueries({ queryKey: ['quotations'] })
      onCreated?.(q)
    },
    onError: (e) => setError(e.response?.data?.error || e.message || 'Error al crear cotización'),
  })

  function handleSubmit(e) {
    e.preventDefault()
    setError(null)
    if (!partner)          return setError('Selecciona un cliente.')
    if (lines.length === 0) return setError('Agrega al menos una línea.')
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i]
      if (!l.product)      return setError(`Línea ${i + 1}: selecciona un producto.`)
      if (!l.quantity)     return setError(`Línea ${i + 1}: cantidad requerida.`)
      if (!l.unit_price)   return setError(`Línea ${i + 1}: precio requerido.`)
    }
    createMut.mutate()
  }

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40 p-4">
      <div className="card w-full max-w-3xl p-5 max-h-[92vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-lg font-semibold text-ink-primary">Nueva cotización</h2>
            <p className="text-xs text-ink-muted mt-0.5">
              Se crea en borrador. Después podrás enviarla, aceptarla o convertirla a pedido.
            </p>
          </div>
          <button type="button" onClick={onClose} className="btn-ghost btn-icon">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12"/>
            </svg>
          </button>
        </div>

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
                placeholder="Buscar cliente..." />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="label">Vigencia hasta</label>
                <input type="date" className="input" value={validUntil}
                  onChange={e => setValidUntil(e.target.value)} />
                <p className="text-[11px] text-ink-muted mt-1">
                  Si pasa sin aceptación, la cotización se marca como expirada.
                </p>
              </div>
              <div>
                <label className="label">Notas</label>
                <input className="input" placeholder="Opcional — condiciones, observaciones..."
                  value={notes} onChange={e => setNotes(e.target.value)} />
              </div>
            </div>
          </div>

          {/* Artículos */}
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <p className="text-xs font-bold text-brand-300 uppercase tracking-wider">Artículos</p>
              <button type="button" onClick={addLine}
                className="text-sm font-medium text-brand-300 hover:text-brand-300">
                + Agregar artículo
              </button>
            </div>

            {lines.map((l, idx) => {
              const qty = parseFloat(l.quantity || 0)
              const price = parseFloat(l.unit_price || 0)
              const disc = parseFloat(l.discount_pct || 0)
              const lineSubtotal = qty * price * (1 - disc / 100)
              return (
                <div key={idx} className="bg-surface-elevated/60 border border-line-subtle rounded-xl p-4 flex flex-col gap-3">
                  <div className="flex items-center justify-between">
                    <p className="text-xs font-semibold text-ink-secondary">Línea {idx + 1}</p>
                    {lines.length > 1 && (
                      <button type="button" onClick={() => removeLine(idx)}
                        className="text-xs text-status-danger hover:text-status-danger font-medium">
                        Eliminar
                      </button>
                    )}
                  </div>

                  <div>
                    <label className="label flex items-center justify-between gap-2">
                      <span>Producto <span className="text-status-danger">*</span></span>
                      {l.product?.id && (
                        <ProductImageThumb
                          productId={l.product.id}
                          imageAttachmentId={l.product.image_attachment_id}
                          caption={l.product.label}
                          size="md" />
                      )}
                    </label>
                    <Autocomplete
                      value={l.product}
                      onChange={(p) => selectProductForLine(idx, p)}
                      onSearch={searchProducts}
                      placeholder="Buscar producto..." />
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    <div>
                      <label className="label">Cantidad <span className="text-status-danger">*</span></label>
                      <input type="number" step="0.001" min="0" inputMode="decimal"
                        value={l.quantity}
                        onChange={e => updateLine(idx, { quantity: e.target.value })}
                        className="input" placeholder="0" />
                    </div>
                    <div>
                      <label className="label">P. Unit. <span className="text-status-danger">*</span></label>
                      <input type="number" step="0.0001" min="0" inputMode="decimal"
                        value={l.unit_price}
                        onChange={e => updateLine(idx, { unit_price: e.target.value })}
                        className="input" placeholder="0.0000" />
                    </div>
                    <div>
                      <label className="label">Desc. %</label>
                      <input type="number" step="0.1" min="0" max="100" inputMode="decimal"
                        value={l.discount_pct}
                        onChange={e => updateLine(idx, { discount_pct: e.target.value })}
                        className="input" placeholder="0" />
                    </div>
                  </div>

                  <div>
                    <label className="label">Notas de la línea</label>
                    <input className="input" placeholder="Opcional"
                      value={l.notes}
                      onChange={e => updateLine(idx, { notes: e.target.value })} />
                  </div>

                  {lineSubtotal > 0 && (
                    <div className="flex justify-between items-center bg-surface-primary border border-line-subtle rounded-lg px-3 py-2">
                      <span className="text-xs text-ink-muted uppercase tracking-wide">Subtotal línea</span>
                      <span className="font-mono font-semibold text-brand-300">
                        {fmtMXN(lineSubtotal, 'MXN')}
                      </span>
                    </div>
                  )}
                </div>
              )
            })}
          </div>

          {/* Total */}
          {subtotal > 0 && (
            <div className="bg-surface-elevated/60 border border-line-subtle rounded-xl p-4 flex flex-col gap-2.5">
              <div className="flex justify-between text-base font-semibold text-ink-primary">
                <span>Total cotización</span>
                <span className="font-mono text-brand-300">{fmtMXN(subtotal, 'MXN')}</span>
              </div>
              <p className="flex items-start gap-1.5 text-xs text-status-warning bg-status-warning/10 border border-status-warning/40 rounded-md px-2.5 py-1.5">
                <svg className="w-3.5 h-3.5 shrink-0 mt-0.5" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clipRule="evenodd"/>
                </svg>
                <span>El IVA (16%) se calculará automáticamente al facturar el pedido.</span>
              </p>
            </div>
          )}

          {error && (
            <div className="flex items-start gap-2 bg-status-danger/10 border border-status-danger/40 rounded-lg px-3 py-2">
              <p className="text-sm text-status-danger">{error}</p>
            </div>
          )}

          <div className="flex justify-end gap-2 sticky bottom-0 bg-surface-primary pt-2">
            <button type="button" onClick={onClose} className="btn-secondary">
              Cancelar
            </button>
            <button type="submit" disabled={createMut.isPending}
              className={clsx('btn-primary', createMut.isPending && 'opacity-60 cursor-wait')}>
              {createMut.isPending ? <Spinner size="sm" /> : 'Crear cotización'}
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body
  )
}
