import { useState, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { invoicingApi } from '@/api/invoicing'
import { tenantsApi } from '@/api/tenants'
import Badge from '@/components/ui/Badge'
import Spinner from '@/components/ui/Spinner'
import { fmtMXN, fmtDate, fmtNum } from '@/utils/fmt'
import { downloadBlob } from '@/utils/downloadBlob'
import useAuthStore from '@/store/useAuthStore'
import clsx from 'clsx'

// ── Datos fiscales y de pago ────────────────────────────────────────────────
function DatosGenerales({ invoice }) {
  const isPPD = invoice.payment_method === 'PPD'
  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-2">
        {[
          ['Cliente',          invoice.partner_name || '—'],
          ['Razón social',     invoice.receptor_legal_name || invoice.partner_tax_name || invoice.partner_name || '—'],
          ['RFC',              invoice.rfc || '—'],
          ['F. emisión',       fmtDate(invoice.issue_date)],
          ['F. timbrado',      fmtDate(invoice.stamp_date)],
          ['Moneda',           invoice.currency === 'USD'
            ? `USD (TC $${invoice.exchange_rate_value ? fmtNum(invoice.exchange_rate_value, 4) : '—'})`
            : 'MXN'],
          ['Uso CFDI',         invoice.use_cfdi || invoice.cfdi_use || '—'],
          ['OC del cliente',   invoice.po_number || '—'],
        ].map(([label, val]) => (
          <div key={label} className="bg-surface-elevated/60 border border-line-strong rounded-lg px-3 py-2">
            <p className="text-[10px] font-bold text-ink-secondary uppercase tracking-wide">{label}</p>
            <p className="text-sm font-medium text-ink-primary mt-0.5 break-words">{val}</p>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div className={clsx('rounded-lg px-3 py-2',
          isPPD ? 'bg-status-warning/10 border border-status-warning/40' : 'bg-surface-elevated/40')}>
          <p className={clsx('text-[10px] uppercase tracking-wide',
            isPPD ? 'text-amber-500' : 'text-ink-muted')}>Método de pago</p>
          <p className={clsx('text-sm font-medium mt-0.5',
            isPPD ? 'text-status-warning' : 'text-ink-primary')}>
            {invoice.payment_method || '—'}
            {isPPD && ' · requiere complemento'}
          </p>
        </div>
        <div className="bg-surface-elevated/60 border border-line-strong rounded-lg px-3 py-2">
          <p className="text-[10px] font-bold text-ink-secondary uppercase tracking-wide">Forma de pago</p>
          <p className="text-sm font-medium text-ink-primary mt-0.5">{invoice.payment_form || '—'}</p>
        </div>
      </div>

      {invoice.cfdi_uuid && (
        <div className="bg-status-info/10 border border-status-info/40 rounded-lg px-3 py-2">
          <p className="text-[10px] text-blue-400 uppercase tracking-wide">UUID CFDI</p>
          <p className="text-xs font-mono text-status-info mt-0.5 break-all">{invoice.cfdi_uuid}</p>
        </div>
      )}

      {(invoice.remission_number || invoice.order_number) && (
        <div className="bg-purple-500/10/50 border border-purple-500/40 rounded-lg px-3 py-2 flex items-center gap-2">
          <svg className="w-4 h-4 text-purple-500 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4"/>
          </svg>
          <p className="text-xs text-ink-secondary">
            Origen:{' '}
            {invoice.remission_number && (
              <>Remisión <span className="font-mono font-semibold text-purple-300">{invoice.remission_number}</span></>
            )}
            {invoice.remission_number && invoice.order_number && ' · '}
            {invoice.order_number && (
              <>Pedido <span className="font-mono font-semibold text-brand-300">{invoice.order_number}</span></>
            )}
          </p>
        </div>
      )}
    </div>
  )
}

// ── Tabla de líneas ──────────────────────────────────────────────────────────
function LineasTable({ invoice }) {
  const lines = invoice.lines || []
  if (lines.length === 0) {
    return <p className="text-sm text-ink-muted text-center py-4">Sin líneas</p>
  }
  const subtotal = parseFloat(invoice.subtotal || 0)
  const tax      = parseFloat(invoice.tax_transferred || 0)
  const total    = parseFloat(invoice.total || subtotal + tax)

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
          </tr>
        </thead>
        <tbody>
          {lines.map(l => {
            const qty   = parseFloat(l.quantity || 0)
            const price = parseFloat(l.unit_price || 0)
            const disc  = parseFloat(l.discount_pct || 0)
            const importe = qty * price * (1 - disc / 100)
            const wasRevalued = !!l.original_currency && l.original_unit_price != null &&
                                l.applied_exchange_rate != null
            return (
              <tr key={l.id}>
                <td>
                  <p className="font-medium text-ink-primary">{l.description || l.product_name}</p>
                  {l.sku && <p className="text-[10px] text-ink-muted font-mono">{l.sku}</p>}
                </td>
                <td className="text-right font-mono tabular-nums">
                  {fmtNum(qty, 3)} {l.unit}
                  {l.pack_factor && Number(l.pack_factor) > 1 && (
                    <p className="text-[10px] text-ink-muted mt-0.5">
                      = {fmtNum(qty * Number(l.pack_factor), 2)} base
                    </p>
                  )}
                </td>
                <td className="text-right font-mono tabular-nums">
                  {fmtMXN(price, invoice.currency)}
                  {wasRevalued && (
                    <p className="text-[10px] text-status-warning mt-0.5">
                      {l.original_currency} ${Number(l.original_unit_price).toFixed(2)} × TC {Number(l.applied_exchange_rate).toFixed(4)}
                      {l.applied_exchange_rate_date && (
                        <span className="text-ink-muted"> ({fmtDate(l.applied_exchange_rate_date)})</span>
                      )}
                    </p>
                  )}
                </td>
                <td className="text-right font-mono tabular-nums">{disc > 0 ? `${fmtNum(disc, 2)}%` : '—'}</td>
                <td className="text-right font-mono tabular-nums font-medium">{fmtMXN(importe, invoice.currency)}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
      <div className="bg-surface-elevated/40 border-t border-line-subtle px-4 py-3 flex flex-col gap-1">
        <div className="flex justify-between text-xs text-ink-muted">
          <span>Subtotal</span>
          <span className="font-mono tabular-nums">{fmtMXN(subtotal, invoice.currency)}</span>
        </div>
        <div className="flex justify-between text-xs text-ink-muted">
          <span>IVA</span>
          <span className="font-mono tabular-nums">{fmtMXN(tax, invoice.currency)}</span>
        </div>
        <div className="flex justify-between text-sm font-semibold text-ink-primary border-t border-line-subtle pt-1.5 mt-0.5">
          <span>Total</span>
          <span className="font-mono tabular-nums text-brand-300">{fmtMXN(total, invoice.currency)}</span>
        </div>
      </div>
    </div>
  )
}

// ── Sección Complementos de pago emitidos ────────────────────────────────────
function PaymentComplementsSection({ invoice, loadingAction, setError, setLoadingAction }) {
  async function download(pc, kind) {
    const action = `pc-${kind}-${pc.facturapi_id}`
    setError(null); setLoadingAction(action)
    try {
      const fn = kind === 'xml'
        ? () => invoicingApi.downloadComplementXml(invoice.id, pc.facturapi_id)
        : () => invoicingApi.downloadComplementPdf(invoice.id, pc.facturapi_id)
      const r = await fn()
      downloadBlob(r.data, `complemento-${invoice.document_number}-${fmtDate(pc.payment_date)}.${kind}`)
    } catch (e) {
      setError(e.response?.data?.error || e.message || `Error al descargar ${kind.toUpperCase()}`)
    } finally {
      setLoadingAction(null)
    }
  }

  return (
    <div className="border border-teal-500/40 rounded-xl overflow-hidden">
      <div className="bg-teal-500/10 px-3 py-2 border-b border-teal-500/40 flex items-center gap-2">
        <svg className="w-4 h-4 text-teal-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h18M7 15h2m4 0h2M5 7h14a2 2 0 012 2v10a2 2 0 01-2 2H5a2 2 0 01-2-2V9a2 2 0 012-2z"/>
        </svg>
        <p className="text-xs font-semibold text-teal-300 uppercase tracking-wide">
          Complementos de pago · {invoice.paymentComplements.length}
        </p>
      </div>
      <div className="divide-y divide-teal-50">
        {invoice.paymentComplements.map(pc => (
          <div key={pc.id} className="px-3 py-2 flex items-center gap-3">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <Badge status={pc.status} />
                <span className="font-mono font-medium text-ink-primary text-sm">
                  {fmtMXN(pc.amount, pc.currency)}
                </span>
                <span className="text-[11px] text-ink-muted">{fmtDate(pc.payment_date)}</span>
                <span className="text-[11px] text-ink-muted">· forma {pc.payment_form}</span>
                {pc.reference && <span className="text-[11px] text-ink-muted">· ref {pc.reference}</span>}
              </div>
              {pc.cfdi_uuid && (
                <p className="text-[10px] text-ink-muted font-mono mt-0.5 break-all">UUID: {pc.cfdi_uuid}</p>
              )}
            </div>
            <div className="flex gap-1">
              <button onClick={() => download(pc, 'pdf')}
                disabled={!!loadingAction}
                className="btn-secondary btn-sm">
                {loadingAction === `pc-pdf-${pc.facturapi_id}` ? <Spinner size="sm" /> : 'PDF'}
              </button>
              <button onClick={() => download(pc, 'xml')}
                disabled={!!loadingAction}
                className="btn-ghost btn-sm">
                {loadingAction === `pc-xml-${pc.facturapi_id}` ? <Spinner size="sm" /> : 'XML'}
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Modal complemento de pago ────────────────────────────────────────────────
const COMPLEMENT_FORM_OPTS = [
  ['03', '03 — Transferencia electrónica'],
  ['01', '01 — Efectivo'],
  ['02', '02 — Cheque nominativo'],
  ['04', '04 — Tarjeta de crédito'],
  ['28', '28 — Tarjeta de débito'],
]

function PaymentComplementModal({ invoice, onConfirm, onClose, loading }) {
  const [paymentDate, setPaymentDate] = useState(new Date().toISOString().slice(0, 10))
  const [paymentForm, setPaymentForm] = useState('03')
  const [amount, setAmount]           = useState('')
  const [reference, setReference]     = useState('')
  const [exchangeRate, setExchangeRate] = useState(
    invoice.currency === 'USD' ? String(invoice.exchange_rate_value || '') : ''
  )

  const isUSD = invoice.currency === 'USD'
  // Pendiente = total - lo ya cobrado por complementos previos
  const alreadyPaid = (invoice.paymentComplements || [])
    .filter(pc => pc.status !== 'cancelled')
    .reduce((s, pc) => s + parseFloat(pc.amount || 0), 0)
  const pending = parseFloat(invoice.total || 0) - alreadyPaid
  const numAmount = parseFloat(amount) || 0
  const exceeds = numAmount > pending + 0.005
  const canSend = !loading && numAmount > 0 && !exceeds && paymentForm && paymentDate &&
                  (!isUSD || parseFloat(exchangeRate) > 0)

  return createPortal(
    <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/40 p-4">
      <div className="card w-full max-w-md p-5">
        <h3 className="text-base font-semibold text-ink-primary mb-1">
          Registrar pago · {invoice.document_number}
        </h3>
        <p className="text-xs text-ink-muted mb-4">
          Genera un CFDI tipo P (complemento de pago) y aplica el cobro al saldo del cliente.
        </p>

        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label">Fecha del pago <span className="text-status-danger">*</span></label>
              <input type="date" className="input"
                value={paymentDate}
                onChange={e => setPaymentDate(e.target.value)}
                disabled={loading} />
            </div>
            <div>
              <label className="label">Forma de pago <span className="text-status-danger">*</span></label>
              <select className="select" value={paymentForm} onChange={e => setPaymentForm(e.target.value)} disabled={loading}>
                {COMPLEMENT_FORM_OPTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </div>
          </div>

          <div>
            <label className="label">Monto recibido <span className="text-status-danger">*</span></label>
            <input type="number" step="0.01" min="0"
              className={clsx('input', exceeds && 'border-status-danger/40')}
              value={amount}
              onChange={e => setAmount(e.target.value)}
              disabled={loading}
              placeholder={fmtMXN(pending, invoice.currency)} />
            <p className="text-[11px] text-ink-muted mt-1">
              Saldo pendiente: <span className="font-mono font-semibold">{fmtMXN(pending, invoice.currency)}</span>
            </p>
            {exceeds && (
              <p className="text-[11px] text-status-danger mt-1">
                El monto excede el saldo pendiente.
              </p>
            )}
          </div>

          <div>
            <label className="label">Referencia (opcional)</label>
            <input className="input"
              value={reference}
              onChange={e => setReference(e.target.value)}
              placeholder="Folio de transferencia, número de cheque, etc."
              disabled={loading} />
          </div>

          {isUSD && (
            <div>
              <label className="label">Tipo de cambio aplicado <span className="text-status-danger">*</span></label>
              <input type="number" step="0.0001" min="0"
                className="input"
                value={exchangeRate}
                onChange={e => setExchangeRate(e.target.value)}
                disabled={loading} />
              <p className="text-[11px] text-ink-muted mt-1">
                TC del DOF en la fecha del pago. La factura fue emitida a {parseFloat(invoice.exchange_rate_value || 1).toFixed(4)}.
              </p>
            </div>
          )}
        </div>

        <div className="flex gap-2 mt-4">
          <button onClick={onClose} className="btn-secondary flex-1" disabled={loading}>Cancelar</button>
          <button
            onClick={() => onConfirm({
              paymentDate,
              paymentForm,
              amount: numAmount,
              currency: invoice.currency,
              reference: reference.trim() || undefined,
              exchangeRate: isUSD ? parseFloat(exchangeRate) : undefined,
            })}
            className="btn-primary flex-1"
            disabled={!canSend}>
            {loading ? <Spinner size="sm" /> : 'Emitir complemento'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}

// ── Sección Notas de crédito emitidas ────────────────────────────────────────
function CreditNotesSection({ invoice, loadingAction, setError, setLoadingAction }) {
  async function download(cn, kind) {
    const action = `cn-${kind}-${cn.id}`
    setError(null); setLoadingAction(action)
    try {
      const fn = kind === 'xml'
        ? () => invoicingApi.downloadCreditNoteXml(invoice.id, cn.id)
        : () => invoicingApi.downloadCreditNotePdf(invoice.id, cn.id)
      const r = await fn()
      downloadBlob(r.data, `${cn.document_number}.${kind}`)
    } catch (e) {
      setError(e.response?.data?.error || e.message || `Error al descargar ${kind.toUpperCase()}`)
    } finally {
      setLoadingAction(null)
    }
  }

  return (
    <div className="border border-purple-500/40 rounded-xl overflow-hidden">
      <div className="bg-purple-500/10 px-3 py-2 border-b border-purple-500/40 flex items-center gap-2">
        <svg className="w-4 h-4 text-purple-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/>
        </svg>
        <p className="text-xs font-semibold text-purple-300 uppercase tracking-wide">
          Notas de crédito emitidas · {invoice.creditNotes.length}
        </p>
      </div>
      <div className="divide-y divide-purple-50">
        {invoice.creditNotes.map(cn => {
          const motivo = (cn.notes || '').split('—').slice(1).join('—').trim() || '—'
          return (
            <div key={cn.id} className="px-3 py-2 flex items-center gap-3">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-mono font-semibold text-purple-300 text-sm">{cn.document_number}</span>
                  <Badge status={cn.status} />
                  <span className="font-mono font-medium text-ink-primary text-sm">{fmtMXN(cn.total, invoice.currency)}</span>
                </div>
                <p className="text-[11px] text-ink-muted mt-0.5">
                  {motivo} · {fmtDate(cn.stamp_date)}
                </p>
                {cn.cfdi_uuid && (
                  <p className="text-[10px] text-ink-muted font-mono mt-0.5 break-all">UUID: {cn.cfdi_uuid}</p>
                )}
              </div>
              <div className="flex gap-1">
                <button onClick={() => download(cn, 'pdf')}
                  disabled={!!loadingAction}
                  className="btn-secondary btn-sm">
                  {loadingAction === `cn-pdf-${cn.id}` ? <Spinner size="sm" /> : 'PDF'}
                </button>
                <button onClick={() => download(cn, 'xml')}
                  disabled={!!loadingAction}
                  className="btn-ghost btn-sm">
                  {loadingAction === `cn-xml-${cn.id}` ? <Spinner size="sm" /> : 'XML'}
                </button>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── Modal envío de correo ────────────────────────────────────────────────────
function EmailModal({ invoice, onSend, onClose, sending }) {
  const userEmail = useAuthStore(s => s.user?.email)
  const { data: tenant } = useQuery({
    queryKey: ['tenant', 'current'],
    queryFn:  tenantsApi.getCurrent,
    staleTime: 60_000,
  })
  const copyEmail = tenant?.notification_email || userEmail

  const contactsWithEmail = (invoice?.contacts || []).filter(c => c?.email)

  const [selected, setSelected] = useState(() => {
    const init = {}
    const hasPrimary = contactsWithEmail.some(x => x.is_primary)
    contactsWithEmail.forEach((c, i) => {
      init[c.email] =
        contactsWithEmail.length === 1 ||
        !!c.is_primary ||
        (!hasPrimary && i === 0)
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
          Enviar factura {invoice?.document_number || ''} por correo
        </h3>
        <p className="text-xs text-ink-muted mb-4">
          Se enviará el XML + PDF timbrado a los contactos seleccionados.
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
              Se enviará copia a <strong className="text-ink-primary">{copyEmail}</strong>
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

// ── Modal editar borrador ────────────────────────────────────────────────────
const USO_CFDI_OPTS = [
  ['G01', 'G01 — Adquisición de mercancías'],
  ['G02', 'G02 — Devoluciones, descuentos o bonificaciones'],
  ['G03', 'G03 — Gastos en general'],
  ['I01', 'I01 — Construcciones'],
  ['I02', 'I02 — Mobiliario y equipo'],
  ['I04', 'I04 — Equipo de cómputo'],
  ['S01', 'S01 — Sin efectos fiscales'],
  ['CP01', 'CP01 — Pagos'],
]
const PAYMENT_METHOD_OPTS = [
  ['PUE', 'PUE — Pago en una sola exhibición'],
  ['PPD', 'PPD — Pago en parcialidades o diferido'],
]
const PAYMENT_FORM_OPTS = [
  ['01', '01 — Efectivo'],
  ['02', '02 — Cheque nominativo'],
  ['03', '03 — Transferencia electrónica'],
  ['04', '04 — Tarjeta de crédito'],
  ['28', '28 — Tarjeta de débito'],
  ['99', '99 — Por definir'],
]

function EditDraftModal({ invoice, onSave, onClose, saving }) {
  const [fields, setFields] = useState({
    receptorLegalName: invoice.receptor_legal_name || '',
    receptorTaxRegime: invoice.receptor_tax_regime || '',
    receptorZipCode:   invoice.receptor_zip_code || '',
    paymentMethod:     invoice.payment_method || 'PUE',
    paymentForm:       invoice.payment_form   || '99',
    useCfdi:           invoice.use_cfdi       || 'G01',
    exportacion:       invoice.exportacion    || '01',
    poNumber:          invoice.po_number      || '',
    issueDate:         invoice.issue_date     ? String(invoice.issue_date).slice(0, 10) : '',
    notes:             invoice.notes          || '',
  })

  function set(key, val) { setFields(f => ({ ...f, [key]: val })) }

  return createPortal(
    <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/40 p-4">
      <div className="card w-full max-w-2xl p-5 max-h-[92vh] overflow-y-auto">
        <h3 className="text-base font-semibold text-ink-primary mb-1">
          Editar factura {invoice.document_number}
        </h3>
        <p className="text-xs text-ink-muted mb-4">
          Solo se editan metadatos del CFDI. Las líneas de producto provienen de la remisión y no se modifican aquí.
        </p>

        <div className="flex flex-col gap-4">
          {/* Datos del receptor */}
          <section className="border border-line-subtle rounded-lg p-3">
            <p className="text-xs font-bold text-brand-300 uppercase tracking-wider mb-2">Receptor</p>
            <div className="flex flex-col gap-3">
              <div>
                <label className="label">Razón social (override por factura)</label>
                <input className="input"
                  value={fields.receptorLegalName}
                  onChange={e => set('receptorLegalName', e.target.value)}
                  placeholder={invoice.partner_tax_name || invoice.partner_name || ''} />
                <p className="text-[11px] text-ink-muted mt-1">
                  Si lo dejas vacío se usa la del catálogo: <strong>{invoice.partner_tax_name || invoice.partner_name || '—'}</strong>
                </p>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="label">Régimen fiscal</label>
                  <input className="input"
                    value={fields.receptorTaxRegime}
                    onChange={e => set('receptorTaxRegime', e.target.value)}
                    placeholder="p.ej. 601, 612, 626" />
                </div>
                <div>
                  <label className="label">CP fiscal</label>
                  <input className="input"
                    value={fields.receptorZipCode}
                    onChange={e => set('receptorZipCode', e.target.value)}
                    placeholder="5 dígitos" />
                </div>
              </div>
              <p className="text-[11px] text-ink-muted">
                RFC y datos del cliente se administran en el catálogo de clientes.
              </p>
            </div>
          </section>

          {/* Datos del CFDI */}
          <section className="border border-line-subtle rounded-lg p-3">
            <p className="text-xs font-bold text-brand-300 uppercase tracking-wider mb-2">CFDI</p>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label">Uso CFDI</label>
                <select className="select" value={fields.useCfdi} onChange={e => set('useCfdi', e.target.value)}>
                  {USO_CFDI_OPTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              </div>
              <div>
                <label className="label">Fecha emisión</label>
                <input type="date" className="input"
                  value={fields.issueDate}
                  onChange={e => set('issueDate', e.target.value)} />
              </div>
              <div>
                <label className="label">Método de pago</label>
                <select className="select" value={fields.paymentMethod} onChange={e => set('paymentMethod', e.target.value)}>
                  {PAYMENT_METHOD_OPTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              </div>
              <div>
                <label className="label">Forma de pago</label>
                <select className="select" value={fields.paymentForm} onChange={e => set('paymentForm', e.target.value)}>
                  {PAYMENT_FORM_OPTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              </div>
              <div>
                <label className="label">OC del cliente</label>
                <input className="input"
                  value={fields.poNumber}
                  onChange={e => set('poNumber', e.target.value)}
                  placeholder="Opcional" />
              </div>
              <div>
                <label className="label">Exportación</label>
                <select className="select" value={fields.exportacion} onChange={e => set('exportacion', e.target.value)}>
                  <option value="01">01 — No aplica</option>
                  <option value="02">02 — Definitiva</option>
                  <option value="03">03 — Temporal</option>
                </select>
              </div>
            </div>
          </section>

          {/* Notas */}
          <div>
            <label className="label">Notas</label>
            <textarea className="input" rows={3}
              value={fields.notes}
              onChange={e => set('notes', e.target.value)}
              placeholder="Observaciones internas (no salen al CFDI)" />
          </div>
        </div>

        <div className="flex gap-2 mt-5">
          <button onClick={onClose} className="btn-secondary flex-1" disabled={saving}>Cancelar</button>
          <button onClick={() => onSave(fields)} className="btn-primary flex-1" disabled={saving}>
            {saving ? <Spinner size="sm" /> : 'Guardar cambios'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}

// ── Modal cancelar ante SAT ──────────────────────────────────────────────────
const SAT_MOTIVES = [
  ['02', '02 — Comprobante emitido con errores sin relación'],
  ['01', '01 — Comprobante emitido con errores con relación (requiere sustitución)'],
  ['03', '03 — No se llevó a cabo la operación'],
  ['04', '04 — Operación nominativa relacionada en factura global'],
]

function CancelSatModal({ invoice, onConfirm, onClose, loading }) {
  const [motive, setMotive] = useState('02')
  const [substitution, setSubstitution] = useState('')
  const [pickedReplacement, setPicked] = useState(null)   // { id, document_number, cfdi_uuid, total_mxn, issue_date }
  const [searchMode, setSearchMode] = useState('picker')  // 'picker' | 'manual'
  const [search, setSearch] = useState('')

  const requiresSubstitution = motive === '01'

  // Cargar facturas timbradas del MISMO cliente para escogerlas por folio.
  const { data: replacementsData } = useQuery({
    queryKey: ['invoices-stamped', invoice.partner_id],
    queryFn:  () => invoicingApi.list({
      status: 'stamped', partnerId: invoice.partner_id, limit: 100,
    }),
    enabled: requiresSubstitution && searchMode === 'picker' && !!invoice.partner_id,
    staleTime: 30_000,
  })
  const allReplacements = (replacementsData?.data || [])
    .filter(r => r.id !== invoice.id && r.cfdi_uuid)  // descartar la actual y sin UUID

  const filteredReplacements = useMemo(() => {
    if (!search.trim()) return allReplacements.slice(0, 15)
    const q = search.trim().toLowerCase()
    return allReplacements.filter(r =>
      (r.document_number || '').toLowerCase().includes(q) ||
      (r.cfdi_uuid       || '').toLowerCase().includes(q)
    ).slice(0, 15)
  }, [allReplacements, search])

  // El UUID efectivo viene del picker o del input manual.
  const effectiveUuid = searchMode === 'manual'
    ? substitution.trim()
    : (pickedReplacement?.cfdi_uuid || '')
  const validUuid = /^[0-9a-fA-F-]{36}$/.test(effectiveUuid)
  const canSend = !loading && (!requiresSubstitution || validUuid)

  return createPortal(
    <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/40 p-4">
      <div className="card w-full max-w-lg p-5 max-h-[92vh] overflow-y-auto">
        <h3 className="text-base font-semibold text-ink-primary mb-1">
          Cancelar ante SAT · {invoice.document_number}
        </h3>
        <p className="text-xs text-ink-muted mb-4">
          La cancelación se solicita a Facturapi y queda registrada en el SAT.
          El AR del cliente se reactiva en la remisión origen (si aplica).
        </p>

        <label className="label">Motivo de cancelación</label>
        <select className="select" value={motive} onChange={e => setMotive(e.target.value)} disabled={loading}>
          {SAT_MOTIVES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>

        {requiresSubstitution && (
          <div className="mt-3 flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <label className="label mb-0">
                Factura que sustituye <span className="text-status-danger">*</span>
              </label>
              <button type="button"
                onClick={() => {
                  setSearchMode(searchMode === 'picker' ? 'manual' : 'picker')
                  setPicked(null); setSubstitution('')
                }}
                className="text-[11px] text-brand-300 hover:underline"
                disabled={loading}>
                {searchMode === 'picker' ? '✎ Pegar UUID manualmente' : '🔍 Buscar por folio'}
              </button>
            </div>

            {searchMode === 'picker' ? (
              <div className="border border-line-subtle rounded-xl overflow-hidden">
                <input
                  className="input border-0 border-b border-line-subtle rounded-none text-sm"
                  placeholder="Buscar folio o UUID del mismo cliente..."
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  disabled={loading} />
                <div className="max-h-56 overflow-y-auto divide-y divide-line-subtle">
                  {filteredReplacements.length === 0 ? (
                    <p className="p-3 text-xs text-ink-muted text-center">
                      No hay facturas timbradas del cliente <strong>{invoice.partner_name}</strong> que puedan sustituir esta.
                    </p>
                  ) : filteredReplacements.map(r => (
                    <button key={r.id} type="button"
                      onClick={() => setPicked(r)}
                      className={clsx(
                        'w-full text-left px-3 py-2 hover:bg-surface-elevated/40 transition-colors',
                        pickedReplacement?.id === r.id && 'bg-brand-500/10'
                      )}>
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-mono text-sm font-semibold text-brand-300">
                          {r.document_number}
                        </span>
                        <span className="text-xs text-ink-muted font-mono">
                          {fmtMXN(r.total_mxn)}
                        </span>
                      </div>
                      <p className="text-[10px] text-ink-muted font-mono break-all">
                        {r.cfdi_uuid}
                      </p>
                      <p className="text-[10px] text-ink-muted">
                        {fmtDate(r.issue_date)}
                        {r.remission_number && <> · remisión {r.remission_number}</>}
                      </p>
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <input
                className="input font-mono text-xs"
                placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                value={substitution}
                onChange={e => setSubstitution(e.target.value)}
                disabled={loading} />
            )}

            {pickedReplacement && searchMode === 'picker' && (
              <div className="bg-brand-500/10 border border-brand-100 rounded-lg px-3 py-2 text-xs">
                <p className="text-brand-300">
                  ✓ Sustituida por <strong>{pickedReplacement.document_number}</strong>
                </p>
                <p className="text-[10px] text-brand-300/70 font-mono break-all mt-0.5">
                  UUID: {pickedReplacement.cfdi_uuid}
                </p>
              </div>
            )}

            <p className="text-[11px] text-ink-muted">
              Motivo 01 requiere que la factura sustituta ya esté timbrada (no draft).
            </p>
          </div>
        )}

        <div className="bg-status-danger/10 border border-status-danger/40 rounded-lg px-3 py-2 mt-4">
          <p className="text-xs text-status-danger">
            Esta operación es irreversible. Verifica el motivo antes de continuar.
          </p>
        </div>

        <div className="flex gap-2 mt-4">
          <button onClick={onClose} className="btn-secondary flex-1" disabled={loading}>Cancelar</button>
          <button
            onClick={() => onConfirm({
              motive,
              substitution: requiresSubstitution ? effectiveUuid : undefined,
            })}
            className="btn-danger flex-1"
            disabled={!canSend}>
            {loading ? <Spinner size="sm" /> : 'Cancelar ante SAT'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}

// ── Modal nota de crédito ────────────────────────────────────────────────────
const CN_REASONS = [
  ['return',     'Devolución de mercancía'],
  ['discount',   'Descuento / bonificación'],
  ['correction', 'Corrección de monto'],
]

function CreditNoteModal({ invoice, onConfirm, onClose, loading }) {
  const [mode, setMode] = useState('amount')  // 'amount' | 'lines'
  const [reason, setReason]           = useState('discount')
  const [amount, setAmount]           = useState('')
  const [description, setDescription] = useState('')
  const [paymentForm, setPaymentForm] = useState(invoice.payment_form || '03')
  // Modo "por línea": cantidad a devolver por cada invoice_line_id
  const [lineQtys, setLineQtys]       = useState({})

  function setLineQty(id, val) { setLineQtys(s => ({ ...s, [id]: val })) }

  const invoiceLines = invoice.lines || []
  const invoiceSubtotal = parseFloat(invoice.subtotal || 0)

  // Cálculos modo amount
  const numAmount = parseFloat(amount) || 0
  const amountExceeds = numAmount > invoiceSubtotal

  // Cálculos modo lines: suma de qty × precio × (1 - disc)
  const linesPayload = invoiceLines.map(l => {
    const qty = parseFloat(lineQtys[l.id] || 0)
    if (!qty || qty <= 0) return null
    if (qty > parseFloat(l.quantity)) return { invoiceLineId: l.id, quantity: qty, invalid: true }
    const price = parseFloat(l.unit_price)
    const disc  = parseFloat(l.discount_pct || 0)
    return {
      invoiceLineId: l.id,
      quantity:      qty,
      lineSubtotal:  qty * price * (1 - disc / 100),
    }
  }).filter(Boolean)
  const linesAnyInvalid = linesPayload.some(l => l.invalid)
  const linesSubtotal = linesPayload.reduce((s, l) => s + (l.lineSubtotal || 0), 0)

  // Subtotal/total según modo
  const finalSubtotal = mode === 'lines' ? linesSubtotal : numAmount
  const finalTax      = finalSubtotal * 0.16
  const finalTotal    = finalSubtotal * 1.16

  const canSend = !loading && finalSubtotal > 0 && (
    mode === 'amount' ? !amountExceeds : !linesAnyInvalid
  )

  function handleSubmit() {
    const base = {
      reason,
      description: description.trim() || undefined,
      paymentForm,
    }
    if (mode === 'lines') {
      onConfirm({
        ...base,
        lines: linesPayload.map(l => ({ invoiceLineId: l.invoiceLineId, quantity: l.quantity })),
      })
    } else {
      onConfirm({ ...base, amount: numAmount })
    }
  }

  return createPortal(
    <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/40 p-4">
      <div className="card w-full max-w-xl p-5 max-h-[92vh] overflow-y-auto">
        <h3 className="text-base font-semibold text-ink-primary mb-1">
          Nota de crédito · {invoice.document_number}
        </h3>
        <p className="text-xs text-ink-muted mb-4">
          Emite un CFDI tipo E vinculado a la factura. Reduce el saldo del AR del cliente.
        </p>

        {/* Toggle de modo */}
        <div className="grid grid-cols-2 gap-2 mb-4">
          {[
            { value: 'amount', label: 'Por monto',  desc: 'Descuento o corrección global' },
            { value: 'lines',  label: 'Por línea',  desc: 'Devolución de productos específicos' },
          ].map(opt => (
            <button key={opt.value} type="button"
              onClick={() => { setMode(opt.value); if (opt.value === 'lines') setReason('return') }}
              disabled={loading}
              className={clsx(
                'flex flex-col gap-0.5 rounded-xl px-3 py-2 border-2 transition-colors text-left',
                mode === opt.value ? 'border-purple-500 bg-purple-500/10' : 'border-line-subtle bg-surface-primary hover:border-line-strong'
              )}>
              <span className="text-sm font-semibold text-ink-primary">{opt.label}</span>
              <span className="text-[11px] text-ink-muted">{opt.desc}</span>
            </button>
          ))}
        </div>

        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label">Motivo</label>
              <select className="select" value={reason} onChange={e => setReason(e.target.value)} disabled={loading}>
                {CN_REASONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </div>
            <div>
              <label className="label">Forma de pago</label>
              <select className="select" value={paymentForm} onChange={e => setPaymentForm(e.target.value)} disabled={loading}>
                <option value="01">01 — Efectivo</option>
                <option value="02">02 — Cheque</option>
                <option value="03">03 — Transferencia</option>
                <option value="04">04 — Tarjeta de crédito</option>
                <option value="28">28 — Tarjeta de débito</option>
                <option value="99">99 — Por definir</option>
              </select>
            </div>
          </div>

          {mode === 'amount' ? (
            <>
              <div>
                <label className="label">Descripción (opcional)</label>
                <input className="input"
                  value={description}
                  onChange={e => setDescription(e.target.value)}
                  placeholder="Texto que aparecerá en el concepto del CFDI"
                  disabled={loading} />
              </div>
              <div>
                <label className="label">Monto sin IVA <span className="text-status-danger">*</span></label>
                <input type="number" step="0.01" min="0"
                  className={clsx('input', amountExceeds && 'border-status-danger/40')}
                  value={amount}
                  onChange={e => setAmount(e.target.value)}
                  disabled={loading} />
                {amountExceeds && (
                  <p className="text-[11px] text-status-danger mt-1">
                    El monto no puede exceder el subtotal de la factura ({fmtMXN(invoiceSubtotal, invoice.currency)}).
                  </p>
                )}
              </div>
            </>
          ) : (
            <div className="border border-line-subtle rounded-lg overflow-hidden">
              <div className="bg-surface-elevated/40 px-3 py-1.5 text-[10px] font-semibold text-ink-muted uppercase tracking-wide">
                Productos de la factura
              </div>
              {invoiceLines.length === 0 ? (
                <p className="text-xs text-ink-muted italic px-3 py-4">Esta factura no tiene líneas.</p>
              ) : (
                <div className="divide-y divide-line-subtle">
                  {invoiceLines.map(l => {
                    const qtyMax = parseFloat(l.quantity)
                    const qty    = parseFloat(lineQtys[l.id] || 0)
                    const excess = qty > qtyMax
                    return (
                      <div key={l.id} className="px-3 py-2 flex items-center gap-3">
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium text-ink-primary truncate">{l.description}</p>
                          <p className="text-[11px] text-ink-muted">
                            Facturadas: <span className="font-mono">{qtyMax.toFixed(2)}</span> {l.unit} · {fmtMXN(l.unit_price, invoice.currency)}/{l.unit}
                          </p>
                        </div>
                        <div className="w-28">
                          <label className="text-[10px] text-ink-muted">Devolver</label>
                          <input type="number" step="0.01" min="0" max={qtyMax}
                            className={clsx('input text-right h-8 py-0', excess && 'border-status-danger/40 bg-status-danger/10')}
                            value={lineQtys[l.id] ?? ''}
                            onChange={e => setLineQty(l.id, e.target.value)}
                            disabled={loading} />
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
              {linesAnyInvalid && (
                <p className="text-[11px] text-status-danger px-3 py-2 border-t border-status-danger/40 bg-status-danger/10">
                  Una cantidad excede lo facturado en esa línea.
                </p>
              )}
            </div>
          )}

          {finalSubtotal > 0 && (
            <div className="bg-surface-elevated/40 border border-line-subtle rounded-lg p-3 flex flex-col gap-1">
              <div className="flex justify-between text-xs text-ink-muted">
                <span>Subtotal</span>
                <span className="font-mono">{fmtMXN(finalSubtotal, invoice.currency)}</span>
              </div>
              <div className="flex justify-between text-xs text-ink-muted">
                <span>IVA 16%</span>
                <span className="font-mono">{fmtMXN(finalTax, invoice.currency)}</span>
              </div>
              <div className="flex justify-between text-sm font-semibold text-ink-primary border-t border-line-subtle pt-1.5 mt-0.5">
                <span>Total de la nota</span>
                <span className="font-mono text-brand-300">{fmtMXN(finalTotal, invoice.currency)}</span>
              </div>
            </div>
          )}
        </div>

        <div className="flex gap-2 mt-4">
          <button onClick={onClose} className="btn-secondary flex-1" disabled={loading}>Cancelar</button>
          <button onClick={handleSubmit} className="btn-primary flex-1" disabled={!canSend}>
            {loading ? <Spinner size="sm" /> : 'Emitir nota de crédito'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}

// ── Modal cancelar borrador ──────────────────────────────────────────────────
function CancelModal({ onConfirm, onClose, loading }) {
  const [reason, setReason] = useState('')
  return createPortal(
    <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/40 p-4">
      <div className="card w-full max-w-md p-5">
        <h3 className="text-base font-semibold text-ink-primary mb-1">Cancelar factura</h3>
        <p className="text-xs text-ink-muted mb-4">
          Solo facturas en borrador. Esta acción no se puede deshacer.
          Si era desde remisión, el pago pendiente vuelve al tipo "Remisión".
        </p>
        <textarea rows={3} className="input w-full"
          placeholder="Motivo (opcional)..."
          value={reason} onChange={e => setReason(e.target.value)} />
        <div className="flex gap-2 mt-4">
          <button onClick={onClose} className="btn-secondary flex-1" disabled={loading}>No, conservar</button>
          <button onClick={() => onConfirm(reason)} className="btn-danger flex-1" disabled={loading}>
            {loading ? <Spinner size="sm" /> : 'Sí, cancelar'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}

// ── Panel principal ──────────────────────────────────────────────────────────
export function FacturaDetallePanel({ invoiceId, onClose }) {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [showEmailModal, setShowEmailModal] = useState(false)
  const [showCancelModal, setShowCancelModal] = useState(false)
  const [showEditModal, setShowEditModal] = useState(false)
  const [showCancelSatModal, setShowCancelSatModal] = useState(false)
  const [showCreditNoteModal, setShowCreditNoteModal] = useState(false)
  const [showComplementModal, setShowComplementModal] = useState(false)
  const [loadingAction, setLoadingAction]   = useState(null)
  const [actionError, setError]             = useState(null)
  const [actionMsg, setMsg]                 = useState(null)
  const [missingFiscal, setMissingFiscal]   = useState(null)

  const { data: invoice, isLoading, error: queryError } = useQuery({
    queryKey: ['invoice', invoiceId],
    queryFn:  () => invoicingApi.get(invoiceId),
    enabled:  !!invoiceId,
    retry:    1,
  })

  function refresh() {
    qc.invalidateQueries({ queryKey: ['invoice', invoiceId] })
    qc.invalidateQueries({ queryKey: ['invoices'] })
  }

  const stampMutation = useMutation({
    mutationFn: () => invoicingApi.stamp(invoiceId),
    onSuccess: (r) => { refresh(); setMsg(r.message || 'Factura timbrada correctamente.') },
    onError: (e) => {
      const data = e.response?.data
      if (data?.code === 'MISSING_FISCAL_DATA' && data?.details) {
        setMissingFiscal(data.details)
        return
      }
      setError(data?.error || e.message || 'Error al timbrar')
    },
    onSettled: () => setLoadingAction(null),
  })

  // Reconcilia una factura que pudo haber quedado timbrada en Facturapi
  // pero todavía en borrador local. Solo se usa en casos raros (server cayó
  // a mitad del timbrado, timeout, etc).
  const reconcileMutation = useMutation({
    mutationFn: () => invoicingApi.reconcile(invoiceId),
    onSuccess: (r) => {
      refresh()
      if (r.reconciled) {
        setMsg(`Factura reconciliada. UUID: ${r.uuid}, folio: ${r.folio}.`)
      } else {
        setMsg(r.reason || 'No se encontró timbrado previo en Facturapi.')
      }
    },
    onError: (e) => setError(e.response?.data?.error || e.message || 'Error al reconciliar'),
    onSettled: () => setLoadingAction(null),
  })

  const cancelMutation = useMutation({
    mutationFn: (reason) => invoicingApi.cancel(invoiceId, { reason }),
    onSuccess: () => {
      refresh()
      setShowCancelModal(false)
      setMsg('Factura cancelada.')
    },
    onError: (e) => setError(e.response?.data?.error || e.message || 'Error al cancelar'),
    onSettled: () => setLoadingAction(null),
  })

  const emailMutation = useMutation({
    mutationFn: (emails) => invoicingApi.sendEmail(invoiceId, emails),
    onSuccess: (r) => {
      setShowEmailModal(false)
      setMsg(r.message || 'Correo enviado.')
    },
    onError: (e) => setError(e.response?.data?.error || e.message || 'Error al enviar'),
  })

  const editMutation = useMutation({
    mutationFn: (fields) => invoicingApi.update(invoiceId, fields),
    onSuccess: (r) => {
      refresh()
      setShowEditModal(false)
      setMsg(r.message || 'Factura actualizada.')
    },
    onError: (e) => setError(e.response?.data?.error || e.message || 'Error al actualizar'),
  })

  const cancelSatMutation = useMutation({
    mutationFn: (body) => invoicingApi.cancelSat(invoiceId, body),
    onSuccess: () => {
      refresh()
      setShowCancelSatModal(false)
      setMsg('Factura cancelada ante el SAT. El AR del cliente fue revertido.')
    },
    onError: (e) => setError(e.response?.data?.error || e.message || 'Error al cancelar ante SAT'),
  })

  const syncSatMutation = useMutation({
    mutationFn: () => invoicingApi.syncSat(invoiceId),
    onSuccess: (r) => {
      refresh()
      if (r.upToDate) {
        setMsg(`✓ Sincronizada. Estado SAT: ${r.remoteStatus}. Sin cambios.`)
      } else {
        const lines = r.changes.map(c =>
          (c.level === 'warning' ? '⚠ ' : c.level === 'info' ? 'ℹ ' : '✓ ') + c.message
        ).join(' · ')
        setMsg(`Sincronizada con SAT: ${lines}`)
      }
    },
    onError: (e) => setError(e.response?.data?.error || e.message || 'Error al sincronizar'),
  })

  const creditNoteMutation = useMutation({
    mutationFn: (body) => invoicingApi.creditNote(invoiceId, body),
    onSuccess: (r) => {
      refresh()
      setShowCreditNoteModal(false)
      setMsg(`Nota de crédito ${r.document_number} emitida. UUID ${r.uuid}.`)
    },
    onError: (e) => setError(e.response?.data?.error || e.message || 'Error al emitir nota de crédito'),
  })

  const complementMutation = useMutation({
    mutationFn: (body) => invoicingApi.paymentComplement(invoiceId, body),
    onSuccess: (r) => {
      refresh()
      qc.invalidateQueries({ queryKey: ['cxc'] })
      setShowComplementModal(false)
      setMsg(`Complemento de pago timbrado. UUID ${r.uuid}.`)
    },
    onError: (e) => setError(e.response?.data?.error || e.message || 'Error al emitir complemento'),
  })

  async function handleDownload(kind) {
    setError(null); setLoadingAction(kind)
    try {
      const downloadFn = {
        'xml-stamped': () => invoicingApi.downloadXmlStamped(invoiceId),
        'pdf-stamped': () => invoicingApi.downloadPdfStamped(invoiceId),
        'xml-draft':   () => invoicingApi.downloadXmlDraft(invoiceId),
        'pdf-draft':   () => invoicingApi.downloadPdfDraft(invoiceId),
      }[kind]
      const ext = kind.startsWith('xml') ? 'xml' : 'pdf'
      const suffix = kind.endsWith('draft') ? '-borrador' : ''
      const r = await downloadFn()
      downloadBlob(r.data, `${invoice.document_number}${suffix}.${ext}`)
    } catch (e) {
      setError(e.response?.data?.error || e.message || 'Error al descargar')
    } finally {
      setLoadingAction(null)
    }
  }

  const Btn = ({ label, onClick, variant = 'secondary', icon, disabled, action }) => (
    <button onClick={onClick} disabled={disabled || (loadingAction && loadingAction === action)}
      className={clsx(`btn-${variant} btn-sm`,
        loadingAction === action && 'opacity-60',
        disabled && 'opacity-40 cursor-not-allowed')}>
      {loadingAction === action ? <Spinner size="sm" /> : icon}
      {label}
    </button>
  )

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
            ) : invoice ? (
              <>
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-mono text-base font-bold text-ink-primary">{invoice.document_number}</span>
                  <Badge status={invoice.status} />
                  {invoice.payment_method === 'PPD' && (
                    <span className="badge-amber">PPD</span>
                  )}
                </div>
                <p className="text-xs text-ink-muted mt-1">
                  {invoice.partner_name} · Emitida {fmtDate(invoice.issue_date)}
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
              <p className="text-sm text-status-danger">
                {queryError.response?.data?.error || queryError.message || 'Error al cargar la factura'}
              </p>
            </div>
          ) : !invoice ? (
            <p className="text-sm text-ink-muted text-center py-8">La factura no fue encontrada</p>
          ) : (
            <div className="flex flex-col gap-5">
              {actionMsg && (
                <div className="flex items-center gap-2 bg-status-success/10 border border-status-success/40 rounded-lg px-3 py-2">
                  <svg className="w-4 h-4 text-status-success shrink-0" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/>
                  </svg>
                  <p className="text-sm text-status-success flex-1">{actionMsg}</p>
                  <button onClick={() => setMsg(null)} className="text-status-success hover:text-status-success">
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12"/>
                    </svg>
                  </button>
                </div>
              )}

              <DatosGenerales invoice={invoice} />

              {/* Notas de facturación del cliente — guía interna, no en CFDI */}
              {invoice.billing_notes && (
                <div className="bg-status-warning/10 border border-status-warning/40 rounded-lg px-3 py-2">
                  <p className="text-[10px] text-amber-500 uppercase tracking-wide mb-0.5 flex items-center gap-1.5">
                    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"/>
                    </svg>
                    Notas de facturación del cliente
                    <span className="font-normal normal-case text-amber-400 text-[10px]">(guía interna)</span>
                  </p>
                  <p className="text-sm text-status-warning whitespace-pre-line">{invoice.billing_notes}</p>
                </div>
              )}

              {invoice.notes && (
                <div className="bg-status-info/10 border border-status-info/40 rounded-lg px-3 py-2">
                  <p className="text-[10px] text-blue-400 uppercase tracking-wide mb-0.5">Notas de la factura</p>
                  <p className="text-sm text-status-info">{invoice.notes}</p>
                </div>
              )}

              <LineasTable invoice={invoice} />

              {invoice.creditNotes && invoice.creditNotes.length > 0 && (
                <CreditNotesSection
                  invoice={invoice}
                  loadingAction={loadingAction}
                  setError={setError}
                  setLoadingAction={setLoadingAction}
                />
              )}

              {invoice.paymentComplements && invoice.paymentComplements.length > 0 && (
                <PaymentComplementsSection
                  invoice={invoice}
                  loadingAction={loadingAction}
                  setError={setError}
                  setLoadingAction={setLoadingAction}
                />
              )}

              {actionError && (
                <div className="bg-status-danger/10 border border-status-danger/40 rounded-lg px-3 py-2">
                  <p className="text-sm text-status-danger">{actionError}</p>
                </div>
              )}

              {missingFiscal && (
                <div className="bg-status-warning/10 border border-status-warning/40 rounded-lg p-4">
                  <p className="text-sm font-semibold text-status-warning mb-1">
                    Faltan datos fiscales para timbrar
                  </p>
                  <p className="text-xs text-ink-secondary mb-2">
                    El cliente <strong>{missingFiscal.partnerName}</strong> se creó en modo "captura rápida" y no tiene los siguientes datos:
                  </p>
                  <ul className="text-xs text-ink-secondary list-disc pl-5 mb-3 space-y-0.5">
                    {missingFiscal.missingFields.map(f => (
                      <li key={f.field}>{f.label}</li>
                    ))}
                  </ul>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      className="btn-primary btn-sm"
                      onClick={() => navigate(`/socios?editPartner=${missingFiscal.partnerId}`)}
                    >
                      Completar datos del cliente
                    </button>
                    <button
                      type="button"
                      className="btn-secondary btn-sm"
                      onClick={() => setMissingFiscal(null)}
                    >
                      Cerrar
                    </button>
                  </div>
                </div>
              )}

              {/* Acciones contextuales */}
              <div className="flex flex-wrap gap-2 border-t border-line-subtle pt-4 mt-2">
                {invoice.status === 'draft' && (
                  <>
                    <Btn label="Editar" action="edit"
                      icon={<svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/>
                      </svg>}
                      onClick={() => { setError(null); setMsg(null); setShowEditModal(true) }}
                    />
                    <Btn label="Timbrar" action="stamp" variant="primary"
                      icon={<svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4M7.835 4.697a3.42 3.42 0 001.946-.806 3.42 3.42 0 014.438 0 3.42 3.42 0 001.946.806 3.42 3.42 0 013.138 3.138 3.42 3.42 0 00.806 1.946 3.42 3.42 0 010 4.438 3.42 3.42 0 00-.806 1.946 3.42 3.42 0 01-3.138 3.138 3.42 3.42 0 00-1.946.806 3.42 3.42 0 01-4.438 0 3.42 3.42 0 00-1.946-.806 3.42 3.42 0 01-3.138-3.138 3.42 3.42 0 00-.806-1.946 3.42 3.42 0 010-4.438 3.42 3.42 0 00.806-1.946 3.42 3.42 0 013.138-3.138z"/>
                      </svg>}
                      onClick={() => { setError(null); setMsg(null); setLoadingAction('stamp'); stampMutation.mutate() }}
                    />
                    <Btn label="Reconciliar con SAT" action="reconcile"
                      title="Úsalo si una factura quedó en borrador después de un timbrado fallido o si sospechas que ya se timbró en el SAT."
                      icon={<svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/>
                      </svg>}
                      onClick={() => {
                        if (!confirm('Buscar esta factura en Facturapi para ver si ya se timbró. Solo úsalo si sospechas que el timbrado se completó pero no se reflejó aquí.')) return
                        setError(null); setMsg(null); setLoadingAction('reconcile'); reconcileMutation.mutate()
                      }}
                    />
                    <Btn label="PDF borrador" action="pdf-draft"
                      icon={<svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/>
                      </svg>}
                      onClick={() => handleDownload('pdf-draft')}
                    />
                    <Btn label="XML borrador" action="xml-draft"
                      icon={<svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4"/>
                      </svg>}
                      onClick={() => handleDownload('xml-draft')}
                    />
                    <Btn label="Cancelar" variant="danger" action="cancel-draft"
                      icon={<svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12"/>
                      </svg>}
                      onClick={() => setShowCancelModal(true)}
                    />
                  </>
                )}

                {invoice.status === 'stamped' && (
                  <>
                    <Btn label="PDF timbrado" action="pdf-stamped" variant="primary"
                      icon={<svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/>
                      </svg>}
                      onClick={() => handleDownload('pdf-stamped')}
                    />
                    <Btn label="XML timbrado" action="xml-stamped"
                      icon={<svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4"/>
                      </svg>}
                      onClick={() => handleDownload('xml-stamped')}
                    />
                    <Btn label="Enviar por correo" action="email"
                      icon={<svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"/>
                      </svg>}
                      onClick={() => setShowEmailModal(true)}
                    />
                    <Btn label="Nota de crédito" action="credit-note"
                      icon={<svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 14l6-6m-5.5.5h.01m4.99 5h.01M9 19l3 3m0 0l3-3m-3 3V10m0-3l3 3M9 7l3-3 3 3"/>
                      </svg>}
                      onClick={() => { setError(null); setMsg(null); setShowCreditNoteModal(true) }}
                    />
                    {invoice.payment_method === 'PPD' && (
                      <Btn label="Registrar pago" action="complement" variant="primary"
                        icon={<svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h18M7 15h2m4 0h2M5 7h14a2 2 0 012 2v10a2 2 0 01-2 2H5a2 2 0 01-2-2V9a2 2 0 012-2z"/>
                        </svg>}
                        onClick={() => { setError(null); setMsg(null); setShowComplementModal(true) }}
                      />
                    )}
                    <Btn label="Sincronizar SAT" action="sync-sat"
                      icon={<svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/>
                      </svg>}
                      onClick={() => { setError(null); setMsg(null); syncSatMutation.mutate() }}
                      disabled={syncSatMutation.isPending}
                    />
                    <Btn label="Cancelar SAT" variant="danger" action="cancel-sat"
                      icon={<svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12"/>
                      </svg>}
                      onClick={() => { setError(null); setMsg(null); setShowCancelSatModal(true) }}
                    />
                  </>
                )}

                {invoice.status === 'cancelled' && (
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-xs text-ink-muted italic">
                      Esta factura fue cancelada{invoice.cancellation_reason && `: motivo ${invoice.cancellation_reason}`}.
                    </span>
                    {invoice.cfdi_uuid && (
                      <>
                        <button
                          onClick={async () => {
                            setError(null)
                            try {
                              const r = await invoicingApi.downloadCancellationReceiptPdf(invoiceId)
                              downloadBlob(r.data, `acuse-cancelacion-${invoice.document_number}.pdf`)
                            } catch (e) {
                              setError(e.response?.data?.error || e.message || 'Error al descargar acuse PDF')
                            }
                          }}
                          className="btn-ghost btn-sm text-status-danger"
                          title="Descargar acuse de cancelación SAT (PDF)">
                          📄 Acuse PDF
                        </button>
                        <button
                          onClick={async () => {
                            setError(null)
                            try {
                              const r = await invoicingApi.downloadCancellationReceiptXml(invoiceId)
                              downloadBlob(r.data, `acuse-cancelacion-${invoice.document_number}.xml`)
                            } catch (e) {
                              setError(e.response?.data?.error || e.message || 'Error al descargar acuse XML')
                            }
                          }}
                          className="btn-ghost btn-sm text-status-danger"
                          title="Descargar acuse de cancelación SAT (XML)">
                          📜 Acuse XML
                        </button>
                        <button
                          onClick={() => { setError(null); setMsg(null); syncSatMutation.mutate() }}
                          disabled={syncSatMutation.isPending}
                          className="btn-ghost btn-sm text-ink-secondary"
                          title="Verificar estado actual en SAT">
                          🔄 Sincronizar
                        </button>
                      </>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {showCancelModal && (
        <CancelModal
          onConfirm={(reason) => { setLoadingAction('cancel'); cancelMutation.mutate(reason) }}
          onClose={() => setShowCancelModal(false)}
          loading={cancelMutation.isPending}
        />
      )}

      {showEmailModal && (
        <EmailModal
          invoice={invoice}
          onSend={(emails) => { emailMutation.mutate(emails) }}
          onClose={() => setShowEmailModal(false)}
          sending={emailMutation.isPending}
        />
      )}

      {showEditModal && invoice && (
        <EditDraftModal
          invoice={invoice}
          onSave={(fields) => editMutation.mutate(fields)}
          onClose={() => setShowEditModal(false)}
          saving={editMutation.isPending}
        />
      )}

      {showCancelSatModal && invoice && (
        <CancelSatModal
          invoice={invoice}
          onConfirm={(body) => cancelSatMutation.mutate(body)}
          onClose={() => setShowCancelSatModal(false)}
          loading={cancelSatMutation.isPending}
        />
      )}

      {showCreditNoteModal && invoice && (
        <CreditNoteModal
          invoice={invoice}
          onConfirm={(body) => creditNoteMutation.mutate(body)}
          onClose={() => setShowCreditNoteModal(false)}
          loading={creditNoteMutation.isPending}
        />
      )}

      {showComplementModal && invoice && (
        <PaymentComplementModal
          invoice={invoice}
          onConfirm={(body) => complementMutation.mutate(body)}
          onClose={() => setShowComplementModal(false)}
          loading={complementMutation.isPending}
        />
      )}
    </div>,
    document.body
  )
}
