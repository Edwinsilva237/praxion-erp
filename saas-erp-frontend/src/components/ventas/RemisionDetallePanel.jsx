import { useState } from 'react'
import { createPortal } from 'react-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { salesApi } from '@/api/sales'
import { tenantsApi } from '@/api/tenants'
import { EntregaModal } from '@/components/ventas/EntregaModal'
import { DeliveryPhoto } from '@/components/ventas/DeliveryPhoto'
import { ProductImageThumb } from '@/components/productos/ProductImageThumb'
import Badge from '@/components/ui/Badge'
import Spinner from '@/components/ui/Spinner'
import { fmtMXN, fmtDate, fmtNum, fmtDateOnly} from '@/utils/fmt'
import { printRemision } from '@/utils/printRemision'
import { printBlob } from '@/utils/downloadBlob'
import { Capacitor } from '@capacitor/core'
import useAuthStore from '@/store/useAuthStore'
import Can from '@/components/auth/Can'
import clsx from 'clsx'

// ── Datos generales ──────────────────────────────────────────────────────────
function DatosGenerales({ note }) {
  return (
    <div className="grid grid-cols-2 gap-2">
      {[
        ['Cliente',         note.partner_name || '—'],
        ['RFC',             note.rfc || '—'],
        ['F. emisión',      fmtDateOnly(note.issue_date)],
        ['F. vencimiento',  fmtDateOnly(note.credit_due_date)],
        ['F. entrega',      fmtDate(note.delivered_at)],
        ['Receptor',        note.receiver_name || '—'],
        ['Moneda',          note.currency === 'USD'
          ? `USD (TC $${note.exchange_rate_value ? fmtNum(note.exchange_rate_value, 4) : '—'})`
          : 'MXN'],
        ['Domicilio',
          note.delivery_address
            ? `${note.address_alias ? note.address_alias + ' · ' : ''}${note.delivery_address}, ${note.delivery_city || ''}`
            : '—'],
      ].map(([label, val]) => (
        <div key={label} className="bg-surface-elevated/60 border border-line-strong rounded-lg px-3 py-2">
          <p className="text-[10px] font-bold text-ink-secondary uppercase tracking-wide">{label}</p>
          <p className="text-sm font-medium text-ink-primary mt-0.5 break-words">{val}</p>
        </div>
      ))}
    </div>
  )
}

// ── Tabla de líneas ──────────────────────────────────────────────────────────
function LineasTable({ note }) {
  const lines = note.lines || []
  // Remisión sin IVA — el total visible es el subtotal puro.
  // IVA se calcula al facturar (ver invoiceService).
  const subtotal = parseFloat(note.subtotal_mxn || note.total_mxn || 0)

  if (lines.length === 0) {
    return <p className="text-sm text-ink-muted text-center py-4">Sin líneas</p>
  }

  return (
    <div className="border border-line-subtle rounded-xl overflow-x-auto">
      <table className="table text-xs min-w-full">
        <thead>
          <tr>
            <th>Producto</th>
            <th className="text-right">Pedido</th>
            <th className="text-right">Entregado</th>
            <th className="text-right">P. Unit.</th>
            <th className="text-right">Importe</th>
          </tr>
        </thead>
        <tbody>
          {lines.map(l => {
            const qtyOrd = parseFloat(l.quantity_ordered || 0)
            const qtyDel = parseFloat(l.quantity_delivered || 0)
            const isPartial = qtyDel > 0 && qtyDel < qtyOrd
            const importe = parseFloat(l.subtotal || qtyDel * parseFloat(l.unit_price) * (1 - parseFloat(l.discount_pct || 0) / 100))
            return (
              <tr key={l.id}>
                <td>
                  <div className="flex items-start gap-1.5">
                    <ProductImageThumb
                      productId={l.product_id}
                      imageAttachmentId={l.image_attachment_id}
                      caption={l.product_name} />
                    <div className="min-w-0 flex-1">
                      <p className="font-medium text-ink-primary">{l.product_name}</p>
                      {l.sku && <p className="text-[10px] text-ink-muted font-mono">{l.sku}</p>}
                      {l.notes && <p className="text-[10px] text-ink-muted mt-0.5 italic">{l.notes}</p>}
                      {l.invoice_id ? (
                        <p className="text-[10px] text-teal-300 mt-0.5">
                          ✓ Facturada en <span className="font-mono">{l.invoice_number}</span>
                          {l.invoice_use_cfdi && <span className="text-ink-muted"> · uso {l.invoice_use_cfdi}</span>}
                        </p>
                      ) : (note.status === 'delivered' || note.status === 'invoiced') && (
                        <p className="text-[10px] text-status-warning mt-0.5 italic">Pendiente de facturar</p>
                      )}
                    </div>
                  </div>
                </td>
                <td className="text-right font-mono tabular-nums text-ink-secondary">{fmtNum(qtyOrd, 3)} {l.unit}</td>
                <td className={clsx('text-right font-mono tabular-nums font-medium',
                  isPartial && 'text-status-warning')}>
                  {fmtNum(qtyDel, 3)} {l.unit}
                </td>
                <td className="text-right font-mono tabular-nums">{fmtMXN(l.unit_price, note.currency)}</td>
                <td className="text-right font-mono tabular-nums font-medium">{fmtMXN(importe, note.currency)}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
      <div className="bg-surface-elevated/40 border-t border-line-subtle px-4 py-3 flex flex-col gap-1.5">
        <div className="flex justify-between text-sm font-semibold text-ink-primary">
          <span>Total remisión</span>
          <span className="font-mono tabular-nums text-brand-300">{fmtMXN(subtotal, note.currency)}</span>
        </div>
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

// ── Acciones contextuales por estado ─────────────────────────────────────────
function AccionesRemision({ note, onSendEmail, onDeliver, onCancel, canceling, onDelete, deleting }) {
  const { status } = note

  // El borrado solo aplica a remisiones que NUNCA movieron inventario
  // (issued / sent_by_email). 'partially_delivered' ya descontó stock.
  const canDelete = status === 'issued' || status === 'sent_by_email'

  if (status === 'issued' || status === 'sent_by_email' || status === 'partially_delivered') return (
    <div className="flex flex-col sm:flex-row sm:flex-wrap gap-2 border-t border-line-subtle pt-4 mt-2">
      <button onClick={onDeliver} className="btn-primary btn-sm justify-center">
        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7"/>
        </svg>
        {status === 'partially_delivered' ? 'Completar entrega' : 'Registrar entrega'}
      </button>
      <button onClick={onSendEmail} className="btn-secondary btn-sm justify-center">
        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"/>
        </svg>
        {status === 'sent_by_email' ? 'Reenviar por correo' : 'Enviar por correo'}
      </button>
      <button onClick={onCancel} disabled={canceling}
        className="btn-ghost btn-sm text-status-danger hover:bg-status-danger/10 justify-center sm:ml-auto">
        {canceling ? <Spinner size="sm" /> : (
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12"/>
          </svg>
        )}
        Cancelar remisión
      </button>
      {canDelete && (
        <Can do="sales:delete">
          <button onClick={onDelete} disabled={deleting}
            className="btn-ghost btn-sm text-status-danger hover:bg-status-danger/10 justify-center">
            {deleting ? <Spinner size="sm" /> : (
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/>
              </svg>
            )}
            Eliminar
          </button>
        </Can>
      )}
    </div>
  )

  if (status === 'delivered') return (
    <div className="border-t border-line-subtle pt-4 mt-2 flex flex-col gap-2">
      <div className="flex items-center gap-2 bg-status-success/10 border border-status-success/40 rounded-lg px-3 py-2">
        <svg className="w-4 h-4 text-status-success shrink-0" fill="currentColor" viewBox="0 0 24 24">
          <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/>
        </svg>
        <p className="text-xs text-status-success">
          Entrega completa registrada. El pago pendiente del cliente se generó automáticamente.
        </p>
      </div>
      <div className="flex gap-2">
        <button onClick={onSendEmail} className="btn-secondary btn-sm">
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"/>
          </svg>
          Enviar por correo
        </button>
      </div>
    </div>
  )

  if (status === 'invoiced') return (
    <div className="border-t border-line-subtle pt-4 mt-2 text-xs text-ink-muted italic">
      Esta remisión ya fue facturada.
    </div>
  )

  if (status === 'cancelled') return (
    <div className="border-t border-line-subtle pt-4 mt-2 flex flex-col gap-2">
      <p className="text-xs text-ink-muted italic">Esta remisión fue cancelada.</p>
      <Can do="sales:delete">
        <button onClick={onDelete} disabled={deleting}
          className="btn-ghost btn-sm text-status-danger hover:bg-status-danger/10 justify-center self-start">
          {deleting ? <Spinner size="sm" /> : (
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/>
            </svg>
          )}
          Eliminar definitivamente
        </button>
      </Can>
    </div>
  )

  return null
}

// ── Modal envío de correo ────────────────────────────────────────────────────
function EmailModal({ note, onSend, onClose, sending }) {
  const userEmail = useAuthStore(s => s.user?.email)
  const { data: tenant } = useQuery({
    queryKey: ['tenant', 'current'],
    queryFn:  tenantsApi.getCurrent,
    staleTime: 60_000,
  })
  const copyEmail = tenant?.notification_email || userEmail

  // Contactos del cliente con email
  const contactsWithEmail = (note?.contacts || []).filter(c => c?.email)

  // Estado: mapa email -> seleccionado. Si hay un solo contacto se selecciona por defecto.
  const [selected, setSelected] = useState(() => {
    const init = {}
    contactsWithEmail.forEach((c, i) => {
      init[c.email] = contactsWithEmail.length === 1 || !!c.is_primary
        // En ausencia de primario explícito, seleccionar el primero si hay varios.
        || (i === 0 && !contactsWithEmail.some(x => x.is_primary))
    })
    return init
  })
  const [extraEmails, setExtraEmails] = useState('')

  const toggleContact = (email) =>
    setSelected(s => ({ ...s, [email]: !s[email] }))

  const selectedEmails = Object.entries(selected).filter(([, v]) => v).map(([k]) => k)
  const extraList = extraEmails.split(',').map(e => e.trim()).filter(Boolean)
  const finalEmails = [...new Set([...selectedEmails, ...extraList])]
  const canSend = finalEmails.length > 0

  return createPortal(
    <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/40 p-4">
      <div className="card w-full max-w-md p-5">
        <h3 className="text-base font-semibold text-ink-primary mb-1">
          Enviar remisión {note?.document_number || ''} por correo
        </h3>
        <p className="text-xs text-ink-muted mb-4">
          Se enviará el PDF de la remisión a los contactos seleccionados.
        </p>

        {contactsWithEmail.length > 0 ? (
          <div className="border border-line-subtle rounded-lg divide-y divide-line-subtle max-h-56 overflow-y-auto">
            {contactsWithEmail.map(c => (
              <label key={c.id || c.email}
                className="flex items-start gap-2 px-3 py-2 cursor-pointer hover:bg-surface-elevated/40">
                <input
                  type="checkbox"
                  className="mt-0.5 accent-brand-600"
                  checked={!!selected[c.email]}
                  onChange={() => toggleContact(c.email)}
                />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <p className="text-sm font-medium text-ink-primary truncate">{c.name || '(Sin nombre)'}</p>
                    {c.is_primary && <span className="badge-teal text-[10px]">Principal</span>}
                  </div>
                  <p className="text-xs text-ink-muted truncate">{c.email}</p>
                </div>
              </label>
            ))}
          </div>
        ) : (
          <div className="bg-status-warning/10 border border-status-warning/40 rounded-lg px-3 py-2">
            <p className="text-xs text-status-warning">
              Este cliente no tiene contactos con correo. Agrega uno abajo o regístralo en el catálogo de clientes.
            </p>
          </div>
        )}

        <label className="block text-xs text-ink-muted mt-4 mb-1">
          Correos adicionales (separados por coma)
        </label>
        <input
          className="input"
          placeholder="contabilidad@cliente.com"
          value={extraEmails}
          onChange={e => setExtraEmails(e.target.value)}
        />

        {copyEmail && (
          <div className="mt-3 flex items-start gap-2 bg-surface-elevated/40 border border-line-subtle rounded-lg px-3 py-2">
            <svg className="w-4 h-4 text-ink-muted mt-0.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"/>
            </svg>
            <div className="text-xs text-ink-secondary">
              Se enviará copia (BCC) a <strong className="text-ink-primary">{copyEmail}</strong>
              {tenant?.notification_email
                ? <span className="text-ink-muted"> · correo institucional</span>
                : <span className="text-ink-muted"> · tu correo de usuario</span>}.
            </div>
          </div>
        )}

        <div className="flex gap-2 mt-4">
          <button onClick={onClose} className="btn-secondary flex-1" disabled={sending}>Cancelar</button>
          <button
            onClick={() => onSend(finalEmails)}
            className="btn-primary flex-1"
            disabled={sending || !canSend}>
            {sending ? <Spinner size="sm" /> : `Enviar${finalEmails.length > 0 ? ` (${finalEmails.length})` : ''}`}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}

// ── Modal: corregir precios de una remisión no facturada ─────────────────────
function PriceAdjustModal({ note, onSubmit, onClose, saving }) {
  const lines = note.lines || []
  const cur = note.currency
  const [edited, setEdited] = useState(() =>
    Object.fromEntries(lines.map(l => [l.id, {
      unitPrice:   l.unit_price != null ? String(l.unit_price) : '',
      discountPct: l.discount_pct != null ? String(l.discount_pct) : '0',
    }]))
  )
  const [reason, setReason] = useState('')

  const setField = (id, field, val) =>
    setEdited(s => ({ ...s, [id]: { ...s[id], [field]: val } }))

  const lineCalc = (l) => {
    const e = edited[l.id] || {}
    const price = Number(e.unitPrice)
    const disc  = Number(e.discountPct || 0)
    const qty   = parseFloat(l.quantity_delivered || 0)
    const validPrice = Number.isFinite(price) && price >= 0
    const validDisc  = Number.isFinite(disc) && disc >= 0 && disc < 100
    const importe = (validPrice ? price : 0) * qty * (1 - (validDisc ? disc : 0) / 100)
    const op = parseFloat(l.unit_price)
    const od = parseFloat(l.discount_pct || 0)
    const changed = validPrice && (price !== op || (validDisc ? disc : 0) !== od)
    return { price, disc, qty, validPrice, validDisc, importe, changed }
  }

  const calcs = lines.map(l => ({ l, c: lineCalc(l) }))
  const newTotal = calcs.reduce((acc, { c }) => acc + c.importe, 0)
  const allValid = calcs.every(({ c }) => c.validPrice && c.validDisc)
  const changes = calcs.filter(({ c }) => c.changed)
  const canSave = !saving && reason.trim().length >= 5 && changes.length > 0 && allValid

  function handleSave() {
    const payload = changes.map(({ l }) => ({
      lineId:      l.id,
      unitPrice:   Number(edited[l.id].unitPrice),
      discountPct: Number(edited[l.id].discountPct || 0),
    }))
    onSubmit({ lines: payload, reason: reason.trim() })
  }

  return createPortal(
    <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/40 p-4">
      <div className="card w-full max-w-2xl p-5 max-h-[92vh] overflow-y-auto">
        <h3 className="text-base font-semibold text-ink-primary mb-1">
          Corregir precios · {note.document_number}
        </h3>
        <p className="text-xs text-ink-muted mb-3">
          Ajusta el precio antes de facturar. La remisión respalda la <strong>entrega</strong> (cantidades),
          no los precios — las cantidades no se modifican aquí. El cambio se registra con tu observación
          y se refleja en el pedido y en el saldo por cobrar.
        </p>

        <div className="border border-line-subtle rounded-xl overflow-x-auto">
          <table className="table text-xs min-w-full">
            <thead>
              <tr>
                <th>Producto</th>
                <th className="text-right">Entregado</th>
                <th className="text-right">P. Unit.</th>
                <th className="text-right">Desc. %</th>
                <th className="text-right">Importe</th>
              </tr>
            </thead>
            <tbody>
              {calcs.map(({ l, c }) => (
                <tr key={l.id} className={c.changed ? 'bg-brand-500/[0.06]' : undefined}>
                  <td>
                    <p className="font-medium text-ink-primary">{l.product_name}</p>
                    {l.sku && <p className="text-[10px] text-ink-muted font-mono">{l.sku}</p>}
                  </td>
                  <td className="text-right font-mono tabular-nums text-ink-secondary whitespace-nowrap">
                    {fmtNum(c.qty, 3)} {l.unit}
                  </td>
                  <td className="text-right">
                    <input
                      type="number" min="0" step="0.0001" inputMode="decimal"
                      className={clsx('input input-sm w-28 text-right font-mono', !c.validPrice && 'input-error')}
                      value={edited[l.id]?.unitPrice ?? ''}
                      onChange={e => setField(l.id, 'unitPrice', e.target.value)}
                    />
                  </td>
                  <td className="text-right">
                    <input
                      type="number" min="0" max="99.99" step="0.01" inputMode="decimal"
                      className={clsx('input input-sm w-20 text-right font-mono', !c.validDisc && 'input-error')}
                      value={edited[l.id]?.discountPct ?? '0'}
                      onChange={e => setField(l.id, 'discountPct', e.target.value)}
                    />
                  </td>
                  <td className="text-right font-mono tabular-nums font-medium whitespace-nowrap">
                    {fmtMXN(c.importe, cur)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="bg-surface-elevated/40 border-t border-line-subtle px-4 py-2.5 flex justify-between text-sm font-semibold text-ink-primary">
            <span>Nuevo total remisión</span>
            <span className="font-mono tabular-nums text-brand-300">{fmtMXN(newTotal, cur)}</span>
          </div>
        </div>

        <label className="block text-xs font-medium text-ink-secondary mt-4 mb-1">
          Observación (obligatoria) <span className="text-status-danger">*</span>
        </label>
        <textarea
          className="input min-h-[64px]" rows={2}
          placeholder="Ej. Precio mal capturado; se corrige a la tarifa autorizada del cliente."
          value={reason}
          onChange={e => setReason(e.target.value)}
        />
        <p className="text-[10px] text-ink-muted mt-1">
          Queda registrada en el historial del documento (mínimo 5 caracteres).
        </p>

        <div className="flex gap-2 mt-4">
          <button onClick={onClose} className="btn-secondary flex-1" disabled={saving}>Cancelar</button>
          <button onClick={handleSave} className="btn-primary flex-1" disabled={!canSave}>
            {saving ? <Spinner size="sm" /> : `Guardar corrección${changes.length ? ` (${changes.length})` : ''}`}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}

// ── Panel principal ──────────────────────────────────────────────────────────
export function RemisionDetallePanel({ noteId, onClose }) {
  const qc = useQueryClient()
  const [showEntregaModal, setShowEntregaModal] = useState(false)
  const [showEmailModal, setShowEmailModal] = useState(false)
  const [showAdjustModal, setShowAdjustModal] = useState(false)
  const [actionError, setError] = useState(null)
  const [actionMsg, setMsg]     = useState(null)

  const { data: note, isLoading, error: queryError } = useQuery({
    queryKey: ['delivery-note', noteId],
    queryFn:  () => salesApi.getDeliveryNote(noteId),
    enabled:  !!noteId,
    retry:    1,
  })

  const sendEmailMutation = useMutation({
    mutationFn: (emails) => salesApi.sendEmail(noteId, emails.length ? emails : null),
    onSuccess: (r) => {
      setShowEmailModal(false)
      setMsg(r.message || `Correo enviado.`)
      qc.invalidateQueries({ queryKey: ['delivery-note', noteId] })
      qc.invalidateQueries({ queryKey: ['delivery-notes'] })
    },
    onError: (e) => setError(e.response?.data?.error || e.message || 'Error al enviar correo'),
  })

  const noInvoiceMutation = useMutation({
    mutationFn: (val) => salesApi.setNoInvoice(noteId, val),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['delivery-note', noteId] })
      qc.invalidateQueries({ queryKey: ['delivery-notes'] })
    },
    onError: (e) => setError(e.response?.data?.error || e.message || 'Error al cambiar la marca'),
  })

  const cancelMutation = useMutation({
    mutationFn: (reason) => salesApi.cancelDeliveryNote(noteId, { reason }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['delivery-note', noteId] })
      qc.invalidateQueries({ queryKey: ['delivery-notes'] })
      qc.invalidateQueries({ queryKey: ['sales-order', note?.sales_order_id] })
      qc.invalidateQueries({ queryKey: ['sales-orders'] })
    },
    onError: (e) => setError(e.response?.data?.error || e.message || 'Error al cancelar la remisión'),
  })

  function handleCancel() {
    const reason = prompt('Cancelar esta remisión. Motivo (opcional):')
    if (reason === null) return // canceló el prompt
    cancelMutation.mutate(reason.trim() || null)
  }

  // Hard delete de una remisión sin movimientos (solo admin — sales:delete).
  const deleteMutation = useMutation({
    mutationFn: () => salesApi.deleteDeliveryNote(noteId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['delivery-notes'] })
      qc.invalidateQueries({ queryKey: ['sales-order', note?.sales_order_id] })
      qc.invalidateQueries({ queryKey: ['sales-orders'] })
      onClose()
    },
    onError: (e) => setError(e.response?.data?.error || e.message || 'Error al eliminar la remisión'),
  })

  function handleDelete() {
    if (!confirm(`Eliminar de raíz la remisión ${note.document_number}? Desaparecerá por completo. Esta acción no se puede deshacer.`)) return
    setError(null); setMsg(null)
    deleteMutation.mutate()
  }

  // Corrección de precios de una remisión NO facturada (solo admin — sales:adjust_price).
  const adjustMutation = useMutation({
    mutationFn: (payload) => salesApi.adjustPrices(noteId, payload),
    onSuccess: (r) => {
      setShowAdjustModal(false)
      setError(null)
      setMsg(r.message || 'Precios corregidos.')
      qc.invalidateQueries({ queryKey: ['delivery-note', noteId] })
      qc.invalidateQueries({ queryKey: ['delivery-notes'] })
      qc.invalidateQueries({ queryKey: ['sales-order', note?.sales_order_id] })
      qc.invalidateQueries({ queryKey: ['sales-orders'] })
    },
    onError: (e) => setError(e.response?.data?.error || e.message || 'Error al corregir precios'),
  })

  // En nativo se imprime el PDF formal del backend (el HTML del cliente no
  // funciona en el webview). El parámetro showPrices pide la versión sin precios.
  async function handleNativePrint(showPrices) {
    try {
      const r = await salesApi.downloadPdf(note.id, { showPrices })
      const base = note.document_number || 'Remision'
      await printBlob(r.data, showPrices ? base : `${base}-sin-precios`)
    } catch (e) {
      alert('No se pudo imprimir: ' + (e.response?.data?.error || e.message))
    }
  }

  return createPortal(
    <div className="fixed inset-0 z-[9998] flex">
      <div className="hidden sm:block flex-1 bg-black/30" onClick={onClose} />

      <div className="w-full max-w-2xl bg-surface-primary h-full overflow-y-auto shadow-card flex flex-col">

        {/* Header */}
        <div className="sticky top-0 bg-surface-primary border-b border-line-subtle px-5 py-4 flex items-start gap-3 z-10"
          style={{ paddingTop: 'calc(1rem + env(safe-area-inset-top))' }}>
          <div className="flex-1 min-w-0">
            {isLoading ? (
              <div className="flex flex-col gap-2">
                <div className="skeleton h-5 w-40" />
                <div className="skeleton h-3 w-28" />
              </div>
            ) : note ? (
              <>
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-mono text-base font-bold text-ink-primary">{note.document_number}</span>
                  <Badge status={note.status} />
                  {(() => {
                    const total = (note.lines || []).length
                    const invoiced = (note.lines || []).filter(l => l.invoice_id).length
                    if (!total) return null
                    if (invoiced === 0 && note.no_invoice) return <span className="badge-gray">Sin factura</span>
                    if (invoiced === 0) return null
                    if (invoiced === total) {
                      // Si todas comparten una sola factura, mostrar el número.
                      const uniqueInvoices = [...new Set(note.lines.map(l => l.invoice_number).filter(Boolean))]
                      return (
                        <span className="badge-teal">
                          Facturada{uniqueInvoices.length === 1 ? ` · ${uniqueInvoices[0]}` : ` · ${uniqueInvoices.length} facturas`}
                        </span>
                      )
                    }
                    return <span className="badge-amber">Facturada parcial · {invoiced}/{total}</span>
                  })()}
                </div>
                <p className="text-xs text-ink-muted mt-1">
                  {note.partner_name} · Emitida {fmtDateOnly(note.issue_date)}
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
                <p className="text-sm font-medium text-ink-secondary">No se pudo cargar la remisión</p>
                <p className="text-xs text-status-danger mt-1">
                  {queryError.response?.data?.error || queryError.message || 'Error de conexión'}
                </p>
              </div>
            </div>
          ) : !note ? (
            <p className="text-sm text-ink-muted text-center py-8">La remisión no fue encontrada</p>
          ) : (
            <div className="flex flex-col gap-5">
              {/* Pedido relacionado */}
              {note.sales_order_id && (
                <div className="flex items-center justify-between bg-brand-500/10/50 border border-brand-100 rounded-lg px-3 py-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <svg className="w-4 h-4 text-brand-500 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"/>
                    </svg>
                    <p className="text-xs text-ink-secondary">
                      Origen:{' '}
                      <span className="font-mono font-semibold text-brand-300">{note.order_number || note.sales_order_id.substring(0, 8)}</span>
                    </p>
                  </div>
                </div>
              )}

              {/* Toggle "No requiere factura" — solo si NO tiene factura todavía */}
              {!note.invoice_id && note.status !== 'cancelled' && (
                <label className={clsx(
                  'flex items-start gap-3 cursor-pointer select-none rounded-xl px-3 py-2.5 border transition-colors',
                  note.no_invoice
                    ? 'border-line-strong bg-surface-elevated/40'
                    : 'border-line-subtle bg-surface-primary hover:border-line-strong'
                )}>
                  <input
                    type="checkbox"
                    className="w-4 h-4 accent-gray-600 rounded mt-0.5"
                    checked={!!note.no_invoice}
                    disabled={noInvoiceMutation.isPending}
                    onChange={e => { setError(null); noInvoiceMutation.mutate(e.target.checked) }}
                  />
                  <div className="flex-1">
                    <p className="text-sm font-medium text-ink-primary">
                      Esta remisión NO se va a facturar
                    </p>
                    <p className="text-[11px] text-ink-muted mt-0.5">
                      Márcala así para que no aparezca en el modal de "Nueva factura". Útil para ventas de mostrador o clientes sin RFC.
                    </p>
                  </div>
                  {noInvoiceMutation.isPending && <Spinner size="sm" />}
                </label>
              )}

              {/* Botones de impresión — disponibles en cualquier estado.
                  En la app (nativo) la impresión HTML con/sin precios no funciona
                  en el webview, así que ahí imprimimos el PDF formal del backend. */}
              <div className="flex flex-wrap gap-2">
                {Capacitor.isNativePlatform() ? (
                  <>
                    <button onClick={() => handleNativePrint(true)}
                      className="btn-secondary btn-sm flex-1">
                      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z"/>
                      </svg>
                      Imprimir con precios
                    </button>
                    <button onClick={() => handleNativePrint(false)}
                      className="btn-secondary btn-sm flex-1">
                      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z"/>
                      </svg>
                      Imprimir sin precios
                    </button>
                  </>
                ) : (
                  <>
                    <button onClick={() => printRemision(note, { showPrices: true })}
                      className="btn-secondary btn-sm flex-1">
                      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z"/>
                      </svg>
                      Imprimir con precios
                    </button>
                    <button onClick={() => printRemision(note, { showPrices: false })}
                      className="btn-secondary btn-sm flex-1">
                      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z"/>
                      </svg>
                      Imprimir sin precios
                    </button>
                  </>
                )}
              </div>

              <DatosGenerales note={note} />

              {note.notes && (
                <div className="bg-status-info/10 border border-status-info/40 rounded-lg px-3 py-2">
                  <p className="text-[10px] text-blue-400 uppercase tracking-wide mb-0.5">Notas</p>
                  <p className="text-sm text-status-info">{note.notes}</p>
                </div>
              )}

              <LineasTable note={note} />

              {/* Corregir precios — solo si la remisión NO tiene factura activa
                  ni está cancelada (permiso sales:adjust_price, solo admin). */}
              {(() => {
                const anyInvoiced = !!note.invoice_id || (note.lines || []).some(l => l.invoice_id)
                if (anyInvoiced || note.status === 'cancelled') return null
                return (
                  <Can do="sales:adjust_price">
                    <div className="flex items-center justify-between gap-2 bg-surface-elevated/40 border border-line-subtle rounded-lg px-3 py-2">
                      <p className="text-[11px] text-ink-muted">
                        ¿Precio equivocado? Corrígelo antes de facturar (queda registrado con observación).
                      </p>
                      <button onClick={() => { setError(null); setMsg(null); setShowAdjustModal(true) }}
                        className="btn-secondary btn-sm shrink-0">
                        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/>
                        </svg>
                        Corregir precios
                      </button>
                    </div>
                  </Can>
                )
              })()}

              {/* Foto de evidencia */}
              {note.receiver_photo_path && (
                <div>
                  <p className="text-xs font-bold text-brand-300 uppercase tracking-wider mb-2">
                    Evidencia de entrega
                  </p>
                  <DeliveryPhoto noteId={note.id} />
                </div>
              )}

              {actionError && (
                <div className="bg-status-danger/10 border border-status-danger/40 rounded-lg px-3 py-2">
                  <p className="text-sm text-status-danger">{actionError}</p>
                </div>
              )}
              {actionMsg && (
                <div className="bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2">
                  <p className="text-sm text-emerald-700">{actionMsg}</p>
                </div>
              )}

              <AccionesRemision
                note={note}
                onSendEmail={() => { setError(null); setMsg(null); setShowEmailModal(true) }}
                onDeliver={() => { setError(null); setShowEntregaModal(true) }}
                onCancel={() => { setError(null); handleCancel() }}
                canceling={cancelMutation.isPending}
                onDelete={handleDelete}
                deleting={deleteMutation.isPending}
              />
            </div>
          )}
        </div>
      </div>

      {showEntregaModal && note && (
        <EntregaModal
          note={note}
          onClose={() => setShowEntregaModal(false)}
          onDelivered={() => setShowEntregaModal(false)}
        />
      )}

      {showEmailModal && note && (
        <EmailModal
          note={note}
          onSend={(emails) => sendEmailMutation.mutate(emails)}
          onClose={() => setShowEmailModal(false)}
          sending={sendEmailMutation.isPending}
        />
      )}

      {showAdjustModal && note && (
        <PriceAdjustModal
          note={note}
          onSubmit={(payload) => adjustMutation.mutate(payload)}
          onClose={() => setShowAdjustModal(false)}
          saving={adjustMutation.isPending}
        />
      )}
    </div>,
    document.body
  )
}
