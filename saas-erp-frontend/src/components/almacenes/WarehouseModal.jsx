import { useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { useMutation, useQuery } from '@tanstack/react-query'
import { warehousesApi } from '@/api/warehouses'
import { processConfigApi } from '@/api/processConfig'
import Spinner from '@/components/ui/Spinner'
import clsx from 'clsx'

const TYPE_OPTIONS = [
  { value: 'raw_material',     label: 'Materia prima',
    desc: 'Recibe compras de MP principal (resina, harina, papel, etc.) y permite ajustes manuales.' },
  { value: 'packaging',        label: 'Embalaje',
    desc: 'Almacena bolsas, etiquetas, fleje, cajas y demás material de empaque. Se consume al producir.' },
  { value: 'wip',              label: 'Producto en proceso (WIP)',
    desc: 'SOLO LECTURA. Gestionado automáticamente por producción. No admite ajustes ni recepciones.' },
  { value: 'finished_product', label: 'Producto terminado',
    desc: 'Recibe del cierre de turno (producción) y sale por ventas.' },
  { value: 'regrind',          label: 'Material reciclado',
    desc: 'Almacena material recuperado de mermas (típico en industrias de plástico).' },
  { value: 'resale',           label: 'Almacén de reventa',
    desc: 'Productos que compras terminados a un proveedor para vender sin transformarlos.' },
]

const RESIN_REQUIRED = ['raw_material', 'regrind']

export default function WarehouseModal({ warehouse, onClose, onSaved }) {
  const isEditing = !!warehouse
  const [form, setForm] = useState({
    name:         warehouse?.name        || '',
    type:         warehouse?.type        || 'raw_material',
    resin_type:   warehouse?.resin_type  || '',
    description:  warehouse?.description || '',
    is_active:    warehouse?.is_active   ?? true,
    make_default: warehouse?.is_default  ?? false,
  })
  const [showFieldErrors, setShowFieldErrors] = useState(false)
  const [serverError, setServerError]         = useState(null)

  // Reset si cambia el warehouse
  useEffect(() => {
    setForm({
      name:         warehouse?.name        || '',
      type:         warehouse?.type        || 'raw_material',
      resin_type:   warehouse?.resin_type  || '',
      description:  warehouse?.description || '',
      is_active:    warehouse?.is_active   ?? true,
      make_default: warehouse?.is_default  ?? false,
    })
  }, [warehouse])

  // El campo "Tipo de resina" solo se pide cuando el tenant usa resinas
  // (uses_resin_types=true) Y el tipo de almacén es de MP/Regrind/Embalaje.
  const { data: tenantConfig } = useQuery({
    queryKey: ['tenant-process-config'],
    queryFn:  processConfigApi.getConfig,
    staleTime: 300000,
  })
  const usesResinTypes = tenantConfig?.uses_resin_types ?? false
  const requiresResin = usesResinTypes && RESIN_REQUIRED.includes(form.type)

  // ── Mutaciones ─────────────────────────────────────────────────────────────
  const createMut = useMutation({
    mutationFn: (body) => warehousesApi.create(body),
    onSuccess:  () => onSaved?.(),
    onError:    (err) => setServerError(err.response?.data?.error || err.message),
  })

  const updateMut = useMutation({
    mutationFn: (patch) => warehousesApi.update(warehouse.id, patch),
    onSuccess:  () => onSaved?.(),
    onError:    (err) => setServerError(err.response?.data?.error || err.message),
  })

  const setDefaultMut = useMutation({
    mutationFn: () => warehousesApi.setDefault(warehouse.id),
  })

  // ── Validación ─────────────────────────────────────────────────────────────
  const errors = []
  if (!form.name.trim())                   errors.push('El nombre es obligatorio.')
  if (requiresResin && !form.resin_type)   errors.push('Los almacenes MP/Regrind requieren tipo de resina.')

  // ── Submit ─────────────────────────────────────────────────────────────────
  function handleSubmit(e) {
    e?.preventDefault()
    setShowFieldErrors(true)
    setServerError(null)
    if (errors.length > 0) return

    if (isEditing) {
      // En edición no se permite cambiar tipo
      const patch = {
        name:        form.name.trim(),
        resin_type:  form.resin_type || null,
        description: form.description?.trim() || null,
        is_active:   form.is_active,
      }
      updateMut.mutate(patch, {
        onSuccess: async () => {
          // Si el toggle "make_default" cambió, llamar al endpoint dedicado
          if (form.make_default && !warehouse.is_default) {
            try { await setDefaultMut.mutateAsync() } catch (_) {}
          }
          onSaved?.()
        },
      })
    } else {
      createMut.mutate({
        name:         form.name.trim(),
        type:         form.type,
        resin_type:   form.resin_type || null,
        description:  form.description?.trim() || null,
        is_active:    form.is_active,
        make_default: form.make_default,
      })
    }
  }

  const isSaving = createMut.isPending || updateMut.isPending
  const selectedTypeInfo = TYPE_OPTIONS.find(t => t.value === form.type)

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40 p-4 overflow-y-auto">
      <div className="card w-full max-w-lg my-6 p-6">
        {/* ── Header ───────────────────────────────────────────────── */}
        <div className="flex items-center justify-between mb-5">
          <div>
            <h2 className="text-base font-semibold text-ink-primary">
              {isEditing ? 'Editar almacén' : 'Nuevo almacén'}
            </h2>
            {isEditing && (
              <p className="text-xs text-ink-muted mt-0.5">
                El tipo no se puede cambiar después de crear el almacén.
              </p>
            )}
          </div>
          <button onClick={onClose} className="btn-ghost btn-icon text-ink-muted">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12"/>
            </svg>
          </button>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          {/* ── Nombre ─────────────────────────────────────────────── */}
          <div>
            <label className="label">Nombre *</label>
            <input
              className={clsx('input', showFieldErrors && !form.name.trim() && 'border-status-danger/40')}
              placeholder="Ej: Materia Prima Nave 1"
              value={form.name}
              onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
              maxLength={100}
              autoFocus
            />
          </div>

          {/* ── Tipo ───────────────────────────────────────────────── */}
          <div>
            <label className="label">Tipo *</label>
            <select
              className={clsx('select', isEditing && 'opacity-60 cursor-not-allowed')}
              value={form.type}
              onChange={e => setForm(f => ({ ...f, type: e.target.value, resin_type: '' }))}
              disabled={isEditing}
            >
              {TYPE_OPTIONS.map(opt => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
            {selectedTypeInfo && (
              <p className={clsx(
                'text-[11px] mt-1.5 leading-relaxed',
                form.type === 'wip' ? 'text-status-warning font-medium' : 'text-ink-muted'
              )}>
                {selectedTypeInfo.desc}
              </p>
            )}
          </div>

          {/* ── Resina ─────────────────────────────────────────────── */}
          {requiresResin && (
            <div>
              <label className="label">Tipo de resina *</label>
              <select
                className={clsx('select', showFieldErrors && !form.resin_type && 'border-status-danger/40')}
                value={form.resin_type}
                onChange={e => setForm(f => ({ ...f, resin_type: e.target.value }))}
              >
                <option value="">— Selecciona —</option>
                <option value="PP">PP — Polipropileno</option>
                <option value="PE">PE — Polietileno</option>
              </select>
            </div>
          )}

          {/* ── Descripción ────────────────────────────────────────── */}
          <div>
            <label className="label">Descripción <span className="text-ink-muted font-normal">(opcional)</span></label>
            <textarea
              className="input min-h-[60px]"
              placeholder="Notas internas sobre el uso de este almacén..."
              value={form.description}
              onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
              rows={2}
              maxLength={500}
            />
          </div>

          {/* ── Toggles ────────────────────────────────────────────── */}
          <div className="border-t border-line-subtle pt-4 flex flex-col gap-3">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={form.is_active}
                onChange={e => setForm(f => ({ ...f, is_active: e.target.checked }))}
                className="w-4 h-4 accent-brand-600"
              />
              <span className="text-sm text-ink-secondary">Activo</span>
            </label>

            <label className="flex items-start gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={form.make_default}
                onChange={e => setForm(f => ({ ...f, make_default: e.target.checked }))}
                className="w-4 h-4 accent-brand-600 mt-0.5"
              />
              <div>
                <span className="text-sm text-ink-secondary">Marcar como default de su tipo ⭐</span>
                <p className="text-[11px] text-ink-muted mt-0.5">
                  Si lo marcas, el actual default deja de serlo. El default es el almacén que reciben los hooks
                  automáticos de producción.
                </p>
              </div>
            </label>
          </div>

          {/* ── Errores ────────────────────────────────────────────── */}
          {showFieldErrors && errors.length > 0 && (
            <ul className="bg-status-warning/10 border border-status-warning/40 rounded-xl px-4 py-2.5 text-xs text-status-warning list-disc list-inside space-y-0.5">
              {errors.map((e, i) => <li key={i}>{e}</li>)}
            </ul>
          )}
          {serverError && (
            <p className="bg-status-danger/10 border border-status-danger/40 rounded-xl px-4 py-2.5 text-xs text-status-danger">
              {serverError}
            </p>
          )}

          {/* ── Botones ────────────────────────────────────────────── */}
          <div className="flex gap-2 pt-3 border-t border-line-subtle">
            <button type="button" onClick={onClose} className="btn-secondary flex-1">Cancelar</button>
            <button
              type="submit"
              disabled={isSaving}
              className="btn-primary flex-1 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isSaving ? <Spinner size="sm" /> : (isEditing ? 'Guardar cambios' : 'Crear almacén')}
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body
  )
}
