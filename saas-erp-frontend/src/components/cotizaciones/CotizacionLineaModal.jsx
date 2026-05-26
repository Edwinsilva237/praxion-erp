import { useState, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { quotationsApi } from '@/api/quotations'
import { productsApi } from '@/api/products'
import Autocomplete from '@/components/ui/Autocomplete'
import Spinner from '@/components/ui/Spinner'
import { ProductImageThumb } from '@/components/productos/ProductImageThumb'
import { fmtMXN } from '@/utils/fmt'

/**
 * Modal compacto para agregar o editar una línea de cotización (solo draft).
 *
 * Sin lógica de presentaciones (pack_options) ni precio sugerido — esos se
 * resuelven cuando la cotización se convierta a pedido.
 *
 * Props:
 *   quotation — { id, currency }
 *   line      — null para crear, o la línea existente para editar
 *   onClose, onSaved
 */
export function CotizacionLineaModal({ quotation, line, onClose, onSaved }) {
  const qc = useQueryClient()
  const isEdit = !!line

  const [product, setProduct]         = useState(() => line ? {
    id: line.product_id, label: line.product_name, sku: line.sku, unit: line.unit,
    image_attachment_id: line.image_attachment_id || null,
  } : null)
  const [quantity, setQuantity]       = useState(line?.quantity?.toString() || '')
  const [unit, setUnit]               = useState(line?.unit || 'paquete')
  const [unitPrice, setUnitPrice]     = useState(line?.unit_price?.toString() || '')
  const [discountPct, setDiscountPct] = useState(line?.discount_pct?.toString() || '')
  const [notes, setNotes]             = useState(line?.notes || '')
  const [error, setError]             = useState(null)

  const searchProducts = useCallback(async (q) => {
    const res = await productsApi.list({ search: q, limit: 20 })
    return (res.data || res).map(p => ({
      id: p.id, label: p.name, sub: p.sku || '',
      sku: p.sku, unit: p.unit || 'paquete',
      catalog_price: p.unit_price || p.price || null,
      image_attachment_id: p.image_attachment_id || null,
    }))
  }, [])

  function handleProductChange(p) {
    setProduct(p)
    if (!p) return
    setUnit(p.unit || 'paquete')
    if (!isEdit && p.catalog_price && !unitPrice) {
      setUnitPrice(String(p.catalog_price))
    }
  }

  const mutation = useMutation({
    mutationFn: () => {
      if (!product?.id)                              throw new Error('Selecciona un producto.')
      if (!quantity || parseFloat(quantity) <= 0)    throw new Error('Captura una cantidad válida.')
      if (!unitPrice || parseFloat(unitPrice) <= 0)  throw new Error('Captura un precio unitario válido.')

      const body = {
        productId:   product.id,
        quantity:    parseFloat(quantity),
        unit:        unit || 'paquete',
        unitPrice:   parseFloat(unitPrice),
        discountPct: parseFloat(discountPct || 0),
        notes:       notes || null,
      }
      return isEdit
        ? quotationsApi.updateLine(quotation.id, line.id, body)
        : quotationsApi.addLine(quotation.id, body)
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['quotation', quotation.id] })
      qc.invalidateQueries({ queryKey: ['quotations'] })
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
        </div>

        <div className="grid grid-cols-12 gap-2">
          <div className="col-span-7">
            <label className="label">Cantidad <span className="text-status-danger">*</span></label>
            <input type="number" step="0.001" min="0" inputMode="decimal" value={quantity}
              onChange={e => setQuantity(e.target.value)}
              className="input text-base" placeholder="0" autoFocus={!isEdit} />
          </div>
          <div className="col-span-5">
            <label className="label">Unidad</label>
            <input className="input" value={unit} onChange={e => setUnit(e.target.value)} />
          </div>
          <div className="col-span-7">
            <label className="label">P. Unit. <span className="text-status-danger">*</span></label>
            <input type="number" step="0.0001" min="0" inputMode="decimal" value={unitPrice}
              onChange={e => setUnitPrice(e.target.value)}
              className="input text-base" placeholder="0.0000" />
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
          <input className="input" placeholder="Opcional" value={notes}
            onChange={e => setNotes(e.target.value)} />
        </div>

        <div className="bg-surface-elevated/40 rounded-lg px-3 py-2 flex justify-between items-center">
          <span className="text-xs text-ink-muted uppercase tracking-wide">Subtotal</span>
          <span className="font-mono font-semibold text-brand-300">{fmtMXN(subtotal, quotation.currency)}</span>
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
