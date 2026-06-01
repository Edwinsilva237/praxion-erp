import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { processConfigApi } from '@/api/processConfig'
import useAuthStore from '@/store/useAuthStore'
import Spinner from '@/components/ui/Spinner'
import clsx from 'clsx'

// Modal crear/editar categoría de gasto.
function CategoriaModal({ item, onClose, onSaved }) {
  const isNew = !item
  const [name, setName]               = useState(item?.name || '')
  const [affectsCost, setAffectsCost] = useState(item?.affects_cost ?? false)
  const [error, setError]             = useState(null)

  const mut = useMutation({
    mutationFn: () => {
      if (!name.trim()) throw new Error('El nombre es requerido.')
      const body = { name: name.trim(), affects_cost: affectsCost }
      return isNew
        ? processConfigApi.createExpenseCategory(body)
        : processConfigApi.updateExpenseCategory(item.id, body)
    },
    onSuccess: () => { onSaved(); onClose() },
    onError: (e) => setError(e.response?.data?.error || e.message),
  })

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-bg-primary/80 backdrop-blur-sm">
      <div className="card w-full max-w-md p-0">
        <div className="flex items-center justify-between px-5 py-4 border-b border-line-subtle">
          <h3 className="text-sm font-semibold text-ink-primary">
            {isNew ? 'Nueva categoría de gasto' : `Editar · ${item.name}`}
          </h3>
          <button onClick={onClose} className="text-ink-muted hover:text-ink-primary">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12"/>
            </svg>
          </button>
        </div>
        <div className="p-5 flex flex-col gap-4">
          {error && <div className="bg-status-danger/10 border border-status-danger/40 rounded-lg px-3 py-2 text-sm text-status-danger">{error}</div>}
          <div>
            <label className="label">Nombre <span className="text-status-danger">*</span></label>
            <input className="input" placeholder="Ej: Energía eléctrica, Renta, Combustible..."
              value={name} onChange={e => setName(e.target.value)} autoFocus />
          </div>
          <label className="flex items-start gap-2 cursor-pointer">
            <input type="checkbox" className="mt-1 w-4 h-4 accent-brand-600"
              checked={affectsCost} onChange={e => setAffectsCost(e.target.checked)} />
            <div>
              <span className="text-sm font-medium text-ink-primary">Prorratear al costo del producto</span>
              <p className="text-xs text-ink-muted mt-0.5">
                Actívalo para fletes de mercancía que deban sumarse al costo. (Hoy es informativo;
                lo usará el cálculo de costo de importación más adelante.)
              </p>
            </div>
          </label>
        </div>
        <div className="flex items-center justify-end gap-3 px-5 py-4 border-t border-line-subtle">
          <button onClick={onClose} className="btn-ghost btn-sm">Cancelar</button>
          <button onClick={() => mut.mutate()} disabled={mut.isPending || !name.trim()} className="btn-primary btn-sm">
            {mut.isPending ? <Spinner size="sm" /> : (isNew ? 'Crear' : 'Guardar')}
          </button>
        </div>
      </div>
    </div>
  )
}

export default function CategoriasGasto() {
  const qc = useQueryClient()
  const can = useAuthStore(s => s.can)
  const permissions = useAuthStore(s => s.permissions)
  const isSuperAdmin = permissions?.includes?.('*')
  const canManage = isSuperAdmin || can?.('tenant_catalogs', 'update')

  const [showInactive, setShowInactive] = useState(false)
  const [editing, setEditing] = useState(null)
  const [msg, setMsg] = useState(null)

  const { data: items = [], isLoading } = useQuery({
    queryKey: ['expense-categories', showInactive],
    queryFn:  () => processConfigApi.listExpenseCategories({ isActive: showInactive ? undefined : true }),
  })

  const toggleMut = useMutation({
    mutationFn: ({ id, isActive }) => processConfigApi.updateExpenseCategory(id, { is_active: isActive }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['expense-categories'] }); flash('Actualizado.') },
  })

  function flash(t) { setMsg(t); setTimeout(() => setMsg(null), 2500) }
  function handleSaved() { qc.invalidateQueries({ queryKey: ['expense-categories'] }); flash('Guardado.') }

  return (
    <div className="page-enter max-w-3xl mx-auto py-6 px-4 flex flex-col gap-5">
      <div className="page-header">
        <div>
          <h1 className="page-title">Categorías de gasto</h1>
          <p className="page-subtitle">
            Clasifica tus gastos de proveedor (renta, luz, fletes, combustible, etc.). Tú creas y editas las tuyas.
          </p>
        </div>
        {canManage && (
          <button onClick={() => setEditing('new')} className="btn-primary w-full sm:w-auto">
            + Nueva categoría
          </button>
        )}
      </div>

      {msg && <div className="alert-success text-sm">{msg}</div>}

      <label className="flex items-center gap-2 text-sm text-ink-secondary cursor-pointer">
        <input type="checkbox" checked={showInactive} onChange={e => setShowInactive(e.target.checked)}
          className="w-4 h-4 accent-brand-600" />
        Mostrar inactivas
      </label>

      <div className="card p-0 overflow-x-auto">
        {isLoading ? (
          <div className="flex justify-center py-16"><Spinner /></div>
        ) : items.length === 0 ? (
          <div className="py-12 text-center text-sm text-ink-muted">No hay categorías. Crea la primera arriba.</div>
        ) : (
          <table className="table min-w-[480px]">
            <thead>
              <tr>
                <th>Categoría</th>
                <th>Prorratea a costo</th>
                <th>Estado</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {items.map(c => (
                <tr key={c.id} className={clsx(!c.is_active && 'opacity-60')}>
                  <td className="font-medium text-ink-primary">{c.name}</td>
                  <td>
                    {c.affects_cost
                      ? <span className="badge-blue">Sí</span>
                      : <span className="text-ink-muted text-xs">—</span>}
                  </td>
                  <td>
                    <span className={clsx('text-[10px] font-bold uppercase px-1.5 py-0.5 rounded-full',
                      c.is_active ? 'bg-status-success/15 text-status-success' : 'bg-surface-elevated/60 text-ink-muted')}>
                      {c.is_active ? 'Activa' : 'Inactiva'}
                    </span>
                  </td>
                  <td className="text-right whitespace-nowrap">
                    {canManage && (
                      <>
                        <button onClick={() => setEditing(c)} className="btn-ghost btn-sm text-brand-300">Editar</button>
                        <button onClick={() => toggleMut.mutate({ id: c.id, isActive: !c.is_active })}
                          className="btn-ghost btn-sm text-ink-muted">
                          {c.is_active ? 'Desactivar' : 'Activar'}
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {editing && (
        <CategoriaModal
          item={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={handleSaved}
        />
      )}
    </div>
  )
}
