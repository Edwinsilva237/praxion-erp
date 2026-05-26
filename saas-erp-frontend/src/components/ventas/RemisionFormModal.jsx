import { useState, useMemo, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { useQuery, useMutation, useQueryClient, useQueries } from '@tanstack/react-query'
import { salesApi } from '@/api/sales'
import { warehousesApi } from '@/api/warehouses'
import { processConfigApi } from '@/api/processConfig'
import { productLotsApi } from '@/api/productLots'
import Spinner from '@/components/ui/Spinner'
import { ProductImageThumb } from '@/components/productos/ProductImageThumb'
import { fmtMXN, fmtDate, fmtNum } from '@/utils/fmt'
import clsx from 'clsx'

/**
 * Modal de captura de remisión.
 *
 * Dos modos:
 *   - prefilledOrderId: modo single — un solo pedido pre-seleccionado.
 *   - Sin prefill: modo multi — el operador elige cliente y consolida 1..N
 *     pedidos de ese cliente con saldo pendiente. Misma moneda y mismo
 *     domicilio son obligatorios entre los pedidos seleccionados.
 */
export function RemisionFormModal({ onClose, onCreated, prefilledOrderId = null }) {
  const qc = useQueryClient()

  const [selectedPartnerId, setSelectedPartnerId] = useState('')
  const [selectedOrderIds, setSelectedOrderIds] = useState(prefilledOrderId ? [prefilledOrderId] : [])
  // qty, warehouse y lote se guardan por sales_order_line_id (clave única global)
  const [lineQtys, setLineQtys] = useState({})
  const [lineWarehouses, setLineWarehouses] = useState({})
  const [lineLots, setLineLots] = useState({}) // {salesOrderLineId: productLotId}
  const [notes, setNotes] = useState('')
  const [error, setError] = useState(null)

  // Flags del tenant — controlan si se pide lote al despachar.
  const { data: tenantConfig } = useQuery({
    queryKey: ['tenant-process-config'],
    queryFn:  processConfigApi.getConfig,
    staleTime: 300000,
  })
  const usesLots = tenantConfig?.uses_lots ?? false
  const usesFefo = tenantConfig?.uses_fefo ?? false

  const isMulti = !prefilledOrderId

  // Almacenes de salida
  const { data: warehousesData } = useQuery({
    queryKey: ['warehouses-for-sale'],
    queryFn:  () => warehousesApi.list(),
  })
  const warehouses = useMemo(
    () => (warehousesData || []).filter(w => (w.type === 'finished_product' || w.type === 'resale') && w.is_active),
    [warehousesData]
  )
  const defaultWarehouseByType = useMemo(() => {
    const map = {}
    warehouses.forEach(w => { if (w.is_default && !map[w.type]) map[w.type] = w.id })
    return map
  }, [warehouses])

  // Cargar pedidos elegibles (confirmed + in_delivery + partially_delivered)
  const { data: confirmedData } = useQuery({
    queryKey: ['sales-orders', 'eligible-confirmed'],
    queryFn: () => salesApi.listOrders({ status: 'confirmed', limit: 200 }),
    enabled: !prefilledOrderId,
  })
  const { data: inDeliveryData } = useQuery({
    queryKey: ['sales-orders', 'eligible-in_delivery'],
    queryFn: () => salesApi.listOrders({ status: 'in_delivery', limit: 200 }),
    enabled: !prefilledOrderId,
  })
  const { data: partialData } = useQuery({
    queryKey: ['sales-orders', 'eligible-partially_delivered'],
    queryFn: () => salesApi.listOrders({ status: 'partially_delivered', limit: 200 }),
    enabled: !prefilledOrderId,
  })

  const allEligible = useMemo(() => {
    const arr = [
      ...(confirmedData?.data || []),
      ...(inDeliveryData?.data || []),
      ...(partialData?.data || []),
    ]
    return arr.sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
  }, [confirmedData, inDeliveryData, partialData])

  // Lista de clientes con pedidos elegibles (deduplicados)
  const partnersWithOrders = useMemo(() => {
    const seen = new Map()
    for (const o of allEligible) {
      if (!seen.has(o.partner_id)) {
        seen.set(o.partner_id, { id: o.partner_id, name: o.partner_name, count: 1 })
      } else {
        seen.get(o.partner_id).count++
      }
    }
    return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name))
  }, [allEligible])

  // Pedidos del cliente seleccionado
  const partnerOrders = useMemo(
    () => selectedPartnerId ? allEligible.filter(o => o.partner_id === selectedPartnerId) : [],
    [allEligible, selectedPartnerId]
  )

  // Detalle de cada pedido seleccionado (carga en paralelo)
  const orderDetails = useQueries({
    queries: selectedOrderIds.map(oid => ({
      queryKey: ['sales-order', oid],
      queryFn:  () => salesApi.getOrder(oid),
      enabled:  !!oid,
    })),
  })
  const pendingDetails = useQueries({
    queries: selectedOrderIds.map(oid => ({
      queryKey: ['sales-order', oid, 'pending'],
      queryFn:  () => salesApi.pendingQuantities(oid),
      enabled:  !!oid,
    })),
  })

  const ordersLoaded = orderDetails.every(q => !q.isLoading && q.data) && pendingDetails.every(q => !q.isLoading && q.data)
  const orders = orderDetails.map(q => q.data).filter(Boolean)

  // Pedido representativo (primero por created_at) — fija moneda y domicilio
  const primary = useMemo(() => {
    if (!orders.length) return null
    return [...orders].sort((a, b) => new Date(a.created_at) - new Date(b.created_at))[0]
  }, [orders])

  // Set de pedidos del cliente con incompatibilidades (moneda/domicilio distintos al primary)
  const incompatibleOrderIds = useMemo(() => {
    if (!primary) return new Set()
    const incompat = new Set()
    for (const o of partnerOrders) {
      if (o.id === primary.id || selectedOrderIds.includes(o.id)) continue
      if (o.currency !== primary.currency) incompat.add(o.id)
      // El domicilio se valida con detalle: necesitamos cargar el order pero
      // listOrders no incluye delivery_address_id. Aproximación: lo permitimos
      // marcar y el backend valida; igual a nivel UX si ya tenemos detalles
      // de los seleccionados, podemos comparar con esos. Para los que NO están
      // cargados aún, no podemos chequear sin detalle. Asumimos OK hasta probar.
    }
    return incompat
  }, [primary, partnerOrders, selectedOrderIds])

  // Líneas agregadas: por pedido, con saldo pendiente
  const aggregatedLines = useMemo(() => {
    const out = []
    for (let i = 0; i < orders.length; i++) {
      const order = orders[i]
      const pendingMap = {}
      ;(pendingDetails[i]?.data?.data || []).forEach(p => { pendingMap[p.lineId] = p })
      for (const l of (order.lines || [])) {
        const pending = pendingMap[l.id]
        const qtyPending = pending?.qtyPending ?? parseFloat(l.quantity)
        out.push({
          ...l,
          order_id: order.id,
          order_number: order.order_number,
          qty_pending: qtyPending,
        })
      }
    }
    return out
  }, [orders, pendingDetails])

  // Al cargar líneas nuevas, prefill qty pendiente y warehouse por tipo
  useEffect(() => {
    if (!aggregatedLines.length) return
    setLineQtys(prev => {
      const next = { ...prev }
      for (const l of aggregatedLines) {
        if (next[l.id] === undefined) {
          next[l.id] = l.qty_pending > 0 ? String(l.qty_pending) : '0'
        }
      }
      return next
    })
    setLineWarehouses(prev => {
      const next = { ...prev }
      for (const l of aggregatedLines) {
        if (next[l.id] === undefined) {
          const wantedType = l.product_type === 'resale' ? 'resale' : 'finished_product'
          next[l.id] = defaultWarehouseByType[wantedType] || ''
        }
      }
      return next
    })
  }, [aggregatedLines, defaultWarehouseByType])

  // ── Lotes disponibles por producto (uses_lots=true) ─────────────────────
  // Hacemos una query por producto único. Por línea preseleccionamos el
  // primero (vienen ordenados FEFO desde el backend) si uses_fefo=true.
  const uniqueProductIds = useMemo(
    () => [...new Set(aggregatedLines.map(l => l.product_id).filter(Boolean))],
    [aggregatedLines],
  )
  const lotsQueries = useQueries({
    queries: uniqueProductIds.map(pid => ({
      queryKey: ['product-lots', pid],
      queryFn:  () => productLotsApi.list({ productId: pid, status: 'active', onlyAvailable: 'true' }),
      enabled:  usesLots && !!pid,
      staleTime: 60000,
    })),
  })
  const lotsByProduct = useMemo(() => {
    const map = {}
    uniqueProductIds.forEach((pid, i) => {
      map[pid] = lotsQueries[i]?.data || []
    })
    return map
  }, [uniqueProductIds, lotsQueries])

  // Auto-seleccionar FEFO (primer lote disponible) cuando aplica.
  useEffect(() => {
    if (!usesLots || !aggregatedLines.length) return
    setLineLots(prev => {
      const next = { ...prev }
      for (const l of aggregatedLines) {
        if (next[l.id] !== undefined) continue
        const lots = lotsByProduct[l.product_id] || []
        next[l.id] = (usesFefo && lots[0]) ? lots[0].id : ''
      }
      return next
    })
  }, [usesLots, usesFefo, aggregatedLines, lotsByProduct])

  function toggleOrder(orderId) {
    setSelectedOrderIds(prev => prev.includes(orderId)
      ? prev.filter(id => id !== orderId)
      : [...prev, orderId])
  }

  function updateLineQty(lineId, val) {
    setLineQtys(prev => ({ ...prev, [lineId]: val }))
  }

  // Cálculo total preview (sin IVA — se calcula al facturar).
  const previewTotals = useMemo(() => {
    if (!aggregatedLines.length || !primary) return null
    let subtotal = 0
    for (const l of aggregatedLines) {
      const qty = parseFloat(lineQtys[l.id] || 0)
      const price = parseFloat(l.unit_price || 0)
      const disc = parseFloat(l.discount_pct || 0)
      subtotal += qty * price * (1 - disc / 100)
    }
    const factor = primary.currency === 'USD' ? parseFloat(primary.exchange_rate_value || 1) : 1
    return {
      subtotal: subtotal * factor,
      total:    subtotal * factor, // sin IVA
      currency: primary.currency,
    }
  }, [aggregatedLines, lineQtys, primary])

  const mutation = useMutation({
    mutationFn: () => {
      if (!selectedOrderIds.length) throw new Error('Selecciona al menos un pedido.')
      if (!aggregatedLines.length)   throw new Error('Los pedidos no tienen líneas.')

      const linesPayload = aggregatedLines
        .map(l => {
          const qty = parseFloat(lineQtys[l.id] || 0)
          if (!qty || qty <= 0) return null
          return {
            salesOrderId:            l.order_id,
            salesOrderLineId:        l.id,
            productId:               l.product_id,
            quantityOrdered:         parseFloat(l.quantity),
            quantityDelivered:       qty,
            unit:                    l.unit,
            unitPrice:               parseFloat(l.unit_price),
            discountPct:             parseFloat(l.discount_pct || 0),
            notes:                   l.notes || null,
            packOptionId:            l.pack_option_id ?? null,
            packFactor:              l.pack_factor != null ? parseFloat(l.pack_factor) : 1,
            originalUnitPrice:       l.original_unit_price ?? null,
            originalCurrency:        l.original_currency ?? null,
            appliedExchangeRate:     l.applied_exchange_rate ?? null,
            appliedExchangeRateDate: l.applied_exchange_rate_date ?? null,
            warehouseId:             lineWarehouses[l.id] || null,
            // Lote: solo si el tenant usa lotes y el usuario eligió uno
            productLotId:            usesLots ? (lineLots[l.id] || null) : null,
          }
        })
        .filter(Boolean)

      if (!linesPayload.length) throw new Error('Captura al menos una cantidad a entregar.')

      const isSingle = selectedOrderIds.length === 1
      return salesApi.createDeliveryNote({
        ...(isSingle
          ? { salesOrderId: selectedOrderIds[0] }
          : { salesOrderIds: selectedOrderIds }),
        lines: linesPayload,
        notes: notes || null,
      })
    },
    onSuccess: (note) => {
      qc.invalidateQueries({ queryKey: ['delivery-notes'] })
      qc.invalidateQueries({ queryKey: ['sales-orders'] })
      for (const oid of selectedOrderIds) {
        qc.invalidateQueries({ queryKey: ['sales-order', oid] })
        qc.invalidateQueries({ queryKey: ['sales-order', oid, 'pending'] })
      }
      onCreated?.(note)
      onClose()
    },
    onError: (e) => setError(e.response?.data?.error || e.message || 'Error al crear la remisión'),
  })

  function handleSubmit(e) { e.preventDefault(); setError(null); mutation.mutate() }

  // En modo single con prefill, no mostramos selector ni checklist
  const showPartnerStep    = isMulti && !selectedPartnerId
  const showOrdersChecklist = isMulti && !!selectedPartnerId
  const showLines           = selectedOrderIds.length > 0 && ordersLoaded

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40 p-4">
      <div className="card w-full max-w-3xl p-6 max-h-[92vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-5">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-purple-500/15 flex items-center justify-center shrink-0">
              <svg className="w-4 h-4 text-purple-300" fill="currentColor" viewBox="0 0 24 24">
                <path d="M20 8h-3V4H3c-1.1 0-2 .9-2 2v11h2c0 1.66 1.34 3 3 3s3-1.34 3-3h6c0 1.66 1.34 3 3 3s3-1.34 3-3h2v-5l-3-4zM6 18.5c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5zm13.5-9l1.96 2.5H17V9.5h2.5zm-1.5 9c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5z"/>
              </svg>
            </div>
            <div>
              <h2 className="text-base font-semibold text-ink-primary">Nueva remisión</h2>
              <p className="text-xs text-ink-muted mt-0.5">
                {isMulti
                  ? 'Selecciona el cliente y los pedidos a remisionar (puedes consolidar varios)'
                  : 'Generar remisión desde el pedido'}
              </p>
            </div>
          </div>
          <button onClick={onClose} className="btn-ghost btn-icon text-ink-muted">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12"/>
            </svg>
          </button>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col gap-5">
          {/* Paso 1: selector de cliente */}
          {showPartnerStep && (
            <div>
              <label className="label">Cliente <span className="text-status-danger">*</span></label>
              <select className="select" value={selectedPartnerId}
                onChange={e => { setSelectedPartnerId(e.target.value); setSelectedOrderIds([]); setLineQtys({}) }}>
                <option value="">— Selecciona un cliente —</option>
                {partnersWithOrders.map(p => (
                  <option key={p.id} value={p.id}>{p.name} · {p.count} pedido{p.count > 1 ? 's' : ''}</option>
                ))}
              </select>
              {partnersWithOrders.length === 0 && (confirmedData || inDeliveryData || partialData) && (
                <p className="text-xs text-ink-muted mt-1.5 italic">
                  No hay pedidos con saldo pendiente para remisionar.
                </p>
              )}
            </div>
          )}

          {/* Paso 2: checklist de pedidos del cliente */}
          {showOrdersChecklist && (
            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="label mb-0">Pedidos a remisionar <span className="text-status-danger">*</span></label>
                <button type="button"
                  onClick={() => { setSelectedPartnerId(''); setSelectedOrderIds([]); setLineQtys({}) }}
                  className="text-xs text-ink-muted hover:text-ink-secondary underline">
                  Cambiar cliente
                </button>
              </div>
              <div className="border border-line-subtle rounded-lg divide-y divide-line-subtle max-h-56 overflow-y-auto">
                {partnerOrders.map(o => {
                  const checked = selectedOrderIds.includes(o.id)
                  const incompat = incompatibleOrderIds.has(o.id)
                  return (
                    <label key={o.id}
                      className={clsx(
                        'flex items-center gap-3 px-3 py-2 cursor-pointer hover:bg-surface-elevated/40',
                        incompat && 'opacity-50 cursor-not-allowed'
                      )}>
                      <input type="checkbox"
                        checked={checked}
                        disabled={incompat}
                        onChange={() => toggleOrder(o.id)}
                        className="accent-brand-600" />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-mono font-semibold text-brand-300 text-sm">{o.order_number}</span>
                          <span className="text-xs text-ink-muted">{fmtDate(o.created_at)}</span>
                          {o.currency === 'USD' && <span className="badge-amber text-[10px]">USD</span>}
                          {o.po_number && <span className="text-[11px] text-ink-muted">OC: {o.po_number}</span>}
                        </div>
                        <p className="text-xs text-ink-muted mt-0.5">
                          {fmtMXN(o.total_mxn, o.currency)}
                          {o.status === 'partially_delivered' && ' · entrega parcial'}
                          {o.status === 'in_delivery'        && ' · remisionado'}
                        </p>
                      </div>
                      {incompat && (
                        <span className="text-[10px] text-status-warning italic">moneda distinta</span>
                      )}
                    </label>
                  )
                })}
              </div>
              {primary && selectedOrderIds.length > 1 && (
                <p className="text-xs text-ink-muted mt-2">
                  Consolidando <strong>{selectedOrderIds.length}</strong> pedidos · moneda {primary.currency} · domicilio del pedido {primary.order_number}.
                  Si los pedidos tienen domicilios distintos el servidor rechazará la operación.
                </p>
              )}
            </div>
          )}

          {/* Pedido prefilled: cabecera resumida */}
          {!isMulti && primary && (
            <div className="bg-surface-elevated/40 rounded-xl p-3 grid grid-cols-2 gap-2 text-xs">
              <div><span className="text-ink-muted">Pedido:</span> <span className="font-mono font-semibold text-brand-300">{primary.order_number}</span></div>
              <div><span className="text-ink-muted">Cliente:</span> <span className="font-medium">{primary.partner_name}</span></div>
              <div><span className="text-ink-muted">F. programada:</span> <span>{fmtDate(primary.scheduled_date)}</span></div>
              <div><span className="text-ink-muted">OC cliente:</span> <span>{primary.po_number || '—'}</span></div>
              {primary.delivery_address && (
                <div className="col-span-2">
                  <span className="text-ink-muted">Domicilio:</span>{' '}
                  <span className="font-medium">
                    {primary.address_alias && `${primary.address_alias} · `}{primary.delivery_address}, {primary.delivery_city}
                  </span>
                </div>
              )}
            </div>
          )}

          {/* Líneas agregadas a remisionar */}
          {selectedOrderIds.length > 0 && (
            !ordersLoaded ? (
              <div className="flex justify-center py-8"><Spinner /></div>
            ) : showLines && (
              <div>
                <p className="text-xs font-bold text-brand-300 uppercase tracking-wider mb-2">
                  Líneas a remisionar
                </p>
                <div className="border border-line-subtle rounded-xl overflow-x-auto">
                  <table className="table text-xs min-w-full">
                    <thead>
                      <tr>
                        <th>Producto</th>
                        {selectedOrderIds.length > 1 && <th>Pedido</th>}
                        <th className="text-right">Pendiente</th>
                        <th className="text-right w-32">A entregar</th>
                        {warehouses.length > 1 && <th className="w-36">Almacén</th>}
                        {usesLots && <th className="w-44">Lote {usesFefo && <span className="text-[10px] font-normal text-ink-muted">(FEFO)</span>}</th>}
                        <th className="text-right">Importe</th>
                      </tr>
                    </thead>
                    <tbody>
                      {aggregatedLines.map(l => {
                        const qtyToDeliver = parseFloat(lineQtys[l.id] || 0)
                        const price = parseFloat(l.unit_price)
                        const disc = parseFloat(l.discount_pct || 0)
                        const importe = qtyToDeliver * price * (1 - disc / 100)
                        const isPartial = qtyToDeliver > 0 && qtyToDeliver < l.qty_pending
                        const isExcess = qtyToDeliver > l.qty_pending
                        const fullyCovered = l.qty_pending <= 0
                        return (
                          <tr key={l.id} className={clsx(fullyCovered && 'opacity-50')}>
                            <td>
                              <div className="flex items-start gap-1.5">
                                <ProductImageThumb
                                  productId={l.product_id}
                                  imageAttachmentId={l.image_attachment_id}
                                  caption={l.product_name} />
                                <div className="min-w-0 flex-1">
                                  <p className="font-medium text-ink-primary">{l.product_name}</p>
                                  {l.sku && <p className="text-[10px] text-ink-muted font-mono">{l.sku}</p>}
                                </div>
                              </div>
                            </td>
                            {selectedOrderIds.length > 1 && (
                              <td className="text-[11px] font-mono text-ink-muted">{l.order_number}</td>
                            )}
                            <td className={clsx('text-right font-mono tabular-nums font-medium',
                              fullyCovered ? 'text-status-success' : 'text-brand-300')}>
                              {fullyCovered ? '✓' : fmtNum(l.qty_pending, 3)} {l.unit}
                            </td>
                            <td className="text-right">
                              <input type="number" step="0.001" min="0" inputMode="decimal"
                                disabled={fullyCovered}
                                value={lineQtys[l.id] ?? ''}
                                onChange={e => updateLineQty(l.id, e.target.value)}
                                className={clsx(
                                  'input text-right text-sm h-8 py-0',
                                  isPartial && 'border-status-warning/40 bg-status-warning/10',
                                  isExcess && 'border-status-danger/40 bg-status-danger/10',
                                  fullyCovered && 'bg-surface-elevated/60 cursor-not-allowed'
                                )} />
                            </td>
                            {warehouses.length > 1 && (
                              <td>
                                <select
                                  disabled={fullyCovered}
                                  value={lineWarehouses[l.id] || ''}
                                  onChange={e => setLineWarehouses(w => ({ ...w, [l.id]: e.target.value }))}
                                  className="select text-sm h-8 py-0">
                                  <option value="">— default —</option>
                                  {[...warehouses]
                                    .sort((a, b) => {
                                      const pref = l.product_type === 'resale' ? 'resale' : 'finished_product'
                                      const aPref = a.type === pref ? 0 : 1
                                      const bPref = b.type === pref ? 0 : 1
                                      if (aPref !== bPref) return aPref - bPref
                                      return (b.is_default ? 1 : 0) - (a.is_default ? 1 : 0)
                                    })
                                    .map(w => (
                                      <option key={w.id} value={w.id}>
                                        {w.name}{w.is_default ? ' ★' : ''}
                                      </option>
                                    ))}
                                </select>
                              </td>
                            )}
                            {usesLots && (
                              <td>
                                {(() => {
                                  const lots = lotsByProduct[l.product_id] || []
                                  if (lots.length === 0) {
                                    return <span className="text-[10px] text-ink-muted italic">Sin stock por lotes</span>
                                  }
                                  return (
                                    <select
                                      disabled={fullyCovered}
                                      value={lineLots[l.id] || ''}
                                      onChange={e => setLineLots(prev => ({ ...prev, [l.id]: e.target.value }))}
                                      className="select text-xs h-8 py-0">
                                      <option value="">— sin lote —</option>
                                      {lots.map(lot => (
                                        <option key={lot.id} value={lot.id}>
                                          {lot.lot_number}
                                          {lot.expiry_date ? ` · vence ${new Date(lot.expiry_date).toLocaleDateString('es-MX')}` : ''}
                                          {' · '}{fmtNum(lot.quantity_remaining, 2)} disp.
                                        </option>
                                      ))}
                                    </select>
                                  )
                                })()}
                              </td>
                            )}
                            <td className="text-right font-mono tabular-nums font-medium">
                              {fmtMXN(importe, primary?.currency)}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>

                  {previewTotals && (
                    <div className="bg-surface-elevated/40 border-t border-line-subtle px-4 py-3 flex flex-col gap-1.5">
                      <div className="flex justify-between text-sm font-semibold text-ink-primary">
                        <span>Total remisión</span>
                        <span className="font-mono text-brand-300">{fmtMXN(previewTotals.subtotal, previewTotals.currency)}</span>
                      </div>
                      <p className="flex items-start gap-1.5 text-[11px] text-status-warning bg-status-warning/10 border border-status-warning/40 rounded-md px-2 py-1 mt-1">
                        <svg className="w-3 h-3 shrink-0 mt-0.5" fill="currentColor" viewBox="0 0 20 20">
                          <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clipRule="evenodd"/>
                        </svg>
                        <span>El IVA (16%) se calculará automáticamente al facturar.</span>
                      </p>
                    </div>
                  )}
                </div>

                <div className="mt-4">
                  <label className="label">Notas de la remisión</label>
                  <input className="input" placeholder="Opcional — observaciones internas o para el cliente"
                    value={notes} onChange={e => setNotes(e.target.value)} />
                </div>
              </div>
            )
          )}

          {error && <p className="field-error">{error}</p>}

          <div className="flex gap-2 pt-1">
            <button type="button" onClick={onClose} className="btn-secondary flex-1" disabled={mutation.isPending}>
              Cancelar
            </button>
            <button type="submit"
              disabled={mutation.isPending || !selectedOrderIds.length || !ordersLoaded}
              className="btn-primary flex-1">
              {mutation.isPending
                ? <Spinner size="sm" />
                : `Crear remisión${selectedOrderIds.length > 1 ? ` (${selectedOrderIds.length} pedidos)` : ''}`}
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body
  )
}
