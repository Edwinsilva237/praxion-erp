import { useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { bankAccountsApi } from '@/api/bankAccounts'
import Spinner from '@/components/ui/Spinner'
import Can from '@/components/auth/Can'
import clsx from 'clsx'

const CURRENCIES = ['MXN', 'USD']

export default function CuentasBancarias() {
  const qc = useQueryClient()
  const [showInactive, setShowInactive] = useState(false)
  const [editing, setEditing] = useState(null) // null | account | 'new'
  const [msg, setMsg] = useState(null)
  const [error, setError] = useState(null)

  const { data: accounts = [], isLoading } = useQuery({
    queryKey: ['bank-accounts', showInactive],
    queryFn:  () => bankAccountsApi.list({ includeInactive: showInactive ? '1' : '' }),
  })

  const deactivate = useMutation({
    mutationFn: (id) => bankAccountsApi.remove(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['bank-accounts'] })
      setMsg('Cuenta desactivada.')
      setTimeout(() => setMsg(null), 3000)
    },
    onError: (e) => setError(e.response?.data?.error || e.message),
  })

  return (
    <div className="page-enter max-w-4xl mx-auto py-6 px-4 flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-xl font-semibold text-ink-primary">Configuración · Cuentas bancarias</h1>
          <p className="text-sm text-ink-muted mt-1">
            Catálogo de cuentas bancarias del negocio. Se usan para registrar a qué cuenta cayó cada cobro.
          </p>
        </div>
        <Can do="financials:create">
          <button onClick={() => setEditing('new')} className="btn-primary">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4"/>
            </svg>
            Nueva cuenta
          </button>
        </Can>
      </div>

      {msg && (
        <div className="bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2">
          <p className="text-sm text-emerald-700">{msg}</p>
        </div>
      )}
      {error && (
        <div className="bg-status-danger/10 border border-status-danger/40 rounded-lg px-3 py-2 flex items-center justify-between">
          <p className="text-sm text-status-danger">{error}</p>
          <button onClick={() => setError(null)} className="text-status-danger">×</button>
        </div>
      )}

      <div className="card p-3 flex items-center justify-between">
        <label className="flex items-center gap-2 text-sm text-ink-secondary">
          <input type="checkbox" checked={showInactive}
            onChange={e => setShowInactive(e.target.checked)} />
          Mostrar cuentas inactivas
        </label>
        <span className="text-xs text-ink-muted">{accounts.length} cuenta(s)</span>
      </div>

      <div className="card overflow-hidden">
        {isLoading ? (
          <div className="flex justify-center py-16"><Spinner /></div>
        ) : accounts.length === 0 ? (
          <div className="flex flex-col items-center gap-3 py-16 text-center">
            <p className="text-sm text-ink-muted">
              Aún no hay cuentas bancarias registradas.
            </p>
            <Can do="financials:create">
              <button onClick={() => setEditing('new')} className="btn-primary btn-sm">
                Crear primera cuenta
              </button>
            </Can>
          </div>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Banco</th>
                <th>Alias</th>
                <th>Cuenta</th>
                <th>CLABE</th>
                <th>Moneda</th>
                <th>Estado</th>
                <th className="text-right">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {accounts.map(a => (
                <tr key={a.id} className={clsx(!a.active && 'opacity-60')}>
                  <td className="font-medium text-ink-primary">{a.bank_name}</td>
                  <td className="text-ink-secondary">{a.alias || <span className="text-ink-muted">—</span>}</td>
                  <td className="font-mono text-xs">{a.account_number || <span className="text-ink-muted">—</span>}</td>
                  <td className="font-mono text-xs">{a.clabe || <span className="text-ink-muted">—</span>}</td>
                  <td>
                    <span className={clsx(
                      'text-[10px] font-bold uppercase px-1.5 py-0.5 rounded-full',
                      a.currency === 'USD' ? 'bg-status-success/15 text-status-success' : 'bg-status-info/15 text-status-info'
                    )}>
                      {a.currency}
                    </span>
                  </td>
                  <td>
                    {a.active
                      ? <span className="text-xs text-emerald-700">Activa</span>
                      : <span className="text-xs text-ink-muted">Inactiva</span>}
                  </td>
                  <td className="text-right">
                    <Can do="financials:update">
                      <button onClick={() => setEditing(a)} className="btn-ghost btn-sm">Editar</button>
                    </Can>
                    {a.active && (
                      <Can do="financials:delete">
                        <button
                          onClick={() => {
                            if (confirm(`Desactivar la cuenta "${a.bank_name}${a.alias ? ` · ${a.alias}` : ''}"?`)) {
                              deactivate.mutate(a.id)
                            }
                          }}
                          className="btn-ghost btn-sm text-status-danger">
                          Desactivar
                        </button>
                      </Can>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {editing && (
        <BankAccountModal
          account={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            qc.invalidateQueries({ queryKey: ['bank-accounts'] })
            setEditing(null)
            setMsg('Cuenta guardada.')
            setTimeout(() => setMsg(null), 3000)
          }}
        />
      )}
    </div>
  )
}

function BankAccountModal({ account, onClose, onSaved }) {
  const isNew = !account
  const [form, setForm] = useState({
    bankName:      account?.bank_name      || '',
    alias:         account?.alias          || '',
    accountNumber: account?.account_number || '',
    clabe:         account?.clabe          || '',
    currency:      account?.currency       || 'MXN',
    active:        account?.active ?? true,
    notes:         account?.notes          || '',
  })
  const [error, setError] = useState(null)

  useEffect(() => {
    if (account) {
      setForm({
        bankName:      account.bank_name      || '',
        alias:         account.alias          || '',
        accountNumber: account.account_number || '',
        clabe:         account.clabe          || '',
        currency:      account.currency       || 'MXN',
        active:        account.active ?? true,
        notes:         account.notes          || '',
      })
    }
  }, [account])

  const mutation = useMutation({
    mutationFn: () => {
      if (!form.bankName.trim()) throw new Error('El banco es requerido.')
      if (form.clabe && !/^[0-9]{18}$/.test(form.clabe.trim())) {
        throw new Error('La CLABE debe tener exactamente 18 dígitos.')
      }
      const body = { ...form, bankName: form.bankName.trim() }
      return isNew
        ? bankAccountsApi.create(body)
        : bankAccountsApi.update(account.id, body)
    },
    onSuccess: onSaved,
    onError: (e) => setError(e.response?.data?.error || e.message),
  })

  function set(k, v) { setForm(f => ({ ...f, [k]: v })) }

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40 p-4">
      <form
        onSubmit={(e) => { e.preventDefault(); setError(null); mutation.mutate() }}
        className="card w-full max-w-md p-6 max-h-[90vh] overflow-y-auto flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold text-ink-primary">
            {isNew ? 'Nueva cuenta bancaria' : 'Editar cuenta bancaria'}
          </h2>
          <button type="button" onClick={onClose} className="text-ink-muted hover:text-ink-secondary">×</button>
        </div>

        <div>
          <label className="label">Banco <span className="text-status-danger">*</span></label>
          <input className="input" value={form.bankName}
            onChange={e => set('bankName', e.target.value)}
            placeholder="BBVA, Banorte, Banamex, Santander..." />
        </div>

        <div>
          <label className="label">Alias <span className="text-ink-muted">(opcional)</span></label>
          <input className="input" value={form.alias}
            onChange={e => set('alias', e.target.value)}
            placeholder="Operativa MXN, Nómina USD, etc." />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">No. cuenta</label>
            <input className="input font-mono" value={form.accountNumber}
              onChange={e => set('accountNumber', e.target.value)}
              placeholder="Opcional" />
          </div>
          <div>
            <label className="label">Moneda</label>
            <select className="select" value={form.currency}
              onChange={e => set('currency', e.target.value)}>
              {CURRENCIES.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
        </div>

        <div>
          <label className="label">CLABE <span className="text-ink-muted">(18 dígitos, opcional)</span></label>
          <input className="input font-mono" value={form.clabe}
            onChange={e => set('clabe', e.target.value.replace(/\D/g, '').slice(0, 18))}
            placeholder="012345678901234567" />
        </div>

        <div>
          <label className="label">Notas</label>
          <textarea className="input" rows={2} value={form.notes}
            onChange={e => set('notes', e.target.value)}
            placeholder="Opcional" />
        </div>

        {!isNew && (
          <label className="flex items-center gap-2 text-sm text-ink-secondary">
            <input type="checkbox" checked={form.active}
              onChange={e => set('active', e.target.checked)} />
            Cuenta activa (visible en selectores)
          </label>
        )}

        {error && <p className="field-error">{error}</p>}

        <div className="flex gap-2">
          <button type="button" onClick={onClose} className="btn-secondary flex-1"
            disabled={mutation.isPending}>
            Cancelar
          </button>
          <button type="submit" className="btn-primary flex-1"
            disabled={mutation.isPending || !form.bankName.trim()}>
            {mutation.isPending ? <Spinner size="sm" /> : (isNew ? 'Crear' : 'Guardar')}
          </button>
        </div>
      </form>
    </div>,
    document.body
  )
}
