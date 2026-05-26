import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { createPortal } from 'react-dom'
import { pettyCashApi } from '@/api/pettyCash'
import { usersApi } from '@/api/users'
import Spinner from '@/components/ui/Spinner'
import clsx from 'clsx'

const fmtMXN = (n) => new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' }).format(n || 0)

export default function CajaChicaFondos() {
  const [editing, setEditing] = useState(null) // { ...fund } or 'new'

  const { data: resp, isLoading } = useQuery({
    queryKey: ['petty-cash', 'funds', { includeInactive: true }],
    queryFn:  () => pettyCashApi.listFunds({ includeInactive: true }),
  })
  const funds = resp?.data || []

  return (
    <div className="page-enter max-w-5xl mx-auto py-6 px-4 flex flex-col gap-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-ink-primary">Cajas chicas</h1>
          <p className="text-sm text-ink-muted mt-1">
            Configura una o varias cajas (por sucursal, departamento o responsable).
            Cada caja tiene saldo independiente.
          </p>
        </div>
        <button onClick={() => setEditing('new')} className="btn-primary">+ Nueva caja</button>
      </div>

      <div className="card overflow-hidden">
        {isLoading ? (
          <div className="flex justify-center py-16"><Spinner /></div>
        ) : funds.length === 0 ? (
          <div className="text-center py-12">
            <p className="text-sm text-ink-muted">No hay cajas configuradas. Crea la primera arriba.</p>
          </div>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Nombre</th>
                <th>Ubicación</th>
                <th>Responsable</th>
                <th className="text-right">Saldo inicial</th>
                <th className="text-right">Saldo actual</th>
                <th className="text-right"># Mov.</th>
                <th>Estado</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {funds.map(f => (
                <tr key={f.id} className={clsx(!f.is_active && 'opacity-60')}>
                  <td className="font-medium text-ink-primary">{f.name}</td>
                  <td className="text-xs text-ink-secondary">{f.location || '—'}</td>
                  <td className="text-xs text-ink-secondary">{f.responsible_name || '—'}</td>
                  <td className="text-right font-mono tabular-nums">{fmtMXN(f.initial_balance)}</td>
                  <td className={clsx('text-right font-mono tabular-nums font-semibold',
                    f.current_balance < 0 ? 'text-status-danger' :
                    f.current_balance < 500 ? 'text-status-warning' : 'text-status-success')}>
                    {fmtMXN(f.current_balance)}
                  </td>
                  <td className="text-right tabular-nums">{f.movements_count}</td>
                  <td>
                    <span className={clsx('text-[10px] font-bold uppercase px-1.5 py-0.5 rounded-full',
                      f.is_active ? 'bg-status-success/15 text-status-success'
                                  : 'bg-surface-elevated/60 text-ink-muted')}>
                      {f.is_active ? 'Activa' : 'Inactiva'}
                    </span>
                  </td>
                  <td className="text-right">
                    <button onClick={() => setEditing(f)} className="btn-ghost btn-sm text-ink-secondary">
                      Editar
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {editing && (
        <FundModal
          fund={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  )
}

function FundModal({ fund, onClose }) {
  const qc = useQueryClient()
  const isNew = !fund
  const [name, setName]                       = useState(fund?.name || '')
  const [location, setLocation]               = useState(fund?.location || '')
  const [responsibleUserId, setResponsibleId] = useState(fund?.responsible_user_id || '')
  const [initialBalance, setInitial]          = useState(fund?.initial_balance ?? 0)
  const [isActive, setIsActive]               = useState(fund?.is_active ?? true)
  const [notes, setNotes]                     = useState(fund?.notes || '')
  const [error, setError]                     = useState(null)

  const { data: usersResp } = useQuery({
    queryKey: ['users', 'list'],
    queryFn:  () => usersApi.list(),
    staleTime: 5 * 60 * 1000,
  })
  const users = usersResp?.data || usersResp || []

  const mutation = useMutation({
    mutationFn: () => {
      if (!name.trim()) throw new Error('El nombre es requerido.')
      const payload = {
        name: name.trim(),
        location: location.trim() || null,
        responsibleUserId: responsibleUserId || null,
        initialBalance: parseFloat(initialBalance) || 0,
        isActive,
        notes: notes.trim() || null,
      }
      return isNew ? pettyCashApi.createFund(payload)
                   : pettyCashApi.updateFund(fund.id, payload)
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['petty-cash'] })
      onClose()
    },
    onError: (e) => setError(e.response?.data?.error || e.message || 'Error'),
  })

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <form onSubmit={e => { e.preventDefault(); setError(null); mutation.mutate() }}
        onClick={e => e.stopPropagation()}
        className="card w-full max-w-md p-6 flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold text-ink-primary">
            {isNew ? '+ Nueva caja chica' : 'Editar caja'}
          </h2>
          <button type="button" onClick={onClose} className="btn-ghost btn-icon text-ink-muted">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12"/>
            </svg>
          </button>
        </div>

        <div>
          <label className="label">Nombre <span className="text-status-danger">*</span></label>
          <input className="input" value={name} onChange={e => setName(e.target.value)}
            placeholder="Ej. Caja oficina, Caja sucursal norte..." autoFocus />
        </div>

        <div>
          <label className="label">Ubicación</label>
          <input className="input" value={location} onChange={e => setLocation(e.target.value)}
            placeholder="Opcional" />
        </div>

        <div>
          <label className="label">Responsable</label>
          <select className="select" value={responsibleUserId} onChange={e => setResponsibleId(e.target.value)}>
            <option value="">— Sin asignar —</option>
            {users.map(u => <option key={u.id} value={u.id}>{u.full_name}</option>)}
          </select>
        </div>

        <div>
          <label className="label">
            Saldo inicial
            {!isNew && <span className="text-[10px] text-ink-muted ml-1">(cambiar afecta saldo actual)</span>}
          </label>
          <input type="number" step="0.01" min="0" className="input"
            value={initialBalance} onChange={e => setInitial(e.target.value)} />
        </div>

        <div>
          <label className="label">Notas</label>
          <textarea className="input" rows={2} value={notes} onChange={e => setNotes(e.target.value)} />
        </div>

        {!isNew && (
          <label className="flex items-center gap-2 text-sm text-ink-secondary">
            <input type="checkbox" className="w-4 h-4 accent-brand-500"
              checked={isActive} onChange={e => setIsActive(e.target.checked)} />
            Caja activa (desactivar impide capturar nuevos movimientos)
          </label>
        )}

        {error && <p className="field-error">{error}</p>}

        <div className="flex gap-2 pt-1">
          <button type="button" onClick={onClose} className="btn-secondary flex-1">Cancelar</button>
          <button type="submit" disabled={mutation.isPending} className="btn-primary flex-1">
            {mutation.isPending ? <Spinner size="sm" /> : (isNew ? 'Crear caja' : 'Guardar cambios')}
          </button>
        </div>
      </form>
    </div>,
    document.body
  )
}
