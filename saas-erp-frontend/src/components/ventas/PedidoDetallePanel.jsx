import { useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { salesApi } from '@/api/sales'
import { partnersApi } from '@/api/partners'
import { usersApi } from '@/api/users'
import { PedidoLineaModal } from '@/components/ventas/PedidoLineaModal'
import { RemisionFormModal } from '@/components/ventas/RemisionFormModal'
import { RemisionDetallePanel } from '@/components/ventas/RemisionDetallePanel'
import { ProductImageThumb } from '@/components/productos/ProductImageThumb'
import Badge from '@/components/ui/Badge'
import Spinner from '@/components/ui/Spinner'
import { fmtMXN, fmtDate, fmtNum, fmtDateInput } from '@/utils/fmt'
import clsx from 'clsx'

// ── Tabla de líneas — read-only + acciones edit/delete cuando editable ──────
// El pedido NO lleva IVA. El total mostrado es el subtotal puro;
// el IVA se calculará al facturar.
function LineasTable({ order, editable, onEditLine, onDeleteLine, deletingLineId }) {
  const lines = order.lines || []
  // Usamos subtotal como total visible del pedido (pre-IVA).
  // Si por algún motivo (datos legacy) subtotal_mxn está vacío, caemos
  // a total_mxn como fallback.
  const subtotal = parseFloat(order.subtotal_mxn || order.total_mxn || 0)

  if (lines.length === 0) {
    return <p className="text-sm text-ink-muted text-center py-4">Sin líneas registradas</p>
  }

  return (
    <div className="border border-line-subtle rounded-xl overflow-x-auto">
      <table className="table text-xs min-w-full">
        <thead>
          <tr>
            <th>Producto</th>
            <th className="text-right">Cant.</th>
            <th className="text-right">P. Unit.</th>
            <th className="text-right">Desc.</th>
            <th className="text-right">Importe</th>
            {editable && <th className="text-right w-20">Acciones</th>}
          </tr>
        </thead>
        <tbody>
          {lines.map(l => {
            const qty = parseFloat(l.quantity || 0)
            const price = parseFloat(l.unit_price || 0)
            const disc = parseFloat(l.discount_pct || 0)
            const importe = parseFloat(l.subtotal || qty * price * (1 - disc / 100))
            return (
              <tr key={l.id}>
                <td>
                  <div className="flex items-start gap-1.5">
                    <ProductImageThumb
                      productId={l.product_id}
                      imageAttachmentId={l.image_attachment_id}
                      caption={l.product_name} />
                    <div className="min-w-0 flex-1">
                      <p className="font-medium text-ink-primary">{l.product_name || '—'}</p>
                      {l.sku && <p className="text-[10px] text-ink-muted font-mono">{l.sku}</p>}
                      {l.notes && <p className="text-[10px] text-ink-muted mt-0.5 italic">{l.notes}</p>}
                    </div>
                  </div>
                </td>
                <td className="text-right font-mono tabular-nums">{fmtNum(qty, 3)} {l.unit}</td>
                <td className="text-right font-mono tabular-nums">{fmtMXN(price, order.currency)}</td>
                <td className="text-right font-mono tabular-nums">{disc > 0 ? `${fmtNum(disc, 2)}%` : '—'}</td>
                <td className="text-right font-mono tabular-nums font-medium">{fmtMXN(importe, order.currency)}</td>
                {editable && (
                  <td className="text-right">
                    <div className="flex items-center justify-end gap-1">
                      <button
                        onClick={() => onEditLine(l)}
                        className="btn-ghost btn-icon p-1 text-ink-muted hover:text-brand-300"
                        title="Editar línea">
                        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/>
                        </svg>
                      </button>
                      <button
                        onClick={() => onDeleteLine(l)}
                        disabled={deletingLineId === l.id}
                        className="btn-ghost btn-icon p-1 text-ink-muted hover:text-status-danger"
                        title="Eliminar línea">
                        {deletingLineId === l.id ? <Spinner size="sm" /> : (
                          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6M1 7h22M9 7V3a1 1 0 011-1h4a1 1 0 011 1v4"/>
                          </svg>
                        )}
                      </button>
                    </div>
                  </td>
                )}
              </tr>
            )
          })}
        </tbody>
      </table>
      <div className="bg-surface-elevated/40 border-t border-line-subtle px-4 py-3 flex flex-col gap-1.5">
        <div className="flex justify-between text-sm font-semibold text-ink-primary">
          <span>Total del pedido</span>
          <span className="font-mono tabular-nums text-brand-300">{fmtMXN(subtotal, order.currency)}</span>
        </div>
        {order.currency === 'USD' && parseFloat(order.exchange_rate_value) > 0 && (
          <div className="flex justify-between text-xs text-ink-muted">
            <span>TC ${fmtNum(order.exchange_rate_value, 4)}</span>
          </div>
        )}
        <p className="flex items-start gap-1.5 text-[11px] text-status-warning bg-status-warning/10 border border-status-warning/40 rounded-md px-2 py-1 mt-1">
          <svg className="w-3 h-3 shrink-0 mt-0.5" fill="currentColor" viewBox="0 0 20 20">
            <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clipRule="evenodd"/>
          </svg>
          <span>El IVA (16%) se calculará automáticamente al facturar.</span>
        </p>
      </div>
    </div>
  )
}

// ── Datos generales en modo lectura ──────────────────────────────────────────
function DatosGeneralesView({ order }) {
  return (
    <div className="grid grid-cols-2 gap-2">
      {[
        ['Cliente',         order.partner_name || '—'],
        ['RFC',             order.rfc || '—'],
        ['Moneda',          order.currency === 'USD'
          ? `USD (TC $${order.exchange_rate_value ? fmtNum(order.exchange_rate_value, 4) : '—'})`
          : 'MXN'],
        ['F. creación',     fmtDate(order.created_at)],
        ['F. programada',   fmtDate(order.scheduled_date)],
        ['F. confirmación', fmtDate(order.confirmed_at)],
        ['OC del cliente',  order.po_number || '—'],
        ['Factura directa', order.direct_invoice ? 'Sí' : 'No'],
        ['Domicilio',
          order.delivery_address
            ? `${order.address_alias ? order.address_alias + ' · ' : ''}${order.delivery_address}, ${order.delivery_city || ''}`
            : '—'],
        ['Creado por',      order.created_by_name || '—'],
        ['Confirmado por',  order.confirmed_by_name || '—'],
      ].map(([label, val]) => (
        <div key={label} className="bg-surface-elevated/60 border border-line-strong rounded-lg px-3 py-2">
          <p className="text-[10px] font-bold text-ink-secondary uppercase tracking-wide">{label}</p>
          <p className="text-sm font-medium text-ink-primary mt-0.5 break-words">{val}</p>
        </div>
      ))}
    </div>
  )
}

// ── Datos generales editables (solo status=draft) ────────────────────────────
function DatosGeneralesEdit({ order, onCancel, onSaved }) {
  const qc = useQueryClient()
  const [addressId, setAddressId] = useState(order.delivery_address_id || '')
  const [scheduledDate, setScheduledDate] = useState(fmtDateInput(order.scheduled_date) || '')
  const [poNumber, setPoNumber] = useState(order.po_number || '')
  const [directInvoice, setDirectInvoice] = useState(!!order.direct_invoice)
  const [notes, setNotes] = useState(order.notes || '')
  const [error, setError] = useState(null)

  const { data: addresses = [] } = useQuery({
    queryKey: ['partner-addresses', order.partner_id],
    queryFn: () => partnersApi.listAddresses(order.partner_id),
    enabled: !!order.partner_id,
  })

  const mutation = useMutation({
    mutationFn: () => salesApi.updateOrder(order.id, {
      deliveryAddressId: addressId || null,
      scheduledDate:     scheduledDate || null,
      poNumber:          poNumber || null,
      directInvoice,
      notes:             notes || null,
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sales-order', order.id] })
      qc.invalidateQueries({ queryKey: ['sales-orders'] })
      onSaved?.()
    },
    onError: (e) => setError(e.response?.data?.error || e.message || 'Error al guardar'),
  })

  return (
    <div className="bg-brand-500/10 rounded-xl p-4 flex flex-col gap-3 border border-brand-500/40">
      <p className="text-xs font-semibold text-brand-300 uppercase tracking-wide">Editando datos generales</p>

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

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label">Fecha programada</label>
          <input type="date" className="input" value={scheduledDate}
            onChange={e => setScheduledDate(e.target.value)} />
        </div>
        <div>
          <label className="label">OC del cliente</label>
          <input className="input" value={poNumber} onChange={e => setPoNumber(e.target.value)} />
        </div>
      </div>

      <label className="flex items-center gap-2 cursor-pointer select-none">
        <input
          type="checkbox" className="w-4 h-4 accent-brand-600 rounded"
          checked={directInvoice} onChange={e => setDirectInvoice(e.target.checked)}
        />
        <span className="text-sm text-ink-secondary">Facturar directo (sin remisión)</span>
      </label>

      <div>
        <label className="label">Notas</label>
        <input className="input" value={notes} onChange={e => setNotes(e.target.value)} />
      </div>

      {error && <p className="field-error">{error}</p>}

      <div className="flex gap-2 pt-1">
        <button onClick={onCancel} className="btn-secondary flex-1" disabled={mutation.isPending}>
          Cancelar
        </button>
        <button onClick={() => { setError(null); mutation.mutate() }}
          className="btn-primary flex-1" disabled={mutation.isPending}>
          {mutation.isPending ? <Spinner size="sm" /> : 'Guardar cambios'}
        </button>
      </div>
    </div>
  )
}

// ── Acciones contextuales por estado ────────────────────────────────────────
function AccionesPedido({ order, onAction, loadingAction, editing, onToggleEdit, onCreateRemision }) {
  const { status } = order
  const hasLines = (order.lines || []).length > 0

  const Btn = ({ label, action, variant = 'secondary', icon, disabled, title }) => (
    <button onClick={() => onAction(action)} disabled={!!loadingAction || disabled}
      title={title}
      className={clsx(
        `btn-${variant} btn-sm`,
        loadingAction === action && 'opacity-60',
        disabled && 'opacity-40 cursor-not-allowed'
      )}>
      {loadingAction === action ? <Spinner size="sm" /> : icon}
      {label}
    </button>
  )

  if (status === 'draft') return (
    <div className="flex flex-col gap-2 border-t border-line-subtle pt-4 mt-2">
      {!hasLines && (
        <div className="flex items-center gap-2 bg-status-warning/10 border border-status-warning/40 rounded-lg px-3 py-2">
          <svg className="w-4 h-4 text-amber-500 shrink-0" fill="currentColor" viewBox="0 0 24 24">
            <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/>
          </svg>
          <p className="text-xs text-status-warning">
            Agrega al menos una línea antes de confirmar el pedido.
          </p>
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        {!editing && (
          <button onClick={onToggleEdit} className="btn-secondary btn-sm">
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/>
            </svg>
            Editar datos
          </button>
        )}
        <Btn label="Confirmar pedido" action="confirm" variant="primary"
          disabled={!hasLines}
          title={!hasLines ? 'Agrega al menos una línea para confirmar' : undefined}
          icon={<svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7"/>
          </svg>}
        />
        <Btn label="Cancelar" action="cancel" variant="danger"
          icon={<svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12"/>
          </svg>}
        />
      </div>
    </div>
  )

  if (status === 'confirmed' || status === 'in_delivery' || status === 'partially_delivered') return (
    <div className="flex flex-wrap gap-2 border-t border-line-subtle pt-4 mt-2">
      <button onClick={onCreateRemision} className="btn-primary btn-sm">
        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 17a2 2 0 11-4 0 2 2 0 014 0zM19 17a2 2 0 11-4 0 2 2 0 014 0z"/>
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16V6a1 1 0 00-1-1H4a1 1 0 00-1 1v10a1 1 0 001 1h1m8-1a1 1 0 01-1 1H9m4-1V8a1 1 0 011-1h2.586a1 1 0 01.707.293l3.414 3.414a1 1 0 01.293.707V16a1 1 0 01-1 1h-1m-6-1a1 1 0 001 1h1M5 17a2 2 0 104 0m-4 0a2 2 0 114 0m6 0a2 2 0 104 0m-4 0a2 2 0 114 0"/>
        </svg>
        {status === 'confirmed' ? 'Crear remisión' : 'Crear otra remisión'}
      </button>
      {status === 'confirmed' && (
        <Btn label="Cancelar pedido" action="cancel" variant="danger"
          icon={<svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12"/>
          </svg>}
        />
      )}
    </div>
  )

  if (status === 'delivered' || status === 'cancelled') return (
    <div className="border-t border-line-subtle pt-4 mt-2 text-xs text-ink-muted italic">
      {status === 'delivered'   && 'Pedido entregado — el pago pendiente del cliente se generó automáticamente.'}
      {status === 'cancelled'   && 'Este pedido fue cancelado.'}
    </div>
  )

  return null
}

// ── Modal de cancelación con captura de razón ───────────────────────────────
function CancelReasonModal({ onConfirm, onClose, loading }) {
  const [reason, setReason] = useState('')
  return createPortal(
    <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/40 p-4">
      <div className="card w-full max-w-md p-5">
        <h3 className="text-base font-semibold text-ink-primary mb-1">Cancelar pedido</h3>
        <p className="text-xs text-ink-muted mb-4">Esta acción no se puede deshacer. Captura el motivo de la cancelación (opcional pero recomendado).</p>
        <textarea
          rows={3}
          className="input w-full"
          placeholder="Motivo de cancelación..."
          value={reason}
          onChange={e => setReason(e.target.value)}
        />
        <div className="flex gap-2 mt-4">
          <button onClick={onClose} className="btn-secondary flex-1" disabled={loading}>No, conservar</button>
          <button onClick={() => onConfirm(reason)} className="btn-danger flex-1" disabled={loading}>
            {loading ? <Spinner size="sm" /> : 'Sí, cancelar pedido'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}

// ── Sección de Repartidor ──────────────────────────────────────────────────
function RepartidorSection({ order, editable }) {
  const qc = useQueryClient()
  const [editing, setEditing]  = useState(false)
  const [driverId, setDriverId] = useState(order.driver_id || '')
  const [isPickup, setIsPickup] = useState(!!order.pickup_in_warehouse)
  const [scheduledDate, setDate] = useState(order.scheduled_date || '')
  const [error, setError]       = useState(null)

  // Listamos miembros del tenant (todos los usuarios activos pueden ser repartidores)
  const { data: usersData } = useQuery({
    queryKey: ['users', 'all'],
    queryFn:  () => usersApi.list({ limit: 100 }),
    enabled:  editing,
    staleTime: 5 * 60 * 1000,
  })
  const users = usersData?.data || usersData || []

  const mutation = useMutation({
    mutationFn: () => salesApi.assignDriver(order.id, {
      driverId:           isPickup ? null : (driverId || null),
      pickupInWarehouse:  isPickup,
      scheduledDate:      scheduledDate || null,
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sales-order', order.id] })
      qc.invalidateQueries({ queryKey: ['sales-orders'] })
      setEditing(false)
    },
    onError: (e) => setError(e.response?.data?.error || e.message || 'Error al asignar'),
  })

  function handleCancel() {
    setDriverId(order.driver_id || '')
    setIsPickup(!!order.pickup_in_warehouse)
    setDate(order.scheduled_date || '')
    setError(null)
    setEditing(false)
  }

  // ── Vista (no editando) ──
  if (!editing) {
    const hasAssignment = !!order.driver_id || !!order.pickup_in_warehouse
    return (
      <div className={clsx(
        'rounded-xl border p-3 flex items-start gap-3',
        order.pickup_in_warehouse
          ? 'bg-status-warning/10 border-status-warning/40'
          : order.driver_id
            ? 'bg-purple-500/10 border-purple-500/40'
            : 'bg-surface-elevated/40 border-line-subtle'
      )}>
        <span className="text-xl">{order.pickup_in_warehouse ? '🏪' : order.driver_id ? '🚚' : '⚪'}</span>
        <div className="flex-1 min-w-0">
          <p className="text-[10px] uppercase tracking-wide font-semibold text-ink-muted">Entrega</p>
          {order.pickup_in_warehouse ? (
            <p className="text-sm font-semibold text-status-warning">El cliente recoge en bodega</p>
          ) : order.driver_id ? (
            <p className="text-sm font-semibold text-purple-300">
              {order.driver_name || 'Repartidor asignado'}
            </p>
          ) : (
            <p className="text-sm font-medium text-ink-muted">Sin asignar</p>
          )}
          {order.scheduled_date && (
            <p className="text-[11px] text-ink-muted mt-0.5">
              Programada: {fmtDate(order.scheduled_date)}
            </p>
          )}
        </div>
        {editable && (
          <button onClick={() => setEditing(true)}
            className="btn-ghost btn-sm text-brand-300 shrink-0">
            {hasAssignment ? 'Cambiar' : 'Asignar'}
          </button>
        )}
      </div>
    )
  }

  // ── Edición ──
  return (
    <div className="rounded-xl border-2 border-brand-500/40 bg-brand-500/10/30 p-4 flex flex-col gap-3">
      <p className="text-xs font-semibold text-ink-secondary uppercase tracking-wide">
        🚚 Asignar entrega
      </p>

      <label className="flex items-center gap-2 text-sm cursor-pointer">
        <input type="checkbox" className="w-4 h-4 accent-amber-600"
          checked={isPickup}
          onChange={e => {
            setIsPickup(e.target.checked)
            if (e.target.checked) setDriverId('')
          }} />
        <span>🏪 El cliente recoge en bodega (no requiere repartidor)</span>
      </label>

      {!isPickup && (
        <div>
          <label className="label">Repartidor</label>
          <select className="select" value={driverId}
            onChange={e => setDriverId(e.target.value)}>
            <option value="">— Sin asignar —</option>
            {users.map(u => (
              <option key={u.id} value={u.id}>
                {u.full_name}
                {u.email && ` · ${u.email}`}
              </option>
            ))}
          </select>
        </div>
      )}

      <div>
        <label className="label">Fecha programada de entrega <span className="text-ink-muted text-xs">(opcional)</span></label>
        <input type="date" className="input" value={scheduledDate || ''}
          onChange={e => setDate(e.target.value)} />
      </div>

      {error && <p className="field-error">{error}</p>}

      <div className="flex gap-2">
        <button onClick={handleCancel} className="btn-secondary flex-1">Cancelar</button>
        <button onClick={() => { setError(null); mutation.mutate() }}
          disabled={mutation.isPending}
          className="btn-primary flex-1">
          {mutation.isPending ? <Spinner size="sm" /> : 'Guardar'}
        </button>
      </div>
    </div>
  )
}

// ── Panel principal ──────────────────────────────────────────────────────────
export function PedidoDetallePanel({ orderId, onClose }) {
  const qc = useQueryClient()
  const [loadingAction, setLoading] = useState(null)
  const [actionError, setError]     = useState(null)
  const [showCancelModal, setShowCancelModal] = useState(false)
  const [editingDatos, setEditingDatos] = useState(false)
  const [lineModal, setLineModal]   = useState(null)   // null | { mode: 'new'|'edit', line? }
  const [deletingLineId, setDeletingLineId] = useState(null)
  const [showRemisionModal, setShowRemisionModal] = useState(false)
  const [remisionMsg, setRemisionMsg] = useState(null)
  const [viewingNoteId, setViewingNoteId] = useState(null)

  const { data: order, isLoading, error: queryError } = useQuery({
    queryKey: ['sales-order', orderId],
    queryFn:  () => salesApi.getOrder(orderId),
    enabled:  !!orderId,
    retry:    1,
  })

  // Saldo de entrega por línea (incluye qty_invoiced para detectar facturación anticipada).
  const { data: balanceData } = useQuery({
    queryKey: ['sales-order-balance', orderId],
    queryFn:  () => salesApi.pendingQuantities(orderId),
    enabled:  !!orderId && !!order && ['confirmed','in_delivery','partially_delivered','invoiced'].includes(order?.status),
  })
  const balanceRows  = balanceData?.data || []
  const hasAdvanceInvoice = balanceRows.some(r => r.hasAdvanceInvoice)

  // Si el pedido cambia de status (ej: alguien lo confirmó en otra pestaña), cerrar edición
  useEffect(() => {
    if (order && order.status !== 'draft') setEditingDatos(false)
  }, [order?.status])

  const confirmMutation = useMutation({
    mutationFn: () => salesApi.confirmOrder(orderId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sales-order', orderId] })
      qc.invalidateQueries({ queryKey: ['sales-orders'] })
    },
    onError: (e) => setError(e.response?.data?.error || e.message || 'Error al confirmar'),
    onSettled: () => setLoading(null),
  })

  const cancelMutation = useMutation({
    mutationFn: (reason) => salesApi.cancelOrder(orderId, { reason }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sales-order', orderId] })
      qc.invalidateQueries({ queryKey: ['sales-orders'] })
      setShowCancelModal(false)
    },
    onError: (e) => setError(e.response?.data?.error || e.message || 'Error al cancelar'),
    onSettled: () => setLoading(null),
  })

  async function handleDeleteLine(line) {
    if (!window.confirm(`¿Eliminar la línea "${line.product_name}"? Esta acción no se puede deshacer.`)) return
    setError(null)
    setDeletingLineId(line.id)
    try {
      await salesApi.deleteLine(orderId, line.id)
      qc.invalidateQueries({ queryKey: ['sales-order', orderId] })
      qc.invalidateQueries({ queryKey: ['sales-orders'] })
    } catch (e) {
      setError(e.response?.data?.error || e.message || 'Error al eliminar la línea')
    } finally {
      setDeletingLineId(null)
    }
  }

  function handleAction(action) {
    setError(null)
    setLoading(action)
    if (action === 'confirm')      confirmMutation.mutate()
    else if (action === 'cancel')  { setShowCancelModal(true); setLoading(null) }
  }

  function handleCancelConfirm(reason) {
    setLoading('cancel')
    cancelMutation.mutate(reason)
  }

  const isDraft = order?.status === 'draft'
  const canEditLines = isDraft

  return createPortal(
    <div className="fixed inset-0 z-[9998] flex">
      <div className="hidden sm:block flex-1 bg-black/30" onClick={onClose} />

      <div className="w-full max-w-2xl bg-surface-primary h-full overflow-y-auto shadow-card flex flex-col">

        {/* Header */}
        <div className="sticky top-0 bg-surface-primary border-b border-line-subtle px-5 py-4 flex items-start gap-3 z-10">
          <div className="flex-1 min-w-0">
            {isLoading ? (
              <div className="flex flex-col gap-2">
                <div className="skeleton h-5 w-40" />
                <div className="skeleton h-3 w-28" />
              </div>
            ) : order ? (
              <>
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-mono text-base font-bold text-ink-primary">{order.order_number}</span>
                  <Badge status={order.status} />
                  {order.direct_invoice && (
                    <span className="badge-blue">Factura directa</span>
                  )}
                </div>
                <p className="text-xs text-ink-muted mt-1">
                  {order.partner_name} · Creado {fmtDate(order.created_at)}
                </p>
              </>
            ) : null}
          </div>
          <button onClick={onClose} className="btn-ghost btn-icon text-ink-muted shrink-0">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12"/>
            </svg>
          </button>
        </div>

        {/* Contenido */}
        <div className="flex-1 p-5">
          {isLoading ? (
            <div className="flex justify-center py-16"><Spinner /></div>
          ) : queryError ? (
            <div className="flex flex-col items-center gap-3 py-12 text-center">
              <div className="w-12 h-12 rounded-xl bg-status-danger/10 flex items-center justify-center">
                <svg className="w-6 h-6 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/>
                </svg>
              </div>
              <div>
                <p className="text-sm font-medium text-ink-secondary">No se pudo cargar el pedido</p>
                <p className="text-xs text-status-danger mt-1">
                  {queryError.response?.data?.error || queryError.message || 'Error de conexión'}
                </p>
              </div>
              <button onClick={() => qc.invalidateQueries({ queryKey: ['sales-order', orderId] })}
                className="btn-secondary btn-sm">
                Reintentar
              </button>
            </div>
          ) : !order ? (
            <p className="text-sm text-ink-muted text-center py-8">El pedido no fue encontrado</p>
          ) : (
            <div className="flex flex-col gap-5">
              {editingDatos && isDraft ? (
                <DatosGeneralesEdit
                  order={order}
                  onCancel={() => setEditingDatos(false)}
                  onSaved={() => setEditingDatos(false)}
                />
              ) : (
                <DatosGeneralesView order={order} />
              )}

              {order.notes && !editingDatos && (
                <div className="bg-status-info/10 border border-status-info/40 rounded-lg px-3 py-2">
                  <p className="text-[10px] text-blue-400 uppercase tracking-wide mb-0.5">Notas</p>
                  <p className="text-sm text-status-info">{order.notes}</p>
                </div>
              )}

              {/* Repartidor / Recoge en bodega — solo para pedidos activos.
                  Editable cuando draft/confirmed/in_delivery. */}
              {['draft','confirmed','in_delivery','partially_delivered','invoiced'].includes(order.status) && (
                <RepartidorSection
                  order={order}
                  editable={['draft','confirmed','in_delivery'].includes(order.status)}
                />
              )}

              {/* Saldo de entrega (solo si hay factura anticipada) */}
              {hasAdvanceInvoice && (
                <div className="bg-emerald-50 border-2 border-emerald-200 rounded-xl p-4 flex flex-col gap-2">
                  <div className="flex items-center gap-2">
                    <span className="text-lg">📋</span>
                    <p className="text-sm font-semibold text-emerald-800">
                      Pedido con facturación anticipada
                    </p>
                  </div>
                  <p className="text-xs text-emerald-700">
                    Este pedido se facturó por adelantado. El cliente recibirá la mercancía en
                    remisiones parciales. Saldo por entregar:
                  </p>
                  <div className="border border-emerald-100 rounded-lg overflow-x-auto bg-surface-primary">
                    <table className="table text-xs">
                      <thead>
                        <tr>
                          <th>Producto</th>
                          <th className="text-right">Facturado</th>
                          <th className="text-right">Entregado</th>
                          <th className="text-right">Pendiente</th>
                        </tr>
                      </thead>
                      <tbody>
                        {balanceRows.map(r => {
                          const cap = r.qtyInvoiced > 0 ? r.qtyInvoiced : r.qtyOrdered
                          const isDone = r.qtyPending <= 0.0001
                          return (
                            <tr key={r.lineId}>
                              <td className="font-medium text-ink-primary">
                                {r.productName}
                                {r.sku && <span className="text-[10px] text-ink-muted ml-1">#{r.sku}</span>}
                              </td>
                              <td className="text-right font-mono">
                                {r.qtyInvoiced > 0
                                  ? <>{Number(r.qtyInvoiced).toLocaleString('es-MX')} <span className="text-[10px] text-ink-muted">{r.unit}</span></>
                                  : <span className="text-ink-muted">—</span>}
                              </td>
                              <td className="text-right font-mono text-status-info">
                                {Number(r.qtyRemisioned).toLocaleString('es-MX')}
                              </td>
                              <td className={clsx('text-right font-mono font-semibold',
                                isDone ? 'text-status-success' : 'text-status-warning')}>
                                {isDone ? '✓ Completo' : Number(r.qtyPending).toLocaleString('es-MX')}
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
              {/* Las notas de facturación del cliente (bp.billing_notes) se
                  muestran solo en el flujo de facturación — FacturaFormModal
                  y FacturaDetallePanel. Aquí no aplican. */}

              {/* Encabezado de líneas con botón agregar cuando draft */}
              {canEditLines && (
                <div className="flex items-center justify-between -mb-2">
                  <p className="text-xs font-bold text-brand-300 uppercase tracking-wider">Líneas</p>
                  <button onClick={() => setLineModal({ mode: 'new' })}
                    className="btn-ghost btn-sm text-brand-300">
                    + Agregar línea
                  </button>
                </div>
              )}

              <LineasTable
                order={order}
                editable={canEditLines}
                onEditLine={(line) => setLineModal({ mode: 'edit', line })}
                onDeleteLine={handleDeleteLine}
                deletingLineId={deletingLineId}
              />

              {/* Lista de remisiones del pedido */}
              {(order.deliveryNotes || []).length > 0 && (
                <div>
                  <p className="text-xs font-bold text-brand-300 uppercase tracking-wider mb-2">
                    Remisiones del pedido ({order.deliveryNotes.length})
                  </p>
                  <div className="border border-line-subtle rounded-xl overflow-hidden">
                    <table className="table text-xs">
                      <thead>
                        <tr>
                          <th>Número</th>
                          <th>F. emisión</th>
                          <th>Estado</th>
                          <th>Receptor</th>
                          <th className="text-right">Total</th>
                        </tr>
                      </thead>
                      <tbody>
                        {order.deliveryNotes.map(n => (
                          <tr key={n.id}
                            onClick={() => setViewingNoteId(n.id)}
                            className="cursor-pointer hover:bg-purple-500/10 transition-colors">
                            <td className="font-mono font-semibold text-purple-300">{n.document_number}</td>
                            <td className="text-ink-secondary">{fmtDate(n.issue_date)}</td>
                            <td><Badge status={n.status} /></td>
                            <td className="text-ink-secondary">{n.receiver_name || '—'}</td>
                            <td className="text-right font-mono tabular-nums font-medium">
                              {fmtMXN(n.total_mxn, n.currency)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {actionError && (
                <div className="bg-status-danger/10 border border-status-danger/40 rounded-lg px-3 py-2">
                  <p className="text-sm text-status-danger">{actionError}</p>
                </div>
              )}

              {remisionMsg && (
                <div className="flex items-center gap-2 bg-status-success/10 border border-status-success/40 rounded-lg px-3 py-2">
                  <svg className="w-4 h-4 text-status-success shrink-0" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/>
                  </svg>
                  <p className="text-sm text-status-success flex-1">{remisionMsg}</p>
                  <button onClick={() => setRemisionMsg(null)} className="text-status-success hover:text-status-success">
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12"/>
                    </svg>
                  </button>
                </div>
              )}

              <AccionesPedido
                order={order}
                onAction={handleAction}
                loadingAction={loadingAction}
                editing={editingDatos}
                onToggleEdit={() => setEditingDatos(true)}
                onCreateRemision={() => setShowRemisionModal(true)}
              />
            </div>
          )}
        </div>
      </div>

      {showCancelModal && (
        <CancelReasonModal
          onConfirm={handleCancelConfirm}
          onClose={() => setShowCancelModal(false)}
          loading={cancelMutation.isPending}
        />
      )}

      {lineModal && order && (
        <PedidoLineaModal
          order={order}
          line={lineModal.mode === 'edit' ? lineModal.line : null}
          onClose={() => setLineModal(null)}
          onSaved={() => {}}
        />
      )}

      {showRemisionModal && order && (
        <RemisionFormModal
          prefilledOrderId={order.id}
          onClose={() => setShowRemisionModal(false)}
          onCreated={(note) => setRemisionMsg(`Remisión ${note.document_number} generada. Ya puedes registrar la entrega desde Remisiones.`)}
        />
      )}

      {viewingNoteId && (
        <RemisionDetallePanel
          noteId={viewingNoteId}
          onClose={() => setViewingNoteId(null)}
        />
      )}
    </div>,
    document.body
  )
}
