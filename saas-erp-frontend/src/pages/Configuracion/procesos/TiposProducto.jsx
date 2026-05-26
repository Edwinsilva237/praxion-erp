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
  code: '', name: '', is_produced: true,
  default_shelf_life_days: '', sort_order: 0,
}

const FIELD_TYPES = [
  { value: 'text',        label: 'Texto libre' },
  { value: 'number',      label: 'Número' },
  { value: 'boolean',     label: 'Sí / No' },
  { value: 'select',      label: 'Lista (una opción)' },
  { value: 'multiselect', label: 'Lista (varias opciones)' },
  { value: 'date',        label: 'Fecha' },
  { value: 'color',       label: 'Color' },
]

// Convierte un label a snake_case válido para `code`.
function toSnakeCase(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')   // quita acentos
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60)
}

function CaptureSchemaEditor({ schema, onChange }) {
  // schema es { version, fields } o null. Trabajamos sobre fields[] localmente.
  const fields = Array.isArray(schema?.fields) ? schema.fields : []

  const [draft, setDraft] = useState({
    label: '', type: 'number', required: false, options: '', unit_code: '',
  })
  const [err, setErr] = useState(null)

  function add() {
    setErr(null)
    const label = draft.label.trim()
    if (!label) { setErr('Captura un nombre.'); return }
    const code = toSnakeCase(label)
    if (!code) { setErr('Nombre inválido — usa letras y números.'); return }
    if (fields.some(f => f.code === code)) { setErr('Ya existe un atributo con ese nombre.'); return }
    const needsOptions = draft.type === 'select' || draft.type === 'multiselect'
    const options = needsOptions
      ? draft.options.split(',').map(s => s.trim()).filter(Boolean)
      : null
    if (needsOptions && options.length === 0) { setErr('Captura al menos una opción.'); return }

    const newField = {
      code, label, type: draft.type,
      ...(draft.required ? { required: true } : {}),
      ...(needsOptions ? { options } : {}),
      ...(draft.unit_code.trim() ? { unit_code: draft.unit_code.trim() } : {}),
    }
    onChange({ version: schema?.version || 1, fields: [...fields, newField] })
    setDraft({ label: '', type: 'number', required: false, options: '', unit_code: '' })
  }

  function remove(code) {
    onChange({ version: schema?.version || 1, fields: fields.filter(f => f.code !== code) })
  }

  return (
    <div className="border border-line-subtle rounded-lg p-3 flex flex-col gap-3">
      <div>
        <p className="text-xs font-semibold text-ink-secondary">Atributos a capturar por paquete</p>
        <p className="text-[11px] text-ink-muted mt-0.5">
          Definen los campos extra que aparecen al operador al registrar cada paquete (ej: color, talla, sabor).
        </p>
      </div>

      {fields.length === 0 ? (
        <p className="text-xs text-ink-muted italic">Sin atributos — el operador solo capturará el peso del paquete.</p>
      ) : (
        <div className="space-y-1">
          {fields.map(f => (
            <div key={f.code} className="flex items-center gap-2 bg-surface-elevated/40 rounded-md px-2 py-1.5">
              <div className="flex-1 min-w-0">
                <p className="text-sm text-ink-primary truncate">
                  {f.label}
                  {f.required && <span className="text-status-danger ml-1">*</span>}
                </p>
                <p className="text-[11px] text-ink-muted font-mono truncate">
                  {f.code} · {FIELD_TYPES.find(t => t.value === f.type)?.label || f.type}
                  {f.options ? ` · ${f.options.join(', ')}` : ''}
                </p>
              </div>
              <button type="button" onClick={() => remove(f.code)}
                className="text-ink-muted hover:text-status-danger">
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12"/>
                </svg>
              </button>
            </div>
          ))}
        </div>
      )}

      {err && <p className="text-xs text-status-danger">{err}</p>}

      <div className="grid grid-cols-2 gap-2 border-t border-line-subtle pt-3">
        <div className="col-span-2">
          <label className="label">Nombre del atributo</label>
          <input className="input text-sm" placeholder="Ej: Color, Sabor, Talla"
            value={draft.label}
            onChange={e => setDraft(d => ({ ...d, label: e.target.value }))} />
        </div>
        <div>
          <label className="label">Tipo</label>
          <select className="select text-sm"
            value={draft.type}
            onChange={e => setDraft(d => ({ ...d, type: e.target.value }))}>
            {FIELD_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
          </select>
        </div>
        <div>
          <label className="label">Unidad (opcional)</label>
          <input className="input text-sm" placeholder="kg, cm, g/m..."
            value={draft.unit_code}
            onChange={e => setDraft(d => ({ ...d, unit_code: e.target.value }))} />
        </div>
        {(draft.type === 'select' || draft.type === 'multiselect') && (
          <div className="col-span-2">
            <label className="label">Opciones (separadas por coma)</label>
            <input className="input text-sm" placeholder="Rojo, Verde, Azul"
              value={draft.options}
              onChange={e => setDraft(d => ({ ...d, options: e.target.value }))} />
          </div>
        )}
        <label className="col-span-2 flex items-center gap-2 text-sm cursor-pointer">
          <input type="checkbox" className="w-4 h-4 accent-brand-600"
            checked={draft.required}
            onChange={e => setDraft(d => ({ ...d, required: e.target.checked }))} />
          <span className="text-ink-secondary">Obligatorio</span>
        </label>
        <button type="button" onClick={add}
          className="btn-secondary btn-sm col-span-2">
          + Agregar atributo
        </button>
      </div>
    </div>
  )
}

function ProductKindModal({ item, onClose, onSaved }) {
  const isNew = !item?.id
  const [form, setForm] = useState(() => isNew
    ? { ...EMPTY_FORM }
    : {
      code: item.code, name: item.name, is_produced: item.is_produced ?? true,
      default_shelf_life_days: item.default_shelf_life_days ?? '',
      sort_order: item.sort_order ?? 0,
    }
  )
  // capture_schema separado del form para serializar como JSONB
  const [captureSchema, setCaptureSchema] = useState(() =>
    item?.capture_schema && Array.isArray(item.capture_schema.fields)
      ? item.capture_schema
      : { version: 1, fields: [] }
  )
  const [error, setError] = useState(null)

  const mut = useMutation({
    mutationFn: () => {
      const body = {
        ...form,
        default_shelf_life_days: form.default_shelf_life_days !== '' ? parseInt(form.default_shelf_life_days) : null,
        capture_schema: captureSchema,
      }
      return isNew
        ? processConfigApi.createProductKind(body)
        : processConfigApi.updateProductKind(item.id, body)
    },
    onSuccess: () => onSaved(),
    onError:   (err) => setError(err.response?.data?.error || err.message),
  })

  function set(f, v) { setForm(p => ({ ...p, [f]: v })) }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-bg-primary/80 backdrop-blur-sm">
      <div className="bg-surface-primary rounded-2xl shadow-xl w-full max-w-xl border border-line-subtle max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-5 py-4 border-b border-line-subtle">
          <h3 className="text-sm font-semibold text-ink-primary">
            {isNew ? 'Nuevo tipo de producto' : `Editar · ${item.name}`}
          </h3>
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
              <input className="input" placeholder="ej: pellet" value={form.code} onChange={e => set('code', e.target.value)} disabled={!isNew} />
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
            <input className="input" placeholder="ej: Pellet de plástico" value={form.name} onChange={e => set('name', e.target.value)} />
          </div>
          <div>
            <label className="label">Vida útil por defecto (días)</label>
            <input
              type="number" min={0}
              className="input"
              placeholder="(sin límite)"
              value={form.default_shelf_life_days}
              onChange={e => set('default_shelf_life_days', e.target.value)}
            />
            <p className="text-xs text-ink-muted mt-1">
              Dejar vacío si no aplica vencimiento para este tipo.
            </p>
          </div>
          <label className="flex items-start gap-3 text-sm cursor-pointer">
            <input type="checkbox" checked={form.is_produced} onChange={e => set('is_produced', e.target.checked)} className="w-4 h-4 accent-brand-600 mt-0.5" />
            <span>
              <span className="font-medium text-ink-primary">Lo fabricas tú</span>
              <span className="block text-xs text-ink-muted mt-0.5">
                Activo: este producto se produce internamente (entra al sistema a través de un turno de producción).
                Apagado: lo compras a un proveedor para revenderlo sin transformación.
              </span>
            </span>
          </label>

          {form.is_produced && (
            <CaptureSchemaEditor schema={captureSchema} onChange={setCaptureSchema} />
          )}
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

export default function TiposProducto() {
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
    queryKey: ['process-config-product-kinds', showInactive],
    queryFn:  () => processConfigApi.listProductKinds({ include_inactive: showInactive || undefined }),
  })

  const toggleMut = useMutation({
    mutationFn: ({ id, isActive }) => processConfigApi.updateProductKind(id, { is_active: isActive }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['process-config-product-kinds'] })
      setSuccessMsg('Actualizado.')
      setTimeout(() => setSuccessMsg(null), 2500)
    },
    onError: (err) => setServerError(err.response?.data?.error || err.message),
  })

  function handleSaved() {
    qc.invalidateQueries({ queryKey: ['process-config-product-kinds'] })
    setEditing(null)
    setSuccessMsg('Guardado.')
    setTimeout(() => setSuccessMsg(null), 2500)
  }

  return (
    <div className="page-enter flex flex-col gap-6">
      <div className="page-header">
        <div>
          <h1 className="page-title">Tipos de producto</h1>
          <p className="page-subtitle">Categorías de producto con esquemas de atributos propios</p>
        </div>
        {canManage && (
          <button onClick={() => setEditing('new')} className="btn-primary">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4"/>
            </svg>
            Nuevo tipo
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
          <p className="font-medium text-ink-secondary">Sin tipos de producto configurados</p>
          {canManage && <button onClick={() => setEditing('new')} className="btn-primary btn-sm mt-3">+ Crear primero</button>}
        </div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Código</th>
                <th>Nombre</th>
                <th>Origen</th>
                <th>Vida útil (días)</th>
                <th>Estado</th>
                {canManage && <th className="w-16"></th>}
              </tr>
            </thead>
            <tbody>
              {items.map(item => (
                <tr key={item.id} className={clsx(!item.is_active && 'opacity-50')}>
                  <td className="font-mono text-xs text-ink-secondary">{item.code}</td>
                  <td className="font-medium text-sm">{item.name}</td>
                  <td>
                    <Badge variant={item.is_produced ? 'blue' : 'purple'} label={item.is_produced ? 'Producido' : 'Reventa'} />
                  </td>
                  <td className="text-sm text-ink-secondary">
                    {item.default_shelf_life_days != null ? item.default_shelf_life_days : <span className="text-ink-muted">—</span>}
                  </td>
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
        <ProductKindModal item={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={handleSaved} />
      )}
    </div>
  )
}
