import { useState } from 'react'
import { createPortal } from 'react-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useForm } from 'react-hook-form'
import { z } from 'zod'
import { zodResolver } from '@hookform/resolvers/zod'
import { rawMaterialsApi } from '@/api/rawMaterials'
import { processConfigApi } from '@/api/processConfig'
import { useCodeSuggestion } from '@/hooks/useCodeSuggestion'
import { useEffect } from 'react'
import Badge from '@/components/ui/Badge'
import Spinner from '@/components/ui/Spinner'
import InventoryLevelsPanel from '@/components/inventario/InventoryLevelsPanel'
import Can from '@/components/auth/Can'
import clsx from 'clsx'

// ─── Catálogos ────────────────────────────────────────────────────────────────
const RESIN_TYPES    = ['PP', 'PE']
const MATERIAL_TYPES = [
  { value: 'virgin',  label: 'Virgen' },
  { value: 'regrind', label: 'Regrind' },
]
const UNITS = ['kg', 'ton', 'lt', 'pza', 'm', 'rollo']

const RESIN_VARIANT  = { PP: 'blue', PE: 'purple' }
const MTYPE_VARIANT  = { virgin: 'green', regrind: 'amber' }
const MTYPE_LABEL    = { virgin: 'Virgen', regrind: 'Regrind' }

// Tipo de item: distingue materia prima principal de empaques y aditivos.
// Habilita catálogos separados, almacenes dedicados y costos desglosados.
const ITEM_KINDS = [
  { value: 'raw_material', label: 'Materia prima', hint: 'Ingrediente principal del producto (resina, harina, papel, etc.)' },
  { value: 'packaging',    label: 'Embalaje',      hint: 'Bolsas, etiquetas, fleje, cajas, cintas. Se consumen al empacar.' },
  { value: 'additive',     label: 'Aditivo',       hint: 'Colorantes, conservadores, saborizantes. Cantidades pequeñas.' },
]
const KIND_LABEL   = { raw_material: 'Materia prima', packaging: 'Embalaje', additive: 'Aditivo' }
const KIND_VARIANT = { raw_material: 'amber', packaging: 'teal', additive: 'purple' }

// ─── Schema ───────────────────────────────────────────────────────────────────
// resin_type y material_type solo se exigen para item_kind='raw_material' (plástico).
// Para packaging/additive se aceptan vacíos.
const schema = z.object({
  name:          z.string().min(2, 'Mínimo 2 caracteres').max(150),
  code:          z.string().max(50).optional().or(z.literal('')),
  itemKind:      z.enum(['raw_material', 'packaging', 'additive']).default('raw_material'),
  resinType:     z.union([z.enum(['PP', 'PE']), z.literal(''), z.null()]).optional(),
  materialType:  z.union([z.enum(['virgin', 'regrind']), z.literal(''), z.null()]).optional(),
  unit:          z.string().min(1, 'Requerido'),
  maxRegrindPct: z.coerce.number().min(0).max(100),
  costPerKg:     z.coerce.number().min(0),
  description:   z.string().optional().or(z.literal('')),
  isActive:      z.boolean().optional(),
  leadTimeDays:  z.coerce.number().min(0).max(365).optional(),
})
// Nota: la validación de "resinType requerido para MP plástica" se hace en
// el componente porque depende de tenantConfig.uses_resin_types (no
// accesible desde el schema estático). Si el flag está ON y el usuario
// crea MP sin resina, mostramos error en submit.

// ─── Íconos ───────────────────────────────────────────────────────────────────
const IconPlus = () => (
  <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
    <path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/>
  </svg>
)
const IconEdit = () => (
  <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
    <path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/>
  </svg>
)
const IconX = ({ className }) => (
  <svg className={clsx('w-4 h-4', className)} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12"/>
  </svg>
)
const IconEmpty = () => (
  <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M20.25 6.375c0 2.278-3.694 4.125-8.25 4.125S3.75 8.653 3.75 6.375m16.5 0c0-2.278-3.694-4.125-8.25-4.125S3.75 4.097 3.75 6.375m16.5 0v11.25c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125V6.375m16.5 0v3.75m-16.5-3.75v3.75m16.5 0v3.75C20.25 16.153 16.556 18 12 18s-8.25-1.847-8.25-4.125v-3.75m16.5 0c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125"/>
  </svg>
)

// ─── Subcomponentes ───────────────────────────────────────────────────────────
function Field({ label, error, required, hint, children, className }) {
  return (
    <div className={className}>
      {label && (
        <label className="label">
          {label}{required && <span className="text-status-danger ml-0.5">*</span>}
        </label>
      )}
      {children}
      {hint && !error && <p className="text-xs text-ink-muted mt-1">{hint}</p>}
      {error && <p className="field-error">{error}</p>}
    </div>
  )
}

function Section({ number, title, children, className }) {
  return (
    <div className={clsx('border border-line-subtle rounded-xl overflow-hidden', className)}>
      <div className="flex items-center gap-2.5 px-4 py-3 bg-surface-elevated/40 border-b border-line-subtle">
        <span className="w-5 h-5 rounded-full bg-brand-600 text-white text-[10px] font-medium flex items-center justify-center shrink-0">
          {number}
        </span>
        <span className="text-sm font-medium text-ink-primary">{title}</span>
      </div>
      <div className="p-4 space-y-3">{children}</div>
    </div>
  )
}

// ─── Modal ────────────────────────────────────────────────────────────────────
function RawMaterialModal({ item, onClose }) {
  const queryClient = useQueryClient()
  const isEditing   = !!item

  const { register, handleSubmit, watch, setValue, formState: { errors, isSubmitting } } = useForm({
    resolver: zodResolver(schema),
    defaultValues: {
      name:          item?.name          || '',
      code:          item?.code          || '',
      itemKind:      item?.item_kind     || 'raw_material',
      resinType:     item?.resin_type    || '',
      materialType:  item?.material_type || '',
      unit:          item?.unit          || 'kg',
      maxRegrindPct: item?.max_regrind_pct ?? 30,
      costPerKg:     item?.cost_per_kg   ?? 0,
      description:   item?.description   || '',
      isActive:      item?.is_active     ?? true,
      leadTimeDays:  item?.lead_time_days ?? 7,
    },
  })

  // El item_kind discrimina entre tres catálogos lógicos con su propia
  // nomenclatura: 'raw_material' (MP), 'packaging' (embalajes), 'additive'
  // (aditivos). Watch del kind ANTES del hook para que cambie de entity al
  // alternar el toggle del form.
  const selectedKind    = watch('itemKind')
  const codeSug = useCodeSuggestion(selectedKind, { enabled: !isEditing })
  useEffect(() => {
    if (!isEditing && codeSug.isAuto && codeSug.code) {
      setValue('code', codeSug.code, { shouldDirty: false, shouldValidate: true })
    }
  }, [codeSug.isAuto, codeSug.code, selectedKind, isEditing])
  const selectedResin   = watch('resinType')
  const selectedMType   = watch('materialType')
  const watchLeadTime   = watch('leadTimeDays')
  const isRawMaterial   = selectedKind === 'raw_material'

  // Flags del tenant: sólo mostramos "Tipo de resina" y "Virgen/Regrind"
  // cuando el tenant los tiene activos en su configuración de proceso.
  const { data: tenantConfig } = useQuery({
    queryKey: ['tenant-process-config'],
    queryFn:  processConfigApi.getConfig,
    staleTime: 300000,
  })
  const usesResinTypes      = tenantConfig?.uses_resin_types       ?? false
  const tracksMaterialOrigin = tenantConfig?.tracks_material_origin ?? false
  // Mostrar atributos plástico solo si es MP principal y el tenant los usa.
  const showResinField    = isRawMaterial && usesResinTypes
  const showMaterialField = isRawMaterial && tracksMaterialOrigin

  const mutation = useMutation({
    mutationFn: (data) => isEditing
      ? rawMaterialsApi.update(item.id, data)
      : rawMaterialsApi.create(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['raw-materials'] })
      onClose()
    },
  })

  const serverError = mutation.error?.response?.data?.error

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto"
      style={{ background: 'rgba(17,24,39,0.55)' }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div
        className="relative w-full max-w-lg my-8 mx-4 bg-surface-primary rounded-2xl shadow-card"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-line-subtle">
          <div>
            <h2 className="text-base font-semibold text-ink-primary">
              {isEditing ? 'Editar materia prima' : 'Nueva materia prima'}
            </h2>
            <p className="text-xs text-ink-muted mt-0.5">
              {isEditing ? item.name : 'Resina para producción de esquineros'}
            </p>
          </div>
          <button type="button" onClick={onClose} className="btn-ghost btn-icon"><IconX /></button>
        </div>

        <form onSubmit={handleSubmit((d) => mutation.mutate(d))} className="px-6 py-5 space-y-4">

          {/* Aviso de captura rápida — solo en móvil */}
          <div className="sm:hidden rounded-lg bg-status-info/10 border border-status-info/30 px-3 py-2 text-xs text-status-info flex items-start gap-2">
            <span className="text-sm leading-none mt-0.5">⚡</span>
            <span><strong>Captura rápida.</strong> Registra lo esencial para que el insumo exista. El código, especificaciones, descripción y niveles se completan en la versión de escritorio.</span>
          </div>

          {/* ── 1. Identificación ── */}
          <Section number="1" title="Identificación">
            {/* Tipo de item — distingue MP principal, empaques y aditivos. */}
            <div>
              <label className="label">Tipo<span className="text-status-danger ml-0.5">*</span></label>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                {ITEM_KINDS.map((k) => (
                  <button key={k.value} type="button"
                    disabled={isEditing}
                    onClick={() => setValue('itemKind', k.value)}
                    className={clsx(
                      'p-3 rounded-lg text-left border transition-colors',
                      selectedKind === k.value
                        ? 'bg-brand-500/10 border-brand-500/40'
                        : 'bg-surface-primary border-line-subtle hover:bg-surface-elevated/40',
                      isEditing && 'opacity-60 cursor-not-allowed',
                    )}>
                    <p className={clsx('text-xs font-medium', selectedKind === k.value ? 'text-brand-300' : 'text-ink-secondary')}>{k.label}</p>
                    <p className="text-[10px] text-ink-muted mt-1 leading-tight">{k.hint}</p>
                  </button>
                ))}
              </div>
              {isEditing && <p className="text-xs text-ink-muted mt-1">El tipo no se puede cambiar después de crear.</p>}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <Field label="Código" error={errors.code?.message}
                className="hidden sm:block"
                hint={codeSug.canSuggest && !isEditing ? `Sugerencia: ${codeSug.code}` : undefined}>
                <div className="flex gap-2">
                  <input {...register('code')}
                    disabled={codeSug.isAuto}
                    placeholder={codeSug.placeholder || 'MP-001'}
                    className={clsx('input flex-1 font-mono',
                      codeSug.isAuto && 'bg-surface-elevated/40 cursor-not-allowed',
                      errors.code && 'input-error')} />
                  {codeSug.canSuggest && !isEditing && (
                    <button type="button"
                      onClick={() => setValue('code', codeSug.code, { shouldDirty: true, shouldValidate: true })}
                      className="btn-secondary btn-sm shrink-0 whitespace-nowrap"
                      title={`Sugerir ${codeSug.code}`}>↻</button>
                  )}
                </div>
              </Field>
              <Field label="Nombre" required error={errors.name?.message} className="sm:col-span-2">
                <input {...register('name')}
                  placeholder={selectedKind === 'packaging' ? 'Bolsa transparente 30×40 cm'
                    : selectedKind === 'additive' ? 'Colorante rojo carmín'
                    : 'PP Virgen 50 MFI'}
                  className={clsx('input', errors.name && 'input-error')} />
              </Field>
            </div>

            {/* Atributos plástico: solo si MP + flag uses_resin_types ON */}
            {showResinField && (
              <div className="hidden sm:block">
                <label className="label">Tipo de resina<span className="text-status-danger ml-0.5">*</span></label>
                <div className="flex gap-2">
                  {RESIN_TYPES.map((r) => (
                    <button key={r} type="button"
                      disabled={isEditing}
                      onClick={() => setValue('resinType', r)}
                      className={clsx(
                        'flex-1 py-2 rounded-lg text-sm font-medium border transition-colors',
                        selectedResin === r
                          ? 'bg-brand-500/10 border-brand-500/40 text-brand-300'
                          : 'bg-surface-primary border-line-subtle text-ink-muted hover:bg-surface-elevated/40',
                        isEditing && 'opacity-60 cursor-not-allowed'
                      )}>
                      {r}
                    </button>
                  ))}
                </div>
                {errors.resinType && <p className="field-error">{errors.resinType.message}</p>}
                {isEditing && <p className="text-xs text-ink-muted mt-1">El tipo de resina no se puede cambiar.</p>}
              </div>
            )}

            {/* Virgen / Regrind: solo si MP + flag tracks_material_origin ON */}
            {showMaterialField && (
              <div className="hidden sm:block">
                <label className="label">Tipo de material<span className="text-status-danger ml-0.5">*</span></label>
                <div className="flex gap-2">
                  {MATERIAL_TYPES.map((m) => (
                    <button key={m.value} type="button"
                      onClick={() => setValue('materialType', m.value)}
                      className={clsx(
                        'flex-1 py-2 rounded-lg text-sm font-medium border transition-colors',
                        selectedMType === m.value
                          ? 'bg-brand-500/10 border-brand-500/40 text-brand-300'
                          : 'bg-surface-primary border-line-subtle text-ink-muted hover:bg-surface-elevated/40'
                      )}>
                      {m.label}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <Field label="Descripción" hint="Opcional — proveedor, grado, especificación" className="hidden sm:block">
              <textarea {...register('description')} rows={2}
                placeholder={selectedKind === 'packaging' ? 'Ej: Polietileno transparente, proveedor X...'
                  : 'Ej: MFI 50, proveedor Braskem...'}
                className="input h-auto py-2 resize-none" />
            </Field>
          </Section>

          {/* ── 2. Parámetros de uso ── */}
          <Section number="2" title="Parámetros de uso en producción">
            <div className={clsx('grid gap-3 grid-cols-1', showMaterialField ? 'sm:grid-cols-3' : 'sm:grid-cols-2')}>
              <Field label="Unidad" required error={errors.unit?.message}>
                <select {...register('unit')} className={clsx('select', errors.unit && 'input-error')}>
                  {UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
                </select>
              </Field>
              {showMaterialField && (
                <Field label="% máx. regrind" error={errors.maxRegrindPct?.message}
                  hint="Mezcla máxima permitida" className="hidden sm:block">
                  <div className="relative">
                    <input {...register('maxRegrindPct')} type="number" min="0" max="100" step="1"
                      className={clsx('input pr-6', errors.maxRegrindPct && 'input-error')} />
                    <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-xs text-ink-muted">%</span>
                  </div>
                </Field>
              )}
              <Field label={`Costo por ${watch('unit') || 'unidad'}`} error={errors.costPerKg?.message}>
                <div className="relative">
                  <input {...register('costPerKg')} type="number" min="0" step="0.01"
                    placeholder="0.00"
                    className={clsx('input pr-10', errors.costPerKg && 'input-error')} />
                  <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-xs text-ink-muted">MXN</span>
                </div>
              </Field>
            </div>
            <p className="text-xs text-ink-muted">
              El costo unitario se actualiza automáticamente al recibir compras. Este valor es el de referencia inicial.
            </p>
          </Section>

          {/* ── 3. Niveles de inventario y reposición ── */}
          <Section number="3" title="Niveles de inventario y reposición" className="hidden sm:block">
            <InventoryLevelsPanel
              itemType="raw_material"
              itemId={item?.id}
              leadTimeDays={watchLeadTime}
              onLeadTimeChange={(v) => setValue('leadTimeDays', v, { shouldDirty: true })}
              unit={watch('unit') || 'kg'}
            />
          </Section>

          {/* Estado — solo edición */}
          {isEditing && (
            <label className="flex items-center gap-3 px-4 py-3 bg-surface-elevated/40 rounded-xl border border-line-subtle cursor-pointer">
              <input type="checkbox" {...register('isActive')} className="w-4 h-4 accent-brand-600" />
              <span className="text-sm text-ink-secondary">Materia prima activa — disponible en producción</span>
            </label>
          )}

          {serverError && (
            <div className="px-4 py-3 bg-status-danger/10 border border-status-danger/40 rounded-xl text-sm text-status-danger">
              {serverError}
            </div>
          )}

          <div className="flex justify-end gap-3 pt-2 border-t border-line-subtle">
            <button type="button" onClick={onClose} className="btn-secondary">Cancelar</button>
            <button type="submit" disabled={isSubmitting} className="btn-primary">
              {isSubmitting && <Spinner className="w-4 h-4" />}
              {isEditing ? 'Guardar cambios' : 'Crear materia prima'}
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body
  )
}

// ─── Página ───────────────────────────────────────────────────────────────────
export default function MateriasPrimas() {
  const [search,       setSearch]       = useState('')
  const [filterKind,   setFilterKind]   = useState('')
  const [filterResin,  setFilterResin]  = useState('')
  const [filterMType,  setFilterMType]  = useState('')
  const [filterActive, setFilterActive] = useState('')
  const [page,         setPage]         = useState(1)
  const [modal,        setModal]        = useState(null)

  // Flags del tenant — controlan visibilidad de filtros y columnas de plástico.
  const { data: tenantConfig } = useQuery({
    queryKey: ['tenant-process-config'],
    queryFn:  processConfigApi.getConfig,
    staleTime: 300000,
  })
  const showResin    = tenantConfig?.uses_resin_types       ?? false
  const showMaterial = tenantConfig?.tracks_material_origin ?? false

  const { data, isLoading } = useQuery({
    queryKey: ['raw-materials', { search, filterKind, filterResin, filterMType, filterActive, page }],
    queryFn: () => rawMaterialsApi.list({
      search:       search       || undefined,
      itemKind:     filterKind   || undefined,
      resinType:    filterResin  || undefined,
      materialType: filterMType  || undefined,
      isActive:     filterActive !== '' ? filterActive === 'true' : undefined,
      page, limit: 50,
    }),
    keepPreviousData: true,
  })

  const items      = data?.data  || []
  const total      = data?.total || 0
  const totalPages = Math.ceil(total / 50)

  async function openEdit(row) {
    const full = await rawMaterialsApi.get(row.id)
    setModal(full)
  }

  return (
    <div className="page-enter">
      <div className="page-header">
        <div>
          <h1 className="page-title">Materias primas</h1>
          <p className="page-subtitle">{total} materia{total !== 1 ? 's' : ''} prima{total !== 1 ? 's' : ''} registrada{total !== 1 ? 's' : ''}</p>
        </div>
        <Can do="raw_materials:create">
          <button className="btn-primary" onClick={() => setModal('new')}>
            <IconPlus /> Nueva materia prima
          </button>
        </Can>
      </div>

      {/* Filtros */}
      <div className="flex flex-wrap gap-3 mb-5">
        <input value={search} onChange={(e) => { setSearch(e.target.value); setPage(1) }}
          placeholder="Buscar por nombre..." className="input max-w-xs" />
        <select value={filterKind} onChange={(e) => { setFilterKind(e.target.value); setPage(1) }}
          className="select w-44">
          <option value="">Todos los tipos</option>
          <option value="raw_material">Materias primas</option>
          <option value="packaging">Embalajes</option>
          <option value="additive">Aditivos</option>
        </select>
        {showResin && (
          <select value={filterResin} onChange={(e) => { setFilterResin(e.target.value); setPage(1) }}
            className="select w-32">
            <option value="">Todas las resinas</option>
            <option value="PP">PP</option>
            <option value="PE">PE</option>
          </select>
        )}
        {showMaterial && (
          <select value={filterMType} onChange={(e) => { setFilterMType(e.target.value); setPage(1) }}
            className="select w-36">
            <option value="">Virgen/Regrind</option>
            <option value="virgin">Virgen</option>
            <option value="regrind">Regrind</option>
          </select>
        )}
        <select value={filterActive} onChange={(e) => { setFilterActive(e.target.value); setPage(1) }}
          className="select w-32">
          <option value="">Todas</option>
          <option value="true">Activas</option>
          <option value="false">Inactivas</option>
        </select>
      </div>

      {/* Tabla */}
      <div className="card p-0 overflow-hidden">
        {isLoading ? (
          <div className="flex items-center justify-center py-16"><Spinner /></div>
        ) : items.length === 0 ? (
          <div className="empty-state">
            <div className="w-12 h-12 rounded-xl bg-surface-elevated/60 flex items-center justify-center text-ink-muted mb-3">
              <IconEmpty />
            </div>
            <p className="font-medium text-ink-secondary">Sin materias primas</p>
            <p>{search || filterResin || filterMType
              ? 'No hay resultados para los filtros aplicados.'
              : 'Registra la primera materia prima.'}
            </p>
          </div>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Tipo</th>
                  <th>Nombre</th>
                  {showResin    && <th>Resina</th>}
                  {showMaterial && <th>Material</th>}
                  <th>Unidad</th>
                  <th>Lead time</th>
                  <th>Costo</th>
                  <th>Estado</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {items.map((r) => {
                  const kind = r.item_kind || 'raw_material'
                  return (
                  <tr key={r.id}>
                    <td><Badge variant={KIND_VARIANT[kind]} label={KIND_LABEL[kind]} /></td>
                    <td><span className="font-medium text-ink-primary">{r.name}</span></td>
                    {showResin && (
                      <td>{r.resin_type ? <Badge variant={RESIN_VARIANT[r.resin_type]} label={r.resin_type} /> : <span className="text-ink-muted text-xs">—</span>}</td>
                    )}
                    {showMaterial && (
                      <td>{r.material_type ? <Badge variant={MTYPE_VARIANT[r.material_type]} label={MTYPE_LABEL[r.material_type]} /> : <span className="text-ink-muted text-xs">—</span>}</td>
                    )}
                    <td className="text-ink-muted text-xs">{r.unit}</td>
                    <td className="text-ink-muted text-xs">{r.lead_time_days ?? 7} días</td>
                    <td className="text-ink-secondary font-medium">
                      ${Number(r.cost_per_kg).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 4 })}/{r.unit}
                    </td>
                    <td>
                      <Badge status={r.is_active ? 'confirmed' : 'cancelled'}
                        label={r.is_active ? 'Activa' : 'Inactiva'} />
                    </td>
                    <td>
                      <Can do="raw_materials:update">
                        <button onClick={() => openEdit(r)}
                          className="btn-ghost btn-icon btn-sm text-ink-muted hover:text-brand-300" title="Editar">
                          <IconEdit />
                        </button>
                      </Can>
                    </td>
                  </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}

        {totalPages > 1 && (
          <div className="flex items-center justify-between px-4 py-3 border-t border-line-subtle">
            <span className="text-xs text-ink-muted">Página {page} de {totalPages} — {total} registros</span>
            <div className="flex gap-2">
              <button onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page === 1} className="btn-secondary btn-sm">Anterior</button>
              <button onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={page === totalPages} className="btn-secondary btn-sm">Siguiente</button>
            </div>
          </div>
        )}
      </div>

      {modal && (
        <RawMaterialModal
          item={modal === 'new' ? null : modal}
          onClose={() => setModal(null)}
        />
      )}
    </div>
  )
}
