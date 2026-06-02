import { useState } from 'react'
import { createPortal } from 'react-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { quotationsApi } from '@/api/quotations'
import { tenantsApi } from '@/api/tenants'
import { CotizacionLineaModal } from '@/components/cotizaciones/CotizacionLineaModal'
import { ProductImageThumb } from '@/components/productos/ProductImageThumb'
import Badge from '@/components/ui/Badge'
import Spinner from '@/components/ui/Spinner'
import useAuthStore from '@/store/useAuthStore'
import { fmtMXN, fmtDate, fmtNum, fmtDateInput, fmtDateOnly} from '@/utils/fmt'
import { downloadBlob, printBlob } from '@/utils/downloadBlob'
import clsx from 'clsx'

// ── Datos generales — vista ─────────────────────────────────────────────────
function DatosGeneralesView({ q }) {
  return (
    <div className="grid grid-cols-2 gap-2">
      {[
        ['Cliente',     q.partner_name || '—'],
        ['RFC',         q.partner_rfc || '—'],
        ['Moneda',      q.currency || 'MXN'],
        ['Vigencia',    q.valid_until ? fmtDateOnly(q.valid_until) : 'Sin vigencia'],
        ['Creada por',  q.created_by_name || '—'],
        ['Enviada',     q.sent_at ? `${fmtDate(q.sent_at)}${q.sent_by_name ? ` · ${q.sent_by_name}` : ''}` : '—'],
        q.converted_at ? ['Convertida', `${fmtDate(q.converted_at)} · ${q.converted_by_name || '—'}`] : null,
        q.converted_order_number ? ['Pedido', q.converted_order_number] : null,
        q.rejected_at ? ['Rechazada', fmtDate(q.rejected_at)] : null,
        q.cancelled_at ? ['Cancelada', fmtDate(q.cancelled_at)] : null,
        q.expired_at ? ['Expirada', fmtDate(q.expired_at)] : null,
      ].filter(Boolean).map(([label, val]) => (
        <div key={label} className="bg-surface-elevated/60 border border-line-strong rounded-lg px-3 py-2">
          <p className="text-[10px] font-bold text-ink-secondary uppercase tracking-wide">{label}</p>
          <p className="text-sm font-medium text-ink-primary mt-0.5 break-words">{val}</p>
        </div>
      ))}
    </div>
  )
}

// ── Datos generales — edición (solo status=draft) ───────────────────────────
function DatosGeneralesEdit({ q, onCancel, onSaved }) {
  const qc = useQueryClient()
  const [validUntil, setValidUntil] = useState(fmtDateInput(q.valid_until) || '')
  const [notes, setNotes]           = useState(q.notes || '')
  const [currency, setCurrency]     = useState(q.currency || 'MXN')
  const [error, setError]           = useState(null)

  const mutation = useMutation({
    mutationFn: () => quotationsApi.update(q.id, {
      validUntil: validUntil || null,
      notes:      notes || null,
      currency,
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['quotation', q.id] })
      qc.invalidateQueries({ queryKey: ['quotations'] })
      onSaved?.()
    },
    onError: (e) => setError(e.response?.data?.error || e.message || 'Error al guardar'),
  })

  return (
    <div className="bg-brand-500/10 rounded-xl p-4 flex flex-col gap-3 border border-brand-500/40">
      <p className="text-xs font-semibold text-brand-300 uppercase tracking-wide">Editando datos generales</p>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label">Vigencia hasta</label>
          <input type="date" className="input" value={validUntil}
            onChange={e => setValidUntil(e.target.value)} />
        </div>
        <div>
          <label className="label">Moneda</label>
          <select className="select" value={currency} onChange={e => setCurrency(e.target.value)}>
            <option value="MXN">MXN</option>
            <option value="USD">USD</option>
          </select>
        </div>
      </div>

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

// ── Tabla de líneas (con acciones cuando editable) ──────────────────────────
function LineasTable({ q, editable, onEditLine, onDeleteLine, deletingLineId }) {
  const lines = q.lines || []
  const subtotal = parseFloat(q.subtotal_mxn ?? q.total_mxn ?? 0)

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
                      <p className="font-medium text-ink-primary">{l.product_name}</p>
                      {l.sku && <p className="text-[10px] text-ink-muted font-mono">{l.sku}</p>}
                      {l.notes && <p className="text-[10px] text-ink-muted mt-0.5 italic">{l.notes}</p>}
                    </div>
                  </div>
                </td>
                <td className="text-right font-mono tabular-nums">{fmtNum(qty, 3)} {l.unit}</td>
                <td className="text-right font-mono tabular-nums">{fmtMXN(price, q.currency)}</td>
                <td className="text-right font-mono tabular-nums">{disc > 0 ? `${fmtNum(disc, 2)}%` : '—'}</td>
                <td className="text-right font-mono tabular-nums font-medium">{fmtMXN(importe, q.currency)}</td>
                {editable && (
                  <td className="text-right">
                    <div className="flex items-center justify-end gap-1">
                      <button onClick={() => onEditLine(l)}
                        className="btn-ghost btn-icon p-1 text-ink-muted hover:text-brand-300"
                        title="Editar línea">
                        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/>
                        </svg>
                      </button>
                      <button onClick={() => onDeleteLine(l)}
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
          <span>Total cotización</span>
          <span className="font-mono tabular-nums text-brand-300">{fmtMXN(subtotal, q.currency)}</span>
        </div>
        <p className="flex items-start gap-1.5 text-[11px] text-status-warning bg-status-warning/10 border border-status-warning/40 rounded-md px-2 py-1 mt-1">
          <svg className="w-3 h-3 shrink-0 mt-0.5" fill="currentColor" viewBox="0 0 20 20">
            <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clipRule="evenodd"/>
          </svg>
          <span>El IVA (16%) se calculará al facturar el pedido derivado.</span>
        </p>
      </div>
    </div>
  )
}

// ── Modal envío por correo (multi-destinatario + PDF adjunto) ───────────────
function EmailModal({ quotation, onSend, onClose, sending }) {
  const userEmail = useAuthStore(s => s.user?.email)
  const { data: tenant } = useQuery({
    queryKey: ['tenant', 'current'],
    queryFn:  tenantsApi.getCurrent,
    staleTime: 60_000,
  })
  const copyEmail = tenant?.notification_email || userEmail

  const { data: contactsData, isLoading } = useQuery({
    queryKey: ['quotation', quotation.id, 'contacts'],
    queryFn:  () => quotationsApi.contacts(quotation.id),
    staleTime: 30_000,
  })

  const contactsWithEmail = (contactsData?.contacts || []).filter(c => c?.email)

  const [selected, setSelected] = useState({})
  const [extraEmails, setExtraEmails] = useState('')
  const [initialized, setInitialized] = useState(false)

  // Inicializar selección cuando carguen los contactos
  if (!initialized && contactsWithEmail.length > 0) {
    const init = {}
    contactsWithEmail.forEach((c, i) => {
      init[c.email] = contactsWithEmail.length === 1 || !!c.is_primary
        || (i === 0 && !contactsWithEmail.some(x => x.is_primary))
    })
    setSelected(init)
    setInitialized(true)
  }

  const toggle = (email) => setSelected(s => ({ ...s, [email]: !s[email] }))

  const selectedEmails = Object.entries(selected).filter(([, v]) => v).map(([k]) => k)
  const extraList = extraEmails.split(',').map(e => e.trim()).filter(Boolean)
  const finalEmails = [...new Set([...selectedEmails, ...extraList])]
  const canSend = finalEmails.length > 0

  return createPortal(
    <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/40 p-4">
      <div className="card w-full max-w-md p-5">
        <h3 className="text-base font-semibold text-ink-primary mb-1">
          Enviar cotización {quotation.quotation_number} por correo
        </h3>
        <p className="text-xs text-ink-muted mb-4">
          Se enviará el PDF de la cotización a los contactos seleccionados.
        </p>

        {isLoading ? (
          <div className="flex justify-center py-6"><Spinner /></div>
        ) : contactsWithEmail.length > 0 ? (
          <div className="border border-line-subtle rounded-lg divide-y divide-line-subtle max-h-56 overflow-y-auto">
            {contactsWithEmail.map(c => (
              <label key={c.id || c.email}
                className="flex items-start gap-2 px-3 py-2 cursor-pointer hover:bg-surface-elevated/40">
                <input
                  type="checkbox"
                  className="mt-0.5 accent-brand-600"
                  checked={!!selected[c.email]}
                  onChange={() => toggle(c.email)}
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

// ── Panel principal ─────────────────────────────────────────────────────────
export function CotizacionDetallePanel({ quotationId, onClose, onConverted }) {
  const qc = useQueryClient()
  const [error, setError] = useState(null)
  const [msg, setMsg]     = useState(null)
  const [showSend, setShowSend] = useState(false)
  const [editingDatos, setEditingDatos] = useState(false)
  const [lineModal, setLineModal] = useState(null) // null | { mode: 'new'|'edit', line? }
  const [deletingLineId, setDeletingLineId] = useState(null)

  const { data: q, isLoading } = useQuery({
    queryKey: ['quotation', quotationId],
    queryFn:  () => quotationsApi.get(quotationId),
    enabled:   !!quotationId,
  })

  function invalidate() {
    qc.invalidateQueries({ queryKey: ['quotation', quotationId] })
    qc.invalidateQueries({ queryKey: ['quotations'] })
  }

  const sendMut    = useMutation({
    mutationFn: (payload) => quotationsApi.send(quotationId, payload),
    onSuccess: (res) => {
      invalidate()
      setShowSend(false)
      if (res?.email?.sent) {
        setMsg(`Cotización enviada a ${res.email.recipients.join(', ')}.`)
      } else if (res?.email?.reason === 'omitido_por_operador') {
        setMsg('Cotización marcada como enviada (sin envío de correo).')
      } else if (res?.email?.reason === 'sin_destinatarios') {
        setMsg('Marcada como enviada (sin envío de correo: el cliente no tiene contactos).')
      } else if (res?.email && res.email.sent === false) {
        setError(`Status cambió a "enviada" pero el correo falló: ${res.email.reason || 'error desconocido'}. Puedes reintentar.`)
      } else {
        setMsg('Cotización marcada como enviada.')
      }
    },
    onError: (e) => setError(e.response?.data?.error || e.message),
  })
  const acceptMut  = useMutation({ mutationFn: () => quotationsApi.accept(quotationId),  onSuccess: invalidate, onError: (e) => setError(e.response?.data?.error || e.message) })
  const rejectMut  = useMutation({ mutationFn: (reason) => quotationsApi.reject(quotationId, reason),  onSuccess: invalidate, onError: (e) => setError(e.response?.data?.error || e.message) })
  const cancelMut  = useMutation({ mutationFn: () => quotationsApi.cancel(quotationId),  onSuccess: invalidate, onError: (e) => setError(e.response?.data?.error || e.message) })
  const convertMut = useMutation({
    mutationFn: () => quotationsApi.convert(quotationId),
    onSuccess: (res) => {
      invalidate()
      qc.invalidateQueries({ queryKey: ['sales-orders'] })
      onConverted?.(res.order)
    },
    onError: (e) => setError(e.response?.data?.error || e.message),
  })
  const deleteLineMut = useMutation({
    mutationFn: (lineId) => { setDeletingLineId(lineId); return quotationsApi.deleteLine(quotationId, lineId) },
    onSuccess: () => { invalidate(); setDeletingLineId(null) },
    onError: (e) => { setDeletingLineId(null); setError(e.response?.data?.error || e.message) },
  })

  async function handleDownloadPdf() {
    try {
      setError(null)
      const res = await quotationsApi.downloadPdf(quotationId)
      // Web: descarga normal. Nativo: guarda + abre menú compartir/guardar.
      await downloadBlob(res.data, `Cotizacion-${q?.quotation_number || quotationId}.pdf`)
    } catch (e) {
      setError(e.response?.data?.error || e.message || 'No se pudo generar el PDF')
    }
  }

  async function handlePrintPdf() {
    try {
      setError(null)
      const res = await quotationsApi.downloadPdf(quotationId)
      await printBlob(res.data, `Cotizacion-${q?.quotation_number || quotationId}`)
    } catch (e) {
      setError(e.response?.data?.error || e.message || 'No se pudo imprimir el PDF')
    }
  }

  const isDraft     = q?.status === 'draft'
  const isSent      = q?.status === 'sent'
  const isAccepted  = q?.status === 'accepted'
  const isConverted = q?.status === 'converted'
  // Acciones de ciclo de vida (editar/convertir/cancelar) solo en estados abiertos.
  const isClosed    = ['converted', 'rejected', 'expired', 'cancelled'].includes(q?.status)
  // El PDF y el reenvío por correo se permiten en CUALQUIER estado salvo cancelada
  // — incluso convertida a pedido (el cliente puede pedir de nuevo la cotización).
  const canSendByEmail = !!q && q.status !== 'cancelled'

  return createPortal(
    <div className="fixed inset-0 z-[9998] flex">
      <div className="hidden sm:block flex-1 bg-black/30" onClick={onClose} />

      <div className="w-full max-w-2xl bg-surface-primary h-full overflow-y-auto shadow-card flex flex-col">

        {/* Header */}
        <div className="sticky top-0 bg-surface-primary border-b border-line-subtle px-5 py-4 flex items-start gap-3 z-10"
          style={{ paddingTop: 'calc(1rem + env(safe-area-inset-top))' }}>
          <div className="flex-1 min-w-0">
            {isLoading || !q ? (
              <div className="flex flex-col gap-2">
                <div className="skeleton h-5 w-40" />
                <div className="skeleton h-3 w-28" />
              </div>
            ) : (
              <>
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-mono text-base font-bold text-ink-primary">{q.quotation_number}</span>
                  <Badge status={q.status} />
                  {q.converted_order_number && (
                    <span className="badge badge-teal">→ {q.converted_order_number}</span>
                  )}
                </div>
                <p className="text-xs text-ink-muted mt-1">
                  {q.partner_name} · Creada {fmtDate(q.created_at)}
                </p>
              </>
            )}
          </div>
          <button onClick={onClose} className="btn-ghost btn-icon text-ink-muted shrink-0">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12"/>
            </svg>
          </button>
        </div>

        {/* Contenido */}
        <div className="flex-1 p-5">
          {isLoading || !q ? (
            <div className="flex justify-center py-16"><Spinner /></div>
          ) : (
            <div className="flex flex-col gap-5">
              {/* Datos generales */}
              {editingDatos ? (
                <DatosGeneralesEdit q={q} onCancel={() => setEditingDatos(false)} onSaved={() => setEditingDatos(false)} />
              ) : (
                <DatosGeneralesView q={q} />
              )}

              {q.notes && !editingDatos && (
                <div className="bg-status-info/10 border border-status-info/40 rounded-lg px-3 py-2">
                  <p className="text-[10px] font-bold text-status-info uppercase tracking-wide">Notas</p>
                  <p className="text-sm text-status-info mt-0.5 break-words">{q.notes}</p>
                </div>
              )}

              {q.rejected_reason && (
                <div className="bg-status-danger/10 border border-status-danger/40 rounded-lg px-3 py-2">
                  <p className="text-[10px] font-bold text-status-danger uppercase tracking-wide">Motivo de rechazo</p>
                  <p className="text-sm text-status-danger mt-0.5 break-words">{q.rejected_reason}</p>
                </div>
              )}

              {/* Líneas */}
              <div className="flex flex-col gap-2">
                {isDraft && (
                  <div className="flex items-center justify-between">
                    <p className="text-xs font-semibold text-ink-secondary uppercase tracking-wide">Líneas</p>
                    <button onClick={() => setLineModal({ mode: 'new' })}
                      className="text-sm font-medium text-brand-300 hover:text-brand-300">
                      + Agregar línea
                    </button>
                  </div>
                )}
                <LineasTable
                  q={q}
                  editable={isDraft}
                  onEditLine={(l) => setLineModal({ mode: 'edit', line: l })}
                  onDeleteLine={(l) => {
                    if (window.confirm(`¿Eliminar la línea "${l.product_name}"?`)) {
                      deleteLineMut.mutate(l.id)
                    }
                  }}
                  deletingLineId={deletingLineId}
                />
              </div>

              {/* Documento — PDF / Imprimir / Enviar disponibles SIEMPRE, incluso
                  cuando la cotización ya se convirtió a pedido (el cliente puede
                  volver a pedir su cotización por correo). */}
              <div className="border-t border-line-subtle pt-4 flex flex-wrap gap-2">
                <button onClick={handleDownloadPdf} className="btn-secondary btn-sm">
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/>
                  </svg>
                  Descargar PDF
                </button>

                <button onClick={handlePrintPdf} className="btn-secondary btn-sm">
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z"/>
                  </svg>
                  Imprimir
                </button>

                {canSendByEmail && (
                  <button onClick={() => setShowSend(true)} className="btn-primary btn-sm">
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"/>
                    </svg>
                    {isSent ? 'Reenviar por correo' : 'Enviar por correo'}
                  </button>
                )}
              </div>

              {/* Acciones de ciclo de vida — solo en estados abiertos */}
              {!isClosed && (
                <div className="flex flex-wrap gap-2 mt-2">
                  {isDraft && !editingDatos && (
                    <button onClick={() => setEditingDatos(true)} className="btn-secondary btn-sm">
                      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/>
                      </svg>
                      Editar datos
                    </button>
                  )}

                  {isDraft && (
                    <button onClick={() => sendMut.mutate({ skipEmail: true })}
                      disabled={sendMut.isPending}
                      className="btn-ghost btn-sm text-ink-secondary">
                      Marcar enviada sin correo
                    </button>
                  )}

                  {isSent && (
                    <>
                      <button onClick={() => acceptMut.mutate()}
                        disabled={acceptMut.isPending}
                        className="btn-secondary btn-sm">
                        Marcar aceptada
                      </button>
                      <button onClick={() => convertMut.mutate()}
                        disabled={convertMut.isPending}
                        className="btn-primary btn-sm">
                        Convertir a pedido
                      </button>
                      <button onClick={() => {
                          const reason = window.prompt('Motivo del rechazo (opcional):')
                          if (reason !== null) rejectMut.mutate(reason)
                        }}
                        disabled={rejectMut.isPending}
                        className="btn-ghost btn-sm text-status-danger">
                        Rechazar
                      </button>
                    </>
                  )}
                  {isAccepted && (
                    <button onClick={() => convertMut.mutate()}
                      disabled={convertMut.isPending}
                      className="btn-primary btn-sm">
                      Convertir a pedido
                    </button>
                  )}
                  {(isDraft || isSent) && (
                    <button onClick={() => {
                        if (window.confirm('¿Cancelar esta cotización?')) cancelMut.mutate()
                      }}
                      disabled={cancelMut.isPending}
                      className="btn-ghost btn-sm text-ink-muted ml-auto">
                      Cancelar cotización
                    </button>
                  )}
                </div>
              )}

              {isConverted && q.converted_order_number && (
                <div className="bg-teal-500/10 border border-teal-500/40 rounded-lg px-3 py-3 flex items-center gap-2">
                  <svg className="w-5 h-5 text-teal-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/>
                  </svg>
                  <p className="text-sm text-teal-300">
                    Convertida al pedido <span className="font-mono font-bold">{q.converted_order_number}</span>.
                  </p>
                </div>
              )}

              {msg && (
                <div className="bg-status-success/10 border border-status-success/40 rounded-lg px-3 py-2 flex items-start gap-2">
                  <svg className="w-4 h-4 text-status-success mt-0.5 shrink-0" fill="currentColor" viewBox="0 0 20 20">
                    <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd"/>
                  </svg>
                  <p className="text-sm text-status-success">{msg}</p>
                  <button onClick={() => setMsg(null)} className="ml-auto text-status-success/60 hover:text-status-success">
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12"/>
                    </svg>
                  </button>
                </div>
              )}

              {error && (
                <div className="bg-status-danger/10 border border-status-danger/40 rounded-lg px-3 py-2 flex items-start gap-2">
                  <p className="text-sm text-status-danger flex-1">{error}</p>
                  <button onClick={() => setError(null)} className="text-status-danger/60 hover:text-status-danger">
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12"/>
                    </svg>
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Modal envío */}
      {showSend && q && (
        <EmailModal
          quotation={q}
          sending={sendMut.isPending}
          onClose={() => setShowSend(false)}
          onSend={(emails) => sendMut.mutate({ emails })}
        />
      )}

      {/* Modal línea (agregar / editar) */}
      {lineModal && q && (
        <CotizacionLineaModal
          quotation={q}
          line={lineModal.mode === 'edit' ? lineModal.line : null}
          onClose={() => setLineModal(null)}
          onSaved={() => { setLineModal(null); invalidate() }}
        />
      )}
    </div>,
    document.body
  )
}
