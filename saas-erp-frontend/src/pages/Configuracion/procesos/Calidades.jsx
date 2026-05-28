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
  grade_number: 1, code: '', name: '',
  counts_for_order_fulfillment: false,
  default_color: '#6366f1', sort_order: 0,
}

// ── Modal ─────────────────────────────────────────────────────────────────────
function QualityGradeModal({ item, onClose, onSaved }) {
  const isNew = !item?.id
  const [form, setForm] = useState(() => isNew
    ? { ...EMPTY_FORM }
    : {
      grade_number: item.grade_number,
      code: item.code,
      name: item.name,
      counts_for_order_fulfillment: item.counts_for_order_fulfillment ?? false,
      default_color: item.default_color || '#6366f1',
      sort_order: item.sort_order ?? 0,
    }
  )
  const [error, setError] = useState(null)

  const mut = useMutation({
    mutationFn: isNew
      ? () => processConfigApi.createQualityGrade(form)
      : () => processConfigApi.updateQualityGrade(item.id, form),
    onSuccess: () => onSaved(),
    onError:   (err) => setError(err.response?.data?.error || err.message),
  })

  function set(field, value) {
    setForm(prev => ({ ...prev, [field]: value }))
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-bg-primary/80 backdrop-blur-sm">
      <div className="bg-surface-primary rounded-2xl shadow-xl w-full max-w-md border border-line-subtle">
        <div className="flex items-center justify-between px-5 py-4 border-b border-line-subtle">
          <h3 className="text-sm font-semibold text-ink-primary">
            {isNew ? 'Nuevo grado de calidad' : `Editar · ${item.name}`}
          </h3>
          <button onClick={onClose} className="text-ink-muted hover:text-ink-primary">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12"/>
            </svg>
          </button>
        </div>

        <div className="p-5 flex flex-col gap-4">
          {error && (
            <div className="bg-status-danger/10 border border-status-danger/40 rounded-lg px-3 py-2 text-sm text-status-danger">
              {error}
            </div>
          )}

          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="label flex items-center gap-1">
                Nro. grado
                <HelpTip
                  title="Número de grado"
                  body="1 es la calidad primaria (la que vendes a precio normal). 2, 3, etc. son calidades inferiores. No se puede cambiar después de crear."
                />
              </label>
              <input
                type="number" min={1}
                className="input"
                value={form.grade_number}
                onChange={e => set('grade_number', parseInt(e.target.value) || 1)}
                disabled={!isNew}
              />
            </div>
            <div>
              <label className="label flex items-center gap-1">
                Código
                <HelpTip {...CODIGO_HELP} />
              </label>
              <input
                className="input"
                placeholder="ej: primera"
                value={form.code}
                onChange={e => set('code', e.target.value)}
                disabled={!isNew}
              />
            </div>
            <div>
              <label className="label flex items-center gap-1">
                Orden
                <HelpTip {...ORDEN_HELP} />
              </label>
              <input
                type="number" min={0}
                className="input"
                value={form.sort_order}
                onChange={e => set('sort_order', parseInt(e.target.value) || 0)}
              />
            </div>
          </div>

          <div>
            <label className="label">Nombre</label>
            <input
              className="input"
              placeholder="ej: Primera calidad"
              value={form.name}
              onChange={e => set('name', e.target.value)}
            />
          </div>

          <div>
            <label className="label">Color identificador</label>
            <div className="flex items-center gap-3">
              <input
                type="color"
                value={form.default_color || '#6366f1'}
                onChange={e => set('default_color', e.target.value)}
                className="h-9 w-12 rounded cursor-pointer border border-line-subtle bg-transparent"
              />
              <input
                className="input flex-1"
                placeholder="#6366f1"
                value={form.default_color || ''}
                onChange={e => set('default_color', e.target.value)}
              />
            </div>
          </div>

          <label className="flex items-start gap-3 text-sm cursor-pointer">
            <input
              type="checkbox"
              checked={form.counts_for_order_fulfillment}
              onChange={e => set('counts_for_order_fulfillment', e.target.checked)}
              className="w-4 h-4 accent-brand-600 mt-0.5"
            />
            <span>
              <span className="font-medium text-ink-primary">Cuenta para cumplimiento de pedidos</span>
              <span className="block text-xs text-ink-muted mt-0.5">
                Si está activo, el producto de este grado puede usarse para cumplir pedidos de clientes
                (aunque sean de calidad menor). Si está apagado, solo se contabiliza como inventario interno.
              </span>
            </span>
          </label>
        </div>

        <div className="flex items-center justify-end gap-3 px-5 py-4 border-t border-line-subtle">
          <button onClick={onClose} className="btn-ghost btn-sm">Cancelar</button>
          <button
            onClick={() => mut.mutate()}
            disabled={mut.isPending || !form.code || !form.name}
            className="btn-primary btn-sm"
          >
            {mut.isPending ? <Spinner className="w-3 h-3" /> : null}
            {isNew ? 'Crear' : 'Guardar'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
export default function Calidades() {
  const qc = useQueryClient()
  const can = useAuthStore(s => s.can)
  const permissions = useAuthStore(s => s.permissions)
  const isSuperAdmin = permissions?.includes?.('*')
  const canManage = isSuperAdmin || can?.('tenant_catalogs', 'update')

  const [showInactive, setShowInactive] = useState(false)
  const [editing, setEditing] = useState(null)
  const [serverError, setServerError] = useState(null)
  const [successMsg, setSuccessMsg] = useState(null)

  const { data: items = [], isLoading } = useQuery({
    queryKey: ['process-config-quality-grades', showInactive],
    queryFn:  () => processConfigApi.listQualityGrades({ include_inactive: showInactive || undefined }),
  })

  const toggleMut = useMutation({
    mutationFn: ({ id, isActive }) => processConfigApi.updateQualityGrade(id, { is_active: isActive }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['process-config-quality-grades'] })
      setSuccessMsg('Actualizado.')
      setTimeout(() => setSuccessMsg(null), 2500)
    },
    onError: (err) => setServerError(err.response?.data?.error || err.message),
  })

  function handleSaved() {
    qc.invalidateQueries({ queryKey: ['process-config-quality-grades'] })
    setEditing(null)
    setSuccessMsg('Guardado.')
    setTimeout(() => setSuccessMsg(null), 2500)
  }

  return (
    <div className="page-enter flex flex-col gap-6">
      <div className="page-header">
        <div>
          <h1 className="page-title">Grados de calidad</h1>
          <p className="page-subtitle">Niveles de calidad para captura de producto terminado</p>
        </div>
        {canManage && (
          <button onClick={() => setEditing('new')} className="btn-primary">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4"/>
            </svg>
            Nuevo grado
          </button>
        )}
      </div>

      {successMsg && (
        <div className="bg-status-success/10 border border-status-success/40 rounded-xl px-4 py-3 text-sm text-status-success flex items-center justify-between">
          <span>{successMsg}</span>
          <button onClick={() => setSuccessMsg(null)}>✕</button>
        </div>
      )}
      {serverError && (
        <div className="bg-status-danger/10 border border-status-danger/40 rounded-xl px-4 py-3 text-sm text-status-danger flex items-center justify-between">
          <span>{serverError}</span>
          <button onClick={() => setServerError(null)}>✕</button>
        </div>
      )}

      <div className="bg-status-info/10 border border-status-info/40 rounded-xl px-4 py-3 text-sm text-status-info">
        <p className="leading-relaxed">
          El <strong>grado 1</strong> es siempre la calidad primaria (la que esperas vender). Los grados 2, 3, etc. son
          calidades secundarias o "segundas" — producto que sigue siendo vendible pero a un precio menor.
        </p>
        <p className="leading-relaxed mt-1">
          Al cerrar un turno, las calidades secundarias se valoran a su <strong>precio de venta esperado × peso producido</strong>
          (lo configuras en la ficha del producto). Ese valor se descuenta del costo total, dejando el resto cargado al grado 1.
          Así, si vendes la segunda a precio bajo, el costo unitario de tu primera refleja la realidad económica del turno.
        </p>
      </div>

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
          <p className="font-medium text-ink-secondary">Sin grados de calidad configurados</p>
          {canManage && (
            <button onClick={() => setEditing('new')} className="btn-primary btn-sm mt-3">+ Crear primero</button>
          )}
        </div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th className="w-16 text-center">Grado</th>
                <th>Código</th>
                <th>Nombre</th>
                <th>Color</th>
                <th>Cumple orden</th>
                <th>Estado</th>
                {canManage && <th className="w-16"></th>}
              </tr>
            </thead>
            <tbody>
              {items.sort((a, b) => a.grade_number - b.grade_number).map(item => (
                <tr key={item.id} className={clsx(!item.is_active && 'opacity-50')}>
                  <td className="text-center">
                    <span className={clsx(
                      'inline-flex items-center justify-center w-7 h-7 rounded-full text-xs font-bold text-white',
                      item.grade_number === 1 ? 'bg-amber-500' : 'bg-gray-400'
                    )}>
                      {item.grade_number}
                    </span>
                  </td>
                  <td className="font-mono text-xs text-ink-secondary">{item.code}</td>
                  <td className="font-medium text-sm">{item.name}</td>
                  <td>
                    {item.default_color ? (
                      <div className="flex items-center gap-2">
                        <div
                          className="w-5 h-5 rounded-full border border-line-subtle"
                          style={{ backgroundColor: item.default_color }}
                        />
                        <span className="font-mono text-xs text-ink-muted">{item.default_color}</span>
                      </div>
                    ) : (
                      <span className="text-ink-muted text-xs">—</span>
                    )}
                  </td>
                  <td>
                    <Badge
                      variant={item.counts_for_order_fulfillment ? 'green' : 'gray'}
                      label={item.counts_for_order_fulfillment ? 'Sí' : 'No'}
                    />
                  </td>
                  <td>
                    <Badge
                      variant={item.is_active ? 'green' : 'gray'}
                      label={item.is_active ? 'Activo' : 'Inactivo'}
                    />
                  </td>
                  {canManage && (
                    <td>
                      <div className="flex items-center gap-1">
                        <button onClick={() => setEditing(item)} className="btn-ghost btn-icon text-ink-muted" title="Editar">
                          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/>
                          </svg>
                        </button>
                        <button
                          onClick={() => toggleMut.mutate({ id: item.id, isActive: !item.is_active })}
                          className={clsx('btn-ghost btn-icon', item.is_active ? 'text-status-warning' : 'text-status-success')}
                          title={item.is_active ? 'Desactivar' : 'Activar'}
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
        <QualityGradeModal
          item={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={handleSaved}
        />
      )}
    </div>
  )
}
