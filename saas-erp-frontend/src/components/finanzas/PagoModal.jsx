import { useState, useCallback, useMemo, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { financialsApi } from '@/api/financials'
import { partnersApi } from '@/api/partners'
import { bankAccountsApi } from '@/api/bankAccounts'
import Autocomplete from '@/components/ui/Autocomplete'
import Spinner from '@/components/ui/Spinner'
import Badge from '@/components/ui/Badge'
import { fmtMXN, fmtDate } from '@/utils/fmt'
import clsx from 'clsx'

const METHOD_OPTS = [
  ['cash',     'Efectivo'],
  ['transfer', 'Transferencia'],
  ['check',    'Cheque'],
]

const DOC_TYPE_LABEL = {
  invoice:      'Factura',
  remission:    'Remisión',
  credit_note:  'Nota de crédito',
}

/**
 * Modal para registrar un pago de cliente y aplicarlo a uno o varios documentos CXC.
 *
 * Props:
 *   onClose, onSaved
 *   prefilledPartnerId — opcional, salta selector de cliente
 *   prefilledArId       — opcional, preselecciona ese documento para aplicar
 */
export function PagoModal({ onClose, onSaved, prefilledPartnerId = null, prefilledArId = null }) {
  const qc = useQueryClient()

  const [partner, setPartner]   = useState(null)
  const [paymentDate, setPaymentDate] = useState(() => new Date().toISOString().split('T')[0])
  const [method, setMethod]     = useState('transfer')
  const [reference, setReference] = useState('')
  const [bankAccountId, setBankAccountId] = useState('')
  const [amount, setAmount]     = useState('')
  const [appByArId, setAppByArId] = useState({}) // { [arId]: '123.45' }
  const [notes, setNotes]       = useState('')
  const [error, setError]       = useState(null)
  const [activeTab, setActiveTab] = useState('remission')  // 'remission' | 'invoice'

  // Catálogo de cuentas bancarias activas (para el dropdown)
  const { data: bankAccounts = [] } = useQuery({
    queryKey: ['bank-accounts', 'active'],
    queryFn:  () => bankAccountsApi.list(),
    staleTime: 5 * 60 * 1000,
  })

  // Si viene prefilledPartnerId, cargamos el partner
  const { data: prefilledPartner } = useQuery({
    queryKey: ['partner', prefilledPartnerId],
    queryFn:  () => partnersApi.get(prefilledPartnerId),
    enabled:  !!prefilledPartnerId,
  })
  useEffect(() => {
    if (prefilledPartner && !partner) {
      setPartner({ id: prefilledPartner.id, label: prefilledPartner.name, sub: prefilledPartner.rfc || '' })
    }
  }, [prefilledPartner])

  // Estado de cuenta del cliente
  const { data: statement, isLoading: stmtLoading } = useQuery({
    queryKey: ['customer-statement', partner?.id],
    queryFn:  () => financialsApi.customerStatement(partner.id),
    enabled:  !!partner?.id,
  })

  // Cuando carga el statement, si hay prefilledArId, prellenar ese
  useEffect(() => {
    if (!statement?.documents || !prefilledArId) return
    const doc = statement.documents.find(d => d.id === prefilledArId)
    if (doc) {
      setAppByArId(prev => ({ ...prev, [doc.id]: String(doc.amount_pending) }))
      setAmount(String(doc.amount_pending))
    }
  }, [statement, prefilledArId])

  const searchPartners = useCallback(async (q) => {
    const res = await partnersApi.list({ search: q, type: 'customer', limit: 20 })
    return (res.data || res).map(p => ({ id: p.id, label: p.name, sub: p.rfc || '' }))
  }, [])

  // Pendientes ordenados por más vencido primero
  const pendingDocs = useMemo(() => {
    const list = statement?.documents || []
    return list.filter(d => d.status !== 'paid' && d.status !== 'cancelled')
  }, [statement])

  // Una factura PPD timbrada generará automáticamente un complemento de
  // pago (CFDI tipo P) al aplicar el pago — no se bloquea, pero se marca
  // visualmente para que el operador sepa qué va a pasar.
  function isPpd(d) {
    return d.document_type === 'invoice'
        && d.invoice_status === 'stamped'
        && d.invoice_payment_method === 'PPD'
  }

  // Separación por tipo (las pestañas son filtro visual; los inputs siguen
  // siendo independientes, así que un mismo pago puede cubrir docs de ambas
  // pestañas a la vez).
  const remissionDocs = useMemo(() => pendingDocs.filter(d => d.document_type === 'remission'), [pendingDocs])
  const invoiceDocs   = useMemo(() => pendingDocs.filter(d => d.document_type === 'invoice'),   [pendingDocs])
  const tabDocs       = activeTab === 'invoice' ? invoiceDocs : remissionDocs

  // Totales por pestaña
  function sumPending(docs) {
    return docs.reduce((s, d) => s + parseFloat(d.amount_pending || 0), 0)
  }
  function sumApplied(docs) {
    return docs.reduce((s, d) => s + (parseFloat(appByArId[d.id]) || 0), 0)
  }

  // Auto-seleccionar pestaña con docs cuando llega el statement
  useEffect(() => {
    if (!statement) return
    if (remissionDocs.length === 0 && invoiceDocs.length > 0) setActiveTab('invoice')
  }, [statement, remissionDocs.length, invoiceDocs.length])

  const totalApplied = useMemo(() => {
    return Object.values(appByArId).reduce((s, v) => s + (parseFloat(v) || 0), 0)
  }, [appByArId])

  const amountNum = parseFloat(amount) || 0
  const overflow  = totalApplied - amountNum     // > 0 si aplicaron de más
  const advance   = amountNum - totalApplied     // > 0 si va a quedar anticipo

  function updateApp(arId, val) {
    setAppByArId(prev => {
      if (!val) { const { [arId]: _, ...rest } = prev; return rest }
      return { ...prev, [arId]: val }
    })
  }

  function autoFillFromAmount(scope = 'all') {
    // FIFO: aplicar el monto recibido a los documentos pendientes ordenados por
    // vencimiento más antiguo.
    //
    // `scope`:
    //   'all'      → todos los pendientes (preserva apps existentes fuera del scope).
    //   'remission' → solo remisiones.
    //   'invoice'   → solo facturas (PPD incluidas — generarán complemento automático).
    if (!amountNum) return
    const source = scope === 'remission' ? remissionDocs
                 : scope === 'invoice'   ? invoiceDocs
                 : pendingDocs
    if (!source.length) return

    // Monto ya aplicado fuera del scope no se toca
    const otherDocs = pendingDocs.filter(d => !source.some(s => s.id === d.id))
    const lockedApplied = otherDocs.reduce((s, d) => s + (parseFloat(appByArId[d.id]) || 0), 0)
    let remaining = Math.max(amountNum - lockedApplied, 0)

    const result = {}
    for (const d of otherDocs) {
      if (appByArId[d.id]) result[d.id] = appByArId[d.id]
    }
    for (const doc of source) {
      if (remaining <= 0) break
      const pending = parseFloat(doc.amount_pending)
      const toApply = Math.min(pending, remaining)
      if (toApply > 0) {
        result[doc.id] = toApply.toFixed(2)
        remaining -= toApply
      }
    }
    setAppByArId(result)
  }

  const mutation = useMutation({
    mutationFn: () => {
      if (!partner?.id) throw new Error('Selecciona un cliente.')
      if (!amountNum || amountNum <= 0) throw new Error('Captura un monto válido.')
      if (method === 'check' && !reference.trim()) {
        throw new Error('El número de cheque es requerido.')
      }
      if (overflow > 0.01) throw new Error('La suma aplicada excede el monto recibido.')

      const applications = Object.entries(appByArId)
        .map(([arId, v]) => ({ arId, amountApplied: parseFloat(v) }))
        .filter(a => a.amountApplied > 0)

      if (applications.length === 0 && advance <= 0.01) {
        throw new Error('Captura el monto a aplicar a al menos un documento, o un anticipo.')
      }

      return financialsApi.registerPayment({
        partnerId:     partner.id,
        paymentDate,
        method,
        reference:     reference.trim() || null,
        bankAccountId: bankAccountId || null,
        amount:        amountNum,
        applications,
        notes:         notes.trim() || null,
      })
    },
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['cxc'] })
      qc.invalidateQueries({ queryKey: ['customer-statement', partner.id] })
      onSaved?.(res)
      onClose()
    },
    onError: (e) => setError(e.response?.data?.error || e.message || 'Error al registrar el pago'),
  })

  function handleSubmit(e) { e.preventDefault(); setError(null); mutation.mutate() }

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40 p-4">
      <form onSubmit={handleSubmit}
        className="card w-full max-w-3xl p-6 max-h-[92vh] overflow-y-auto flex flex-col gap-5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-status-success/15 flex items-center justify-center shrink-0">
              <svg className="w-4 h-4 text-status-success" fill="currentColor" viewBox="0 0 24 24">
                <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/>
              </svg>
            </div>
            <div>
              <h2 className="text-base font-semibold text-ink-primary">Registrar pago</h2>
              <p className="text-xs text-ink-muted mt-0.5">Aplica el cobro a uno o varios documentos del cliente</p>
            </div>
          </div>
          <button type="button" onClick={onClose} className="btn-ghost btn-icon text-ink-muted">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12"/>
            </svg>
          </button>
        </div>

        {/* Cliente */}
        <div>
          <label className="label">Cliente <span className="text-status-danger">*</span></label>
          <Autocomplete
            value={partner}
            onChange={setPartner}
            onSearch={searchPartners}
            placeholder="Buscar cliente..."
            disabled={!!prefilledPartnerId}
          />
        </div>

        {/* Datos del pago */}
        {partner && (
          <div className="bg-surface-elevated/60 border border-line-subtle rounded-xl p-4 flex flex-col gap-3">
            <p className="text-xs font-bold text-brand-300 uppercase tracking-wider">Datos del pago</p>
            <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
              <div>
                <label className="label">Fecha</label>
                <input type="date" className="input" value={paymentDate}
                  onChange={e => setPaymentDate(e.target.value)} />
              </div>
              <div>
                <label className="label">Método <span className="text-status-danger">*</span></label>
                <select className="select" value={method} onChange={e => setMethod(e.target.value)}>
                  {METHOD_OPTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              </div>
              <div className="sm:col-span-2">
                <label className="label">
                  Referencia
                  {method === 'check' && <span className="text-status-danger"> *</span>}
                </label>
                <input className="input" value={reference} onChange={e => setReference(e.target.value)}
                  placeholder={method === 'transfer' ? 'SPEI / folio (opcional)' : method === 'check' ? '# cheque' : 'Opcional'} />
              </div>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="label">
                  Banco receptor
                  {(method === 'transfer' || method === 'check') && (
                    <span className="text-ink-muted"> (¿dónde cayó?)</span>
                  )}
                </label>
                <select className="select" value={bankAccountId}
                  onChange={e => setBankAccountId(e.target.value)}>
                  <option value="">— Sin asignar —</option>
                  {bankAccounts.map(a => (
                    <option key={a.id} value={a.id}>
                      {a.bank_name}
                      {a.alias ? ` · ${a.alias}` : ''}
                      {a.account_number ? ` (${a.account_number})` : ''}
                      {' · '}{a.currency}
                    </option>
                  ))}
                </select>
                {bankAccounts.length === 0 && (
                  <p className="text-[11px] text-status-warning mt-1">
                    No hay cuentas bancarias configuradas.{' '}
                    <a href="/configuracion/cuentas-bancarias" target="_blank" rel="noopener" className="underline">
                      Crear una
                    </a>.
                  </p>
                )}
              </div>
              <div>
                <label className="label">Monto recibido <span className="text-status-danger">*</span></label>
                <input type="number" step="0.01" min="0" inputMode="decimal" className="input text-base"
                  value={amount} onChange={e => setAmount(e.target.value)} placeholder="0.00" />
              </div>
            </div>
            <div>
              <label className="label">Notas</label>
              <input className="input" value={notes} onChange={e => setNotes(e.target.value)}
                placeholder="Opcional" />
            </div>
          </div>
        )}

        {/* Documentos pendientes */}
        {partner && (
          stmtLoading ? (
            <div className="flex justify-center py-6"><Spinner /></div>
          ) : pendingDocs.length === 0 ? (
            <div className="bg-status-success/10 border border-status-success/40 rounded-lg px-3 py-3 text-center">
              <p className="text-sm text-status-success">Este cliente no tiene documentos pendientes.</p>
              {amountNum > 0 && (
                <p className="text-xs text-status-success mt-1">
                  El monto se registrará como anticipo de {fmtMXN(amountNum)}.
                </p>
              )}
            </div>
          ) : (
            <div>
              {/* Pestañas Remisionado / Facturado */}
              <div className="flex border-b border-line-subtle mb-3">
                {[
                  { value: 'remission', label: 'Remisionado', docs: remissionDocs },
                  { value: 'invoice',   label: 'Facturado',   docs: invoiceDocs },
                ].map(tab => {
                  const isActive = activeTab === tab.value
                  const pendingSum = sumPending(tab.docs)
                  const appliedSum = sumApplied(tab.docs)
                  return (
                    <button key={tab.value} type="button"
                      onClick={() => setActiveTab(tab.value)}
                      className={clsx(
                        'px-4 py-2 text-sm font-medium border-b-2 transition-colors -mb-px',
                        isActive
                          ? 'border-brand-600 text-brand-300'
                          : 'border-transparent text-ink-muted hover:text-ink-secondary'
                      )}>
                      {tab.label}
                      <span className="ml-1.5 text-[11px] text-ink-muted">
                        ({tab.docs.length})
                      </span>
                      {pendingSum > 0 && (
                        <span className="ml-2 text-[11px] font-mono text-ink-muted">
                          {fmtMXN(pendingSum)}
                        </span>
                      )}
                      {appliedSum > 0 && (
                        <span className="ml-1.5 text-[11px] font-mono font-semibold text-brand-300">
                          · {fmtMXN(appliedSum)} aplicado
                        </span>
                      )}
                    </button>
                  )
                })}
              </div>

              <div className="flex items-center justify-between mb-2">
                <p className="text-xs font-bold text-brand-300 uppercase tracking-wider">
                  {activeTab === 'invoice' ? 'Facturas pendientes' : 'Remisiones pendientes'} ({tabDocs.length})
                </p>
                {amountNum > 0 && tabDocs.length > 0 && (
                  <button type="button" onClick={() => autoFillFromAmount(activeTab)}
                    className="btn-ghost btn-sm text-brand-300">
                    Aplicar a los más vencidos de esta pestaña
                  </button>
                )}
              </div>

              {tabDocs.length === 0 ? (
                <p className="text-xs text-ink-muted italic py-4 text-center">
                  {activeTab === 'invoice'
                    ? 'No hay facturas pendientes de cobrar para este cliente.'
                    : 'No hay remisiones pendientes de cobrar para este cliente.'}
                </p>
              ) : (
              <div className="border border-line-subtle rounded-xl overflow-x-auto">
                <table className="table text-xs min-w-full">
                  <thead>
                    <tr>
                      <th>Documento</th>
                      <th>F. emisión</th>
                      <th>Vence</th>
                      <th>Estado</th>
                      <th className="text-right">Pendiente</th>
                      <th className="text-right w-32">A aplicar</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tabDocs.map(d => {
                      const pending = parseFloat(d.amount_pending)
                      const applied = parseFloat(appByArId[d.id] || 0)
                      const excess  = applied > pending
                      const ppd = isPpd(d)
                      return (
                        <tr key={d.id} className={clsx(d.is_overdue && 'bg-status-danger/10/50')}>
                          <td>
                            <p className="font-medium text-ink-primary">
                              {DOC_TYPE_LABEL[d.document_type] || d.document_type}{' '}
                              <span className="font-mono text-brand-300">{d.document_number}</span>
                              {ppd && <span className="ml-1.5 badge-amber text-[10px]">PPD</span>}
                            </p>
                            {ppd && applied > 0 && (
                              <p className="text-[10px] text-teal-300 mt-0.5">
                                Al guardar se emitirá un complemento de pago (CFDI tipo P).
                              </p>
                            )}
                          </td>
                          <td className="text-ink-secondary">{fmtDate(d.issue_date)}</td>
                          <td className={clsx(d.is_overdue ? 'text-status-danger font-semibold' : 'text-ink-secondary')}>
                            {fmtDate(d.due_date)}
                          </td>
                          <td><Badge status={d.is_overdue ? 'overdue' : d.status} /></td>
                          <td className="text-right font-mono tabular-nums font-medium">
                            {fmtMXN(pending)}
                          </td>
                          <td className="text-right">
                            <input type="number" step="0.01" min="0" inputMode="decimal"
                              value={appByArId[d.id] ?? ''}
                              onChange={e => updateApp(d.id, e.target.value)}
                              className={clsx('input text-right text-sm h-8 py-0',
                                excess && 'border-status-danger/40 bg-status-danger/10')}
                              placeholder="0.00" />
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
              )}

              {/* Resumen */}
              {amountNum > 0 && (
                <div className="mt-3 grid grid-cols-3 gap-2">
                  <div className="bg-surface-elevated/40 rounded-lg px-3 py-2">
                    <p className="text-[10px] text-ink-muted uppercase tracking-wide">Recibido</p>
                    <p className="text-sm font-mono font-semibold">{fmtMXN(amountNum)}</p>
                  </div>
                  <div className={clsx('rounded-lg px-3 py-2',
                    overflow > 0.01 ? 'bg-status-danger/10' : 'bg-brand-500/10')}>
                    <p className={clsx('text-[10px] uppercase tracking-wide',
                      overflow > 0.01 ? 'text-status-danger' : 'text-brand-500')}>Aplicado</p>
                    <p className={clsx('text-sm font-mono font-semibold',
                      overflow > 0.01 ? 'text-status-danger' : 'text-brand-300')}>{fmtMXN(totalApplied)}</p>
                  </div>
                  <div className={clsx('rounded-lg px-3 py-2',
                    advance > 0.01 ? 'bg-status-warning/10' : 'bg-surface-elevated/40')}>
                    <p className={clsx('text-[10px] uppercase tracking-wide',
                      advance > 0.01 ? 'text-status-warning' : 'text-ink-muted')}>
                      {advance > 0.01 ? 'Anticipo a generar' : 'Sin sobrante'}
                    </p>
                    <p className={clsx('text-sm font-mono font-semibold',
                      advance > 0.01 ? 'text-status-warning' : 'text-ink-muted')}>
                      {fmtMXN(Math.max(0, advance))}
                    </p>
                  </div>
                </div>
              )}

              {overflow > 0.01 && (
                <p className="text-xs text-status-danger mt-2">
                  La suma aplicada ({fmtMXN(totalApplied)}) excede el monto recibido ({fmtMXN(amountNum)}).
                </p>
              )}
            </div>
          )
        )}

        {/* Anticipos disponibles */}
        {partner && statement?.advances?.length > 0 && (
          <div className="bg-status-warning/10 border border-status-warning/40 rounded-lg px-3 py-2">
            <p className="text-xs font-semibold text-status-warning mb-1">
              Anticipos disponibles del cliente
            </p>
            {statement.advances.map(a => (
              <p key={a.id} className="text-xs text-status-warning">
                {fmtDate(a.receipt_date)} · {fmtMXN(a.amount_available)} disponibles de {fmtMXN(a.amount)}
              </p>
            ))}
            <p className="text-[11px] text-status-warning mt-1 italic">
              Puedes aplicarlos desde el detalle de cada documento por cobrar.
            </p>
          </div>
        )}

        {error && <p className="field-error">{error}</p>}

        <div className="flex gap-2 pt-1">
          <button type="button" onClick={onClose} className="btn-secondary flex-1" disabled={mutation.isPending}>
            Cancelar
          </button>
          <button type="submit" className="btn-primary flex-1"
            disabled={mutation.isPending || !partner || !amountNum}>
            {mutation.isPending ? <Spinner size="sm" /> : 'Registrar pago'}
          </button>
        </div>
      </form>
    </div>,
    document.body
  )
}
