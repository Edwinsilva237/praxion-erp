import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { processConfigApi } from '@/api/processConfig'
import Spinner from '@/components/ui/Spinner'
import Badge from '@/components/ui/Badge'
import HelpTip from '@/components/ui/HelpTip'
import useAuthStore from '@/store/useAuthStore'
import { ORDEN_HELP, CODIGO_HELP } from '@/pages/SuperAdmin/tenant-process/helpTexts'
import clsx from 'clsx'

const EMPTY_FORM = {
  code: '', name: '', is_required: false, is_unique_per_shift: false,
  can_capture: false, can_validate: false, can_handover: false, sort_order: 0,
}

function ShiftRoleModal({ item, onClose, onSaved }) {
  const isNew = !item?.id
  const [form, setForm] = useState(() => isNew
    ? { ...EMPTY_FORM }
    : { code: item.code, name: item.name, is_required: item.is_required ?? false,
        is_unique_per_shift: item.is_unique_per_shift ?? false, can_capture: item.can_capture ?? false,
        can_validate: item.can_validate ?? false, can_handover: item.can_handover ?? false, sort_order: item.sort_order ?? 0 }
  )
  const [error, setError] = useState(null)

  const mut = useMutation({
    mutationFn: isNew
      ? () => processConfigApi.createShiftRole(form)
      : () => processConfigApi.updateShiftRole(item.id, form),
    onSuccess: () => onSaved(),
    onError:   (err) => setError(err.response?.data?.error || err.message),
  })

  function set(f, v) { setForm(p => ({ ...p, [f]: v })) }

  const CheckRow = ({ field, label, desc }) => (
    <label className="flex items-start gap-3 text-sm cursor-pointer py-1.5 border-b border-line-subtle last:border-0">
      <input type="checkbox" checked={form[field]} onChange={e => set(field, e.target.checked)} className="w-4 h-4 accent-brand-600 mt-0.5" />
      <span>
        <span className="font-medium text-ink-primary">{label}</span>
        {desc && <span className="text-ink-muted ml-1 text-xs block">{desc}</span>}
      </span>
    </label>
  )

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-bg-primary/80 backdrop-blur-sm">
      <div className="bg-surface-primary rounded-2xl shadow-xl w-full max-w-md border border-line-subtle">
        <div className="flex items-center justify-between px-5 py-4 border-b border-line-subtle">
          <h3 className="text-sm font-semibold text-ink-primary">{isNew ? 'Nuevo rol de turno' : `Editar · ${item.name}`}</h3>
          <button onClick={onClose} className="text-ink-muted hover:text-ink-primary">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12"/>
            </svg>
          </button>
        </div>
        <div className="p-5 flex flex-col gap-4">
          {error && <div className="bg-status-danger/10 border border-status-danger/40 rounded-lg px-3 py-2 text-sm text-status-danger">{error}</div>}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label flex items-center gap-1">
                Código
                <HelpTip {...CODIGO_HELP} />
              </label>
              <input className="input" placeholder="ej: operador" value={form.code} onChange={e => set('code', e.target.value)} disabled={!isNew} />
            </div>
            <div>
              <label className="label flex items-center gap-1">
                Orden
                <HelpTip {...ORDEN_HELP} />
              </label>
              <input type="number" min={0} className="input" value={form.sort_order} onChange={e => set('sort_order', parseInt(e.target.value) || 0)} />
            </div>
          </div>
          <div>
            <label className="label">Nombre</label>
            <input className="input" placeholder="ej: Operador de turno" value={form.name} onChange={e => set('name', e.target.value)} />
          </div>
          <div className="card p-3">
            <p className="text-xs font-semibold text-ink-muted uppercase tracking-wide mb-2">Restricciones</p>
            <CheckRow field="is_required" label="Requerido" desc="El turno no puede abrirse sin asignar este rol" />
            <CheckRow field="is_unique_per_shift" label="Único por turno" desc="Solo puede haber una persona con este rol en cada turno" />
          </div>
          <div className="card p-3">
            <p className="text-xs font-semibold text-ink-muted uppercase tracking-wide mb-2">Capacidades</p>
            <CheckRow field="can_capture" label="Puede capturar" desc="Puede registrar paquetes de producto terminado" />
            <CheckRow field="can_validate" label="Puede validar" desc="Puede aprobar el cierre del turno" />
            <CheckRow field="can_handover" label="Puede entregar el turno" desc="Puede firmar la entrega del turno al siguiente operador" />
          </div>
        </div>
        <div className="flex items-center justify-end gap-3 px-5 py-4 border-t border-line-subtle">
          <button onClick={onClose} className="btn-ghost btn-sm">Cancelar</button>
          <button onClick={() => mut.mutate()} disabled={mut.isPending || !form.code || !form.name} className="btn-primary btn-sm">
            {mut.isPending ? <Spinner className="w-3 h-3" /> : null}
            {isNew ? 'Crear' : 'Guardar'}
          </button>
        </div>
      </div>
    </div>
  )
}

export default function RolesTurno() {
  const qc = useQueryClient()
  const can = useAuthStore(s => s.can)
  const permissions = useAuthStore(s => s.permissions)
  const isSuperAdmin = permissions?.includes?.('*')
  const canManage = isSuperAdmin || can?.('settings', 'update')

  const [showInactive, setShowInactive] = useState(false)
  const [editing, setEditing] = useState(null)
  const [serverError, setServerError] = useState(null)
  const [successMsg, setSuccessMsg] = useState(null)

  const { data: items = [], isLoading } = useQuery({
    queryKey: ['process-config-shift-roles', showInactive],
    queryFn:  () => processConfigApi.listShiftRoles({ include_inactive: showInactive || undefined }),
  })

  const toggleMut = useMutation({
    mutationFn: ({ id, isActive }) => processConfigApi.updateShiftRole(id, { is_active: isActive }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['process-config-shift-roles'] })
      setSuccessMsg('Actualizado.')
      setTimeout(() => setSuccessMsg(null), 2500)
    },
    onError: (err) => setServerError(err.response?.data?.error || err.message),
  })

  function handleSaved() {
    qc.invalidateQueries({ queryKey: ['process-config-shift-roles'] })
    setEditing(null)
    setSuccessMsg('Guardado.')
    setTimeout(() => setSuccessMsg(null), 2500)
  }

  const Dot = ({ on }) => (
    <span className={clsx('inline-block w-2 h-2 rounded-full', on ? 'bg-status-success' : 'bg-line-base')} />
  )

  return (
    <div className="page-enter flex flex-col gap-6">
      <div className="page-header">
        <div>
          <h1 className="page-title">Roles de turno</h1>
          <p className="page-subtitle">Roles que se asignan a personas en cada turno productivo</p>
        </div>
        {canManage && (
          <button onClick={() => setEditing('new')} className="btn-primary">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4"/>
            </svg>
            Nuevo rol
          </button>
        )}
      </div>

      {successMsg && (
        <div className="bg-status-success/10 border border-status-success/40 rounded-xl px-4 py-3 text-sm text-status-success flex items-center justify-between">
          <span>{successMsg}</span><button onClick={() => setSuccessMsg(null)}>✕</button>
        </div>
      )}
      {serverError && (
        <div className="bg-status-danger/10 border border-status-danger/40 rounded-xl px-4 py-3 text-sm text-status-danger flex items-center justify-between">
          <span>{serverError}</span><button onClick={() => setServerError(null)}>✕</button>
        </div>
      )}

      <div className="flex items-center gap-4">
        <label className="flex items-center gap-2 text-sm text-ink-secondary cursor-pointer">
          <input type="checkbox" checked={showInactive} onChange={e => setShowInactive(e.target.checked)} className="w-4 h-4 accent-brand-600" />
          Mostrar inactivos
        </label>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-16"><Spinner /></div>
      ) : items.length === 0 ? (
        <div className="empty-state">
          <p className="font-medium text-ink-secondary">Sin roles configurados</p>
          {canManage && <button onClick={() => setEditing('new')} className="btn-primary btn-sm mt-3">+ Crear primero</button>}
        </div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Código</th>
                <th>Nombre</th>
                <th className="text-center">Requerido</th>
                <th className="text-center">Único</th>
                <th className="text-center">Captura</th>
                <th className="text-center">Valida</th>
                <th className="text-center">Entrega</th>
                <th>Estado</th>
                {canManage && <th className="w-16"></th>}
              </tr>
            </thead>
            <tbody>
              {items.map(item => (
                <tr key={item.id} className={clsx(!item.is_active && 'opacity-50')}>
                  <td className="font-mono text-xs text-ink-secondary">{item.code}</td>
                  <td className="font-medium text-sm">{item.name}</td>
                  <td className="text-center"><Dot on={item.is_required} /></td>
                  <td className="text-center"><Dot on={item.is_unique_per_shift} /></td>
                  <td className="text-center"><Dot on={item.can_capture} /></td>
                  <td className="text-center"><Dot on={item.can_validate} /></td>
                  <td className="text-center"><Dot on={item.can_handover} /></td>
                  <td><Badge variant={item.is_active ? 'green' : 'gray'} label={item.is_active ? 'Activo' : 'Inactivo'} /></td>
                  {canManage && (
                    <td>
                      <div className="flex items-center gap-1">
                        <button onClick={() => setEditing(item)} className="btn-ghost btn-icon text-ink-muted">
                          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/>
                          </svg>
                        </button>
                        <button
                          onClick={() => toggleMut.mutate({ id: item.id, isActive: !item.is_active })}
                          className={clsx('btn-ghost btn-icon', item.is_active ? 'text-status-warning' : 'text-status-success')}
                        >
                          {item.is_active ? (
                            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 9v6m4-6v6m7-3a9 9 0 11-18 0 9 9 0 0118 0z"/>
                            </svg>
                          ) : (
                            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z"/>
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>
                            </svg>
                          )}
                        </button>
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editing && (
        <ShiftRoleModal item={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={handleSaved} />
      )}
    </div>
  )
}
