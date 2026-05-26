import { useState, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { financialsApi } from '@/api/financials'
import { bankAccountsApi } from '@/api/bankAccounts'
import Spinner from '@/components/ui/Spinner'
import { fmtMXN, fmtDate } from '@/utils/fmt'
import clsx from 'clsx'

const MATCH_LABELS = {
  exact_single: { text: 'Exacto · 1 factura',     cls: 'bg-emerald-100 text-emerald-700' },
  exact_pair:   { text: 'Exacto · combinación 2', cls: 'bg-emerald-100 text-emerald-700' },
  exact_triple: { text: 'Exacto · combinación 3', cls: 'bg-teal-500/15 text-teal-300' },
  partial:      { text: 'Parcial · cubre parte',  cls: 'bg-status-warning/15 text-status-warning' },
}

const METHOD_OPTS = [
  ['transfer', 'Transferencia'],
  ['cash',     'Efectivo'],
  ['check',    'Cheque'],
]

/**
 * Conciliación bancaria: el banco reporta un depósito sin identificar al
 * emisor. Capturas el monto, el sistema busca facturas pendientes que
 * sumen ese monto (1 factura, combinaciones de 2-3, o parcial), eliges
 * el match más probable y aplicas el pago en un solo paso.
 */
export function IdentificarPagoModal({ onClose, onSaved }) {
  const qc = useQueryClient()

  const [amount, setAmount]         = useState('')
  const [currency, setCurrency]     = useState('MXN')
  const [tolerance, setTolerance]   = useState('0.5')
  const [paymentDate, setPaymentDate] = useState(() => new Date().toISOString().split('T')[0])
  const [method, setMethod]         = useState('transfer')
  const [reference, setReference]   = useState('')
  const [bankAccountId, setBankAccountId] = useState('')
  const [notes, setNotes]           = useState('')
  const [results, setResults]       = useState(null)
  const [selected, setSelected]     = useState(null)  // index del match elegido
  const [searched, setSearched]     = useState(false)
  const [error, setError]           = useState(null)

  const { data: bankAccounts = [] } = useQuery({
    queryKey: ['bank-accounts', 'active'],
    queryFn:  () => bankAccountsApi.list(),
    staleTime: 5 * 60 * 1000,
  })

  const amountNum = parseFloat(amount) || 0

  const searchMut = useMutation({
    mutationFn: () => {
      if (!amountNum) throw new Error('Captura un monto.')
      return financialsApi.matchPayment({
        amount:    amountNum,
        currency,
        tolerance: parseFloat(tolerance) || 0.5,
      })
    },
    onSuccess: (res) => {
      setResults(res)
      setSearched(true)
      setSelected(null)
    },
    onError: (e) => setError(e.response?.data?.error || e.message),
  })

  const applyMut = useMutation({
    mutationFn: () => {
      if (selected === null) throw new Error('Selecciona una coincidencia.')
      const match = results.matches[selected]
      const applications = match.invoices.map(inv => ({
        arId:           inv.ar_id,
        amountApplied:  inv.amount_to_apply,
      }))
      return financialsApi.registerPayment({
        partnerId:     match.partner_id,
        paymentDate,
        method,
        reference:     reference.trim() || null,
        bankAccountId: bankAccountId || null,
        amount:        amountNum,
        applications,
        notes:         notes.trim() || `Identificado desde conciliación bancaria · ${amountNum.toFixed(2)}`,
      })
    },
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['cxc'] })
      onSaved?.({ ...res, match: results.matches[selected] })
      onClose()
    },
    onError: (e) => setError(e.response?.data?.error || e.message),
  })

  const matches = results?.matches || []
  const selectedMatch = selected !== null ? matches[selected] : null

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40 p-4">
      <div className="card w-full max-w-3xl p-6 max-h-[92vh] overflow-y-auto flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-purple-500/15 flex items-center justify-center shrink-0">
              <svg className="w-4 h-4 text-purple-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"/>
              </svg>
            </div>
            <div>
              <h2 className="text-base font-semibold text-ink-primary">Identificar pago bancario</h2>
              <p className="text-xs text-ink-muted mt-0.5">
                Buscar facturas pendientes que sumen el monto recibido
              </p>
            </div>
          </div>
          <button onClick={onClose} className="text-ink-muted hover:text-ink-secondary">×</button>
        </div>

        {/* Paso 1: Captura del depósito */}
        <div className="bg-surface-elevated/60 border border-line-subtle rounded-xl p-4 flex flex-col gap-3">
          <p className="text-xs font-bold text-brand-300 uppercase tracking-wider">
            1 · Datos del depósito
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
            <div className="sm:col-span-2">
              <label className="label">Monto recibido <span className="text-status-danger">*</span></label>
              <input type="number" step="0.01" min="0" inputMode="decimal"
                className="input text-base font-mono"
                value={amount} onChange={e => setAmount(e.target.value)}
                placeholder="0.00" />
            </div>
            <div>
              <label className="label">Moneda</label>
              <select className="select" value={currency} onChange={e => setCurrency(e.target.value)}>
                <option value="MXN">MXN</option>
                <option value="USD">USD</option>
              </select>
            </div>
            <div>
              <label className="label">Tolerancia</label>
              <input type="number" step="0.01" min="0" className="input font-mono"
                value={tolerance} onChange={e => setTolerance(e.target.value)} />
              <p className="text-[10px] text-ink-muted mt-0.5">{currency} de diferencia aceptable</p>
            </div>
          </div>
          <button onClick={() => { setError(null); searchMut.mutate() }}
            disabled={searchMut.isPending || !amountNum}
            className="btn-primary self-end">
            {searchMut.isPending ? <Spinner size="sm" /> : 'Buscar coincidencias'}
          </button>
        </div>

        {/* Paso 2: Resultados */}
        {searched && (
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <p className="text-xs font-bold text-brand-300 uppercase tracking-wider">
                2 · Coincidencias encontradas ({matches.length})
              </p>
              <p className="text-[11px] text-ink-muted">
                Buscados {results.searched_invoices} pendientes · {results.searched_partners} clientes
              </p>
            </div>

            {matches.length === 0 ? (
              <div className="bg-status-warning/10 border border-status-warning/40 rounded-lg px-3 py-3 text-center">
                <p className="text-sm text-status-warning">
                  No se encontraron facturas pendientes que sumen {fmtMXN(amountNum, currency)}.
                </p>
                <p className="text-xs text-status-warning mt-1">
                  Sube la tolerancia o registra el monto como anticipo desde "Registrar pago".
                </p>
              </div>
            ) : (
              <div className="border border-line-subtle rounded-xl divide-y divide-line-subtle max-h-72 overflow-y-auto">
                {matches.map((m, i) => {
                  const lbl = MATCH_LABELS[m.match_type] || MATCH_LABELS.partial
                  const isSel = selected === i
                  return (
                    <label key={i} className={clsx(
                      'flex items-start gap-3 px-3 py-2.5 cursor-pointer transition-colors',
                      isSel ? 'bg-purple-500/10' : 'hover:bg-surface-elevated/40'
                    )}>
                      <input type="radio" name="match" className="mt-1 accent-purple-600"
                        checked={isSel} onChange={() => setSelected(i)} />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className={clsx(
                            'text-[10px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded-full',
                            lbl.cls
                          )}>
                            {lbl.text}
                          </span>
                          <span className="text-sm font-medium text-ink-primary">{m.partner_name}</span>
                          {m.partner_rfc && (
                            <span className="text-[10px] text-ink-muted font-mono">{m.partner_rfc}</span>
                          )}
                          {m.diff > 0.001 && (
                            <span className="text-[10px] text-status-warning">
                              diff {fmtMXN(m.diff, currency)}
                            </span>
                          )}
                        </div>
                        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-ink-secondary">
                          {m.invoices.map(inv => (
                            <span key={inv.ar_id}>
                              <span className="font-mono text-brand-300">{inv.document_number}</span>
                              <span className="text-ink-muted"> · pend {fmtMXN(inv.amount_pending, currency)}</span>
                              {inv.amount_to_apply !== inv.amount_pending && (
                                <span className="text-status-warning"> · aplicar {fmtMXN(inv.amount_to_apply, currency)}</span>
                              )}
                            </span>
                          ))}
                        </div>
                      </div>
                      <div className="text-right shrink-0">
                        <p className="text-sm font-mono font-semibold text-status-success">
                          {fmtMXN(m.total, currency)}
                        </p>
                        <p className="text-[10px] text-ink-muted">{m.invoices.length} fact.</p>
                      </div>
                    </label>
                  )
                })}
              </div>
            )}
          </div>
        )}

        {/* Paso 3: Confirmar y aplicar */}
        {selectedMatch && (
          <div className="bg-purple-500/10 border border-purple-500/40 rounded-xl p-4 flex flex-col gap-3">
            <p className="text-xs font-semibold text-purple-300 uppercase tracking-wide">
              3 · Confirmar aplicación a {selectedMatch.partner_name}
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
              <div>
                <label className="label">Fecha</label>
                <input type="date" className="input" value={paymentDate}
                  onChange={e => setPaymentDate(e.target.value)} />
              </div>
              <div>
                <label className="label">Método</label>
                <select className="select" value={method} onChange={e => setMethod(e.target.value)}>
                  {METHOD_OPTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              </div>
              <div className="sm:col-span-2">
                <label className="label">Referencia</label>
                <input className="input" value={reference}
                  onChange={e => setReference(e.target.value)}
                  placeholder="SPEI / folio" />
              </div>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="label">Banco receptor</label>
                <select className="select" value={bankAccountId}
                  onChange={e => setBankAccountId(e.target.value)}>
                  <option value="">— Sin asignar —</option>
                  {bankAccounts.map(a => (
                    <option key={a.id} value={a.id}>
                      {a.bank_name}{a.alias ? ` · ${a.alias}` : ''} · {a.currency}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="label">Notas</label>
                <input className="input" value={notes}
                  onChange={e => setNotes(e.target.value)}
                  placeholder="Opcional" />
              </div>
            </div>
          </div>
        )}

        {error && <p className="field-error">{error}</p>}

        <div className="flex gap-2 pt-1">
          <button onClick={onClose} className="btn-secondary flex-1"
            disabled={searchMut.isPending || applyMut.isPending}>
            Cancelar
          </button>
          <button onClick={() => { setError(null); applyMut.mutate() }}
            disabled={applyMut.isPending || selected === null}
            className="btn-primary flex-1">
            {applyMut.isPending
              ? <Spinner size="sm" />
              : selectedMatch
                ? `Aplicar pago a ${selectedMatch.invoices.length} factura(s)`
                : 'Aplicar pago'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
