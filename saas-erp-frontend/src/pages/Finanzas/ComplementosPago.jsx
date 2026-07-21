import { useState, useMemo, useCallback, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { cxpApi } from '@/api/cxp'
import { partnersApi } from '@/api/partners'
import Autocomplete from '@/components/ui/Autocomplete'
import Spinner from '@/components/ui/Spinner'
import Can from '@/components/auth/Can'
import { fmtMXN, fmtDateOnly } from '@/utils/fmt'

/**
 * Complementos de pago (REP) RECIBIDOS de proveedores.
 *
 * Dos pestañas:
 *  - Recibidos: los REP que llegaron (buzón de correo o subidos a mano), con su
 *    cruce a facturas (por UUID) y al pago registrado; los que no cuadran quedan
 *    "Por revisar".
 *  - Por vigilar: facturas PPD que ya pagaste y siguen SIN complemento — las que
 *    hay que perseguir con el proveedor (cumplimiento SAT).
 */

const PAGE_SIZE = 20

const STATUS_META = {
  matched: { label: 'Ligado',      cls: 'bg-status-success/10 text-status-success border-status-success/40' },
  review:  { label: 'Por revisar', cls: 'bg-status-warning/10 text-status-warning border-status-warning/40' },
}

function StatusChip({ status }) {
  const m = STATUS_META[status] || { label: status, cls: 'bg-surface-elevated text-ink-muted border-line-subtle' }
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${m.cls}`}>
      {m.label}
    </span>
  )
}

export default function ComplementosPago() {
  const [tab, setTab] = useState('recibidos')

  return (
    <div className="page-enter flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-xl font-semibold text-ink-primary">Complementos de pago</h1>
          <p className="text-xs text-ink-muted mt-0.5">
            Recibos electrónicos de pago (REP) que emiten tus proveedores por lo que les pagas
          </p>
        </div>
        <div className="flex rounded-xl border border-line-subtle overflow-hidden">
          <button onClick={() => setTab('recibidos')}
            className={`px-3.5 py-1.5 text-sm font-medium transition-colors ${
              tab === 'recibidos' ? 'bg-brand-500/15 text-brand-300' : 'text-ink-muted hover:text-ink-secondary'}`}>
            Recibidos
          </button>
          <button onClick={() => setTab('vigilar')}
            className={`px-3.5 py-1.5 text-sm font-medium transition-colors ${
              tab === 'vigilar' ? 'bg-brand-500/15 text-brand-300' : 'text-ink-muted hover:text-ink-secondary'}`}>
            Por vigilar
          </button>
        </div>
      </div>

      {tab === 'recibidos' ? <RecibidosTab /> : <VigilarTab />}
    </div>
  )
}

// ── Pestaña: REP recibidos ───────────────────────────────────────────────────
function RecibidosTab() {
  const qc = useQueryClient()
  const [partner, setPartner] = useState(null)
  const [status, setStatus]   = useState('')
  const [page, setPage]       = useState(1)
  const [detailId, setDetailId] = useState(null)
  const [uploadMsg, setUploadMsg] = useState(null)
  const fileRef = useRef(null)

  const queryParams = useMemo(() => {
    const p = { page, limit: PAGE_SIZE }
    if (partner?.id) p.partnerId = partner.id
    if (status)      p.status    = status
    return p
  }, [partner, status, page])

  const { data, isLoading, error } = useQuery({
    queryKey: ['complementos', queryParams],
    queryFn:  () => cxpApi.listComplements(queryParams),
    keepPreviousData: true,
  })

  const uploadMutation = useMutation({
    mutationFn: (file) => cxpApi.uploadComplement(file),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['complementos'] })
      qc.invalidateQueries({ queryKey: ['complementos-compliance'] })
      if (res.status === 'duplicate') {
        setUploadMsg({ kind: 'warn', text: 'Ese complemento ya estaba registrado.' })
      } else {
        setUploadMsg({
          kind: 'ok',
          text: res.matchStatus === 'matched'
            ? 'Complemento registrado y ligado automáticamente.'
            : 'Complemento registrado — quedó "Por revisar" (algo no cuadró solo).',
        })
        if (res.complementId) setDetailId(res.complementId)
      }
    },
    onError: (e) => setUploadMsg({
      kind: 'err', text: e.response?.data?.error || e.message || 'No se pudo subir el XML.' }),
  })

  const searchPartners = useCallback(async (q) => {
    const res = await partnersApi.list({ search: q, role: 'supplier', limit: 20 })
    return (res.data || res).map(p => ({ id: p.id, label: p.name, sub: p.rfc || '' }))
  }, [])

  const rows = data?.data || []
  const total = data?.total || 0
  const reviewCount = data?.reviewCount || 0
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  return (
    <>
      {/* Filtros + subir */}
      <div className="card p-4 flex flex-wrap gap-3 items-end">
        <div className="min-w-[220px] flex-1">
          <label className="label">Proveedor</label>
          <Autocomplete value={partner}
            onChange={(p) => { setPartner(p); setPage(1) }}
            onSearch={searchPartners}
            placeholder="Filtrar por proveedor..." />
        </div>
        <div>
          <label className="label">Estado</label>
          <select className="select" value={status}
            onChange={e => { setStatus(e.target.value); setPage(1) }}>
            <option value="">Todos</option>
            <option value="matched">Ligados</option>
            <option value="review">Por revisar{reviewCount ? ` (${reviewCount})` : ''}</option>
          </select>
        </div>
        <Can do="purchases:create">
          <div className="ml-auto">
            <input ref={fileRef} type="file" accept=".xml,text/xml,application/xml" className="hidden"
              onChange={e => {
                const f = e.target.files?.[0]
                if (f) { setUploadMsg(null); uploadMutation.mutate(f) }
                e.target.value = ''
              }} />
            <button onClick={() => fileRef.current?.click()} disabled={uploadMutation.isPending}
              className="btn-primary btn-sm">
              {uploadMutation.isPending ? <Spinner size="sm" /> : 'Subir XML del complemento'}
            </button>
          </div>
        </Can>
      </div>

      {uploadMsg && (
        <div className={`rounded-xl border p-3 text-sm ${
          uploadMsg.kind === 'ok'   ? 'bg-status-success/10 border-status-success/40 text-status-success'
          : uploadMsg.kind === 'warn' ? 'bg-status-warning/10 border-status-warning/40 text-status-warning'
          : 'bg-status-danger/10 border-status-danger/40 text-status-danger'}`}>
          {uploadMsg.text}
        </div>
      )}

      {/* Listado */}
      <div className="card overflow-hidden">
        {isLoading ? (
          <div className="flex justify-center py-16"><Spinner /></div>
        ) : error ? (
          <div className="p-8 text-center">
            <p className="text-sm text-status-danger">
              {error.response?.data?.error || error.message || 'Error al cargar'}
            </p>
          </div>
        ) : rows.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-16 text-center px-6">
            <p className="text-sm font-medium text-ink-secondary">Aún no hay complementos recibidos.</p>
            <p className="text-xs text-ink-muted max-w-md">
              Los REP que tus proveedores manden al buzón de facturas se registran solos.
              También puedes subir el XML a mano con el botón de arriba.
            </p>
          </div>
        ) : (
          <>
            {/* Móvil: tarjetas */}
            <div className="md:hidden flex flex-col gap-3 p-3">
              {rows.map(r => (
                <div key={r.id} onClick={() => setDetailId(r.id)}
                  className="rounded-xl bg-surface-primary px-3 py-2.5 border border-line-subtle cursor-pointer">
                  <div className="flex items-start justify-between gap-2">
                    <p className="font-medium text-ink-primary truncate">{r.partner_name || '—'}</p>
                    <p className="font-mono tabular-nums font-semibold text-ink-primary shrink-0">
                      {fmtMXN(r.amount)}{r.currency === 'USD' ? ' USD' : ''}
                    </p>
                  </div>
                  <div className="mt-1.5 flex items-center gap-2 flex-wrap text-[11px] text-ink-muted">
                    <span>Pago {fmtDateOnly(r.payment_date)}</span>
                    {r.invoice_numbers && <span>· {r.invoice_numbers}</span>}
                    <StatusChip status={r.match_status} />
                  </div>
                </div>
              ))}
            </div>

            {/* Escritorio: tabla */}
            <div className="table-wrap hidden md:block">
              <table className="table">
                <thead>
                  <tr>
                    <th>Fecha del pago</th>
                    <th>Proveedor</th>
                    <th>Facturas que liquida</th>
                    <th>Pago ligado</th>
                    <th className="text-right">Monto</th>
                    <th>Estado</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(r => (
                    <tr key={r.id} onClick={() => setDetailId(r.id)}
                      className="cursor-pointer hover:bg-surface-elevated/40 transition-colors">
                      <td className="text-xs text-ink-secondary whitespace-nowrap">{fmtDateOnly(r.payment_date)}</td>
                      <td>
                        <p className="font-medium text-ink-primary">{r.partner_name || '—'}</p>
                        {r.partner_rfc && <p className="text-[10px] text-ink-muted font-mono">{r.partner_rfc}</p>}
                      </td>
                      <td className="text-xs text-ink-secondary">
                        {r.invoice_numbers || (r.docs_total > 0
                          ? <span className="text-status-warning">{r.docs_matched}/{r.docs_total} identificadas</span>
                          : '—')}
                      </td>
                      <td className="text-xs text-ink-secondary">
                        {r.supplier_payment_id
                          ? <>{fmtDateOnly(r.linked_payment_date)}{r.linked_payment_reference ? ` · ${r.linked_payment_reference}` : ''}</>
                          : <span className="text-ink-muted">Sin ligar</span>}
                      </td>
                      <td className="text-right font-mono tabular-nums font-semibold text-ink-primary">
                        {fmtMXN(r.amount)}{r.currency === 'USD' ? ' USD' : ''}
                      </td>
                      <td><StatusChip status={r.match_status} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {totalPages > 1 && (
              <div className="border-t border-line-subtle px-4 py-3 flex items-center justify-between">
                <p className="text-xs text-ink-muted">
                  Mostrando {((page - 1) * PAGE_SIZE) + 1}–{Math.min(page * PAGE_SIZE, total)} de {total}
                </p>
                <div className="flex gap-1">
                  <button disabled={page === 1} onClick={() => setPage(p => p - 1)}
                    className="btn-ghost btn-sm disabled:opacity-30">Anterior</button>
                  <span className="text-sm self-center px-2 text-ink-secondary">{page} / {totalPages}</span>
                  <button disabled={page === totalPages} onClick={() => setPage(p => p + 1)}
                    className="btn-ghost btn-sm disabled:opacity-30">Siguiente</button>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {detailId && (
        <ComplementDetailModal complementId={detailId} onClose={() => setDetailId(null)} />
      )}
    </>
  )
}

// ── Pestaña: PPD pagadas sin complemento ─────────────────────────────────────
function VigilarTab() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['complementos-compliance'],
    queryFn:  () => cxpApi.complianceComplements(),
  })

  const rows = data?.data || []

  return (
    <>
      <div className="card p-4">
        <p className="text-sm text-ink-secondary">
          Facturas <strong>PPD</strong> (pago en parcialidades o diferido) que ya pagaste y de las
          que tu proveedor <strong>aún no te emite el complemento de pago</strong>. Sin ese recibo,
          el SAT puede rechazar la deducción del pago — persíguelas con el proveedor.
        </p>
        {data?.unknownMethodCount > 0 && (
          <p className="text-xs text-ink-muted mt-2">
            ⚠ {data.unknownMethodCount} factura{data.unknownMethodCount !== 1 ? 's' : ''} pagada{data.unknownMethodCount !== 1 ? 's' : ''} no
            se vigilan porque no se conoce su método de pago (PUE/PPD) — son anteriores a esta
            función. Ábrelas en Gastos y usa "Volver a leer del XML" para incorporarlas.
          </p>
        )}
      </div>

      <div className="card overflow-hidden">
        {isLoading ? (
          <div className="flex justify-center py-16"><Spinner /></div>
        ) : error ? (
          <div className="p-8 text-center">
            <p className="text-sm text-status-danger">
              {error.response?.data?.error || error.message || 'Error al cargar'}
            </p>
          </div>
        ) : rows.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-16 text-center px-6">
            <div className="w-12 h-12 rounded-xl bg-status-success/10 flex items-center justify-center">
              <svg className="w-6 h-6 text-status-success" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>
              </svg>
            </div>
            <p className="text-sm font-medium text-ink-secondary">Todo en orden.</p>
            <p className="text-xs text-ink-muted">No hay facturas PPD pagadas esperando complemento.</p>
          </div>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Factura</th>
                  <th>Proveedor</th>
                  <th>Último pago</th>
                  <th className="text-right">Pagado</th>
                  <th className="text-right">Cubierto por REP</th>
                  <th className="text-right">Faltante</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(r => {
                  const paid = parseFloat(r.amount_paid_mxn || 0)
                  const covered = parseFloat(r.covered_mxn || 0)
                  return (
                    <tr key={r.id}>
                      <td className="font-mono text-brand-300 text-xs">{r.invoice_number}</td>
                      <td>
                        <p className="font-medium text-ink-primary">{r.partner_name || '—'}</p>
                        {r.partner_rfc && <p className="text-[10px] text-ink-muted font-mono">{r.partner_rfc}</p>}
                      </td>
                      <td className="text-xs text-ink-secondary whitespace-nowrap">{fmtDateOnly(r.last_payment_date)}</td>
                      <td className="text-right font-mono tabular-nums">{fmtMXN(paid)}</td>
                      <td className="text-right font-mono tabular-nums">{fmtMXN(covered)}</td>
                      <td className="text-right font-mono tabular-nums font-semibold text-status-warning">
                        {fmtMXN(paid - covered)}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  )
}

// ── Modal: detalle de un REP recibido ────────────────────────────────────────
function ComplementDetailModal({ complementId, onClose }) {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [error, setError] = useState(null)
  const [showLinkPicker, setShowLinkPicker] = useState(false)

  const { data: c, isLoading, error: loadError } = useQuery({
    queryKey: ['complemento', complementId],
    queryFn:  () => cxpApi.getComplement(complementId),
  })

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['complemento', complementId] })
    qc.invalidateQueries({ queryKey: ['complementos'] })
    qc.invalidateQueries({ queryKey: ['complementos-compliance'] })
  }

  const rematch = useMutation({
    mutationFn: () => cxpApi.rematchComplement(complementId),
    onSuccess: invalidate,
    onError: (e) => setError(e.response?.data?.error || 'No se pudo reintentar el cruce.'),
  })
  const unlink = useMutation({
    mutationFn: () => cxpApi.unlinkComplementPayment(complementId),
    onSuccess: invalidate,
    onError: (e) => setError(e.response?.data?.error || 'No se pudo desligar el pago.'),
  })
  const remove = useMutation({
    mutationFn: () => cxpApi.deleteComplement(complementId),
    onSuccess: () => { invalidate(); onClose() },
    onError: (e) => setError(e.response?.data?.error || 'No se pudo eliminar.'),
  })

  const downloadAttachment = async (att) => {
    try {
      const res = await cxpApi.downloadComplementAttachment(complementId, att.id)
      const url = URL.createObjectURL(res.data)
      const a = document.createElement('a')
      a.href = url; a.download = att.filename || 'rep.xml'
      a.click()
      URL.revokeObjectURL(url)
    } catch {
      setError('No se pudo descargar el archivo.')
    }
  }

  return createPortal(
    <div className="fixed inset-0 z-[9998] flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="card w-full max-w-2xl max-h-[90vh] overflow-y-auto p-5" onClick={e => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="eyebrow">COMPLEMENTO DE PAGO (REP)</p>
            <h2 className="text-lg font-semibold text-ink-primary mt-0.5">
              {isLoading ? 'Cargando…' : (c?.partner_name || '—')}
            </h2>
            {c && <div className="mt-1"><StatusChip status={c.match_status} /></div>}
          </div>
          <button onClick={onClose} className="text-ink-muted hover:text-ink-secondary text-xl leading-none">×</button>
        </div>

        {loadError ? (
          <p className="field-error mt-4">{loadError.response?.data?.error || 'No se pudo cargar.'}</p>
        ) : isLoading ? (
          <div className="flex justify-center py-10"><Spinner /></div>
        ) : (
          <div className="mt-4 flex flex-col gap-4">
            <dl className="grid grid-cols-2 md:grid-cols-3 gap-3 text-sm">
              <Field label="Fecha del pago" value={fmtDateOnly(c.payment_date)} />
              <Field label="Monto" value={`${fmtMXN(c.amount)} ${c.currency || 'MXN'}`} />
              <Field label="Serie / Folio" value={[c.serie, c.folio].filter(Boolean).join('-') || '—'} mono />
              <Field label="RFC emisor" value={c.rfc_emisor || '—'} mono />
              <Field label="Recibido" value={`${fmtDateOnly(c.created_at)} · ${c.source === 'email' ? 'por correo' : 'subido a mano'}`} />
              <Field label="Folio fiscal" value={c.cfdi_uuid} mono />
            </dl>

            {/* Facturas que liquida */}
            <div>
              <p className="text-xs font-bold text-brand-300 uppercase tracking-wider mb-1.5">Facturas que liquida</p>
              {(!c.docs || c.docs.length === 0) ? (
                <p className="text-sm text-ink-muted italic">El complemento no trae facturas relacionadas.</p>
              ) : (
                <div className="border border-line-subtle rounded-xl overflow-x-auto">
                  <table className="table text-xs min-w-full">
                    <thead>
                      <tr>
                        <th>Factura</th><th>Parcialidad</th>
                        <th className="text-right">Pagado</th>
                        <th className="text-right">Saldo restante</th>
                      </tr>
                    </thead>
                    <tbody>
                      {c.docs.map(d => (
                        <tr key={d.id}>
                          <td>
                            {d.supplier_invoice_id ? (
                              <span className="font-mono text-brand-300">{d.invoice_number}</span>
                            ) : (
                              <span className="text-status-warning">
                                No identificada{(d.serie || d.folio) ? ` (${[d.serie, d.folio].filter(Boolean).join('-')})` : ''}
                              </span>
                            )}
                          </td>
                          <td>{d.num_parcialidad ?? '—'}</td>
                          <td className="text-right font-mono tabular-nums font-semibold">{fmtMXN(d.imp_pagado)}</td>
                          <td className="text-right font-mono tabular-nums">{d.imp_saldo_insoluto != null ? fmtMXN(d.imp_saldo_insoluto) : '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* Pago ligado */}
            <div>
              <p className="text-xs font-bold text-brand-300 uppercase tracking-wider mb-1.5">Pago ligado</p>
              {c.supplier_payment_id ? (
                <div className="flex items-center justify-between gap-3 border border-line-subtle rounded-xl px-3 py-2.5">
                  <div className="text-sm">
                    <button
                      onClick={() => navigate(`/pagos-emitidos?open=${c.supplier_payment_id}&highlight=${c.supplier_payment_id}`)}
                      className="text-brand-300 hover:underline font-medium">
                      Pago del {fmtDateOnly(c.linked_payment_date)} · {fmtMXN(c.linked_payment_amount)} {c.linked_payment_currency || 'MXN'}
                    </button>
                    {c.linked_payment_reference && (
                      <p className="text-[11px] text-ink-muted font-mono">{c.linked_payment_reference}</p>
                    )}
                    {c.linked_payment_reversed_at && (
                      <p className="text-[11px] text-status-danger">⚠ Ese pago fue reversado — liga el REP al pago vigente.</p>
                    )}
                  </div>
                  <Can do="purchases:update">
                    <button onClick={() => unlink.mutate()} disabled={unlink.isPending}
                      className="btn-ghost btn-sm text-ink-muted">Desligar</button>
                  </Can>
                </div>
              ) : (
                <div className="flex items-center justify-between gap-3 border border-status-warning/40 bg-status-warning/5 rounded-xl px-3 py-2.5">
                  <p className="text-sm text-status-warning">Sin pago ligado.</p>
                  <Can do="purchases:update">
                    <button onClick={() => setShowLinkPicker(true)} className="btn-secondary btn-sm">
                      Ligar a un pago
                    </button>
                  </Can>
                </div>
              )}
            </div>

            {/* Respaldos */}
            {c.attachments?.length > 0 && (
              <div>
                <p className="text-xs font-bold text-brand-300 uppercase tracking-wider mb-1.5">Comprobante</p>
                <div className="flex flex-wrap gap-2">
                  {c.attachments.map(a => (
                    <button key={a.id} onClick={() => downloadAttachment(a)}
                      className="btn-secondary btn-sm font-mono text-xs">
                      ⬇ {a.filename}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {error && <p className="field-error">{error}</p>}

            <div className="flex items-center justify-between pt-1">
              <Can do="purchases:update">
                <button onClick={() => {
                  if (window.confirm('¿Eliminar este complemento recibido? No mueve dinero; puedes volver a subirlo.')) {
                    remove.mutate()
                  }
                }} disabled={remove.isPending}
                  className="btn-ghost btn-sm text-status-danger">Eliminar</button>
              </Can>
              {c.match_status === 'review' && (
                <Can do="purchases:update">
                  <button onClick={() => rematch.mutate()} disabled={rematch.isPending}
                    className="btn-secondary btn-sm">
                    {rematch.isPending ? <Spinner size="sm" /> : 'Reintentar cruce'}
                  </button>
                </Can>
              )}
            </div>
          </div>
        )}
      </div>

      {showLinkPicker && c && (
        <LinkPaymentPicker
          complement={c}
          onClose={() => setShowLinkPicker(false)}
          onLinked={() => { setShowLinkPicker(false); invalidate() }}
        />
      )}
    </div>,
    document.body
  )
}

// ── Selector de pago para ligar a mano ───────────────────────────────────────
function LinkPaymentPicker({ complement, onClose, onLinked }) {
  const [error, setError] = useState(null)

  // Pagos del proveedor del REP (o todos si llegó sin proveedor identificado).
  const { data, isLoading } = useQuery({
    queryKey: ['complemento-link-pagos', complement.partner_id],
    queryFn:  () => cxpApi.listPayments({
      partnerId: complement.partner_id || undefined, limit: 50 }),
  })

  const link = useMutation({
    mutationFn: (paymentId) => cxpApi.linkComplementPayment(complement.id, paymentId),
    onSuccess: onLinked,
    onError: (e) => setError(e.response?.data?.error || 'No se pudo ligar.'),
  })

  const rows = data?.data || []

  return createPortal(
    <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="card w-full max-w-lg max-h-[80vh] overflow-y-auto p-5" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-base font-semibold text-ink-primary">¿A qué pago corresponde este complemento?</h3>
          <button onClick={onClose} className="text-ink-muted hover:text-ink-secondary">×</button>
        </div>
        <p className="text-xs text-ink-muted mb-3">
          El REP dice: pago de <strong>{fmtMXN(complement.amount)} {complement.currency}</strong> el {fmtDateOnly(complement.payment_date)}.
        </p>
        {isLoading ? (
          <div className="flex justify-center py-8"><Spinner /></div>
        ) : rows.length === 0 ? (
          <p className="text-sm text-ink-muted italic">No hay pagos registrados de este proveedor.</p>
        ) : (
          <div className="flex flex-col gap-2">
            {rows.map(p => (
              <button key={p.id} onClick={() => link.mutate(p.id)} disabled={link.isPending}
                className="flex items-center justify-between gap-3 border border-line-subtle rounded-xl px-3 py-2.5 text-left hover:border-brand-400 transition-colors">
                <div>
                  <p className="text-sm font-medium text-ink-primary">
                    {fmtDateOnly(p.payment_date)} · {p.partner_name || p.generic_supplier || '—'}
                  </p>
                  <p className="text-[11px] text-ink-muted">
                    {p.applied_docs || 'Sin documentos'}{p.reference ? ` · ${p.reference}` : ''}
                  </p>
                </div>
                <span className="font-mono tabular-nums font-semibold text-ink-primary">{fmtMXN(p.amount_mxn)}</span>
              </button>
            ))}
          </div>
        )}
        {error && <p className="field-error mt-3">{error}</p>}
      </div>
    </div>,
    document.body
  )
}

function Field({ label, value, mono }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] text-ink-muted uppercase tracking-wide">{label}</dt>
      <dd className={`text-ink-primary break-all ${mono ? 'font-mono text-xs' : ''}`}>{value}</dd>
    </div>
  )
}
