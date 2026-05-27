import { useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useForm, useFieldArray } from 'react-hook-form'
import { z } from 'zod'
import { zodResolver } from '@hookform/resolvers/zod'
import { productionApi } from '@/api/production'
import { productsApi } from '@/api/products'
import { rawMaterialsApi } from '@/api/rawMaterials'
import { recipesApi } from '@/api/recipes'
import useAuthStore from '@/store/useAuthStore'
import Can from '@/components/auth/Can'
import Spinner from '@/components/ui/Spinner'
import clsx from 'clsx'

const PRIORITY_COLOR = {
  urgente: { bar:'#E24B4A', border:'#E24B4A', bg:'#FCEBEB', text:'#A32D2D', label:'Urgente' },
  alta:    { bar:'#EF9F27', border:'#EF9F27', bg:'#FAEEDA', text:'#633806', label:'Alta' },
  normal:  { bar:'#1D9E75', border:'#1D9E75', bg:'#EAF3DE', text:'#27500A', label:'Normal' },
  baja:    { bar:'#888780', border:'#888780', bg:'#F1EFE8', text:'#5F5E5A', label:'Baja' },
}

const STATUS_LABEL = {
  draft:'Borrador', released:'En cola', in_progress:'En producción',
  completed:'Completada', cancelled:'Cancelada',
}

const mpSchema = z.object({
  rawMaterialId: z.string().min(1, 'Selecciona un material'),
  percentage:    z.coerce.number().positive('Mayor a 0').max(100, 'Máx 100'),
})

const schema = z.object({
  productId:            z.string().min(1, 'Requerido'),
  lengthCm:             z.coerce.number().positive('Requerido').optional().or(z.literal('')),
  quantityPackages:     z.coerce.number().int().positive('Requerido'),
  priority:             z.enum(['urgente','alta','normal','baja']),
  deliveryDate:         z.string().optional().or(z.literal('')),
  lineId:               z.coerce.number().int().min(1).optional(),
  notes:                z.string().optional().or(z.literal('')),
  mpFormula:   z.array(mpSchema).optional().default([]),
  customItems: z.array(z.object({
    description: z.string().min(1, 'Describe la personalización'),
    cost:        z.coerce.number().min(0).default(0),
    // 'per_unit' multiplica por la cantidad de paquetes del pedido.
    // 'fixed' es un cargo único independiente de la cantidad.
    costType:    z.enum(['fixed', 'per_unit']).optional().default('per_unit'),
  })).optional().default([]),
})

const IconPlus  = () => <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>
const IconX     = () => <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12"/></svg>
const IconPlay  = () => <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
const IconEdit  = () => <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>
const IconTrash = () => <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
const IconInfo  = () => <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/></svg>
const IconStar  = () => <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 24 24"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>

function Field({ label, error, required, hint, children, className }) {
  return (
    <div className={className}>
      {label && <label className="label">{label}{required && <span className="text-status-danger ml-0.5">*</span>}</label>}
      {children}
      {hint && !error && <p className="text-xs text-ink-muted mt-1">{hint}</p>}
      {error && <p className="field-error">{error}</p>}
    </div>
  )
}

// ─── Sección de personalización — lista dinámica de items ─────────────────────
function CustomItemsSection({ control, register, errors, watch, setValue }) {
  const { fields, append, remove } = useFieldArray({ control, name: 'customItems' })
  const items    = watch('customItems') || []
  const qty      = parseInt(watch('quantityPackages')) || 0

  // Costo efectivo por item: si es por unidad, multiplica por la cantidad de
  // paquetes del pedido. Si es fijo, queda tal cual.
  function lineTotal(it) {
    const cost = parseFloat(it?.cost) || 0
    return it?.costType === 'fixed' ? cost : cost * qty
  }
  const total    = items.reduce((s, i) => s + lineTotal(i), 0)
  const hasItems = fields.length > 0
  // No permitir agregar fila si la última está vacía (evita basura).
  const lastEmpty = hasItems && !(items[items.length - 1]?.description?.trim())

  return (
    <div className="border-t border-line-subtle pt-4">
      <div className="flex items-center justify-between mb-3">
        <span className="text-sm font-medium text-ink-secondary flex items-center gap-1.5">
          <IconStar /> Personalización del pedido
          {hasItems && (
            <span className="ml-1 text-xs px-2 py-0.5 rounded-full bg-purple-500/15 text-purple-300 font-semibold">
              {fields.length}
            </span>
          )}
        </span>
        {total > 0 && (
          <span className="text-xs font-semibold text-purple-300">
            Cargo total: ${total.toFixed(2)}
          </span>
        )}
      </div>

      {hasItems && (
        <div className="mb-2 rounded-xl overflow-hidden border border-line-subtle bg-surface-elevated">
          {/* Cabecera */}
          <div className="grid grid-cols-[1fr_120px_120px_28px] gap-2 px-3 py-1.5 bg-surface-secondary/40 border-b border-line-subtle">
            <span className="text-[10px] font-semibold text-ink-muted uppercase tracking-wide">Descripción</span>
            <span className="text-[10px] font-semibold text-ink-muted uppercase tracking-wide">Tipo</span>
            <span className="text-[10px] font-semibold text-ink-muted uppercase tracking-wide text-right">Costo $</span>
            <span />
          </div>

          {/* Filas */}
          <div className="divide-y divide-line-subtle">
            {fields.map((field, idx) => {
              const it = items[idx] || {}
              const isPerUnit = (it.costType || 'per_unit') === 'per_unit'
              const cost = parseFloat(it.cost) || 0
              const showBreakdown = isPerUnit && cost > 0 && qty > 0
              return (
                <div key={field.id} className="px-3 py-2 grid grid-cols-[1fr_120px_120px_28px] gap-2 items-center">
                  <input
                    {...register(`customItems.${idx}.description`)}
                    type="text"
                    placeholder="Ej: Texto feliz cumpleaños"
                    className={clsx(
                      'input input-sm text-sm',
                      errors.customItems?.[idx]?.description && 'input-error'
                    )}
                  />

                  {/* Toggle Fijo / Por unidad */}
                  <div className="flex bg-surface-secondary/40 rounded-md p-0.5 text-[11px] font-medium">
                    <button type="button"
                      onClick={() => setValue(`customItems.${idx}.costType`, 'per_unit', { shouldDirty: true })}
                      className={clsx(
                        'flex-1 py-1 rounded transition',
                        isPerUnit ? 'bg-purple-500/20 text-purple-300' : 'text-ink-muted hover:text-ink-primary'
                      )}
                    >
                      Por unidad
                    </button>
                    <button type="button"
                      onClick={() => setValue(`customItems.${idx}.costType`, 'fixed', { shouldDirty: true })}
                      className={clsx(
                        'flex-1 py-1 rounded transition',
                        !isPerUnit ? 'bg-purple-500/20 text-purple-300' : 'text-ink-muted hover:text-ink-primary'
                      )}
                    >
                      Fijo
                    </button>
                  </div>

                  <div className="relative">
                    <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-xs text-ink-muted">$</span>
                    <input
                      {...register(`customItems.${idx}.cost`)}
                      type="number" step="0.01" min="0"
                      placeholder="0.00"
                      className="input input-sm text-sm pl-5 text-right"
                    />
                  </div>

                  <button
                    type="button"
                    onClick={() => remove(idx)}
                    className="btn-ghost btn-icon btn-sm text-ink-muted hover:text-status-danger"
                    title="Quitar"
                  >
                    <IconX />
                  </button>

                  {/* Breakdown del cálculo cuando es por unidad */}
                  {showBreakdown && (
                    <div className="col-span-4 text-[10px] text-ink-muted -mt-0.5 pl-1">
                      {cost.toFixed(2)} × {qty} paq = <span className="text-purple-300 font-semibold">${lineTotal(it).toFixed(2)}</span>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}

      <button
        type="button"
        disabled={lastEmpty}
        onClick={() => append({ description: '', cost: 0, costType: 'per_unit' })}
        title={lastEmpty ? 'Completa la descripción anterior primero' : ''}
        className={clsx(
          'btn-sm w-full justify-center border border-dashed transition-colors',
          lastEmpty
            ? 'border-line-subtle text-ink-muted opacity-50 cursor-not-allowed'
            : hasItems
              ? 'border-purple-500/40 text-purple-300 hover:bg-purple-500/10'
              : 'border-line-subtle text-ink-muted hover:border-purple-500/40 hover:text-purple-300'
        )}
      >
        <IconPlus />
        {hasItems ? 'Agregar otra personalización' : '+ Agregar personalización del pedido'}
      </button>
    </div>
  )
}

// ─── Sección de fórmula de mezcla ────────────────────────────────────────────
function MpFormulaSection({ control, register, errors, mps, watch }) {
  const { fields, append, remove } = useFieldArray({ control, name: 'mpFormula' })
  const formula = watch('mpFormula') || []
  const totalPct = formula.reduce((s, f) => s + parseFloat(f.percentage || 0), 0)

  // Calcular costo promedio ponderado en tiempo real
  const blendedCost = formula.reduce((sum, f) => {
    const mat = mps.find(m => m.id === f.rawMaterialId)
    return sum + (parseFloat(f.percentage||0) / 100) * parseFloat(mat?.cost_per_kg || 0)
  }, 0)

  const usedIds = formula.map(f => f.rawMaterialId).filter(Boolean)
  const available = mps.filter(m => !usedIds.includes(m.id))

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <label className="label mb-0">Fórmula de mezcla<span className="text-status-danger ml-0.5">*</span></label>
        <div className="flex items-center gap-3">
          {blendedCost > 0 && (
            <span className="text-xs text-brand-300 font-medium">
              Costo mezcla: ${blendedCost.toFixed(4)}/kg
            </span>
          )}
          <span className={clsx('text-xs font-medium', Math.abs(totalPct - 100) < 0.01 ? 'text-status-success' : 'text-status-warning')}>
            {totalPct.toFixed(1)}% / 100%
          </span>
        </div>
      </div>

      <div className="space-y-2 mb-2">
        {fields.map((field, idx) => (
          <div key={field.id} className="flex items-center gap-2">
            <select {...register(`mpFormula.${idx}.rawMaterialId`)}
              className={clsx('select flex-1', errors.mpFormula?.[idx]?.rawMaterialId && 'input-error')}>
              <option value="">Seleccionar material...</option>
              {mps.filter(m => m.id === formula[idx]?.rawMaterialId || !usedIds.includes(m.id)).map(m => (
                <option key={m.id} value={m.id}>{m.name} — {m.resin_type} · ${parseFloat(m.cost_per_kg||0).toFixed(2)}/kg</option>
              ))}
            </select>
            <div className="relative w-24">
              <input {...register(`mpFormula.${idx}.percentage`)} type="number" step="0.1" min="0.1" max="100"
                placeholder="0"
                className={clsx('input pr-5', errors.mpFormula?.[idx]?.percentage && 'input-error')} />
              <span className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-ink-muted">%</span>
            </div>
            <button type="button" onClick={() => remove(idx)}
              className="btn-ghost btn-icon btn-sm text-ink-muted hover:text-status-danger shrink-0">
              <IconX />
            </button>
          </div>
        ))}
      </div>

      {fields.length < 4 && available.length > 0 && (
        <button type="button"
          onClick={() => append({ rawMaterialId: '', percentage: fields.length === 0 ? 100 : '' })}
          className="btn-secondary btn-sm w-full justify-center">
          <IconPlus /> Agregar material {fields.length > 0 ? `(${4 - fields.length} más disponible${4-fields.length!==1?'s':''})` : ''}
        </button>
      )}

      {errors.mpFormula?.message && <p className="field-error mt-1">{errors.mpFormula.message}</p>}
      {Math.abs(totalPct - 100) > 0.01 && totalPct > 0 && (
        <p className="text-xs text-status-warning mt-1">Los porcentajes deben sumar exactamente 100%</p>
      )}
    </div>
  )
}

// ─── Panel de disponibilidad de MP (en vivo durante el form) ──────────────────
// Recibe los datos crudos del form y llama al backend con debounce.
// Muestra 3 estados: esperando datos, stock OK, stock insuficiente.
function StockPreviewPanel({ productId, lengthMm, quantityPackages, mpFormula }) {
  const [preview, setPreview] = useState(null)
  const [loading, setLoading] = useState(false)

  // Validez de la fórmula MP: cada item con material y porcentaje, total 100%
  const formulaValid = (mpFormula || []).length > 0
    && (mpFormula || []).every(f => f.rawMaterialId && parseFloat(f.percentage || 0) > 0)
    && Math.abs((mpFormula || []).reduce((s,f) => s + parseFloat(f.percentage||0), 0) - 100) < 0.01

  const canPreview = !!productId
    && parseFloat(lengthMm || 0) > 0
    && parseInt(quantityPackages || 0) > 0
    && formulaValid

  // Llave para detectar cambios reales y evitar requests redundantes
  const key = canPreview ? JSON.stringify({
    productId, lengthMm, quantityPackages,
    mp: mpFormula.map(f => ({ id: f.rawMaterialId, pct: parseFloat(f.percentage) })),
  }) : null

  // Debounce: 500ms tras el último cambio antes de consultar
  useEffect(() => {
    if (!canPreview) { setPreview(null); return }
    let cancelled = false
    setLoading(true)
    const t = setTimeout(async () => {
      try {
        const res = await productionApi.previewStock({
          productId,
          lengthMm:         parseFloat(lengthMm),
          quantityPackages: parseInt(quantityPackages),
          mpFormula:        mpFormula.map(f => ({
            rawMaterialId: f.rawMaterialId,
            percentage:    parseFloat(f.percentage),
          })),
        })
        if (!cancelled) setPreview(res)
      } catch (err) {
        if (!cancelled) setPreview({ error: err?.response?.data?.error || 'Error consultando stock' })
      } finally {
        if (!cancelled) setLoading(false)
      }
    }, 500)
    return () => { cancelled = true; clearTimeout(t) }
  }, [key])  // eslint-disable-line react-hooks/exhaustive-deps

  // Estado A: faltan datos
  if (!canPreview) {
    return (
      <div className="px-4 py-3 bg-surface-elevated/40 border border-line-subtle rounded-xl">
        <p className="text-xs font-medium text-ink-secondary mb-1">Estimado de materia prima</p>
        <p className="text-xs text-ink-muted">
          Completa producto, largo, paquetes y fórmula MP (suma 100%) para ver el estimado de stock.
        </p>
      </div>
    )
  }

  // Loading state
  if (loading || !preview) {
    return (
      <div className="px-4 py-3 bg-surface-elevated/40 border border-line-subtle rounded-xl">
        <div className="flex items-center gap-2">
          <Spinner className="w-3 h-3" />
          <p className="text-xs text-ink-muted">Consultando inventario...</p>
        </div>
      </div>
    )
  }

  if (preview.error) {
    return (
      <div className="px-4 py-3 bg-status-danger/10 border border-status-danger/40 rounded-xl">
        <p className="text-xs text-status-danger">⚠ {preview.error}</p>
      </div>
    )
  }

  const { ok, items = [], totals = {}, meta = {} } = preview

  // Estado B/C: hay resultado
  return (
    <div className={clsx(
      'border rounded-xl overflow-hidden',
      ok ? 'bg-status-success/10 border-status-success/40' : 'bg-status-warning/10 border-status-warning/40',
    )}>
      <div className="flex items-center justify-between px-4 py-2 border-b"
        style={{ borderColor: ok ? '#bbf7d0' : '#fcd34d' }}>
        <p className="text-xs font-semibold text-ink-primary">Estimado de materia prima</p>
        <span className={clsx(
          'text-[10px] font-bold px-2 py-0.5 rounded-full',
          ok ? 'bg-green-200 text-status-success' : 'bg-amber-200 text-status-warning',
        )}>
          {ok ? '✓ STOCK OK' : '⚠ STOCK BAJO'}
        </span>
      </div>

      <div className="px-4 py-3 space-y-1">
        <div className="grid grid-cols-12 gap-1 text-[10px] font-semibold text-ink-muted uppercase pb-1 border-b border-line-subtle">
          <div className="col-span-5">Material</div>
          <div className="col-span-2 text-right">%</div>
          <div className="col-span-2 text-right">Req. kg</div>
          <div className="col-span-2 text-right">Disp. kg</div>
          <div className="col-span-1 text-right">Falta</div>
        </div>
        {items.map((it) => (
          <div key={it.rawMaterialId}
            className={clsx('grid grid-cols-12 gap-1 text-xs py-1', !it.ok && 'text-status-warning font-medium')}>
            <div className="col-span-5 truncate">{it.name}{!it.ok && ' ⚠'}</div>
            <div className="col-span-2 text-right text-ink-muted">{it.percentage}%</div>
            <div className="col-span-2 text-right font-mono">{it.requiredKg.toFixed(1)}</div>
            <div className="col-span-2 text-right font-mono">{it.availableKg.toFixed(1)}</div>
            <div className="col-span-1 text-right font-mono">{it.missingKg > 0 ? it.missingKg.toFixed(1) : '—'}</div>
          </div>
        ))}
        <div className="grid grid-cols-12 gap-1 text-xs pt-1 mt-1 border-t border-line-subtle font-semibold">
          <div className="col-span-7 text-ink-secondary">TOTAL</div>
          <div className="col-span-2 text-right font-mono">{totals.requiredKg?.toFixed(1)}</div>
          <div className="col-span-2 text-right font-mono">{totals.availableKg?.toFixed(1)}</div>
          <div className="col-span-1 text-right font-mono">{totals.missingKg > 0 ? totals.missingKg.toFixed(1) : '—'}</div>
        </div>
        <p className="text-[10px] text-ink-muted pt-1">
          Incluye factor de merma {(meta.reprocessFactor * 100).toFixed(0)}% para reproceso.
        </p>
        {!ok && (
          <p className="text-[11px] text-status-warning pt-1 leading-tight">
            Puedes guardar la orden, pero al liberarla el sistema pedirá una justificación.
          </p>
        )}
      </div>
    </div>
  )
}

// ─── Modal: liberar orden con stock insuficiente ──────────────────────────────
function LowStockReleaseModal({ order, availability, onClose, onConfirm, isPending }) {
  const [reason, setReason] = useState('')
  const missing = (availability?.items || []).filter(it => !it.ok)

  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-center justify-center"
      style={{ background:'rgba(17,24,39,0.55)' }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="relative w-full max-w-md mx-4 bg-surface-primary rounded-2xl shadow-card"
        onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-6 py-4 border-b border-status-warning/40 bg-status-warning/10 rounded-t-2xl">
          <h2 className="text-base font-semibold text-status-warning">⚠ Stock insuficiente</h2>
          <button type="button" onClick={onClose} className="btn-ghost btn-icon"><IconX /></button>
        </div>

        <div className="px-6 py-5 space-y-4">
          <p className="text-sm text-ink-secondary">
            La orden <span className="font-medium">{order?.order_number}</span> tiene materiales con stock insuficiente:
          </p>

          <div className="bg-status-warning/10 border border-status-warning/40 rounded-xl p-3 space-y-1.5">
            {missing.map(it => (
              <div key={it.rawMaterialId} className="flex justify-between text-sm">
                <span className="text-status-warning font-medium">{it.name}</span>
                <span className="text-status-warning font-mono">faltan {it.missingKg.toFixed(2)} kg</span>
              </div>
            ))}
          </div>

          <div>
            <label className="label">
              Justifica por qué deseas liberarla de todos modos
              <span className="text-status-danger ml-0.5">*</span>
            </label>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              className="input h-auto py-2 resize-none"
              placeholder="Ej: La materia prima llega a las 14:00 hrs"
              autoFocus
            />
            <p className="text-[11px] text-ink-muted mt-1">
              Mínimo 5 caracteres. Se registra en auditoría con tu usuario, fecha y hora.
            </p>
          </div>
        </div>

        <div className="flex justify-end gap-3 px-6 py-4 border-t border-line-subtle">
          <button type="button" onClick={onClose} className="btn-secondary" disabled={isPending}>
            Cancelar
          </button>
          <button
            type="button"
            onClick={() => onConfirm(reason.trim())}
            disabled={isPending || reason.trim().length < 5}
            className="btn-primary">
            {isPending && <Spinner className="w-4 h-4" />}
            Liberar con justificación
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}

// ─── Modal crear / editar orden ───────────────────────────────────────────────
function OrderModal({ order, onClose }) {
  const queryClient = useQueryClient()
  const isEditing   = !!order

  // Solo productos que se fabrican internamente aparecen en órdenes de producción.
  // Los de reventa (is_produced=false) no pueden tener orden de fabricación.
  const { data: productsData } = useQuery({
    queryKey:['products-producible'],
    queryFn:() => productsApi.list({ isActive:true, isProduced:true, limit:200 }),
  })
  const { data: mpData }       = useQuery({ queryKey:['raw-materials-active'], queryFn:() => rawMaterialsApi.list({ isActive:true, limit:200 }) })

  const products = productsData?.data || []
  const mps      = mpData?.data || []

  const { register, handleSubmit, watch, setValue, control, formState:{ errors, isSubmitting } } = useForm({
    resolver: zodResolver(schema),
    defaultValues: {
      productId:            order?.product_id        || '',
      lengthCm:             order?.length_mm ? (order.length_mm / 10) : '',
      quantityPackages:     order?.quantity_packages  || 100,
      priority:             order?.priority          || 'normal',
      deliveryDate:         order?.delivery_date?.slice?.(0,10) || '',
      lineId:               order?.line_id           || 1,
      notes:                order?.notes             || '',
      mpFormula:   order?.mpFormula?.map(f => ({
        rawMaterialId: f.raw_material_id,
        percentage:    parseFloat(f.percentage),
      })) || [{ rawMaterialId:'', percentage:100 }],
      customItems: (() => {
        const ca = order?.custom_attributes
        if (!ca) return []
        // Nuevo formato: { items: [{d, c, t?}] } — t='fixed'|'per_unit' (default per_unit)
        if (Array.isArray(ca.items)) return ca.items.map(i => ({
          description: i.d || i.description || '',
          cost:        i.c ?? i.cost ?? 0,
          costType:    i.t || i.costType || 'per_unit',
        }))
        // Formato legacy: {texto, color_betun, figuras} → migrar a items.
        // Asumimos 'fixed' para legacy porque no sabemos la intención original.
        const legacy = []
        if (ca.texto)       legacy.push({ description: ca.texto,                       cost: 0, costType: 'fixed' })
        if (ca.color_betun) legacy.push({ description: `Color betún: ${ca.color_betun}`, cost: 0, costType: 'fixed' })
        if (ca.figuras)     legacy.push({ description: `Figuras: ${ca.figuras}`,       cost: 0, costType: 'fixed' })
        if (order.additional_costs > 0 && order.additional_costs_notes)
          legacy.push({ description: order.additional_costs_notes, cost: parseFloat(order.additional_costs), costType: 'fixed' })
        return legacy
      })(),
    },
  })

  const selectedPriority  = watch('priority')
  const selectedProductId = watch('productId')
  const selectedProduct    = products.find(p => p.id === selectedProductId)
  // Producto con spec lineal (gramos/metro): muestra campo "Largo" y requiere fórmula.
  // Antes se basaba en type='corner_protector'; ahora se basa en si el catálogo tiene
  // grams_per_linear_meter capturado, lo que hace el flujo independiente del enum legacy.
  const hasLinealSpec      = !!selectedProduct?.has_quality_spec
    || (parseFloat(selectedProduct?.grams_per_linear_meter || 0) > 0)

  // Carga receta vigente del producto seleccionado (si existe) para autopopular fórmula.
  const { data: vigentRecipes = [] } = useQuery({
    queryKey: ['recipe-vigent', selectedProductId],
    queryFn:  () => recipesApi.list({ productId: selectedProductId, vigentOnly: true }),
    enabled:  !!selectedProductId && !isEditing,
    staleTime: 60000,
  })
  const vigentRecipe = vigentRecipes[0] || null
  const { data: vigentRecipeFull } = useQuery({
    queryKey: ['recipe-full', vigentRecipe?.id],
    queryFn:  () => recipesApi.get(vigentRecipe.id),
    enabled:  !!vigentRecipe?.id,
  })

  // Convierte componentes de receta (cantidades absolutas) a mpFormula (porcentajes).
  // Solo funciona limpiamente cuando todos los componentes están en la misma unidad.
  function applyRecipe() {
    if (!vigentRecipeFull?.components?.length) return
    const comps = vigentRecipeFull.components
    const total = comps.reduce((s, c) => s + parseFloat(c.quantity || 0), 0)
    if (total <= 0) return
    const formula = comps.map(c => ({
      rawMaterialId: c.raw_material_id,
      percentage:    Math.round((parseFloat(c.quantity) / total) * 10000) / 100, // 2 decimales
    }))
    setValue('mpFormula', formula, { shouldDirty: true })
  }

  const mutation = useMutation({
    mutationFn: (data) => {
      if (isEditing) {
        return productionApi.updateOrder(order.id, {
          notes: data.notes, priority: data.priority,
          deliveryDate: data.deliveryDate, mpFormula: data.mpFormula,
          customAttributes:     data.customAttributes,
          additionalCosts:      data.additionalCosts,
          additionalCostsNotes: data.additionalCostsNotes,
        })
      }
      return productionApi.createOrder(data)
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey:['production-queue'] })
      queryClient.invalidateQueries({ queryKey:['production-orders'] })
      onClose()
    },
  })

  const formula = watch('mpFormula') || []
  const totalPct = formula.reduce((s,f) => s + parseFloat(f.percentage||0), 0)
  const formulaValid = formula.length === 0 || Math.abs(totalPct - 100) < 0.01
  const canSubmit = formulaValid && (!hasLinealSpec || formula.length > 0)

  const onSubmit = (data) => {
    if (!formulaValid) return
    if (hasLinealSpec && formula.length === 0) return
    const payload = { ...data }
    if (data.lengthCm && parseFloat(data.lengthCm) > 0) {
      payload.lengthMm = parseFloat(data.lengthCm) * 10
    }
    delete payload.lengthCm
    const items = (data.customItems || []).filter(i => i.description?.trim())
    if (items.length > 0) {
      const qty = parseInt(data.quantityPackages) || 1
      payload.customAttributes = { items: items.map(i => ({
        d: i.description.trim(),
        c: parseFloat(i.cost || 0),
        t: i.costType || 'per_unit',
      })) }
      // Costo agregado al pedido: 'per_unit' multiplica por la cantidad de
      // paquetes, 'fixed' se suma tal cual. Antes siempre se sumaba el costo
      // crudo, lo que subestimaba el cargo cuando era por pieza.
      payload.additionalCosts = items.reduce((s, i) => {
        const cost = parseFloat(i.cost || 0)
        return s + ((i.costType || 'per_unit') === 'per_unit' ? cost * qty : cost)
      }, 0)
      payload.additionalCostsNotes = items.map(i => i.description.trim()).join(', ')
    } else {
      payload.customAttributes     = null
      payload.additionalCosts      = null
      payload.additionalCostsNotes = null
    }
    delete payload.customItems
    mutation.mutate(payload)
  }

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto"
      style={{ background:'rgba(17,24,39,0.55)' }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="relative w-full max-w-lg my-8 mx-4 bg-surface-primary rounded-2xl shadow-card"
        onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-6 py-4 border-b border-line-subtle">
          <h2 className="text-base font-semibold text-ink-primary">
            {isEditing ? `Editar orden ${order.order_number}` : 'Nueva orden de fabricación'}
          </h2>
          <button type="button" onClick={onClose} className="btn-ghost btn-icon"><IconX /></button>
        </div>

        <form onSubmit={handleSubmit(onSubmit)} className="px-6 py-5 space-y-4">

          {/* Producto — bloqueado en edición */}
          <Field label="Producto" required error={errors.productId?.message}>
            <select {...register('productId')} disabled={isEditing}
              className={clsx('select', isEditing && 'bg-surface-elevated/40 cursor-not-allowed', errors.productId && 'input-error')}>
              <option value="">Seleccionar producto...</option>
              {products.map(p => <option key={p.id} value={p.id}>{p.name}{p.sku ? ` — ${p.sku}` : ''}</option>)}
            </select>
          </Field>

          {/* Largo y paquetes — largo solo para corner_protector */}
          <div className="grid grid-cols-2 gap-3">
            {hasLinealSpec && (
              <Field label="Largo (cm)" required error={errors.lengthCm?.message} hint="200 = 2 metros">
                <input {...register('lengthCm')} type="number" step="0.1" placeholder="200" disabled={isEditing}
                  className={clsx('input', isEditing && 'bg-surface-elevated/40 cursor-not-allowed', errors.lengthCm && 'input-error')} />
              </Field>
            )}
            <Field label="Paquetes / lotes" required error={errors.quantityPackages?.message}
              className={hasLinealSpec ? '' : 'col-span-2'}>
              <input {...register('quantityPackages')} type="number" min="1" disabled={isEditing}
                className={clsx('input', isEditing && 'bg-surface-elevated/40 cursor-not-allowed', errors.quantityPackages && 'input-error')} />
            </Field>
          </div>

          {/* Banner: receta vigente disponible para autocargar */}
          {vigentRecipe && !isEditing && (
            <div className="flex items-center justify-between gap-3 rounded-xl border border-brand-500/30 bg-brand-500/5 px-4 py-3">
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-brand-300">
                  Receta vigente · v{vigentRecipe.version}
                  {vigentRecipe.name && <span className="text-ink-secondary font-normal ml-1">({vigentRecipe.name})</span>}
                </p>
                <p className="text-xs text-ink-muted mt-0.5">
                  {vigentRecipe.components_count} componente{vigentRecipe.components_count !== 1 ? 's' : ''} configurado{vigentRecipe.components_count !== 1 ? 's' : ''}.
                  Al cargar, los porcentajes se calculan proporcionalmente a las cantidades de la receta.
                </p>
              </div>
              <button type="button" onClick={applyRecipe}
                disabled={!vigentRecipeFull?.components?.length}
                className="btn-primary btn-sm shrink-0">
                Cargar receta
              </button>
            </div>
          )}

          {/* Fórmula de mezcla — requerida para corner_protector, opcional para otros */}
          {(hasLinealSpec || formula.length > 0) && (
            <MpFormulaSection control={control} register={register} errors={errors} mps={mps} watch={watch} />
          )}
          {!hasLinealSpec && formula.length === 0 && !vigentRecipe && (
            <button type="button"
              onClick={() => setValue('mpFormula', [{ rawMaterialId: '', percentage: 100 }])}
              className="btn-secondary btn-sm w-full justify-center text-ink-muted">
              + Definir fórmula de materias primas (opcional)
            </button>
          )}

          {/* Panel: disponibilidad de MP en vivo — solo si hay fórmula */}
          {hasLinealSpec && formula.length > 0 && (
            <StockPreviewPanel
              productId={watch('productId')}
              lengthMm={parseFloat(watch('lengthCm') || 0) * 10}
              quantityPackages={watch('quantityPackages')}
              mpFormula={formula}
            />
          )}

          {/* Prioridad */}
          <div>
            <label className="label">Prioridad<span className="text-status-danger ml-0.5">*</span></label>
            <div className="grid grid-cols-4 gap-2">
              {Object.entries(PRIORITY_COLOR).map(([key, c]) => (
                <button key={key} type="button" onClick={() => setValue('priority', key)}
                  style={selectedPriority===key ? { background:c.bg, borderColor:c.border, color:c.text } : {}}
                  className={clsx('py-2 rounded-lg text-xs font-medium border transition-colors',
                    selectedPriority===key ? '' : 'bg-surface-primary border-line-subtle text-ink-muted hover:bg-surface-elevated/40')}>
                  {c.label}
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Fecha de entrega">
              <input {...register('deliveryDate')} type="date" className="input" />
            </Field>
            {!isEditing && (
              <Field label="Línea de producción">
                <input {...register('lineId')} type="number" min="1" className="input" />
              </Field>
            )}
          </div>

          <Field label="Notas">
            <textarea {...register('notes')} rows={2} className="input h-auto py-2 resize-none"
              placeholder="Instrucciones especiales..." />
          </Field>

          {/* Personalización del pedido — items dinámicos */}
          <CustomItemsSection control={control} register={register} errors={errors} watch={watch} setValue={setValue} />

          {mutation.error && (
            <div className="px-4 py-3 bg-status-danger/10 border border-status-danger/40 rounded-xl text-sm text-status-danger">
              {mutation.error?.response?.data?.error}
            </div>
          )}

          <div className="flex justify-end gap-3 pt-2 border-t border-line-subtle">
            <button type="button" onClick={onClose} className="btn-secondary">Cancelar</button>
            <button type="submit" disabled={isSubmitting || !canSubmit} className="btn-primary">
              {isSubmitting && <Spinner className="w-4 h-4" />}
              {isEditing ? 'Guardar cambios' : 'Crear orden'}
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body
  )
}

// ─── Modal detalle de orden ───────────────────────────────────────────────────
function OrderDetailModal({ order, onClose, onEdit, onCancel, onCloseOrder, onReopen, currentUser }) {
  const prio = PRIORITY_COLOR[order.priority] || PRIORITY_COLOR.normal
  const canEdit  = ['draft','released'].includes(order.status)
  const canClose = ['released','in_progress','fulfilled'].includes(order.status)
  const canReopen = order.status === 'completed'
  // currentUser.roles puede venir como array, objeto o null según el endpoint.
  // Forzamos array para evitar el crash si el shape no es el esperado.
  const userRoles = Array.isArray(currentUser?.roles) ? currentUser.roles : []
  const isAdmin = userRoles.includes('admin') || userRoles.includes('super_admin')

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto"
      style={{ background:'rgba(17,24,39,0.55)' }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="relative w-full max-w-lg my-8 mx-4 bg-surface-primary rounded-2xl shadow-card"
        onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-6 py-4 border-b border-line-subtle">
          <div>
            <h2 className="text-base font-semibold text-ink-primary">{order.order_number}</h2>
            <span style={{ fontSize:11, fontWeight:500, padding:'2px 8px', borderRadius:20, background:prio.bg, color:prio.text }}>
              {prio.label}
            </span>
          </div>
          <button type="button" onClick={onClose} className="btn-ghost btn-icon"><IconX /></button>
        </div>

        <div className="px-6 py-5 space-y-4">
          {/* Info básica */}
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div className={order.length_mm ? '' : 'col-span-2'}>
              <p className="text-ink-muted text-xs mb-1">Producto</p>
              <p className="font-medium">{order.product_name}</p>
            </div>
            {order.length_mm > 0 && (
              <div><p className="text-ink-muted text-xs mb-1">Largo</p><p className="font-medium">{`${(order.length_mm/1000).toFixed(2)}m`}</p></div>
            )}
            <div><p className="text-ink-muted text-xs mb-1">Cantidad</p><p className="font-medium">{order.quantity_packages} paq · {parseInt(order.quantity_units||0).toLocaleString()} pzas</p></div>
            <div><p className="text-ink-muted text-xs mb-1">Entrega</p><p className="font-medium">{order.delivery_date ? new Date(order.delivery_date).toLocaleDateString('es-MX',{day:'numeric',month:'short'}) : '—'}</p></div>
            <div><p className="text-ink-muted text-xs mb-1">Estado</p><p className="font-medium">{STATUS_LABEL[order.status]}</p></div>
            <div><p className="text-ink-muted text-xs mb-1">Avance</p><p className="font-medium text-brand-300">{parseFloat(order.progress_pct||0).toFixed(0)}%</p></div>
          </div>

          {/* Fórmula de mezcla */}
          {order.mpFormula?.length > 0 && (
            <div>
              <p className="text-xs text-ink-muted mb-2">Fórmula de mezcla</p>
              <div className="space-y-2">
                {order.mpFormula.map((f, i) => (
                  <div key={i} className="flex items-center gap-3 px-3 py-2 bg-surface-elevated/40 rounded-lg">
                    <div className="flex-1">
                      <p className="text-sm font-medium text-ink-primary">{f.material_name}</p>
                      <p className="text-xs text-ink-muted">{f.resin_type} · ${parseFloat(f.cost_per_kg||0).toFixed(2)}/kg</p>
                    </div>
                    <span className="text-sm font-bold text-brand-300">{parseFloat(f.percentage).toFixed(1)}%</span>
                  </div>
                ))}
                {order.blended_cost_per_kg && (
                  <div className="flex justify-between px-3 py-2 bg-brand-500/10 rounded-lg">
                    <span className="text-xs text-brand-300">Costo promedio mezcla</span>
                    <span className="text-sm font-bold text-brand-300">${parseFloat(order.blended_cost_per_kg).toFixed(4)}/kg</span>
                  </div>
                )}
              </div>
            </div>
          )}

          {order.notes && (
            <div>
              <p className="text-xs text-ink-muted mb-1">Notas</p>
              <p className="text-sm text-ink-secondary">{order.notes}</p>
            </div>
          )}

          {order.custom_attributes && (
            (() => {
              const ca  = order.custom_attributes
              const raw = Array.isArray(ca.items) ? ca.items : []
              // Compatibilidad con formato legacy (texto/color_betun/figuras)
              const legacy = !raw.length && (ca.texto || ca.color_betun || ca.figuras)
              const items = raw.length
                ? raw
                : legacy
                  ? [
                      ca.texto       && { d: ca.texto,              c: 0 },
                      ca.color_betun && { d: `Color betún: ${ca.color_betun}`, c: 0 },
                      ca.figuras     && { d: `Figuras: ${ca.figuras}`,         c: 0 },
                    ].filter(Boolean)
                  : []
              if (!items.length) return null
              const total = items.reduce((s, i) => s + parseFloat(i.c ?? i.cost ?? 0), 0)
              return (
                <div>
                  <p className="text-xs text-ink-muted mb-2 flex items-center gap-1"><IconStar /> Personalización</p>
                  <div className="rounded-xl overflow-hidden border border-purple-100">
                    <div className="grid grid-cols-[1fr_auto] gap-3 px-3 py-1.5 bg-purple-50 border-b border-purple-100">
                      <span className="text-[11px] font-semibold text-purple-700 uppercase tracking-wide">Descripción</span>
                      <span className="text-[11px] font-semibold text-purple-700 uppercase tracking-wide">Costo</span>
                    </div>
                    <div className="divide-y divide-purple-50 bg-white">
                      {items.map((item, i) => (
                        <div key={i} className="grid grid-cols-[1fr_auto] gap-3 px-3 py-2 items-center">
                          <span className="text-sm text-ink-primary">{item.d || item.description}</span>
                          <span className="text-sm font-mono text-purple-700 text-right whitespace-nowrap">
                            {parseFloat(item.c ?? item.cost ?? 0) > 0
                              ? `$${parseFloat(item.c ?? item.cost ?? 0).toFixed(2)}`
                              : <span className="text-ink-muted text-xs">—</span>}
                          </span>
                        </div>
                      ))}
                    </div>
                    {total > 0 && (
                      <div className="flex justify-between px-3 py-2 bg-purple-50 border-t border-purple-100">
                        <span className="text-xs font-semibold text-purple-700">Total cargo</span>
                        <span className="text-sm font-bold text-purple-700">+${total.toFixed(2)}</span>
                      </div>
                    )}
                  </div>
                </div>
              )
            })()
          )}
        </div>

        {/* Acciones */}
        {(canEdit || canClose || canReopen) && (
          <div className="flex flex-wrap gap-2 px-6 pb-5">
            {canEdit && (
              <>
                <button onClick={onEdit} className="btn-secondary flex-1 justify-center"><IconEdit /> Editar</button>
                <button onClick={onCancel}
                  className="btn-secondary flex-1 justify-center text-status-danger hover:bg-status-danger/10 hover:border-status-danger/40">
                  <IconTrash /> Cancelar orden
                </button>
              </>
            )}
            {canClose && (
              <button onClick={onCloseOrder} className="btn-primary w-full justify-center">
                Cerrar orden
              </button>
            )}
            {canReopen && isAdmin && (
              <button onClick={onReopen} className="btn-secondary flex-1 justify-center">
                Reabrir orden
              </button>
            )}
          </div>
        )}
      </div>
    </div>,
    document.body
  )
}

// ─── Página principal ─────────────────────────────────────────────────────────
export default function ProduccionOrdenes() {
  const [showCreate,  setShowCreate]  = useState(false)
  const [editOrder,   setEditOrder]   = useState(null)
  const [detailOrder, setDetailOrder] = useState(null)
  const [filterStatus,setFilterStatus]= useState('')
  const queryClient = useQueryClient()

 const { data: queue = [], isLoading: loadingQueue } = useQuery({
    queryKey: ['production-queue'],
    queryFn: () => productionApi.getQueue(),
    refetchInterval: 30000,
  })

  // Conteo independiente de órdenes cumplidas (al 100%) — para mostrar
  // el badge rojo en la tab "Cumplidas" y que el supervisor las vea
  // sin tener que hacer click.
  const { data: fulfilledData } = useQuery({
    queryKey: ['production-orders-fulfilled-count'],
    queryFn: () => productionApi.listOrders({ status: 'fulfilled', limit: 100 }),
    refetchInterval: 30000,
  })
  const fulfilledCount = fulfilledData?.data?.length || 0

  const { data: allOrders, isLoading: loadingAll } = useQuery({
    queryKey: ['production-orders', filterStatus],
    queryFn: () => productionApi.listOrders({ status: filterStatus||undefined, limit:100 }),
    enabled: filterStatus !== '',
  })

  // Estado para el flujo "liberar con stock bajo" — modal de razón
  const [lowStockModal, setLowStockModal] = useState(null) // { order, availability }

  const releaseMutation = useMutation({
    mutationFn: ({ id, reason }) => productionApi.releaseOrder(id, reason ? { lowStockOverrideReason: reason } : undefined),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey:['production-queue'] })
      queryClient.invalidateQueries({ queryKey:['production-orders'] })
      queryClient.invalidateQueries({ queryKey:['production-orders', filterStatus] })
      setLowStockModal(null)
      setFilterStatus('')  // volver a Cola activa donde aparecerá la orden liberada
    },
  })

  // Pre-check de stock antes de liberar. Si OK → libera directo. Si no → modal con razón.
  const tryRelease = async (order) => {
    try {
      const availability = await productionApi.getStockAvailability(order.id)
      if (availability.ok) {
        releaseMutation.mutate({ id: order.id })
      } else {
        setLowStockModal({ order, availability })
      }
    } catch (err) {
      // Si el endpoint falla, intentamos liberar directo (el backend revalidará).
      releaseMutation.mutate({ id: order.id })
    }
  }

  const priorityMutation = useMutation({
    mutationFn: ({ id, priority }) => productionApi.updatePriority(id, { priority }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey:['production-queue'] }),
  })

  const cancelMutation = useMutation({
    mutationFn: (id) => productionApi.cancelOrder(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey:['production-queue'] })
      queryClient.invalidateQueries({ queryKey:['production-orders'] })
      queryClient.invalidateQueries({ queryKey:['production-orders', filterStatus] })
      setDetailOrder(null)
      setFilterStatus('')
    },
  })

  const [closingOrder, setClosingOrder] = useState(null)
  const [reopeningOrder, setReopeningOrder] = useState(null)
  const currentUser = useAuthStore((s) => s.user)

  const closeOrderMutation = useMutation({
    mutationFn: ({ id, reason }) => productionApi.closeOrder(id, { reason }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey:['production-queue'] })
      queryClient.invalidateQueries({ queryKey:['production-orders'] })
      queryClient.invalidateQueries({ queryKey:['production-orders', filterStatus] })
      setClosingOrder(null)
      setDetailOrder(null)
    },
  })

  const reopenOrderMutation = useMutation({
    mutationFn: ({ id, reason }) => productionApi.reopenOrder(id, { reason }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey:['production-queue'] })
      queryClient.invalidateQueries({ queryKey:['production-orders'] })
      queryClient.invalidateQueries({ queryKey:['production-orders', filterStatus] })
      setReopeningOrder(null)
      setDetailOrder(null)
    },
  })

  async function openDetail(order) {
    const full = await productionApi.getOrder(order.id)
    setDetailOrder(full)
  }

  const activeQueue = filterStatus === '' ? queue : (allOrders?.data || [])
  const isLoading   = filterStatus === '' ? loadingQueue : loadingAll

  return (
    <div className="page-enter">
      <div className="page-header">
        <div>
          <h1 className="page-title">Cola de producción</h1>
          <p className="page-subtitle">
            {queue.length} orden{queue.length!==1?'es':''} activas ·{' '}
            {queue.reduce((s,o)=>s+parseInt(o.quantity_units||0),0).toLocaleString('es-MX')} piezas totales
          </p>
        </div>
        <Can do="production:manage">
          <button className="btn-primary" onClick={() => setShowCreate(true)}>
            <IconPlus /> Nueva orden
          </button>
        </Can>
      </div>

      {/* Filtros */}
      <div className="flex gap-2 mb-5 flex-wrap">
        {[
          {value:'',label:'Cola activa'},
          {value:'fulfilled',label:'Cumplidas', showBadge:true},
          {value:'draft',label:'Borradores'},
          {value:'completed',label:'Completadas'},
          {value:'cancelled',label:'Canceladas'},
        ].map(f => (
          <button key={f.value} onClick={() => setFilterStatus(f.value)}
            className={clsx('px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors inline-flex items-center gap-1.5',
              filterStatus===f.value ? 'bg-brand-600 text-white border-brand-600' : 'bg-surface-primary border-line-subtle text-ink-secondary hover:bg-surface-elevated/40')}>
            {f.label}
            {f.showBadge && fulfilledCount > 0 && (
              <span className={clsx(
                'inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full text-[10px] font-bold',
                filterStatus===f.value ? 'bg-surface-primary text-status-danger' : 'bg-red-500 text-white'
              )}>
                {fulfilledCount}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Cola */}
      {isLoading ? (
        <div className="flex justify-center py-16"><Spinner /></div>
      ) : activeQueue.length === 0 ? (
        <div className="empty-state">
          <p className="font-medium text-ink-secondary">Sin órdenes</p>
          <p>Crea una orden y libérala para que aparezca en la cola.</p>
        </div>
      ) : (
        <div className="space-y-2.5">
          {activeQueue.map((order, idx) => {
            const prio    = PRIORITY_COLOR[order.priority] || PRIORITY_COLOR.normal
            const pct     = parseFloat(order.progress_pct || 0)
            const isActive= order.status === 'in_progress'

            return (
              <div key={order.id}
                style={{ borderLeftColor: prio.border }}
                className={clsx('bg-surface-primary border border-line-subtle rounded-xl p-4 border-l-4',
                  isActive && 'bg-status-info/10 border-status-info/40')}>
                <div className="flex items-center gap-3 mb-2.5 flex-wrap sm:flex-nowrap">
                  <div className="w-6 h-6 rounded-full bg-surface-elevated/60 border border-line-subtle flex items-center justify-center text-[11px] font-medium text-ink-muted shrink-0">
                    {idx+1}
                  </div>
                  <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full shrink-0"
                    style={{ background: isActive ? '#E6F1FB' : prio.bg, color: isActive ? '#0C447C' : prio.text }}>
                    {isActive ? 'En producción' : prio.label}
                  </span>
                  <span className="font-medium text-ink-primary flex-1 text-sm break-words min-w-0 sm:truncate basis-full sm:basis-0 order-3 sm:order-none inline-flex items-center gap-1.5 flex-wrap">
                    {order.product_name}{order.length_mm ? ` · ${(order.length_mm/1000).toFixed(2)}m` : ''}
                    {order.custom_attributes && Object.keys(order.custom_attributes).length > 0 && (
                      <span className="inline-flex items-center gap-0.5 text-[10px] font-semibold px-1.5 py-0.5 bg-purple-100 text-purple-700 rounded-full shrink-0">
                        <IconStar /> Personalizado
                      </span>
                    )}
                  </span>
                  <span className="text-xs font-mono text-ink-muted shrink-0">{order.order_number}</span>
                </div>

                <div className="flex items-center gap-3 mb-2.5">
                  <span className="text-xs text-ink-muted w-28 shrink-0">
                    {parseInt(order.units_produced||0).toLocaleString('es-MX')} / {parseInt(order.quantity_units||0).toLocaleString('es-MX')} pzas
                  </span>
                  <div className="flex-1 h-1.5 bg-surface-elevated/60 rounded-full overflow-hidden">
                    <div className="h-full rounded-full transition-all"
                      style={{ width:`${pct}%`, background: isActive ? '#378ADD' : prio.bar }} />
                  </div>
                  <span className="text-xs font-medium w-10 text-right shrink-0"
                    style={{ color: isActive ? '#0C447C' : prio.text }}>{pct.toFixed(0)}%</span>
                </div>

                <div className="flex items-center gap-3 flex-wrap">
                  {order.delivery_date && (
                    <span className="text-xs text-ink-muted">
                      Entrega: {new Date(order.delivery_date).toLocaleDateString('es-MX',{day:'numeric',month:'short'})}
                    </span>
                  )}
                  {order.blended_cost_per_kg && (
                    <span className="text-xs text-ink-muted">
                      Mezcla: ${parseFloat(order.blended_cost_per_kg).toFixed(2)}/kg
                    </span>
                  )}

                  {/* Acciones */}
                  <div className="ml-auto flex items-center gap-1.5">
                    {/* Ver detalle */}
                    <button onClick={() => openDetail(order)}
                      className="btn-ghost btn-icon btn-sm text-ink-muted hover:text-brand-300" title="Ver detalle">
                      <IconInfo />
                    </button>

                    {order.status === 'draft' && (
                      <button onClick={() => tryRelease(order)}
                        disabled={releaseMutation.isPending}
                        className="btn-secondary btn-sm inline-flex items-center gap-1">
                        <IconPlay /> Liberar
                      </button>
                    )}

                    {/* Cambio rápido de prioridad */}
                    {order.status !== 'draft' && (
                      <>
                        <span className="text-xs text-ink-muted">Prioridad:</span>
                        {Object.entries(PRIORITY_COLOR).map(([key, c]) => (
                          <button key={key} type="button"
                            onClick={() => priorityMutation.mutate({ id:order.id, priority:key })}
                            style={order.priority===key ? { background:c.bg, color:c.text, borderColor:c.border } : {}}
                            className={clsx('px-2 py-0.5 rounded text-[10px] font-medium border transition-colors',
                              order.priority===key ? '' : 'bg-surface-primary border-line-subtle text-ink-muted hover:bg-surface-elevated/40')}>
                            {c.label}
                          </button>
                        ))}
                      </>
                    )}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* Leyenda */}
      {filterStatus==='' && queue.length>0 && (
        <div className="flex gap-4 flex-wrap mt-4 pt-3 border-t border-line-subtle">
          {Object.entries(PRIORITY_COLOR).map(([key,c]) => (
            <div key={key} className="flex items-center gap-1.5">
              <div className="w-2.5 h-2.5 rounded-sm" style={{ background:c.bar }} />
              <span className="text-xs text-ink-muted">{c.label}</span>
            </div>
          ))}
          <div className="flex items-center gap-1.5">
            <div className="w-2.5 h-2.5 rounded-sm bg-blue-400" />
            <span className="text-xs text-ink-muted">En producción</span>
          </div>
        </div>
      )}

      {/* Modales */}
      {showCreate && <OrderModal onClose={() => setShowCreate(false)} />}
      {editOrder   && <OrderModal order={editOrder} onClose={() => setEditOrder(null)} />}
      {detailOrder && (
        <OrderDetailModal
          order={detailOrder}
          currentUser={currentUser}
          onClose={() => setDetailOrder(null)}
          onEdit={() => { setEditOrder(detailOrder); setDetailOrder(null) }}
          onCancel={() => {
            if (confirm(`¿Cancelar la orden ${detailOrder.order_number}? Esta acción no se puede deshacer.`)) {
              cancelMutation.mutate(detailOrder.id)
            }
          }}
          onCloseOrder={() => setClosingOrder(detailOrder)}
          onReopen={() => setReopeningOrder(detailOrder)}
        />
      )}

      {closingOrder && (
        <CloseOrderModal
          order={closingOrder}
          onClose={() => setClosingOrder(null)}
          onConfirm={(reason) => closeOrderMutation.mutate({ id: closingOrder.id, reason })}
          isPending={closeOrderMutation.isPending}
          error={closeOrderMutation.error?.response?.data?.error || closeOrderMutation.error?.message}
        />
      )}

      {reopeningOrder && (
        <ReopenOrderModal
          order={reopeningOrder}
          onClose={() => setReopeningOrder(null)}
          onConfirm={(reason) => reopenOrderMutation.mutate({ id: reopeningOrder.id, reason })}
          isPending={reopenOrderMutation.isPending}
          error={reopenOrderMutation.error?.response?.data?.error || reopenOrderMutation.error?.message}
        />
      )}

      {lowStockModal && (
        <LowStockReleaseModal
          order={lowStockModal.order}
          availability={lowStockModal.availability}
          onClose={() => setLowStockModal(null)}
          onConfirm={(reason) => releaseMutation.mutate({ id: lowStockModal.order.id, reason })}
          isPending={releaseMutation.isPending}
        />
      )}
    </div>
  )
}

function CloseOrderModal({ order, onClose, onConfirm, isPending, error }) {
  const [reason, setReason] = useState('')
  const target   = parseInt(order.quantity_packages || 0)
  const produced = parseInt(order.produced_units || 0)
  const isPartial = target > 0 && produced < target
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background:'rgba(17,24,39,0.55)' }}>
      <div className="card w-full max-w-md p-5 flex flex-col gap-4">
        <h2 className="text-base font-semibold text-ink-primary">Cerrar orden</h2>
        <div className="text-sm text-ink-secondary">
          <p className="mb-2"><strong>{order.order_number}</strong></p>
          <p className="text-xs text-ink-muted">{order.product_name} {order.length_mm ? `· ${(order.length_mm/1000).toFixed(2)}m` : ''}</p>
          {target > 0 && (<p className="text-xs text-ink-muted mt-1">Producido: {produced} / {target} piezas</p>)}
        </div>
        {isPartial && (<div className="bg-status-warning/10 border border-status-warning/40 rounded-lg p-3 text-sm text-status-warning">⚠️ Esta orden está incompleta. Se cerrará sin alcanzar el target original.</div>)}
        <div className="bg-status-danger/10 border border-status-danger/40 rounded-lg p-3 text-xs text-status-danger">Una vez cerrada, la orden NO admite más cambios: ni agregar paquetes, ni editar merma, ni cambiar fórmula. Para reabrir solo un admin puede hacerlo.</div>
        {error && (<div className="bg-status-danger/10 border border-status-danger/40 rounded-lg p-3 text-sm text-status-danger">{error}</div>)}
        <div>
          <label className="label">Razón {isPartial ? '* (obligatoria por cierre parcial)' : '(opcional)'}</label>
          <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} placeholder="Ej: Entrega parcial autorizada por cliente..." className="input h-auto py-2 resize-none" />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <button onClick={onClose} className="btn-secondary">Cancelar</button>
          <button onClick={() => onConfirm(reason.trim() || null)} disabled={isPending || (isPartial && !reason.trim())} className="btn-primary">{isPending ? '...' : 'Cerrar orden'}</button>
        </div>
      </div>
    </div>,
    document.body
  )
}

function ReopenOrderModal({ order, onClose, onConfirm, isPending, error }) {
  const [reason, setReason] = useState('')
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background:'rgba(17,24,39,0.55)' }}>
      <div className="card w-full max-w-md p-5 flex flex-col gap-4">
        <h2 className="text-base font-semibold text-ink-primary">Reabrir orden</h2>
        <div className="text-sm text-ink-secondary">
          <p><strong>{order.order_number}</strong></p>
          <p className="text-xs text-ink-muted">{order.product_name}</p>
        </div>
        <div className="bg-status-info/10 border border-status-info/40 rounded-lg p-3 text-xs text-status-info">La orden pasará nuevamente a estado <strong>in_progress</strong> o <strong>fulfilled</strong> (según el avance) y volverá a ser editable. Acción reservada para admins.</div>
        {error && (<div className="bg-status-danger/10 border border-status-danger/40 rounded-lg p-3 text-sm text-status-danger">{error}</div>)}
        <div>
          <label className="label">Razón *</label>
          <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} placeholder="Ej: Falta capturar último paquete del turno..." className="input h-auto py-2 resize-none" />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <button onClick={onClose} className="btn-secondary">Cancelar</button>
          <button onClick={() => onConfirm(reason.trim())} disabled={isPending || !reason.trim()} className="btn-primary">{isPending ? '...' : 'Reabrir'}</button>
        </div>
      </div>
    </div>,
    document.body
  )
}
