import { useState, useMemo, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { financialsApi } from '@/api/financials'
import { partnersApi } from '@/api/partners'
import { tenantsApi } from '@/api/tenants'
import { PagoModal } from '@/components/finanzas/PagoModal'
import Badge from '@/components/ui/Badge'
import Spinner from '@/components/ui/Spinner'
import { fmtMXN, fmtDate } from '@/utils/fmt'
import { downloadBlob } from '@/utils/downloadBlob'
import useAuthStore from '@/store/useAuthStore'
import clsx from 'clsx'

// Formas de pago SAT comunes para complemento de pago (CFDI tipo P)
const SAT_PAYMENT_FORMS = [
  ['03', 'Transferencia electrónica (SPEI)'],
  ['01', 'Efectivo'],
  ['02', 'Cheque nominativo'],
  ['04', 'Tarjeta de crédito'],
  ['28', 'Tarjeta de débito'],
  ['99', 'Por definir'],
]

const DOC_TYPE_LABEL = {
  invoice:      'Factura',
  remission:    'Remisión',
  credit_note:  'Nota de crédito',
}

const PAYMENT_METHOD_LABEL = {
  cash:                'Efectivo',
  transfer:            'Transferencia',
  check:               'Cheque',
  advance_application: 'Aplicación de anticipo',
  credit_note:         'Nota de crédito',
}

// ── Bloque de info según tipo de documento origen ───────────────────────────
function DocumentoOrigen({ ar }) {
  const src = ar.sourceDoc
  if (!src) return null

  if (ar.document_type === 'invoice') {
    const isPPD = src.payment_method === 'PPD'
    const isStamped = src.status === 'stamped'
    return (
      <div className="bg-status-info/10 border border-status-info/40 rounded-xl p-4 flex flex-col gap-2">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <p className="text-xs font-semibold text-status-info uppercase tracking-wide">Factura origen</p>
          <div className="flex items-center gap-2">
            {isStamped && <Badge status="stamped" />}
            <span className={clsx(
              'text-[10px] font-bold px-1.5 py-0.5 rounded-full uppercase tracking-wide',
              isPPD ? 'bg-status-warning/15 text-status-warning' : 'bg-surface-elevated/60 text-ink-secondary'
            )}>
              {isPPD ? 'PPD · requiere complemento' : 'PUE'}
            </span>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2 text-xs">
          <div>
            <span className="text-ink-muted">Folio:</span>{' '}
            <span className="font-mono font-semibold">{src.document_number}</span>
          </div>
          {src.stamp_date && (
            <div>
              <span className="text-ink-muted">Timbrado:</span> {fmtDate(src.stamp_date)}
            </div>
          )}
          {src.cfdi_uuid && (
            <div className="col-span-2">
              <span className="text-ink-muted">UUID:</span>{' '}
              <span className="font-mono text-[10px] break-all">{src.cfdi_uuid}</span>
            </div>
          )}
          {src.delivery_note_id && (
            <div className="col-span-2 text-[11px] text-ink-muted italic">
              Esta factura se generó desde una remisión.
            </div>
          )}
        </div>
      </div>
    )
  }

  if (ar.document_type === 'remission') {
    return (
      <div className="bg-purple-500/10 border border-purple-500/40 rounded-xl p-4 flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <p className="text-xs font-semibold text-purple-300 uppercase tracking-wide">Remisión origen</p>
          <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-surface-elevated/60 text-ink-secondary uppercase tracking-wide">
            Sin timbre
          </span>
        </div>
        <div className="grid grid-cols-2 gap-2 text-xs">
          <div>
            <span className="text-ink-muted">Folio:</span>{' '}
            <span className="font-mono font-semibold">{src.document_number}</span>
          </div>
          {src.sales_order_number && (
            <div>
              <span className="text-ink-muted">Pedido:</span>{' '}
              <span className="font-mono font-semibold">{src.sales_order_number}</span>
            </div>
          )}
          {src.delivered_at && (
            <div>
              <span className="text-ink-muted">Entregada:</span> {fmtDate(src.delivered_at)}
            </div>
          )}
          {src.receiver_name && (
            <div>
              <span className="text-ink-muted">Receptor:</span> {src.receiver_name}
            </div>
          )}
        </div>
      </div>
    )
  }

  return null
}

// ── Pagos aplicados ──────────────────────────────────────────────────────────
function PagosAplicados({ payments, partnerId }) {
  const [loadingKey, setLoadingKey] = useState(null)
  const [error, setError]           = useState(null)
  const [sending, setSending]       = useState(null)  // payment object

  if (!payments?.length) {
    return (
      <p className="text-sm text-ink-muted italic text-center py-4">
        Aún no se han registrado pagos para este documento.
      </p>
    )
  }

  async function downloadReceipt(p) {
    const key = `pdf-${p.id}`
    setError(null); setLoadingKey(key)
    try {
      const r = await financialsApi.downloadReceiptPdf(p.id)
      const dateStr = p.payment_date
        ? new Date(p.payment_date).toISOString().slice(0, 10)
        : p.id.slice(-6)
      downloadBlob(r.data, `recibo-pago-${dateStr}.pdf`)
    } catch (e) {
      setError(e.response?.data?.error || e.message || 'Error al descargar el recibo')
    } finally {
      setLoadingKey(null)
    }
  }

  return (
    <>
      {error && (
        <div className="mb-2 bg-status-danger/10 border border-status-danger/40 rounded-lg px-3 py-2 flex items-center justify-between">
          <p className="text-xs text-status-danger">{error}</p>
          <button onClick={() => setError(null)} className="text-status-danger">×</button>
        </div>
      )}
      <div className="border border-line-subtle rounded-xl overflow-x-auto">
        <table className="table text-xs min-w-full">
          <thead>
            <tr>
              <th>Fecha</th>
              <th>Método</th>
              <th>Banco</th>
              <th>Referencia</th>
              <th>Registró</th>
              <th className="text-right">Importe</th>
              <th className="text-right">Recibo</th>
            </tr>
          </thead>
          <tbody>
            {payments.map(p => (
              <tr key={p.id}>
                <td className="text-ink-secondary">{fmtDate(p.payment_date)}</td>
                <td>{PAYMENT_METHOD_LABEL[p.payment_method] || p.payment_method}</td>
                <td className="text-ink-secondary text-[11px]">
                  {p.bank_name
                    ? <>
                        {p.bank_name}
                        {p.bank_alias && <span className="text-ink-muted"> · {p.bank_alias}</span>}
                      </>
                    : <span className="text-ink-muted">—</span>}
                </td>
                <td className="font-mono text-ink-secondary">{p.reference || '—'}</td>
                <td className="text-ink-secondary">{p.created_by_name || '—'}</td>
                <td className="text-right font-mono tabular-nums font-semibold text-status-success">
                  {fmtMXN(p.amount)}
                </td>
                <td className="text-right whitespace-nowrap">
                  <button onClick={() => downloadReceipt(p)} disabled={!!loadingKey}
                    className="btn-ghost btn-sm" title="Descargar recibo en PDF">
                    {loadingKey === `pdf-${p.id}` ? <Spinner size="sm" /> : 'PDF'}
                  </button>
                  <button onClick={() => setSending(p)} disabled={!!loadingKey}
                    className="btn-ghost btn-sm text-brand-300" title="Enviar recibo por correo">
                    Enviar
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {sending && (
        <EnviarReciboModal
          partnerId={partnerId}
          payment={sending}
          onClose={() => setSending(null)}
          onSent={() => setSending(null)}
        />
      )}
    </>
  )
}

// ── Panel principal ──────────────────────────────────────────────────────────
export function CxCDetallePanel({ arId, onClose }) {
  const qc = useQueryClient()
  const [showPagoModal, setShowPagoModal] = useState(false)
  const [showComplementModal, setShowComplementModal] = useState(false)
  const [paidMsg, setPaidMsg] = useState(null)

  const { data: ar, isLoading, error: queryError } = useQuery({
    queryKey: ['cxc', arId],
    queryFn:  () => financialsApi.getCXC(arId),
    enabled:  !!arId,
    retry:    1,
  })

  const hasPending = ar && parseFloat(ar.amount_pending) > 0.01

  // Para PPD: ¿queda monto cobrado sin complementar?
  // Lo calculamos client-side a partir de los pagos visibles y el campo
  // `complement_total` que ya devuelve listCXC. Aquí no lo tenemos aún, pero
  // podemos aproximar como SUM(payments) - 0 (los complementos vienen
  // en una nueva propiedad opcional ar.complement_total más adelante).
  const isPPD = ar?.document_type === 'invoice'
             && ar.sourceDoc?.payment_method === 'PPD'
             && ar.sourceDoc?.status === 'stamped'
  const totalPaid = useMemo(
    () => (ar?.payments || []).reduce((s, p) => s + parseFloat(p.amount || 0), 0),
    [ar?.payments]
  )
  const totalComplemented = parseFloat(ar?.complement_total || 0)
  const missingComplement = +(totalPaid - totalComplemented).toFixed(2)
  const canStampComplement = isPPD && missingComplement > 0.01

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
            ) : ar ? (
              <>
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-[10px] font-bold uppercase tracking-wide bg-surface-elevated/60 text-ink-secondary px-1.5 py-0.5 rounded-full">
                    {DOC_TYPE_LABEL[ar.document_type] || ar.document_type}
                  </span>
                  <span className="font-mono text-base font-bold text-ink-primary">{ar.document_number}</span>
                  <Badge status={ar.is_overdue ? 'overdue' : ar.status} />
                </div>
                <p className="text-xs text-ink-muted mt-1">
                  {ar.partner_name} · Emitido {fmtDate(ar.issue_date)}
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
                {queryError.response?.data?.error || queryError.message || 'Error al cargar el documento'}
              </p>
            </div>
          ) : !ar ? (
            <p className="text-sm text-ink-muted text-center py-8">El documento no fue encontrado</p>
          ) : (
            <div className="flex flex-col gap-5">
              {paidMsg && (
                <div className="flex items-center gap-2 bg-status-success/10 border border-status-success/40 rounded-lg px-3 py-2">
                  <svg className="w-4 h-4 text-status-success shrink-0" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/>
                  </svg>
                  <p className="text-sm text-status-success flex-1">{paidMsg}</p>
                  <button onClick={() => setPaidMsg(null)} className="text-status-success hover:text-status-success">
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12"/>
                    </svg>
                  </button>
                </div>
              )}

              {/* Importes */}
              <div className={clsx('grid gap-2',
                parseFloat(ar.amount_credited || 0) > 0 ? 'grid-cols-4' : 'grid-cols-3')}>
                <div className="bg-surface-elevated/40 rounded-lg px-3 py-2">
                  <p className="text-[10px] text-ink-muted uppercase tracking-wide">Total</p>
                  <p className="text-sm font-mono font-semibold text-ink-primary">{fmtMXN(ar.amount_total, ar.currency)}</p>
                </div>
                <div className="bg-status-success/10 rounded-lg px-3 py-2">
                  <p className="text-[10px] text-green-500 uppercase tracking-wide">Pagado</p>
                  <p className="text-sm font-mono font-semibold text-status-success">{fmtMXN(ar.amount_paid, ar.currency)}</p>
                </div>
                {parseFloat(ar.amount_credited || 0) > 0 && (
                  <div className="bg-purple-500/10 rounded-lg px-3 py-2">
                    <p className="text-[10px] text-purple-500 uppercase tracking-wide">N. crédito</p>
                    <p className="text-sm font-mono font-semibold text-purple-300">
                      {fmtMXN(ar.amount_credited, ar.currency)}
                    </p>
                  </div>
                )}
                <div className={clsx('rounded-lg px-3 py-2',
                  hasPending ? (ar.is_overdue ? 'bg-status-danger/10' : 'bg-status-warning/10') : 'bg-surface-elevated/40')}>
                  <p className={clsx('text-[10px] uppercase tracking-wide',
                    hasPending ? (ar.is_overdue ? 'text-status-danger' : 'text-amber-500') : 'text-ink-muted')}>
                    Pendiente
                  </p>
                  <p className={clsx('text-sm font-mono font-semibold',
                    hasPending ? (ar.is_overdue ? 'text-status-danger' : 'text-status-warning') : 'text-ink-muted')}>
                    {fmtMXN(ar.amount_pending, ar.currency)}
                  </p>
                </div>
              </div>

              {/* Datos del documento */}
              <div className="grid grid-cols-2 gap-2">
                {[
                  ['Cliente',        ar.partner_name],
                  ['RFC',            ar.partner_rfc || '—'],
                  ['F. emisión',     fmtDate(ar.issue_date)],
                  ['F. vencimiento', fmtDate(ar.due_date)],
                ].map(([label, val]) => (
                  <div key={label} className="bg-surface-elevated/60 border border-line-strong rounded-lg px-3 py-2">
                    <p className="text-[10px] font-bold text-ink-secondary uppercase tracking-wide">{label}</p>
                    <p className="text-sm font-medium text-ink-primary mt-0.5">{val}</p>
                  </div>
                ))}
              </div>

              {ar.notes && (
                <div className="bg-status-info/10 border border-status-info/40 rounded-lg px-3 py-2">
                  <p className="text-[10px] text-blue-400 uppercase tracking-wide mb-0.5">Notas</p>
                  <p className="text-sm text-status-info">{ar.notes}</p>
                </div>
              )}

              {/* Documento origen (factura o remisión) */}
              <DocumentoOrigen ar={ar} />

              {/* Pagos aplicados */}
              <div>
                <p className="text-xs font-bold text-brand-300 uppercase tracking-wider mb-2">
                  Pagos aplicados ({ar.payments?.length || 0})
                </p>
                <PagosAplicados payments={ar.payments} partnerId={ar.partner_id} />
              </div>

              {/* Complementos de pago timbrados (solo factura PPD) */}
              {isPPD && ar.paymentComplements?.length > 0 && (
                <div>
                  <p className="text-xs font-bold text-brand-300 uppercase tracking-wider mb-2">
                    Complementos timbrados ({ar.paymentComplements.length})
                  </p>
                  <ComplementsList
                    partnerId={ar.partner_id}
                    complements={ar.paymentComplements}
                  />
                </div>
              )}

              {/* Acciones */}
              <div className="flex flex-wrap gap-2 border-t border-line-subtle pt-4 mt-2">
                {hasPending ? (
                  <button onClick={() => setShowPagoModal(true)} className="btn-primary btn-sm">
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>
                    </svg>
                    Registrar pago
                  </button>
                ) : (
                  <div className="flex items-center gap-2 bg-status-success/10 border border-status-success/40 rounded-lg px-3 py-2 flex-1">
                    <svg className="w-4 h-4 text-status-success shrink-0" fill="currentColor" viewBox="0 0 24 24">
                      <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/>
                    </svg>
                    <p className="text-xs text-status-success flex-1">Documento totalmente pagado.</p>
                  </div>
                )}
                {isPPD && (
                  <button
                    onClick={() => canStampComplement && setShowComplementModal(true)}
                    disabled={!canStampComplement}
                    title={
                      canStampComplement
                        ? `Timbrar complemento por ${fmtMXN(missingComplement, ar.currency)} faltantes`
                        : 'No hay pagos pendientes de complementar'
                    }
                    className={clsx(
                      'btn-sm flex items-center gap-1.5',
                      canStampComplement
                        ? 'btn-secondary'
                        : 'btn-secondary opacity-40 cursor-not-allowed'
                    )}>
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/>
                    </svg>
                    {canStampComplement
                      ? `Generar complemento (${fmtMXN(missingComplement, ar.currency)})`
                      : 'Complemento al día'}
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {showPagoModal && ar && (
        <PagoModal
          prefilledPartnerId={ar.partner_id}
          prefilledArId={ar.id}
          onClose={() => setShowPagoModal(false)}
          onSaved={(res) => {
            const parts = [`Pago de ${fmtMXN(res.amount)} registrado. Aplicado ${fmtMXN(res.totalApplied)}`]
            if (res.advanceGenerated) parts.push(`+ anticipo ${fmtMXN(res.advanceGenerated)}`)
            if (res.complementsIssued?.length) parts.push(`· ${res.complementsIssued.length} complemento(s) timbrado(s)`)
            if (res.complementsSkipped?.length) {
              parts.push(`· Sin complemento: ${res.complementsSkipped.map(s => s.reason).join(' · ')}`)
            }
            setPaidMsg(parts.join(' '))
            qc.invalidateQueries({ queryKey: ['cxc', arId] })
          }}
        />
      )}

      {showComplementModal && ar && (
        <StampComplementModal
          ar={ar}
          missing={missingComplement}
          onClose={() => setShowComplementModal(false)}
          onStamped={(res) => {
            setPaidMsg(`Complemento timbrado: ${fmtMXN(res.amount, ar.currency)} · UUID ${res.uuid}`)
            setShowComplementModal(false)
            qc.invalidateQueries({ queryKey: ['cxc', arId] })
            qc.invalidateQueries({ queryKey: ['cxc'] })
          }}
        />
      )}
    </div>,
    document.body
  )
}

// ── Lista de complementos timbrados con acciones PDF/XML/Enviar ─────────────
function ComplementsList({ partnerId, complements }) {
  const [loadingKey, setLoadingKey] = useState(null)
  const [error, setError]           = useState(null)
  const [sending, setSending]       = useState(null) // complement object

  async function download(pc, kind) {
    const key = `${kind}-${pc.id}`
    setError(null); setLoadingKey(key)
    try {
      const fn = kind === 'xml'
        ? () => financialsApi.downloadComplementXml(pc.facturapi_id)
        : () => financialsApi.downloadComplementPdf(pc.facturapi_id)
      const r = await fn()
      const dateStr = pc.payment_date ? new Date(pc.payment_date).toISOString().slice(0, 10) : pc.facturapi_id
      downloadBlob(r.data, `complemento-${dateStr}.${kind}`)
    } catch (e) {
      setError(e.response?.data?.error || e.message || `Error al descargar ${kind.toUpperCase()}`)
    } finally {
      setLoadingKey(null)
    }
  }

  return (
    <>
      {error && (
        <div className="mb-2 bg-status-danger/10 border border-status-danger/40 rounded-lg px-3 py-2 flex items-center justify-between">
          <p className="text-xs text-status-danger">{error}</p>
          <button onClick={() => setError(null)} className="text-status-danger">×</button>
        </div>
      )}
      <div className="border border-teal-500/40 rounded-xl overflow-hidden divide-y divide-teal-50">
        {complements.map(pc => (
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
              <button onClick={() => download(pc, 'pdf')} disabled={!!loadingKey}
                className="btn-secondary btn-sm">
                {loadingKey === `pdf-${pc.id}` ? <Spinner size="sm" /> : 'PDF'}
              </button>
              <button onClick={() => download(pc, 'xml')} disabled={!!loadingKey}
                className="btn-ghost btn-sm">
                {loadingKey === `xml-${pc.id}` ? <Spinner size="sm" /> : 'XML'}
              </button>
              <button onClick={() => setSending(pc)} disabled={!!loadingKey || pc.status === 'cancelled'}
                className="btn-ghost btn-sm text-brand-300">
                Enviar
              </button>
            </div>
          </div>
        ))}
      </div>

      {sending && (
        <EnviarComplementoModal
          partnerId={partnerId}
          complement={sending}
          onClose={() => setSending(null)}
          onSent={() => setSending(null)}
        />
      )}
    </>
  )
}

// ── Modal: enviar complemento por correo ─────────────────────────────────────
function EnviarComplementoModal({ partnerId, complement, onClose, onSent }) {
  const userEmail = useAuthStore(s => s.user?.email)
  const { data: tenant } = useQuery({
    queryKey: ['tenant', 'current'],
    queryFn:  tenantsApi.getCurrent,
    staleTime: 60_000,
  })
  const copyEmail = tenant?.notification_email || userEmail

  const { data: partner, isLoading } = useQuery({
    queryKey: ['partner', partnerId],
    queryFn:  () => partnersApi.get(partnerId),
    enabled:  !!partnerId,
  })

  const contactsWithEmail = (partner?.contacts || []).filter(c => c?.email)

  const [selected, setSelected] = useState({})
  const [extraEmails, setExtraEmails] = useState('')
  const [error, setError] = useState(null)

  // Preseleccionar principal o todos si solo hay uno
  useEffect(() => {
    if (!contactsWithEmail.length) return
    const init = {}
    const hasPrimary = contactsWithEmail.some(x => x.is_primary)
    contactsWithEmail.forEach((c, i) => {
      init[c.email] = contactsWithEmail.length === 1
                   || !!c.is_primary
                   || (!hasPrimary && i === 0)
    })
    setSelected(init)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [partner?.id])

  const toggle = (email) => setSelected(s => ({ ...s, [email]: !s[email] }))

  const selectedEmails = Object.entries(selected).filter(([, v]) => v).map(([k]) => k)
  const extraList = extraEmails.split(',').map(e => e.trim()).filter(Boolean)
  const finalEmails = [...new Set([...selectedEmails, ...extraList])]

  const mutation = useMutation({
    mutationFn: () => financialsApi.sendComplementEmail(complement.id, finalEmails),
    onSuccess: () => onSent(),
    onError: (e) => setError(e.response?.data?.error || e.message || 'Error al enviar'),
  })

  return createPortal(
    <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/40 p-4">
      <div className="card w-full max-w-md p-5">
        <div className="flex items-center justify-between mb-1">
          <h3 className="text-base font-semibold text-ink-primary">Enviar complemento de pago</h3>
          <button onClick={onClose} className="text-ink-muted hover:text-ink-secondary">×</button>
        </div>
        <p className="text-xs text-ink-muted mb-4">
          Se enviará el XML + PDF del complemento {fmtMXN(complement.amount, complement.currency)}
          {' '}del {fmtDate(complement.payment_date)} a los destinatarios seleccionados.
        </p>

        {isLoading ? (
          <div className="flex justify-center py-6"><Spinner /></div>
        ) : contactsWithEmail.length > 0 ? (
          <div className="border border-line-subtle rounded-lg divide-y divide-line-subtle max-h-56 overflow-y-auto">
            {contactsWithEmail.map(c => (
              <label key={c.id || c.email}
                className="flex items-start gap-2 px-3 py-2 cursor-pointer hover:bg-surface-elevated/40">
                <input type="checkbox" className="mt-0.5 accent-brand-600"
                  checked={!!selected[c.email]}
                  onChange={() => toggle(c.email)} />
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
              Este cliente no tiene contactos con correo. Agrega uno abajo o regístralo en el catálogo.
            </p>
          </div>
        )}

        <label className="block text-xs text-ink-muted mt-4 mb-1">
          Correos adicionales (separados por coma)
        </label>
        <input className="input" placeholder="contabilidad@cliente.com"
          value={extraEmails} onChange={e => setExtraEmails(e.target.value)} />

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

        {error && <p className="field-error mt-3">{error}</p>}

        <div className="flex gap-2 mt-4">
          <button onClick={onClose} className="btn-secondary flex-1" disabled={mutation.isPending}>
            Cancelar
          </button>
          <button
            onClick={() => { setError(null); mutation.mutate() }}
            disabled={mutation.isPending || finalEmails.length === 0}
            className="btn-primary flex-1">
            {mutation.isPending ? <Spinner size="sm" /> : `Enviar${finalEmails.length > 0 ? ` (${finalEmails.length})` : ''}`}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}

// ── Modal: enviar recibo de pago por correo ──────────────────────────────────
function EnviarReciboModal({ partnerId, payment, onClose, onSent }) {
  const userEmail = useAuthStore(s => s.user?.email)
  const { data: tenant } = useQuery({
    queryKey: ['tenant', 'current'],
    queryFn:  tenantsApi.getCurrent,
    staleTime: 60_000,
  })
  const copyEmail = tenant?.notification_email || userEmail

  const { data: partner, isLoading } = useQuery({
    queryKey: ['partner', partnerId],
    queryFn:  () => partnersApi.get(partnerId),
    enabled:  !!partnerId,
  })

  const contactsWithEmail = (partner?.contacts || []).filter(c => c?.email)

  const [selected, setSelected] = useState({})
  const [extraEmails, setExtraEmails] = useState('')
  const [error, setError] = useState(null)
  const [msg, setMsg]     = useState(null)

  useEffect(() => {
    if (!contactsWithEmail.length) return
    const init = {}
    const hasPrimary = contactsWithEmail.some(x => x.is_primary)
    contactsWithEmail.forEach((c, i) => {
      init[c.email] = contactsWithEmail.length === 1
                   || !!c.is_primary
                   || (!hasPrimary && i === 0)
    })
    setSelected(init)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [partner?.id])

  const toggle = (email) => setSelected(s => ({ ...s, [email]: !s[email] }))

  const selectedEmails = Object.entries(selected).filter(([, v]) => v).map(([k]) => k)
  const extraList = extraEmails.split(',').map(e => e.trim()).filter(Boolean)
  const finalEmails = [...new Set([...selectedEmails, ...extraList])]

  const mutation = useMutation({
    mutationFn: () => financialsApi.sendReceiptEmail(payment.id, finalEmails),
    onSuccess: (res) => {
      setMsg(`Recibo ${res.folio} enviado a ${res.recipients.length} destinatario(s).`)
      setTimeout(onSent, 1500)
    },
    onError: (e) => setError(e.response?.data?.error || e.message || 'Error al enviar'),
  })

  return createPortal(
    <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/40 p-4">
      <div className="card w-full max-w-md p-5">
        <div className="flex items-center justify-between mb-1">
          <h3 className="text-base font-semibold text-ink-primary">Enviar recibo de pago</h3>
          <button onClick={onClose} className="text-ink-muted hover:text-ink-secondary">×</button>
        </div>
        <p className="text-xs text-ink-muted mb-4">
          Se enviará el PDF del recibo por <strong>{fmtMXN(payment.amount)}</strong> del
          {' '}{fmtDate(payment.payment_date)} a los destinatarios seleccionados.
        </p>

        {isLoading ? (
          <div className="flex justify-center py-6"><Spinner /></div>
        ) : contactsWithEmail.length > 0 ? (
          <div className="border border-line-subtle rounded-lg divide-y divide-line-subtle max-h-56 overflow-y-auto">
            {contactsWithEmail.map(c => (
              <label key={c.id || c.email}
                className="flex items-start gap-2 px-3 py-2 cursor-pointer hover:bg-surface-elevated/40">
                <input type="checkbox" className="mt-0.5 accent-brand-600"
                  checked={!!selected[c.email]} onChange={() => toggle(c.email)} />
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
              Este cliente no tiene contactos con correo. Agrega uno abajo o regístralo en el catálogo.
            </p>
          </div>
        )}

        <label className="block text-xs text-ink-muted mt-4 mb-1">
          Correos adicionales (separados por coma)
        </label>
        <input className="input" placeholder="contabilidad@cliente.com"
          value={extraEmails} onChange={e => setExtraEmails(e.target.value)} />

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

        {msg && (
          <div className="mt-3 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2">
            <p className="text-xs text-emerald-700">{msg}</p>
          </div>
        )}
        {error && <p className="field-error mt-3">{error}</p>}

        <div className="flex gap-2 mt-4">
          <button onClick={onClose} className="btn-secondary flex-1" disabled={mutation.isPending}>
            Cancelar
          </button>
          <button
            onClick={() => { setError(null); mutation.mutate() }}
            disabled={mutation.isPending || finalEmails.length === 0}
            className="btn-primary flex-1">
            {mutation.isPending ? <Spinner size="sm" /> : `Enviar${finalEmails.length > 0 ? ` (${finalEmails.length})` : ''}`}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}

// ── Modal: timbrar complemento faltante ──────────────────────────────────────
function StampComplementModal({ ar, missing, onClose, onStamped }) {
  const [paymentDate, setPaymentDate] = useState(() => new Date().toISOString().split('T')[0])
  const [paymentForm, setPaymentForm] = useState('03')
  const [reference, setReference]     = useState('')
  const [amount, setAmount]           = useState(missing.toFixed(2))
  const [exchangeRate, setExchangeRate] = useState(
    ar.currency === 'USD' ? String(parseFloat(ar.exchange_rate || 1)) : ''
  )
  const [error, setError] = useState(null)

  const mutation = useMutation({
    mutationFn: () => {
      const amt = parseFloat(amount)
      if (!amt || amt <= 0) throw new Error('Monto inválido.')
      if (amt > missing + 0.01) throw new Error(`El monto no puede exceder ${fmtMXN(missing, ar.currency)}.`)
      return financialsApi.stampMissingComplement(ar.id, {
        paymentDate,
        paymentForm,
        amount: amt,
        reference: reference.trim() || null,
        exchangeRate: ar.currency === 'USD' ? parseFloat(exchangeRate) || 1 : undefined,
      })
    },
    onSuccess: onStamped,
    onError: (e) => setError(e.response?.data?.error || e.message),
  })

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40 p-4">
      <form
        onSubmit={(e) => { e.preventDefault(); setError(null); mutation.mutate() }}
        className="card w-full max-w-md p-6 flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold text-ink-primary">Generar complemento de pago</h2>
          <button type="button" onClick={onClose} className="text-ink-muted hover:text-ink-secondary">×</button>
        </div>

        <div className="bg-status-warning/10 border border-status-warning/40 rounded-lg px-3 py-2 text-xs text-status-warning">
          Esta factura PPD tiene <strong>{fmtMXN(missing, ar.currency)}</strong> cobrados sin complemento timbrado.
          Se generará un CFDI tipo P por el monto que indiques.
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">Fecha del pago</label>
            <input type="date" className="input" value={paymentDate}
              onChange={e => setPaymentDate(e.target.value)} />
          </div>
          <div>
            <label className="label">Forma de pago SAT</label>
            <select className="select" value={paymentForm}
              onChange={e => setPaymentForm(e.target.value)}>
              {SAT_PAYMENT_FORMS.map(([v, l]) => <option key={v} value={v}>{v} · {l}</option>)}
            </select>
          </div>
        </div>

        <div>
          <label className="label">Referencia <span className="text-ink-muted">(opcional)</span></label>
          <input className="input" value={reference}
            onChange={e => setReference(e.target.value)}
            placeholder="SPEI / folio / # cheque" />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">Monto a timbrar <span className="text-status-danger">*</span></label>
            <input type="number" step="0.01" min="0" max={missing} className="input font-mono"
              value={amount} onChange={e => setAmount(e.target.value)} />
            <p className="text-[11px] text-ink-muted mt-0.5">Máx {fmtMXN(missing, ar.currency)}</p>
          </div>
          {ar.currency === 'USD' && (
            <div>
              <label className="label">TC del pago</label>
              <input type="number" step="0.0001" min="0" className="input font-mono"
                value={exchangeRate} onChange={e => setExchangeRate(e.target.value)} />
              <p className="text-[11px] text-ink-muted mt-0.5">Default: TC de la factura</p>
            </div>
          )}
        </div>

        {error && <p className="field-error">{error}</p>}

        <div className="flex gap-2">
          <button type="button" onClick={onClose} className="btn-secondary flex-1"
            disabled={mutation.isPending}>
            Cancelar
          </button>
          <button type="submit" className="btn-primary flex-1" disabled={mutation.isPending}>
            {mutation.isPending ? <Spinner size="sm" /> : 'Timbrar complemento'}
          </button>
        </div>
      </form>
    </div>,
    document.body
  )
}
