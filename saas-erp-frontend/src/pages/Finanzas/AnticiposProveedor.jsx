import { useState, useMemo, useCallback } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { createPortal } from 'react-dom'
import { cxpApi } from '@/api/cxp'
import { partnersApi } from '@/api/partners'
import { bankAccountsApi } from '@/api/bankAccounts'
import Autocomplete from '@/components/ui/Autocomplete'
import Spinner from '@/components/ui/Spinner'
import Can from '@/components/auth/Can'
import { fmtMXN, fmtDate, fmtDateOnly} from '@/utils/fmt'
import clsx from 'clsx'

const METHOD_LABEL = {
  cash:                'Efectivo',
  transfer:            'Transferencia',
  check:               'Cheque',
  advance_application: 'Aplicación',
}

const PAGE_SIZE = 30

// ── Modal de registro manual de anticipo ───────────────────────────────────
function NuevoAnticipoModal({ onClose, onSaved }) {
  const qc = useQueryClient()
  const [partner, setPartner]     = useState(null)
  const [amount, setAmount]       = useState('')
  const [method, setMethod]       = useState('transfer')
  const [reference, setReference] = useState('')
  const [bankAccountId, setBank]  = useState('')
  const [date, setDate]           = useState(() => new Date().toISOString().split('T')[0])
  const [notes, setNotes]         = useState('')
  const [error, setError]         = useState(null)

  const { data: bankAccounts = [] } = useQuery({
    queryKey: ['bank-accounts', 'active'],
    queryFn:  () => bankAccountsApi.list(),
    staleTime: 5 * 60 * 1000,
  })

  const searchPartners = useCallback(async (q) => {
    const res = await partnersApi.list({ search: q, type: 'supplier', limit: 20 })
    return (res.data || res).map(p => ({ id: p.id, label: p.name, sub: p.rfc || '' }))
  }, [])

  const mutation = useMutation({
    mutationFn: () => {
      if (!partner?.id) throw new Error('Selecciona un proveedor.')
      const amt = parseFloat(amount)
      if (!amt || amt <= 0) throw new Error('Captura un monto válido.')
      if (method === 'check' && !reference.trim()) {
        throw new Error('El número de cheque es requerido.')
      }
      return cxpApi.registerAdvance({
        partnerId:     partner.id,
        amount:        amt,
        paymentMethod: method,
        reference:     reference.trim() || null,
        bankAccountId: bankAccountId || null,
        paymentDate:   date,
        notes:         notes.trim() || null,
      })
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['ap-advances'] })
      qc.invalidateQueries({ queryKey: ['cxp'] })
      onSaved?.()
      onClose()
    },
    onError: (e) => setError(e.response?.data?.error || e.message || 'Error'),
  })

  function handleSubmit(e) { e.preventDefault(); setError(null); mutation.mutate() }

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40 p-4">
      <form onSubmit={handleSubmit}
        className="card w-full max-w-md p-6 flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold text-ink-primary">💰 Registrar anticipo a proveedor</h2>
            <p className="text-xs text-ink-muted mt-0.5">Pago sin factura asociada (depósito, prepago)</p>
          </div>
          <button type="button" onClick={onClose} className="btn-ghost btn-icon text-ink-muted">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12"/>
            </svg>
          </button>
        </div>

        <div>
          <label className="label">Proveedor <span className="text-status-danger">*</span></label>
          <Autocomplete value={partner} onChange={setPartner} onSearch={searchPartners}
            placeholder="Buscar proveedor..." />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">Monto <span className="text-status-danger">*</span></label>
            <input type="number" step="0.01" min="0" inputMode="decimal" className="input"
              value={amount} onChange={e => setAmount(e.target.value)} placeholder="0.00" />
          </div>
          <div>
            <label className="label">Fecha</label>
            <input type="date" className="input" value={date}
              onChange={e => setDate(e.target.value)} />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">Método <span className="text-status-danger">*</span></label>
            <select className="select" value={method} onChange={e => setMethod(e.target.value)}>
              <option value="transfer">Transferencia</option>
              <option value="cash">Efectivo</option>
              <option value="check">Cheque</option>
            </select>
          </div>
          <div>
            <label className="label">
              Referencia {method === 'check' && <span className="text-status-danger">*</span>}
            </label>
            <input className="input" value={reference} onChange={e => setReference(e.target.value)}
              placeholder={method === 'check' ? '# cheque' : 'Opcional'} />
          </div>
        </div>

        <div>
          <label className="label">Banco emisor <span className="text-ink-muted text-xs">(opcional)</span></label>
          <select className="select" value={bankAccountId} onChange={e => setBank(e.target.value)}>
            <option value="">— Sin asignar —</option>
            {bankAccounts.map(a => (
              <option key={a.id} value={a.id}>
                {a.bank_name}{a.alias ? ` · ${a.alias}` : ''}{a.account_number ? ` (${a.account_number})` : ''} · {a.currency}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="label">Notas</label>
          <input className="input" value={notes} onChange={e => setNotes(e.target.value)}
            placeholder="Concepto, OC asociada, etc." />
        </div>

        {error && <p className="field-error">{error}</p>}

        <div className="flex gap-2 pt-1">
          <button type="button" onClick={onClose} className="btn-secondary flex-1">Cancelar</button>
          <button type="submit" disabled={mutation.isPending}
            className="btn-primary flex-1">
            {mutation.isPending ? <Spinner size="sm" /> : 'Registrar anticipo'}
          </button>
        </div>
      </form>
    </div>,
    document.body
  )
}

// ── Página principal ───────────────────────────────────────────────────────
export default function AnticiposProveedor() {
  const [partner, setPartner]       = useState(null)
  const [onlyAvailable, setOnly]    = useState(true)
  const [search, setSearch]         = useState('')
  const [showNew, setShowNew]       = useState(false)

  const queryParams = useMemo(() => {
    const p = {}
    if (partner?.id)    p.partnerId     = partner.id
    if (onlyAvailable)  p.onlyAvailable = '1'
    return p
  }, [partner, onlyAvailable])

  const { data: advances = [], isLoading } = useQuery({
    queryKey: ['ap-advances', queryParams],
    queryFn:  () => cxpApi.listAdvances(queryParams),
  })

  const searchPartners = useCallback(async (q) => {
    const res = await partnersApi.list({ search: q, type: 'supplier', limit: 20 })
    return (res.data || res).map(p => ({ id: p.id, label: p.name, sub: p.rfc || '' }))
  }, [])

  const filtered = useMemo(() => {
    if (!search.trim()) return advances
    const q = search.trim().toLowerCase()
    return advances.filter(a =>
      (a.partner_name  || '').toLowerCase().includes(q) ||
      (a.reference     || '').toLowerCase().includes(q) ||
      (a.notes         || '').toLowerCase().includes(q)
    )
  }, [advances, search])

  const summary = useMemo(() => ({
    count:     filtered.length,
    total:     filtered.reduce((s, a) => s + parseFloat(a.amount || 0), 0),
    applied:   filtered.reduce((s, a) => s + parseFloat(a.amount_applied || 0), 0),
    available: filtered.reduce((s, a) => s + parseFloat(a.amount_available || 0), 0),
  }), [filtered])

  return (
    <div className="page-enter flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-xl font-semibold text-ink-primary">💰 Anticipos a proveedores</h1>
          <p className="text-xs text-ink-muted mt-0.5">
            Saldos a favor del tenant: prepagos, depósitos y sobre-pagos por aplicar a futuras facturas.
          </p>
        </div>
        <Can do="financials:create">
          <button onClick={() => setShowNew(true)} className="btn-primary">
            + Registrar anticipo
          </button>
        </Can>
      </div>

      {!isLoading && filtered.length > 0 && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <div className="card p-3">
            <p className="text-[10px] text-ink-muted uppercase tracking-wide">Anticipos</p>
            <p className="text-lg font-semibold text-ink-primary mt-0.5">{summary.count}</p>
          </div>
          <div className="card p-3">
            <p className="text-[10px] text-ink-muted uppercase tracking-wide">Monto total</p>
            <p className="text-lg font-mono font-semibold text-ink-primary mt-0.5">{fmtMXN(summary.total)}</p>
          </div>
          <div className="card p-3 bg-status-info/10/40">
            <p className="text-[10px] text-blue-500 uppercase tracking-wide">Aplicado</p>
            <p className="text-lg font-mono font-semibold text-status-info mt-0.5">{fmtMXN(summary.applied)}</p>
          </div>
          <div className="card p-3 bg-emerald-50/40">
            <p className="text-[10px] text-emerald-500 uppercase tracking-wide">Disponible</p>
            <p className="text-lg font-mono font-semibold text-emerald-700 mt-0.5">{fmtMXN(summary.available)}</p>
          </div>
        </div>
      )}

      <div className="card p-4 flex flex-wrap gap-3 items-end">
        <div className="flex-1 min-w-[200px]">
          <label className="label">Buscar</label>
          <input className="input" placeholder="Proveedor, referencia, notas..."
            value={search} onChange={e => setSearch(e.target.value)} />
        </div>
        <div className="min-w-[200px]">
          <label className="label">Proveedor</label>
          <Autocomplete value={partner} onChange={setPartner} onSearch={searchPartners}
            placeholder="Filtrar..." />
        </div>
        <label className="flex items-center gap-2 text-sm text-ink-secondary">
          <input type="checkbox" className="w-4 h-4 accent-emerald-600"
            checked={onlyAvailable}
            onChange={e => setOnly(e.target.checked)} />
          Solo con saldo
        </label>
        {(partner || search || !onlyAvailable) && (
          <button onClick={() => { setPartner(null); setSearch(''); setOnly(true) }}
            className="btn-ghost btn-sm text-ink-muted">
            Limpiar
          </button>
        )}
      </div>

      <div className="card overflow-hidden">
        {isLoading ? (
          <div className="flex justify-center py-16"><Spinner /></div>
        ) : !filtered.length ? (
          <div className="flex flex-col items-center gap-3 py-16 text-center">
            <p className="font-medium text-ink-secondary">Sin anticipos</p>
            <p className="text-sm text-ink-muted">
              Los anticipos se crean automáticamente al pagar más de lo facturado,
              o aquí manualmente con el botón "+ Registrar anticipo".
            </p>
          </div>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Fecha</th>
                <th>Proveedor</th>
                <th>Método</th>
                <th>Banco</th>
                <th>Referencia</th>
                <th className="text-right">Monto</th>
                <th className="text-right">Aplicado</th>
                <th className="text-right">Disponible</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(a => {
                const avail = parseFloat(a.amount_available)
                const isActive = avail > 0.01
                return (
                  <tr key={a.id} className={clsx(!isActive && 'opacity-60')}>
                    <td className="text-ink-secondary text-sm">{fmtDateOnly(a.payment_date)}</td>
                    <td className="font-medium text-ink-primary">{a.partner_name}</td>
                    <td className="text-sm">{METHOD_LABEL[a.payment_method] || a.payment_method}</td>
                    <td className="text-[11px] text-ink-secondary">
                      {a.bank_name ? <>{a.bank_name}{a.bank_alias && ` · ${a.bank_alias}`}</> : <span className="text-ink-muted">—</span>}
                    </td>
                    <td className="text-xs text-ink-secondary font-mono">{a.reference || '—'}</td>
                    <td className="text-right font-mono tabular-nums">{fmtMXN(a.amount)}</td>
                    <td className="text-right font-mono tabular-nums text-status-info">{fmtMXN(a.amount_applied)}</td>
                    <td className={clsx('text-right font-mono tabular-nums font-semibold',
                      isActive ? 'text-emerald-700' : 'text-ink-muted')}>
                      {fmtMXN(avail)}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>

      {showNew && (
        <NuevoAnticipoModal
          onClose={() => setShowNew(false)}
          onSaved={() => {}}
        />
      )}
    </div>
  )
}
