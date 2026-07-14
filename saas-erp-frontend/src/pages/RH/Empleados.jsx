import { useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { hrApi } from '@/api/hr'
import { usersApi } from '@/api/users'
import Spinner from '@/components/ui/Spinner'
import Can from '@/components/auth/Can'
import clsx from 'clsx'

// Formatea 'YYYY-MM-DD' a 'DD/MM/YYYY' sin construir Date (evita corrimiento de zona).
function fmtDate(ymd) {
  if (!ymd) return '—'
  const [y, m, d] = ymd.slice(0, 10).split('-')
  return `${d}/${m}/${y}`
}

// Años cumplidos de servicio a partir de 'YYYY-MM-DD' (para mostrar antigüedad).
function seniorityLabel(hire, term) {
  if (!hire) return '—'
  const [hy, hm, hd] = hire.slice(0, 10).split('-').map(Number)
  const ref = term ? term.slice(0, 10).split('-').map(Number) : (() => {
    const t = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' }).split('-').map(Number)
    return t
  })()
  let years = ref[0] - hy
  if (ref[1] < hm || (ref[1] === hm && ref[2] < hd)) years -= 1
  years = Math.max(0, years)
  return years === 1 ? '1 año' : `${years} años`
}

export default function Empleados() {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [showInactive, setShowInactive] = useState(false)
  const [search, setSearch] = useState('')
  const [editing, setEditing] = useState(null) // null | employee | 'new'
  const [msg, setMsg] = useState(null)
  const [error, setError] = useState(null)

  const { data: employees = [], isLoading } = useQuery({
    queryKey: ['hr-employees', showInactive, search],
    queryFn:  () => hrApi.listEmployees({ includeInactive: showInactive ? '1' : '', search }),
  })

  const deactivate = useMutation({
    mutationFn: (id) => hrApi.removeEmployee(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['hr-employees'] })
      flash('Empleado dado de baja.')
    },
    onError: (e) => setError(e.response?.data?.error || e.message),
  })

  function flash(t) { setMsg(t); setTimeout(() => setMsg(null), 3000) }

  return (
    <div className="page-enter max-w-6xl mx-auto py-6 px-4 flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-xl font-semibold text-ink-primary">Recursos Humanos · Empleados</h1>
          <p className="text-sm text-ink-muted mt-1">
            Registro laboral de tu personal. La <strong>fecha de ingreso</strong> determina la antigüedad y, con ella,
            los días de vacaciones que le corresponden por ley.
          </p>
        </div>
        <Can do="hr:manage">
          <button onClick={() => setEditing('new')} className="btn-primary">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4"/>
            </svg>
            Nuevo empleado
          </button>
        </Can>
      </div>

      {msg && (
        <div className="bg-status-success/10 border border-status-success/40 rounded-lg px-3 py-2">
          <p className="text-sm text-status-success">{msg}</p>
        </div>
      )}
      {error && (
        <div className="bg-status-danger/10 border border-status-danger/40 rounded-lg px-3 py-2 flex items-center justify-between">
          <p className="text-sm text-status-danger">{error}</p>
          <button onClick={() => setError(null)} className="text-status-danger">×</button>
        </div>
      )}

      <div className="card p-3 flex items-center justify-between gap-3 flex-wrap">
        <input className="input max-w-xs" placeholder="Buscar por nombre, folio o puesto…"
          value={search} onChange={e => setSearch(e.target.value)} />
        <label className="flex items-center gap-2 text-sm text-ink-secondary">
          <input type="checkbox" checked={showInactive}
            onChange={e => setShowInactive(e.target.checked)} />
          Mostrar bajas
        </label>
        <span className="text-xs text-ink-muted">{employees.length} empleado(s)</span>
      </div>

      <div className="card overflow-hidden">
        {isLoading ? (
          <div className="flex justify-center py-16"><Spinner /></div>
        ) : employees.length === 0 ? (
          <div className="flex flex-col items-center gap-3 py-16 text-center">
            <p className="text-sm text-ink-muted">Aún no hay empleados registrados.</p>
            <Can do="hr:manage">
              <button onClick={() => setEditing('new')} className="btn-primary btn-sm">Registrar el primero</button>
            </Can>
          </div>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Folio</th>
                  <th>Nombre</th>
                  <th>Ingreso</th>
                  <th>Antigüedad</th>
                  <th>Puesto</th>
                  <th className="text-right">Salario diario</th>
                  <th>Estado</th>
                  <th className="text-right">Acciones</th>
                </tr>
              </thead>
              <tbody>
                {employees.map(e => (
                  <tr key={e.id} className={clsx(e.status !== 'active' && 'opacity-60')}>
                    <td className="font-mono text-xs text-ink-muted">{e.employee_number}</td>
                    <td className="font-medium text-ink-primary">{e.full_name}</td>
                    <td className="text-ink-secondary">{fmtDate(e.hire_date)}</td>
                    <td className="text-ink-secondary">{seniorityLabel(e.hire_date, e.termination_date)}</td>
                    <td className="text-ink-secondary text-xs">{e.position || <span className="text-ink-muted">—</span>}</td>
                    <td className="text-right tabular-nums text-ink-secondary">
                      {e.daily_salary == null ? <span className="text-ink-muted">—</span>
                        : `$${Number(e.daily_salary).toLocaleString('es-MX', { minimumFractionDigits: 2 })}`}
                    </td>
                    <td>
                      {e.status === 'active'
                        ? <span className="text-xs text-status-success">Activo</span>
                        : <span className="text-xs text-ink-muted">Baja {fmtDate(e.termination_date)}</span>}
                    </td>
                    <td className="text-right whitespace-nowrap">
                      <button onClick={() => navigate(`/rh/vacaciones/${e.id}`)} className="btn-ghost btn-sm">
                        Vacaciones
                      </button>
                      <Can do="hr:manage">
                        <button onClick={() => setEditing(e)} className="btn-ghost btn-sm">Editar</button>
                      </Can>
                      {e.status === 'active' && (
                        <Can do="hr:manage">
                          <button
                            onClick={() => { if (confirm(`¿Dar de baja a "${e.full_name}"?`)) deactivate.mutate(e.id) }}
                            className="btn-ghost btn-sm text-status-danger">Baja</button>
                        </Can>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {editing && (
        <EmployeeModal
          employee={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            qc.invalidateQueries({ queryKey: ['hr-employees'] })
            setEditing(null)
            flash('Empleado guardado. Sus periodos vacacionales se generaron automáticamente.')
          }}
        />
      )}
    </div>
  )
}

function EmployeeModal({ employee, onClose, onSaved }) {
  const isNew = !employee
  const blank = {
    fullName: '', employeeNumber: '', hireDate: '', dailySalary: '',
    position: '', department: '', userId: '', terminationDate: '', notes: '',
  }
  const fromEmp = (e) => ({
    fullName: e.full_name || '', employeeNumber: e.employee_number || '',
    hireDate: e.hire_date || '', dailySalary: e.daily_salary ?? '',
    position: e.position || '', department: e.department || '',
    userId: e.user_id || '', terminationDate: e.termination_date || '', notes: e.notes || '',
  })
  const [form, setForm] = useState(employee ? fromEmp(employee) : blank)
  const [error, setError] = useState(null)

  useEffect(() => { if (employee) setForm(fromEmp(employee)) }, [employee])

  const { data: usersResp } = useQuery({
    queryKey: ['users', 'active-for-hr'],
    queryFn:  () => usersApi.list({ isActive: true }),
    staleTime: 5 * 60 * 1000,
  })
  const users = usersResp?.data || usersResp || []

  const mutation = useMutation({
    mutationFn: () => {
      if (!form.fullName.trim()) throw new Error('El nombre es requerido.')
      if (!form.hireDate) throw new Error('La fecha de ingreso es requerida.')
      const body = {
        ...form,
        fullName: form.fullName.trim(),
        employeeNumber: form.employeeNumber.trim() || undefined,
        dailySalary: form.dailySalary === '' ? null : form.dailySalary,
        userId: form.userId || null,
        terminationDate: form.terminationDate || null,
      }
      return isNew ? hrApi.createEmployee(body) : hrApi.updateEmployee(employee.id, body)
    },
    onSuccess: onSaved,
    onError: (e) => setError(e.response?.data?.error || e.message),
  })

  function set(k, v) { setForm(f => ({ ...f, [k]: v })) }

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40 p-4">
      <form
        onSubmit={(e) => { e.preventDefault(); setError(null); mutation.mutate() }}
        className="card w-full max-w-lg p-6 max-h-[90vh] overflow-y-auto flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold text-ink-primary">
            {isNew ? 'Nuevo empleado' : 'Editar empleado'}
          </h2>
          <button type="button" onClick={onClose} className="text-ink-muted hover:text-ink-secondary">×</button>
        </div>

        <div>
          <label className="label">Nombre completo <span className="text-status-danger">*</span></label>
          <input className="input" value={form.fullName}
            onChange={e => set('fullName', e.target.value)} placeholder="Nombre y apellidos" />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="label">Folio <span className="text-ink-muted">(automático)</span></label>
            <input className="input font-mono" value={form.employeeNumber}
              onChange={e => set('employeeNumber', e.target.value)} placeholder="EMP-0001" />
          </div>
          <div>
            <label className="label">Fecha de ingreso <span className="text-status-danger">*</span></label>
            <input type="date" className="input" value={form.hireDate}
              onChange={e => set('hireDate', e.target.value)} />
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="label">Puesto</label>
            <input className="input" value={form.position}
              onChange={e => set('position', e.target.value)} placeholder="Opcional" />
          </div>
          <div>
            <label className="label">Departamento</label>
            <input className="input" value={form.department}
              onChange={e => set('department', e.target.value)} placeholder="Opcional" />
          </div>
        </div>

        <div>
          <label className="label">Salario diario <span className="text-ink-muted">(para prima vacacional)</span></label>
          <input type="number" min="0" step="0.01" className="input" value={form.dailySalary}
            onChange={e => set('dailySalary', e.target.value)} placeholder="Opcional" />
        </div>

        <div>
          <label className="label">Usuario del ERP <span className="text-ink-muted">(opcional)</span></label>
          <select className="select" value={form.userId} onChange={e => set('userId', e.target.value)}>
            <option value="">— Sin usuario ligado —</option>
            {users.map(u => (
              <option key={u.id} value={u.id}>{u.full_name || u.fullName || u.email}</option>
            ))}
          </select>
          <p className="text-xs text-ink-muted mt-1">Ligar a un usuario permite que, en el futuro, vea sus propias vacaciones.</p>
        </div>

        {!isNew && (
          <div>
            <label className="label">Fecha de baja <span className="text-ink-muted">(al terminar la relación laboral)</span></label>
            <input type="date" className="input" value={form.terminationDate}
              onChange={e => set('terminationDate', e.target.value)} />
          </div>
        )}

        <div>
          <label className="label">Notas</label>
          <textarea className="input" rows={2} value={form.notes}
            onChange={e => set('notes', e.target.value)} placeholder="Opcional" />
        </div>

        {error && <p className="field-error">{error}</p>}

        <div className="flex gap-2">
          <button type="button" onClick={onClose} className="btn-secondary flex-1" disabled={mutation.isPending}>Cancelar</button>
          <button type="submit" className="btn-primary flex-1"
            disabled={mutation.isPending || !form.fullName.trim() || !form.hireDate}>
            {mutation.isPending ? <Spinner size="sm" /> : (isNew ? 'Crear' : 'Guardar')}
          </button>
        </div>
      </form>
    </div>,
    document.body
  )
}
