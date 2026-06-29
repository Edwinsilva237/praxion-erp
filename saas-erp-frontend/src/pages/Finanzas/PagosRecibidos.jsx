import { useState, useMemo, useCallback, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { useQuery } from '@tanstack/react-query'
import { financialsApi } from '@/api/financials'
import { partnersApi } from '@/api/partners'
import { useTableSort } from '@/hooks/useTableSort'
import { SortableHeader } from '@/components/ui/SortableHeader'
import Autocomplete from '@/components/ui/Autocomplete'
import Spinner from '@/components/ui/Spinner'
import { fmtMXN, fmtDateOnly } from '@/utils/fmt'
import { downloadBlob } from '@/utils/downloadBlob'
import SendDocEmailModal from '@/components/finanzas/SendDocEmailModal'

// Un cobro tiene complemento (CFDI tipo P) descargable cuando llega su
// facturapi_id y el complemento NO está cancelado.
const hasComplement = (row) =>
  !!row?.complement_facturapi_id && row?.complement_status !== 'cancelled'

const METHOD_OPTS = [
  ['',         'Todos'],
  ['transfer', 'Transferencia'],
  ['cash',     'Efectivo'],
  ['check',    'Cheque'],
]

const METHOD_LABEL = {
  transfer:            'Transferencia',
  cash:                'Efectivo',
  check:               'Cheque',
  advance_application: 'Aplicación de anticipo',
}

const methodLabel = (m) => METHOD_LABEL[m] || m || '—'

const PAGE_SIZE = 25

export default function PagosRecibidos() {
  const [partner, setPartner] = useState(null)
  const [from, setFrom]       = useState('')
  const [to, setTo]           = useState('')
  const [method, setMethod]   = useState('')
  const [page, setPage]       = useState(1)
  const [detailId, setDetailId] = useState(null) // cobro abierto en el panel de detalle
  const [busyRow, setBusyRow]   = useState(null)  // id de la fila descargando

  const { sortBy, sortDir, onSort } = useTableSort('fecha', 'desc')
  useEffect(() => { setPage(1) }, [partner, from, to, method, sortBy, sortDir])

  const queryParams = useMemo(() => {
    const p = { page, limit: PAGE_SIZE, sortBy, sortDir }
    if (partner?.id) p.partnerId = partner.id
    if (from)        p.from      = from
    if (to)          p.to        = to
    if (method)      p.method    = method
    return p
  }, [partner, from, to, method, page, sortBy, sortDir])

  const { data, isLoading, isFetching, error } = useQuery({
    queryKey: ['pagos-recibidos', queryParams],
    queryFn:  () => financialsApi.listPayments(queryParams),
    keepPreviousData: true,
  })

  const searchPartners = useCallback(async (q) => {
    const res = await partnersApi.list({ search: q, role: 'customer', limit: 20 })
    return (res.data || res).map(p => ({ id: p.id, label: p.name, sub: p.rfc || '' }))
  }, [])

  // Descarga el comprobante del cobro. Si el cobro generó un complemento de pago
  // (CFDI tipo P, factura PPD) baja el PDF + XML fiscal de Facturapi; si no, baja
  // el recibo no fiscal del sistema.
  async function downloadDoc(row) {
    if (busyRow) return
    setBusyRow(row.id)
    try {
      if (hasComplement(row)) {
        const fid  = row.complement_facturapi_id
        const base = `complemento-${row.complement_uuid || row.document_number || fid}`
        const [pdf, xml] = await Promise.all([
          financialsApi.downloadComplementPdf(fid),
          financialsApi.downloadComplementXml(fid),
        ])
        await downloadBlob(pdf.data, `${base}.pdf`)
        await downloadBlob(xml.data, `${base}.xml`)
      } else {
        const r = await financialsApi.downloadReceiptPdf(row.id)
        await downloadBlob(r.data, `recibo-${row.document_number}.pdf`)
      }
    } catch {
      // Ignorar errores de descarga del comprobante.
    } finally {
      setBusyRow(null)
    }
  }

  const rows = data?.data || []
  const total = data?.total || 0
  const totalAmount = data?.totalAmount || 0
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  const hasFilters = partner || from || to || method

  return (
    <div className="page-enter flex flex-col gap-4">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-xl font-semibold text-ink-primary">Pagos recibidos</h1>
          <p className="text-xs text-ink-muted mt-0.5">Historial de cobros aplicados</p>
        </div>
        {!isLoading && total > 0 && (
          <div className="card px-3 py-2">
            <p className="text-sm text-ink-secondary">
              <span className="font-semibold text-ink-primary">{total}</span> cobro{total !== 1 ? 's' : ''}
              {' · '}
              <span className="font-mono font-semibold text-status-success">{fmtMXN(totalAmount)}</span> en total
            </p>
          </div>
        )}
      </div>

      {/* Filtros */}
      <div className="card p-4 flex flex-wrap gap-3 items-end">
        <div className="min-w-[220px] flex-1">
          <label className="label">Cliente</label>
          <Autocomplete value={partner}
            onChange={(p) => { setPartner(p); setPage(1) }}
            onSearch={searchPartners}
            placeholder="Filtrar por cliente..." />
        </div>
        <div>
          <label className="label">Desde</label>
          <input type="date" className="input" value={from}
            onChange={e => { setFrom(e.target.value); setPage(1) }} />
        </div>
        <div>
          <label className="label">Hasta</label>
          <input type="date" className="input" value={to}
            onChange={e => { setTo(e.target.value); setPage(1) }} />
        </div>
        <div>
          <label className="label">Método</label>
          <select className="select" value={method}
            onChange={e => { setMethod(e.target.value); setPage(1) }}>
            {METHOD_OPTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </div>
        {hasFilters && (
          <button onClick={() => { setPartner(null); setFrom(''); setTo(''); setMethod(''); setPage(1) }}
            className="btn-ghost btn-sm text-ink-muted">
            Limpiar filtros
          </button>
        )}
      </div>

      {/* Listado */}
      <div className="card overflow-hidden">
        {isLoading ? (
          <div className="flex justify-center py-16"><Spinner /></div>
        ) : error ? (
          <div className="p-8 text-center">
            <p className="text-sm text-status-danger">
              {error.response?.data?.error || error.message || 'Error al cargar los cobros'}
            </p>
          </div>
        ) : rows.length === 0 ? (
          <div className="flex flex-col items-center gap-3 py-16 text-center">
            <div className="w-12 h-12 rounded-xl bg-surface-elevated/60 flex items-center justify-center">
              <svg className="w-6 h-6 text-ink-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>
              </svg>
            </div>
            <p className="text-sm font-medium text-ink-secondary">Sin cobros en el periodo.</p>
          </div>
        ) : (
          <>
            {/* ── Móvil: tarjetas ── */}
            <div className="md:hidden flex flex-col gap-3 p-3">
              {rows.map(r => (
                <div key={r.id}
                  onClick={() => setDetailId(r.id)}
                  className="border border-line-subtle rounded-xl bg-surface-primary px-3 py-2.5 cursor-pointer active:bg-surface-elevated/40">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="font-medium text-ink-primary truncate">{r.partner_name}</p>
                      {r.partner_tax_name && r.partner_tax_name !== r.partner_name && (
                        <p className="text-[11px] text-ink-muted truncate">{r.partner_tax_name}</p>
                      )}
                    </div>
                    <p className="font-mono tabular-nums font-semibold text-status-success shrink-0">
                      {fmtMXN(r.amount)}
                    </p>
                  </div>
                  <div className="mt-1.5 flex items-center gap-2 flex-wrap text-[11px] text-ink-muted">
                    <span>{fmtDateOnly(r.payment_date)}</span>
                    {r.document_number && (
                      <span className="font-mono text-ink-secondary">· {r.document_number}</span>
                    )}
                    <span>· {methodLabel(r.payment_method)}</span>
                    {(r.bank_alias || r.bank_name) && (
                      <span>· {r.bank_alias || r.bank_name}</span>
                    )}
                  </div>
                  <div className="mt-2">
                    <button
                      onClick={(e) => { e.stopPropagation(); downloadDoc(r) }}
                      disabled={busyRow === r.id}
                      className="btn-secondary btn-sm">
                      {busyRow === r.id
                        ? <Spinner size="sm" />
                        : hasComplement(r) ? 'Complemento' : 'Recibo'}
                    </button>
                  </div>
                </div>
              ))}
            </div>

            {/* ── Escritorio: tabla ── */}
            <div className="table-wrap hidden md:block">
              <table className="table">
                <thead>
                  <tr>
                    <SortableHeader sortKey="fecha"   sortBy={sortBy} sortDir={sortDir} onSort={onSort}>Fecha</SortableHeader>
                    <SortableHeader sortKey="cliente" sortBy={sortBy} sortDir={sortDir} onSort={onSort} initialDir="asc">Cliente</SortableHeader>
                    <SortableHeader sortKey="folio"   sortBy={sortBy} sortDir={sortDir} onSort={onSort}>Documento</SortableHeader>
                    <SortableHeader sortKey="metodo"  sortBy={sortBy} sortDir={sortDir} onSort={onSort} initialDir="asc">Método</SortableHeader>
                    <th>Banco</th>
                    <SortableHeader sortKey="monto"   sortBy={sortBy} sortDir={sortDir} onSort={onSort} align="right">Monto</SortableHeader>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(r => (
                    <tr key={r.id}
                      onClick={() => setDetailId(r.id)}
                      className="hover:bg-surface-elevated/40 cursor-pointer">
                      <td className="text-xs text-ink-secondary whitespace-nowrap">{fmtDateOnly(r.payment_date)}</td>
                      <td>
                        <p className="font-medium text-ink-primary">{r.partner_name}</p>
                        {r.partner_tax_name && r.partner_tax_name !== r.partner_name && (
                          <p className="text-[10px] text-ink-muted">{r.partner_tax_name}</p>
                        )}
                      </td>
                      <td className="font-mono text-brand-300">{r.document_number || '—'}</td>
                      <td className="text-xs text-ink-secondary">{methodLabel(r.payment_method)}</td>
                      <td className="text-xs text-ink-secondary">{r.bank_alias || r.bank_name || '—'}</td>
                      <td className="text-right font-mono tabular-nums font-semibold text-status-success">
                        {fmtMXN(r.amount)}
                      </td>
                      <td className="text-right">
                        <button
                          onClick={(e) => { e.stopPropagation(); downloadDoc(r) }}
                          disabled={busyRow === r.id}
                          className="btn-secondary btn-sm">
                          {busyRow === r.id
                            ? <Spinner size="sm" />
                            : hasComplement(r) ? 'Complemento' : 'Recibo'}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {totalPages > 1 && (
              <div className="border-t border-line-subtle px-4 py-3 flex items-center justify-between">
                <p className="text-xs text-ink-muted">
                  Mostrando {((page - 1) * PAGE_SIZE) + 1}–{Math.min(page * PAGE_SIZE, total)} de {total}
                  {isFetching && <span className="ml-2 italic text-ink-muted">Actualizando…</span>}
                </p>
                <div className="flex gap-1">
                  <button disabled={page === 1} onClick={() => setPage(p => p - 1)}
                    className="btn-ghost btn-sm disabled:opacity-30">
                    Anterior
                  </button>
                  <span className="text-sm self-center px-2 text-ink-secondary">
                    {page} / {totalPages}
                  </span>
                  <button disabled={page === totalPages} onClick={() => setPage(p => p + 1)}
                    className="btn-ghost btn-sm disabled:opacity-30">
                    Siguiente
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {detailId && (
        <PaymentDetailModal paymentId={detailId} onClose={() => setDetailId(null)} />
      )}
    </div>
  )
}

// ── Detalle de un cobro recibido ─────────────────────────────────────────────
function PaymentDetailModal({ paymentId, onClose }) {
  const [busy, setBusy] = useState(null) // 'pdf' | 'xml' | 'receipt'
  const [showSend, setShowSend] = useState(false)

  const { data: p, isLoading, error } = useQuery({
    queryKey: ['pago-detalle', paymentId],
    queryFn:  () => financialsApi.getPayment(paymentId),
    enabled:  !!paymentId,
  })

  const withComplement = p && hasComplement(p)

  async function download(kind) {
    if (busy) return
    setBusy(kind)
    try {
      if (kind === 'receipt') {
        const r = await financialsApi.downloadReceiptPdf(p.id)
        await downloadBlob(r.data, `recibo-${p.document_number}.pdf`)
      } else {
        const fid  = p.complement_facturapi_id
        const base = `complemento-${p.complement_uuid || p.document_number || fid}`
        const r = kind === 'pdf'
          ? await financialsApi.downloadComplementPdf(fid)
          : await financialsApi.downloadComplementXml(fid)
        await downloadBlob(r.data, `${base}.${kind}`)
      }
    } catch {
      // Ignorar errores de descarga.
    } finally {
      setBusy(null)
    }
  }

  const docTypeLabel = p?.document_type === 'invoice' ? 'Factura'
                     : p?.document_type === 'remission' ? 'Remisión'
                     : 'Documento'

  return createPortal(
    <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}>
      <div className="card w-full max-w-lg p-5" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-base font-semibold text-ink-primary">Detalle del cobro</h3>
          <button onClick={onClose} className="text-ink-muted hover:text-ink-secondary">×</button>
        </div>

        {isLoading ? (
          <div className="flex justify-center py-10"><Spinner /></div>
        ) : error ? (
          <p className="text-sm text-status-danger py-6 text-center">
            {error.response?.data?.error || error.message || 'Error al cargar el cobro'}
          </p>
        ) : p ? (
          <div className="flex flex-col gap-3">
            <div className="flex items-baseline justify-between gap-3">
              <div className="min-w-0">
                <p className="font-medium text-ink-primary truncate">{p.partner_name}</p>
                {p.partner_tax_name && p.partner_tax_name !== p.partner_name && (
                  <p className="text-[11px] text-ink-muted truncate">{p.partner_tax_name}</p>
                )}
                {p.partner_rfc && <p className="text-[11px] text-ink-muted font-mono">{p.partner_rfc}</p>}
              </div>
              <p className="font-mono tabular-nums text-lg font-semibold text-status-success shrink-0">
                {fmtMXN(p.amount, p.currency)}
              </p>
            </div>

            <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
              <Field label="Fecha del cobro" value={fmtDateOnly(p.payment_date)} />
              <Field label="Método" value={methodLabel(p.payment_method)} />
              <Field label={docTypeLabel} value={p.document_number || '—'} mono />
              <Field label="Referencia" value={p.reference || '—'} mono />
              {(p.bank_alias || p.bank_name) && (
                <Field label="Banco" value={p.bank_alias || p.bank_name} />
              )}
              {p.created_by_name && <Field label="Registró" value={p.created_by_name} />}
              {p.notes && <div className="col-span-2"><Field label="Notas" value={p.notes} /></div>}
            </dl>

            {/* Comprobante fiscal / recibo */}
            {withComplement ? (
              <div className="rounded-lg border border-teal-500/40 bg-teal-500/5 px-3 py-2.5">
                <div className="flex items-center gap-2 mb-1.5">
                  <span className="badge-teal text-[10px]">Complemento de pago</span>
                  <span className="text-[11px] text-ink-muted">CFDI tipo P timbrado</span>
                </div>
                {p.complement_uuid && (
                  <p className="text-[10px] text-ink-muted font-mono break-all mb-2">UUID: {p.complement_uuid}</p>
                )}
                <div className="flex gap-2 flex-wrap">
                  <button onClick={() => download('pdf')} disabled={!!busy} className="btn-secondary btn-sm">
                    {busy === 'pdf' ? <Spinner size="sm" /> : 'PDF'}
                  </button>
                  <button onClick={() => download('xml')} disabled={!!busy} className="btn-ghost btn-sm">
                    {busy === 'xml' ? <Spinner size="sm" /> : 'XML'}
                  </button>
                  <button onClick={() => setShowSend(true)} className="btn-ghost btn-sm text-brand-300">
                    Enviar por correo
                  </button>
                </div>
              </div>
            ) : (
              <div className="rounded-lg border border-line-subtle bg-surface-elevated/30 px-3 py-2.5">
                <p className="text-[11px] text-ink-muted mb-2">
                  Recibo de pago interno (sin efectos fiscales).
                </p>
                <div className="flex gap-2 flex-wrap">
                  <button onClick={() => download('receipt')} disabled={!!busy} className="btn-secondary btn-sm">
                    {busy === 'receipt' ? <Spinner size="sm" /> : 'Descargar recibo'}
                  </button>
                  <button onClick={() => setShowSend(true)} className="btn-ghost btn-sm text-brand-300">
                    Enviar por correo
                  </button>
                </div>
              </div>
            )}
          </div>
        ) : null}
      </div>

      {showSend && p && (
        <SendDocEmailModal
          partnerId={p.partner_id}
          title={withComplement ? 'Enviar complemento de pago' : 'Enviar recibo de pago'}
          description={withComplement
            ? `Se enviará el PDF + XML del complemento de ${fmtMXN(p.amount, p.currency)} a los destinatarios seleccionados.`
            : `Se enviará el PDF del recibo de ${fmtMXN(p.amount, p.currency)} a los destinatarios seleccionados.`}
          sendFn={(emails) => withComplement
            ? financialsApi.sendComplementEmail(p.complement_id, emails)
            : financialsApi.sendReceiptEmail(p.id, emails)}
          onClose={() => setShowSend(false)}
          onSent={() => setShowSend(false)}
        />
      )}
    </div>,
    document.body
  )
}

function Field({ label, value, mono }) {
  return (
    <div>
      <dt className="text-[10px] uppercase tracking-wide text-ink-muted">{label}</dt>
      <dd className={`text-ink-primary ${mono ? 'font-mono' : ''}`}>{value}</dd>
    </div>
  )
}
