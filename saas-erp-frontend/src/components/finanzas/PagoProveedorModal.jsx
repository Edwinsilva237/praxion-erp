import { useState, useCallback, useMemo, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { cxpApi } from '@/api/cxp'
import { partnersApi } from '@/api/partners'
import { bankAccountsApi } from '@/api/bankAccounts'
import Autocomplete from '@/components/ui/Autocomplete'
import Spinner from '@/components/ui/Spinner'
import Badge from '@/components/ui/Badge'
import { fmtMXN, fmtDate, fmtDateOnly} from '@/utils/fmt'
import clsx from 'clsx'

const METHOD_OPTS = [
  ['transfer', 'Transferencia'],
  ['cash',     'Efectivo'],
  ['check',    'Cheque'],
]

const DOC_TYPE_LABEL = {
  invoice:      'Factura',
  remission:    'Remisión',
  credit_note:  'Nota de crédito',
}

/**
 * Modal para registrar un pago a proveedor y aplicarlo a uno o varios documentos CXP.
 *
 * Props:
 *   onClose, onSaved
 *   initialPartnerId — opcional, salta selector de proveedor
 *   initialApId      — opcional, preselecciona ese documento para aplicar
 */
export function PagoProveedorModal({ onClose, onSaved, initialPartnerId = null, initialApId = null }) {
  const qc = useQueryClient()

  const [partner, setPartner]     = useState(null)
  const [paymentDate, setPaymentDate] = useState(() => new Date().toISOString().split('T')[0])
  const [method, setMethod]       = useState('transfer')
  const [reference, setReference] = useState('')
  const [bankAccountId, setBankAccountId] = useState('')
  const [amount, setAmount]       = useState('')
  const [appByApId, setAppByApId] = useState({})  // { [apId]: '123.45' }
  const [notes, setNotes]         = useState('')
  const [error, setError]         = useState(null)
  const [saveSurplus, setSaveSurplus] = useState(true)  // guardar sobrante como anticipo

  // Catálogo de cuentas bancarias activas del tenant
  const { data: bankAccounts = [] } = useQuery({
    queryKey: ['bank-accounts', 'active'],
    queryFn:  () => bankAccountsApi.list(),
    staleTime: 5 * 60 * 1000,
  })

  // Si viene initialPartnerId, cargamos el partner
  const { data: prefilledPartner } = useQuery({
    queryKey: ['partner', initialPartnerId],
    queryFn:  () => partnersApi.get(initialPartnerId),
    enabled:  !!initialPartnerId,
  })
  useEffect(() => {
    if (prefilledPartner && !partner) {
      setPartner({ id: prefilledPartner.id, label: prefilledPartner.name, sub: prefilledPartner.rfc || '' })
    }
  }, [prefilledPartner])

  // Estado de cuenta del proveedor
  const { data: statement, isLoading: stmtLoading } = useQuery({
    queryKey: ['supplier-statement', partner?.id],
    queryFn:  () => cxpApi.supplierStatement(partner.id),
    enabled:  !!partner?.id,
  })

  // Anticipos disponibles del proveedor (solo informativo en V1)
  const { data: availableAdvances = [] } = useQuery({
    queryKey: ['ap-advances', partner?.id, 'available'],
    queryFn:  () => cxpApi.listAdvances({ partnerId: partner.id, onlyAvailable: 1 }),
    enabled:  !!partner?.id,
  })
  const totalAvailableAdvances = availableAdvances.reduce(
    (s, a) => s + parseFloat(a.amount_available || 0), 0
  )

  // Pendientes ordenados por más vencido primero
  const pendingDocs = useMemo(() => {
    const list = statement?.documents || []
    return list.filter(d => d.status !== 'paid' && d.status !== 'cancelled')
  }, [statement])

  // Cuando carga el statement, si hay initialApId, prellenar ese documento
  useEffect(() => {
    if (!pendingDocs.length || !initialApId) return
    const doc = pendingDocs.find(d => d.id === initialApId)
    if (doc) {
      setAppByApId(prev => ({ ...prev, [doc.id]: String(doc.amount_pending) }))
      setAmount(String(doc.amount_pending))
    }
  }, [pendingDocs.length, initialApId])

  const searchPartners = useCallback(async (q) => {
    const res = await partnersApi.list({ search: q, role: 'supplier', limit: 20 })
    return (res.data || res).map(p => ({ id: p.id, label: p.name, sub: p.rfc || '' }))
  }, [])

  const totalApplied = useMemo(() => {
    return Object.values(appByApId).reduce((s, v) => s + (parseFloat(v) || 0), 0)
  }, [appByApId])

  const amountNum = parseFloat(amount) || 0
  const overflow  = totalApplied - amountNum     // > 0 si aplicaron de más
  const remaining = amountNum - totalApplied     // > 0 si sobra (no se permite anticipo a proveedor en V1)

  function updateApp(apId, val) {
    setAppByApId(prev => {
      if (!val) { const { [apId]: _, ...rest } = prev; return rest }
      return { ...prev, [apId]: val }
    })
  }

  function autoFillFromAmount() {
    // FIFO: aplicar el monto a los documentos más vencidos primero.
    if (!amountNum) return
    if (!pendingDocs.length) return
    let leftover = amountNum
    const result = {}
    for (const doc of pendingDocs) {
      if (leftover <= 0) break
      const pending = parseFloat(doc.amount_pending)
      const toApply = Math.min(pending, leftover)
      if (toApply > 0) {
        result[doc.id] = toApply.toFixed(2)
        leftover -= toApply
      }
    }
    setAppByApId(result)
  }

  const mutation = useMutation({
    mutationFn: () => {
      if (!partner?.id) throw new Error('Selecciona un proveedor.')
      if (!amountNum || amountNum <= 0) throw new Error('Captura un monto válido.')
      // Solo el cheque exige número; SPEI / referencia de transfer es opcional.
      if (method === 'check' && !reference.trim()) {
        throw new Error('El número de cheque es requerido.')
      }
      if (overflow > 0.01) throw new Error('La suma aplicada excede el monto del pago.')
      if (remaining > 0.01 && !saveSurplus) {
        throw new Error(`Faltan ${fmtMXN(remaining)} por aplicar. Marca "Guardar como anticipo" o redistribuye el monto.`)
      }

      const applications = Object.entries(appByApId)
        .map(([apId, v]) => ({ apId, amountApplied: parseFloat(v) }))
        .filter(a => a.amountApplied > 0)

      // Permitido: solo registrar anticipo (sin aplicar a documentos),
      // siempre que haya sobrante y saveSurplus esté marcado.
      if (applications.length === 0 && !(remaining > 0.01 && saveSurplus)) {
        throw new Error('Captura el monto a aplicar a al menos un documento o marca el sobrante como anticipo.')
      }

      return cxpApi.registerPayment({
        supplierId:    partner.id,
        paymentDate,
        method,
        reference:     reference.trim() || null,
        bankAccountId: bankAccountId || null,
        amount:        amountNum,
        applications,
        saveSurplusAsAdvance: saveSurplus && remaining > 0.01,
        notes:         notes.trim() || null,
      })
    },
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['cxp'] })
      qc.invalidateQueries({ queryKey: ['supplier-statement', partner.id] })
      onSaved?.({ ...res, amount: amountNum })
      onClose()
    },
    onError: (e) => setError(e.response?.data?.error || e.message || 'Error al registrar el pago'),
  })

  function handleSubmit(e) { e.preventDefault(); setError(null); mutation.mutate() }

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40 p-4">
      <form onSubmit={handleSubmit}
        className="card w-full max-w-3xl p-4 sm:p-6 max-h-[92vh] overflow-y-auto flex flex-col gap-5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-status-danger/15 flex items-center justify-center shrink-0">
              <svg className="w-4 h-4 text-status-danger" fill="currentColor" viewBox="0 0 24 24">
                <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/>
              </svg>
            </div>
            <div>
              <h2 className="text-base font-semibold text-ink-primary">Registrar pago a proveedor</h2>
              <p className="text-xs text-ink-muted mt-0.5">Aplica un pago a uno o varios documentos pendientes del proveedor</p>
            </div>
          </div>
          <button type="button" onClick={onClose} className="btn-ghost btn-icon text-ink-muted">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12"/>
            </svg>
          </button>
        </div>

        {/* Proveedor */}
        <div>
          <label className="label">Proveedor <span className="text-status-danger">*</span></label>
          <Autocomplete
            value={partner}
            onChange={setPartner}
            onSearch={searchPartners}
            placeholder="Buscar proveedor..."
            disabled={!!initialPartnerId}
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
                  {method === 'transfer' && <span className="text-ink-muted text-xs"> (opcional)</span>}
                </label>
                <input className="input" value={reference} onChange={e => setReference(e.target.value)}
                  placeholder={method === 'transfer' ? 'SPEI / folio (opcional)' : method === 'check' ? '# cheque' : 'Opcional'} />
              </div>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="label">
                  Banco emisor
                  <span className="text-ink-muted text-xs"> (¿de qué cuenta sale?)</span>
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
                <label className="label">Monto del pago <span className="text-status-danger">*</span></label>
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

        {/* Aviso de anticipos disponibles (solo informativo en V1; aplicarlos
            se hace desde el panel CXP) */}
        {partner && availableAdvances.length > 0 && (
          <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-4 flex items-start gap-3">
            <span className="text-2xl shrink-0">💰</span>
            <div className="flex-1">
              <p className="text-sm font-semibold text-emerald-800">
                {availableAdvances.length} anticipo{availableAdvances.length !== 1 ? 's' : ''} disponible{availableAdvances.length !== 1 ? 's' : ''} · {fmtMXN(totalAvailableAdvances)}
              </p>
              <p className="text-xs text-emerald-700 mt-0.5">
                Para aplicar un anticipo existente a una factura, ábrela desde Cuentas por Pagar y usa "Aplicar anticipo" en el panel de detalle.
              </p>
            </div>
          </div>
        )}

        {/* Documentos pendientes */}
        {partner && (
          stmtLoading ? (
            <div className="flex justify-center py-6"><Spinner /></div>
          ) : pendingDocs.length === 0 ? (
            <div className="bg-status-success/10 border border-status-success/40 rounded-lg px-3 py-3 text-center">
              <p className="text-sm text-status-success">Este proveedor no tiene documentos pendientes.</p>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              <div className="flex items-center justify-between">
                <p className="text-xs font-bold text-brand-300 uppercase tracking-wider">
                  Documentos pendientes ({pendingDocs.length})
                </p>
                {amountNum > 0 && (
                  <button type="button" onClick={autoFillFromAmount}
                    className="btn-ghost btn-sm text-brand-300">
                    Aplicar a los más vencidos
                  </button>
                )}
              </div>

              {/* Escritorio: tabla */}
              <div className="hidden sm:block border border-line-subtle rounded-xl overflow-x-auto">
                <table className="table text-xs min-w-full">
                  <thead>
                    <tr>
                      <th>Documento</th>
                      <th>Emitido</th>
                      <th>Vence</th>
                      <th>Estado</th>
                      <th className="text-right">Pendiente</th>
                      <th className="text-right w-40">Aplicar</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pendingDocs.map(d => {
                      const pending = parseFloat(d.amount_pending)
                      const applied = parseFloat(appByApId[d.id]) || 0
                      const overApplied = applied > pending + 0.01
                      return (
                        <tr key={d.id} className={clsx(d.is_overdue && 'bg-status-danger/10/30')}>
                          <td>
                            <div className="flex items-center gap-2">
                              <span className="text-[10px] font-bold uppercase tracking-wide bg-surface-elevated/60 text-ink-secondary px-1.5 py-0.5 rounded-full">
                                {DOC_TYPE_LABEL[d.document_type] || d.document_type}
                              </span>
                              <span className="font-mono font-semibold text-brand-300">{d.document_number}</span>
                            </div>
                          </td>
                          <td className="text-ink-secondary">{fmtDateOnly(d.issue_date)}</td>
                          <td className={clsx(d.is_overdue ? 'text-status-danger font-semibold' : 'text-ink-secondary')}>
                            {fmtDateOnly(d.due_date)}
                          </td>
                          <td><Badge status={d.is_overdue ? 'overdue' : d.status} /></td>
                          <td className="text-right font-mono tabular-nums font-semibold text-status-warning">
                            {fmtMXN(pending)}
                          </td>
                          <td className="text-right">
                            <input type="number" step="0.01" min="0" max={pending}
                              inputMode="decimal"
                              className={clsx('input text-right text-sm w-36',
                                overApplied && 'border-status-danger/40')}
                              value={appByApId[d.id] || ''}
                              onChange={e => updateApp(d.id, e.target.value)}
                              placeholder="0.00" />
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>

              {/* Móvil: tarjetas — "Aplicar" queda accesible sin scroll horizontal */}
              <div className="sm:hidden flex flex-col gap-2">
                {pendingDocs.map(d => {
                  const pending = parseFloat(d.amount_pending)
                  const applied = parseFloat(appByApId[d.id]) || 0
                  const overApplied = applied > pending + 0.01
                  return (
                    <div key={d.id} className={clsx('border rounded-xl p-3 flex flex-col gap-2',
                      d.is_overdue ? 'border-status-danger/40 bg-status-danger/10/40' : 'border-line-subtle')}>
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-[10px] font-bold uppercase tracking-wide bg-surface-elevated/60 text-ink-secondary px-1.5 py-0.5 rounded-full">
                              {DOC_TYPE_LABEL[d.document_type] || d.document_type}
                            </span>
                            <span className="font-mono font-semibold text-brand-300">{d.document_number}</span>
                          </div>
                          <p className="text-[10px] text-ink-muted mt-1">
                            Emitido {fmtDateOnly(d.issue_date)} · Vence{' '}
                            <span className={clsx(d.is_overdue && 'text-status-danger font-semibold')}>{fmtDateOnly(d.due_date)}</span>
                          </p>
                        </div>
                        <Badge status={d.is_overdue ? 'overdue' : d.status} />
                      </div>
                      <div className="flex items-end justify-between gap-3">
                        <div className="shrink-0">
                          <p className="text-[10px] text-ink-muted uppercase tracking-wide">Pendiente</p>
                          <p className="text-sm font-mono tabular-nums font-semibold text-status-warning">{fmtMXN(pending)}</p>
                        </div>
                        <div className="flex-1 max-w-[55%]">
                          <label className="text-[10px] text-ink-muted uppercase tracking-wide block mb-0.5">Aplicar</label>
                          <input type="number" step="0.01" min="0" max={pending} inputMode="decimal"
                            className={clsx('input w-full text-right font-mono tabular-nums text-base h-10',
                              overApplied && 'border-status-danger/40 bg-status-danger/10')}
                            value={appByApId[d.id] || ''}
                            onChange={e => updateApp(d.id, e.target.value)}
                            placeholder="0.00" />
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>

              {/* Resumen del pago */}
              <div className="flex flex-col gap-1 text-sm">
                <div className="flex justify-between">
                  <span className="text-ink-muted">Monto del pago:</span>
                  <span className="font-mono tabular-nums">{fmtMXN(amountNum)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-ink-muted">Total aplicado:</span>
                  <span className="font-mono tabular-nums">{fmtMXN(totalApplied)}</span>
                </div>
                {overflow > 0.01 ? (
                  <div className="flex justify-between font-semibold text-status-danger">
                    <span>Excedente (no permitido):</span>
                    <span className="font-mono tabular-nums">{fmtMXN(overflow)}</span>
                  </div>
                ) : remaining > 0.01 ? (
                  <div className="flex flex-col gap-2 border-t border-status-warning/40 pt-2 mt-1">
                    <div className="flex justify-between font-semibold text-status-warning">
                      <span>Por aplicar (sobrante):</span>
                      <span className="font-mono tabular-nums">{fmtMXN(remaining)}</span>
                    </div>
                    <label className="flex items-start gap-2 text-sm text-status-warning cursor-pointer">
                      <input type="checkbox" className="mt-0.5 w-4 h-4 accent-amber-600"
                        checked={saveSurplus}
                        onChange={e => setSaveSurplus(e.target.checked)} />
                      <span>
                        💰 Guardar el sobrante de <strong>{fmtMXN(remaining)}</strong> como
                        <strong> anticipo del proveedor</strong> para usarlo en futuras facturas.
                      </span>
                    </label>
                  </div>
                ) : amountNum > 0 ? (
                  <div className="flex justify-between font-semibold text-status-success">
                    <span>Listo para registrar</span>
                    <span>✓</span>
                  </div>
                ) : null}
              </div>
            </div>
          )
        )}

        {error && (
          <div className="bg-status-danger/10 border border-status-danger/40 rounded-lg px-3 py-2">
            <p className="text-sm text-status-danger">{error}</p>
          </div>
        )}

        <div className="flex gap-2 pt-1">
          <button type="button" onClick={onClose} className="btn-secondary flex-1">Cancelar</button>
          <button type="submit" disabled={mutation.isPending || !partner || !amountNum}
            className="btn-primary flex-1">
            {mutation.isPending ? <Spinner size="sm" /> : 'Registrar pago'}
          </button>
        </div>
      </form>
    </div>,
    document.body
  )
}
