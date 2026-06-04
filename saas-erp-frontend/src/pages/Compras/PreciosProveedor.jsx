import { useState, useCallback } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { createPortal } from 'react-dom'
import { purchasesApi } from '@/api/purchases'
import { partnersApi } from '@/api/partners'
import { rawMaterialsApi } from '@/api/rawMaterials'
import { productsApi } from '@/api/products'
import Autocomplete from '@/components/ui/Autocomplete'
import Spinner from '@/components/ui/Spinner'
import { fmtMXN } from '@/utils/fmt'
import clsx from 'clsx'

// De dónde salió el precio vigente.
function SourceBadge({ source }) {
  const map = {
    manual:    ['Negociado',     'bg-status-success/15 text-status-success'],
    po:        ['Última OC',     'bg-status-info/15 text-status-info'],
    receipt:   ['Última compra', 'bg-status-info/15 text-status-info'],
  }
  const f = map[source] || ['—', 'bg-surface-elevated/80 text-ink-muted']
  return (
    <span className={clsx('text-[10px] font-bold px-1.5 py-0.5 rounded-full uppercase tracking-wide', f[1])}>
      {f[0]}
    </span>
  )
}

export default function PreciosProveedor() {
  const qc = useQueryClient()
  const [supplier, setSupplier] = useState(null)
  const [showAdd, setShowAdd]   = useState(false)
  const [editRow, setEditRow]   = useState(null)
  const [msg, setMsg]           = useState(null)

  const searchSuppliers = useCallback(async (q) => {
    const res = await partnersApi.list({ search: q, role: 'supplier', limit: 20 })
    return (res.data || res).map(p => ({ id: p.id, label: p.name, type: p.type, sub: [p.rfc, p.type === 'both' ? 'Ambos' : null].filter(Boolean).join(' · ') }))
  }, [])

  const { data, isLoading } = useQuery({
    queryKey: ['supplier-prices', supplier?.id],
    queryFn:  () => purchasesApi.listSupplierPrices({ supplierId: supplier.id }),
    enabled:  !!supplier?.id,
  })
  const prices = data?.data || []

  const invalidate = () => qc.invalidateQueries({ queryKey: ['supplier-prices', supplier?.id] })

  const deleteMutation = useMutation({
    mutationFn: (id) => purchasesApi.deleteSupplierPrice(id),
    onSuccess: () => { invalidate(); setMsg('Precio eliminado.') },
    onError: (e) => setMsg(e.response?.data?.error || 'No se pudo eliminar.'),
  })

  return (
    <div className="page-enter flex flex-col gap-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold text-ink-primary">Precios por proveedor</h1>
          <p className="text-xs text-ink-muted mt-0.5">
            <strong className="text-ink-secondary">Precio de compra</strong> (lo que te cobra el proveedor).
            Precios negociados y aprendidos por proveedor. Se precargan al crear la orden de compra.
            El precio <strong>negociado</strong> gana sobre el aprendido automáticamente de OC/recepciones.
          </p>
        </div>
        {supplier && (
          <button onClick={() => setShowAdd(true)} className="btn-primary btn-sm">
            <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>
            Agregar precio
          </button>
        )}
      </div>

      {msg && (
        <div className="flex items-center gap-2 bg-status-success/10 border border-status-success/40 rounded-lg px-3 py-2">
          <p className="text-sm text-status-success flex-1">{msg}</p>
          <button onClick={() => setMsg(null)} className="text-status-success">✕</button>
        </div>
      )}

      <div className="card p-4">
        <label className="label">Proveedor</label>
        <div className="sm:max-w-md">
          <Autocomplete value={supplier} onChange={setSupplier} onSearch={searchSuppliers}
            placeholder="Buscar proveedor..." />
        </div>
        {!supplier && (
          <p className="text-xs text-ink-muted mt-2">
            Elige un proveedor para ver y editar sus precios por artículo.
          </p>
        )}
        {supplier?.type === 'both' && (
          <div className="text-xs bg-brand-500/10 border border-brand-500/30 rounded-lg px-3 py-2 text-ink-secondary mt-2">
            <span className="font-semibold text-brand-300">Ambos</span> — este socio es proveedor y cliente.
            Aquí defines su <strong>precio de compra</strong>; su precio de venta se gestiona en{' '}
            <strong>Comercial → Precios por cliente</strong>.
          </div>
        )}
      </div>

      {supplier && (
        <div className="card overflow-hidden">
          {isLoading ? (
            <div className="flex justify-center py-16"><Spinner /></div>
          ) : prices.length === 0 ? (
            <div className="flex flex-col items-center gap-3 py-16 text-center">
              <p className="text-sm font-medium text-ink-secondary">Este proveedor no tiene precios registrados</p>
              <button onClick={() => setShowAdd(true)} className="btn-primary btn-sm">Agregar primer precio</button>
            </div>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Artículo</th>
                  <th>Clave proveedor</th>
                  <th className="text-right">Precio</th>
                  <th>Origen</th>
                  <th className="text-right">Mín. orden</th>
                  <th className="text-right">Lead time</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {prices.map(p => (
                  <tr key={p.id}>
                    <td>
                      <p className="font-medium text-ink-primary">{p.item_name}</p>
                      <p className="text-[10px] text-ink-muted">
                        {p.item_type === 'raw_material' ? 'Materia prima' : 'Producto'}
                        {p.item_sku && <span className="font-mono"> · {p.item_sku}</span>}
                      </p>
                    </td>
                    <td className="font-mono text-xs text-ink-secondary">{p.supplier_sku || '—'}</td>
                    <td className="text-right font-mono tabular-nums font-medium">{fmtMXN(p.unit_price, p.currency)}</td>
                    <td><SourceBadge source={p.source} /></td>
                    <td className="text-right font-mono tabular-nums text-xs text-ink-muted">
                      {p.min_order_qty != null ? Number(p.min_order_qty).toLocaleString('es-MX') : '—'}
                    </td>
                    <td className="text-right text-xs text-ink-muted">
                      {p.lead_time_days != null ? `${p.lead_time_days} d` : '—'}
                    </td>
                    <td>
                      <div className="flex items-center justify-end gap-1">
                        <button onClick={() => setEditRow(p)} title="Editar"
                          className="btn-ghost btn-icon btn-sm text-ink-muted hover:text-brand-300">
                          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                          </svg>
                        </button>
                        <button onClick={() => { if (confirm(`Eliminar el precio de ${p.item_name}?`)) deleteMutation.mutate(p.id) }}
                          title="Eliminar"
                          className="btn-ghost btn-icon btn-sm text-ink-muted hover:text-status-danger">
                          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12"/>
                          </svg>
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {(showAdd || editRow) && supplier && (
        <PriceModal
          supplierId={supplier.id}
          row={editRow}
          onClose={() => { setShowAdd(false); setEditRow(null) }}
          onSaved={() => { invalidate(); setMsg(editRow ? 'Precio actualizado.' : 'Precio agregado.'); setShowAdd(false); setEditRow(null) }}
        />
      )}
    </div>
  )
}

// ── Modal: agregar / editar precio negociado ────────────────────────────────
function PriceModal({ supplierId, row, onClose, onSaved }) {
  const isEdit = !!row
  const [itemType, setItemType] = useState(row?.item_type || 'raw_material')
  const [item, setItem]         = useState(row ? { id: row.item_id, label: row.item_name, sub: row.item_sku } : null)
  const [unitPrice, setUnitPrice]       = useState(row ? String(row.unit_price) : '')
  const [currency, setCurrency]         = useState(row?.currency || 'MXN')
  const [supplierSku, setSupplierSku]   = useState(row?.supplier_sku || '')
  const [minOrderQty, setMinOrderQty]   = useState(row?.min_order_qty != null ? String(row.min_order_qty) : '')
  const [leadTimeDays, setLeadTimeDays] = useState(row?.lead_time_days != null ? String(row.lead_time_days) : '')
  const [notes, setNotes]               = useState(row?.notes || '')
  const [error, setError]               = useState(null)

  const searchItems = useCallback(async (q) => {
    if (itemType === 'raw_material') {
      const res = await rawMaterialsApi.list({ search: q, limit: 20 })
      return (res.data || res).map(r => ({ id: r.id, label: r.name, sub: 'Materia prima' }))
    }
    const res = await productsApi.list({ search: q, limit: 20 })
    return (res.data || res).map(p => ({ id: p.id, label: p.name, sub: p.sku || '' }))
  }, [itemType])

  const mutation = useMutation({
    mutationFn: () => purchasesApi.upsertSupplierPrice({
      supplierId, itemType, itemId: item.id,
      unitPrice: parseFloat(unitPrice), currency,
      supplierSku:  supplierSku.trim() || null,
      minOrderQty:  minOrderQty  ? parseFloat(minOrderQty)  : null,
      leadTimeDays: leadTimeDays ? parseInt(leadTimeDays, 10) : null,
      notes: notes.trim() || null,
    }),
    onSuccess: onSaved,
    onError: (e) => setError(e.response?.data?.error || e.message),
  })

  const submit = (e) => {
    e.preventDefault(); setError(null)
    if (!item) return setError('Selecciona un artículo.')
    if (unitPrice === '' || parseFloat(unitPrice) < 0) return setError('Precio inválido.')
    mutation.mutate()
  }

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="bg-surface-primary rounded-xl shadow-card w-full max-w-md max-h-[92vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <form onSubmit={submit}>
          <div className="px-5 py-4 border-b border-line-subtle flex items-center justify-between">
            <h2 className="text-base font-semibold text-ink-primary">
              {isEdit ? 'Editar precio del proveedor' : 'Agregar precio del proveedor'}
            </h2>
            <button type="button" onClick={onClose} className="btn-ghost btn-icon btn-sm">
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12"/>
              </svg>
            </button>
          </div>
          <div className="p-5 space-y-3">
            {!isEdit && (
              <div>
                <label className="label">Tipo de artículo</label>
                <div className="flex gap-2">
                  {[['raw_material', 'Materia prima'], ['product', 'Producto']].map(([v, l]) => (
                    <button key={v} type="button"
                      onClick={() => { setItemType(v); setItem(null) }}
                      className={clsx('btn-sm flex-1 justify-center', itemType === v ? 'btn-primary' : 'btn-secondary')}>
                      {l}
                    </button>
                  ))}
                </div>
              </div>
            )}
            <div>
              <label className="label">Artículo</label>
              {isEdit ? (
                <p className="input bg-surface-elevated/40 text-ink-secondary cursor-default">{item?.label}</p>
              ) : (
                <Autocomplete value={item} onChange={setItem} onSearch={searchItems}
                  placeholder={`Buscar ${itemType === 'raw_material' ? 'materia prima' : 'producto'}...`} />
              )}
            </div>
            <div className="grid grid-cols-[1fr_auto] gap-2">
              <div>
                <label className="label">Precio unitario</label>
                <input type="number" step="0.0001" min="0" value={unitPrice}
                  onChange={e => setUnitPrice(e.target.value)} className="input text-right font-mono" autoFocus />
              </div>
              <div>
                <label className="label">Moneda</label>
                <select value={currency} onChange={e => setCurrency(e.target.value)} className="select w-24">
                  <option value="MXN">MXN</option>
                  <option value="USD">USD</option>
                </select>
              </div>
            </div>
            <div>
              <label className="label">Clave del proveedor <span className="text-ink-muted font-normal text-[10px]">(opcional)</span></label>
              <input className="input font-mono" value={supplierSku} onChange={e => setSupplierSku(e.target.value)}
                placeholder="Código con el que el proveedor identifica el artículo" />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="label">Mín. de orden <span className="text-ink-muted font-normal text-[10px]">(opcional)</span></label>
                <input type="number" step="0.001" min="0" className="input" value={minOrderQty}
                  onChange={e => setMinOrderQty(e.target.value)} placeholder="0" />
              </div>
              <div>
                <label className="label">Lead time (días) <span className="text-ink-muted font-normal text-[10px]">(opcional)</span></label>
                <input type="number" step="1" min="0" className="input" value={leadTimeDays}
                  onChange={e => setLeadTimeDays(e.target.value)} placeholder="0" />
              </div>
            </div>
            <div>
              <label className="label">Notas <span className="text-ink-muted font-normal text-[10px]">(opcional)</span></label>
              <textarea className="input h-16 resize-none" value={notes} onChange={e => setNotes(e.target.value)}
                placeholder="Acuerdo, condiciones, vigencia..." />
            </div>
            {error && <p className="text-xs text-status-danger">{error}</p>}
          </div>
          <div className="px-5 py-3 border-t border-line-subtle flex justify-end gap-2">
            <button type="button" onClick={onClose} className="btn-ghost btn-sm">Cancelar</button>
            <button type="submit" disabled={mutation.isPending} className="btn-primary btn-sm">
              {mutation.isPending ? 'Guardando…' : (isEdit ? 'Guardar' : 'Agregar')}
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body
  )
}
