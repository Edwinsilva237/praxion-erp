import { useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { creditCardsApi } from '@/api/creditCards'
import { usersApi } from '@/api/users'
import Spinner from '@/components/ui/Spinner'
import Can from '@/components/auth/Can'
import clsx from 'clsx'

const CURRENCIES = ['MXN', 'USD']

export default function TarjetasCredito() {
  const qc = useQueryClient()
  const [showInactive, setShowInactive] = useState(false)
  const [editing, setEditing] = useState(null) // null | card | 'new'
  const [msg, setMsg] = useState(null)
  const [error, setError] = useState(null)

  const { data: cards = [], isLoading } = useQuery({
    queryKey: ['credit-cards', showInactive],
    queryFn:  () => creditCardsApi.list({ includeInactive: showInactive ? '1' : '' }),
  })

  const deactivate = useMutation({
    mutationFn: (id) => creditCardsApi.remove(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['credit-cards'] })
      setMsg('Tarjeta desactivada.')
      setTimeout(() => setMsg(null), 3000)
    },
    onError: (e) => setError(e.response?.data?.error || e.message),
  })

  return (
    <div className="page-enter max-w-4xl mx-auto py-6 px-4 flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-xl font-semibold text-ink-primary">Configuración · Tarjetas de crédito</h1>
          <p className="text-sm text-ink-muted mt-1">
            Catálogo de tarjetas del negocio. Al pagar un gasto con tarjeta puedes asociarlo a una de estas,
            y te recordamos la fecha límite de pago según el día que configures.
          </p>
        </div>
        <Can do="financials:create">
          <button onClick={() => setEditing('new')} className="btn-primary">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4"/>
            </svg>
            Nueva tarjeta
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
          Mostrar tarjetas inactivas
        </label>
        <span className="text-xs text-ink-muted">{cards.length} tarjeta(s)</span>
      </div>

      <div className="card overflow-hidden">
        {isLoading ? (
          <div className="flex justify-center py-16"><Spinner /></div>
        ) : cards.length === 0 ? (
          <div className="flex flex-col items-center gap-3 py-16 text-center">
            <p className="text-sm text-ink-muted">Aún no hay tarjetas registradas.</p>
            <Can do="financials:create">
              <button onClick={() => setEditing('new')} className="btn-primary btn-sm">
                Crear primera tarjeta
              </button>
            </Can>
          </div>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Tarjeta</th>
                <th>Banco</th>
                <th>Corte</th>
                <th>Pago</th>
                <th>Responsable</th>
                <th>Moneda</th>
                <th>Estado</th>
                <th className="text-right">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {cards.map(c => (
                <tr key={c.id} className={clsx(!c.active && 'opacity-60')}>
                  <td className="font-medium text-ink-primary">
                    {c.alias}{c.last_four && <span className="text-ink-muted font-mono"> ••{c.last_four}</span>}
                  </td>
                  <td className="text-ink-secondary">{c.bank_name || <span className="text-ink-muted">—</span>}</td>
                  <td className="text-center">{c.statement_day}</td>
                  <td className="text-center font-semibold">{c.payment_day}</td>
                  <td className="text-ink-secondary text-xs">
                    {c.responsible_full_name || c.responsible_name || <span className="text-ink-muted">—</span>}
                  </td>
                  <td>
                    <span className={clsx(
                      'text-[10px] font-bold uppercase px-1.5 py-0.5 rounded-full',
                      c.currency === 'USD' ? 'bg-status-success/15 text-status-success' : 'bg-status-info/15 text-status-info'
                    )}>
                      {c.currency}
                    </span>
                  </td>
                  <td>
                    {c.active
                      ? <span className="text-xs text-emerald-700">Activa</span>
                      : <span className="text-xs text-ink-muted">Inactiva</span>}
                  </td>
                  <td className="text-right">
                    <Can do="financials:update">
                      <button onClick={() => setEditing(c)} className="btn-ghost btn-sm">Editar</button>
                    </Can>
                    {c.active && (
                      <Can do="financials:delete">
                        <button
                          onClick={() => {
                            if (confirm(`Desactivar la tarjeta "${c.alias}"?`)) deactivate.mutate(c.id)
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
        <CreditCardModal
          card={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            qc.invalidateQueries({ queryKey: ['credit-cards'] })
            setEditing(null)
            setMsg('Tarjeta guardada.')
            setTimeout(() => setMsg(null), 3000)
          }}
        />
      )}
    </div>
  )
}

function CreditCardModal({ card, onClose, onSaved }) {
  const isNew = !card
  const blank = {
    alias: '', bankName: '', lastFour: '', statementDay: '', paymentDay: '',
    responsibleUserId: '', creditLimit: '', currency: 'MXN', reminderLeadDays: 3,
    active: true, notes: '',
  }
  const fromCard = (c) => ({
    alias: c.alias || '', bankName: c.bank_name || '', lastFour: c.last_four || '',
    statementDay: c.statement_day || '', paymentDay: c.payment_day || '',
    responsibleUserId: c.responsible_user_id || '', creditLimit: c.credit_limit ?? '',
    currency: c.currency || 'MXN', reminderLeadDays: c.reminder_lead_days ?? 3,
    active: c.active ?? true, notes: c.notes || '',
  })
  const [form, setForm] = useState(card ? fromCard(card) : blank)
  const [error, setError] = useState(null)

  useEffect(() => { if (card) setForm(fromCard(card)) }, [card])

  // Usuarios activos del tenant para el dropdown de responsable.
  const { data: usersResp } = useQuery({
    queryKey: ['users', 'active-for-cards'],
    queryFn:  () => usersApi.list({ isActive: true }),
    staleTime: 5 * 60 * 1000,
  })
  const users = usersResp?.data || usersResp || []

  const mutation = useMutation({
    mutationFn: () => {
      if (!form.alias.trim()) throw new Error('El alias es requerido.')
      const sd = parseInt(form.statementDay, 10), pd = parseInt(form.paymentDay, 10)
      if (!(sd >= 1 && sd <= 31)) throw new Error('El día de corte debe estar entre 1 y 31.')
      if (!(pd >= 1 && pd <= 31)) throw new Error('El día de pago debe estar entre 1 y 31.')
      if (form.lastFour && !/^[0-9]{4}$/.test(form.lastFour)) throw new Error('Los últimos 4 dígitos deben ser 4 números.')
      const body = {
        ...form,
        alias: form.alias.trim(),
        responsibleUserId: form.responsibleUserId || null,
        creditLimit: form.creditLimit === '' ? null : form.creditLimit,
      }
      return isNew ? creditCardsApi.create(body) : creditCardsApi.update(card.id, body)
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
            {isNew ? 'Nueva tarjeta de crédito' : 'Editar tarjeta de crédito'}
          </h2>
          <button type="button" onClick={onClose} className="text-ink-muted hover:text-ink-secondary">×</button>
        </div>

        <div>
          <label className="label">Alias <span className="text-status-danger">*</span></label>
          <input className="input" value={form.alias}
            onChange={e => set('alias', e.target.value)}
            placeholder="BBVA Oro, Amex Empresa, etc." />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="label">Banco</label>
            <input className="input" value={form.bankName}
              onChange={e => set('bankName', e.target.value)} placeholder="Opcional" />
          </div>
          <div>
            <label className="label">Últimos 4 dígitos</label>
            <input className="input font-mono" value={form.lastFour}
              onChange={e => set('lastFour', e.target.value.replace(/\D/g, '').slice(0, 4))}
              placeholder="4321" />
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="label">Día de corte <span className="text-status-danger">*</span></label>
            <input type="number" min="1" max="31" className="input" value={form.statementDay}
              onChange={e => set('statementDay', e.target.value)} placeholder="1–31" />
          </div>
          <div>
            <label className="label">Día límite de pago <span className="text-status-danger">*</span></label>
            <input type="number" min="1" max="31" className="input" value={form.paymentDay}
              onChange={e => set('paymentDay', e.target.value)} placeholder="1–31" />
          </div>
        </div>

        <div>
          <label className="label">Responsable <span className="text-ink-muted">(recibe el recordatorio)</span></label>
          <select className="select" value={form.responsibleUserId}
            onChange={e => set('responsibleUserId', e.target.value)}>
            <option value="">— Sin responsable —</option>
            {users.map(u => (
              <option key={u.id} value={u.id}>{u.full_name || u.fullName || u.email}</option>
            ))}
          </select>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div>
            <label className="label">Moneda</label>
            <select className="select" value={form.currency}
              onChange={e => set('currency', e.target.value)}>
              {CURRENCIES.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <div>
            <label className="label">Límite</label>
            <input type="number" min="0" step="0.01" className="input" value={form.creditLimit}
              onChange={e => set('creditLimit', e.target.value)} placeholder="Opcional" />
          </div>
          <div>
            <label className="label">Avisar (días antes)</label>
            <input type="number" min="0" max="30" className="input" value={form.reminderLeadDays}
              onChange={e => set('reminderLeadDays', e.target.value)} />
          </div>
        </div>

        <div>
          <label className="label">Notas</label>
          <textarea className="input" rows={2} value={form.notes}
            onChange={e => set('notes', e.target.value)} placeholder="Opcional" />
        </div>

        {!isNew && (
          <label className="flex items-center gap-2 text-sm text-ink-secondary">
            <input type="checkbox" checked={form.active}
              onChange={e => set('active', e.target.checked)} />
            Tarjeta activa (visible en selectores)
          </label>
        )}

        {error && <p className="field-error">{error}</p>}

        <div className="flex gap-2">
          <button type="button" onClick={onClose} className="btn-secondary flex-1"
            disabled={mutation.isPending}>Cancelar</button>
          <button type="submit" className="btn-primary flex-1"
            disabled={mutation.isPending || !form.alias.trim()}>
            {mutation.isPending ? <Spinner size="sm" /> : (isNew ? 'Crear' : 'Guardar')}
          </button>
        </div>
      </form>
    </div>,
    document.body
  )
}
