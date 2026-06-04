import { useState, useEffect, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useForm, Controller } from 'react-hook-form'
import { z } from 'zod'
import { zodResolver } from '@hookform/resolvers/zod'
import { productsApi } from '@/api/products'
import { processConfigApi } from '@/api/processConfig'
import Badge from '@/components/ui/Badge'
import Spinner from '@/components/ui/Spinner'
import InventoryLevelsPanel from '@/components/inventario/InventoryLevelsPanel'
import { ProductImageUploader } from '@/components/productos/ProductImageUploader'
import { useCodeSuggestion } from '@/hooks/useCodeSuggestion'
import { TechSheetsList } from '@/components/productos/TechSheetsList'
import { ProductThumbnail } from '@/components/productos/ProductThumbnail'
import { PendingImagePicker } from '@/components/productos/PendingImagePicker'
import { PendingSheetsPicker } from '@/components/productos/PendingSheetsPicker'
import { PendingInventoryLevel } from '@/components/productos/PendingInventoryLevel'
import { inventoryApi } from '@/api/inventory'
import Can from '@/components/auth/Can'
import SatUnitCombobox from '@/components/productos/SatUnitCombobox'
import SatProductCodeCombobox from '@/components/productos/SatProductCodeCombobox'
import IvaTreatmentSelect from '@/components/fiscal/IvaTreatmentSelect'
import clsx from 'clsx'

const SALE_UNITS = ['pieza', 'paquete', 'millar', 'rollo', 'caja', 'metro', 'kilogramo']

// Opciones de tipo de producto. El valor `corner_protector` es legacy del modelo
// específico de plástico. En tenants nuevos, el catálogo `tenant_product_kinds`
// reemplaza este enum, pero hasta que la migración esté completa coexisten.
// El selector solo muestra "Esquinero" si el tenant tiene un kind que lo respalde.
const TYPE_OPTS_BASE = [
  { value: 'corner_protector', label: 'Esquinero (fabricado)', hint: 'Lo produces internamente con receta y captura',
    requiresKind: ['corner_protector', 'esquinero'] },
  { value: 'resale',           label: 'Reventa',                hint: 'Lo compras a un proveedor para distribuir' },
]
const TYPE_LABEL   = { corner_protector: 'Esquinero', resale: 'Reventa' }
const TYPE_VARIANT = { corner_protector: 'blue', resale: 'amber' }

// ─── Schema ───────────────────────────────────────────────────────────────────
// `type` queda como dato legacy del modelo viejo (corner_protector | resale).
// El discriminador "se fabrica o no" ahora es `isProduced` (bool).
// Los campos de "metros lineales" (length, grams/m, etc.) son opcionales y
// solo se exigen como conjunto si el usuario activa la sección de medición
// lineal en el formulario — no por validación de schema.
const schema = z.object({
  type:            z.string().optional(),               // legacy, mantenemos compat
  isProduced:      z.boolean().optional(),
  productKindId:   z.string().uuid('Selecciona un tipo de producción').optional().or(z.literal('')).or(z.null()),
  sku:             z.string().min(1, 'Requerido').max(50),
  name:            z.string().min(2, 'Mínimo 2 caracteres').max(200),
  saleUnit:        z.string().min(1, 'Requerido'),
  // Mismo patrón que basePrice/gramsPerLinearMeter: acepta vacío/null. Sin esto,
  // z.coerce.number() convierte ''/null → 0 y .positive() falla → el submit se
  // bloqueaba en silencio (el campo está oculto en móvil `hidden sm:block`, así que
  // el error no se veía). El backend usa `unitsPerPackage || 50` → vacío es seguro.
  unitsPerPackage: z.union([z.coerce.number().int().positive(), z.literal(''), z.null()]).optional(),
  description:     z.string().optional().or(z.literal('')),
  satProductCode:  z.string().min(1, 'Requerido'),
  satUnitCode:     z.string().min(1, 'Requerido'),
  objetoImp:       z.string().min(1, 'Requerido'),
  taxFactor:       z.string().optional(),
  taxRate:         z.coerce.number().min(0).max(100).optional(),
  isActive:        z.boolean().optional(),
  leadTimeDays:    z.coerce.number().min(0).max(365).optional(),
  basePrice:       z.union([z.coerce.number().positive('Debe ser > 0'), z.literal('')]).optional(),
  baseCurrency:    z.enum(['MXN', 'USD']).optional(),

  // Campos opcionales del modelo lineal (esquineros, tubos, perfiles, etc.).
  // No son obligatorios — si el tenant no produce lineales, los deja vacíos.
  gramsPerLinearMeter: z.union([z.coerce.number().positive('Debe ser > 0'), z.literal(''), z.null()]).optional(),
  tolerancePct:        z.union([z.coerce.number().min(0.1).max(50), z.literal(''), z.null()]).optional(),
  qualityNotes:        z.string().optional().or(z.literal('')),
})

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
const IconBox = () => (
  <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M20.25 7.5l-.625 10.632a2.25 2.25 0 01-2.247 2.118H6.622a2.25 2.25 0 01-2.247-2.118L3.75 7.5M10 11.25h4M3.375 7.5h17.25c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125z"/>
  </svg>
)
const IconLock = () => (
  <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24">
    <path d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zM12 17c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2z"/>
  </svg>
)
const IconAlert = () => (
  <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24">
    <path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/>
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

function Section({ number, title, badge, children, className }) {
  return (
    <div className={clsx('border border-line-subtle rounded-xl overflow-hidden', className)}>
      <div className="flex items-center gap-2.5 px-4 py-3 bg-surface-elevated/40 border-b border-line-subtle">
        <span className="w-5 h-5 rounded-full bg-brand-600 text-white text-[10px] font-medium flex items-center justify-center shrink-0">
          {number}
        </span>
        <span className="text-sm font-medium text-ink-primary">{title}</span>
        {badge && (
          <span className="ml-auto text-[10px] px-2 py-0.5 rounded-full bg-brand-500/10 text-brand-300 font-medium">
            {badge}
          </span>
        )}
      </div>
      <div className="p-4 space-y-3">{children}</div>
    </div>
  )
}

// ─── Modal ────────────────────────────────────────────────────────────────────
function ProductModal({ product: initialProduct, cloneFrom = null, onClose }) {
  const queryClient  = useQueryClient()
  // Después de crear un producto nuevo, el modal NO se cierra: transiciona a
  // modo edición para que el usuario configure presentaciones (rollo, millar,
  // caja…) sin re-abrir el form. `savedProduct` arranca como `initialProduct`
  // (edición de un producto existente) o null (creación). Al guardar por
  // primera vez se popula con el row recién creado.
  const [savedProduct, setSavedProduct] = useState(initialProduct)
  const product = savedProduct
  const isEditing = !!product
  // Origen para pre-llenar: el producto en edición, o el que estamos DUPLICANDO.
  // Al clonar se copian todos los campos EXCEPTO el SKU (debe ser único) — el
  // usuario ajusta nombre, descripción y precio. isEditing sigue false → crea uno nuevo.
  const source = product || cloneFrom
  const isCloning = !product && !!cloneFrom
  // `justCreated` distingue "se acaba de crear en este modal" de "abriste el
  // modal directamente sobre un producto preexistente". Solo lo usamos para
  // mostrar el banner informativo y para decidir si tras un segundo submit
  // cerramos o seguimos.
  const justCreated = !initialProduct && !!savedProduct
  const codeSug      = useCodeSuggestion('product', { enabled: !isEditing })

  const {
    register,
    handleSubmit,
    control,
    watch,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm({
    resolver: zodResolver(schema),
    defaultValues: {
      type:            source?.type             || 'resale',
      isProduced:      source?.is_produced ?? (source?.type === 'corner_protector') ?? false,
      productKindId:   source?.product_kind_id  || '',
      // El SKU NO se copia al clonar (debe ser único): la sugerencia/usuario lo llena.
      sku:             product?.sku              || '',
      name:            source?.name             || '',
      saleUnit:        source?.sale_unit        || 'pieza',
      unitsPerPackage: source?.qualitySpec?.units_per_package ?? source?.units_per_package ?? null,
      description:     source?.description      || '',
      satProductCode:  source?.sat_product_code || '44102305',
      satUnitCode:     source?.sat_unit_code    || 'H87',
      objetoImp:       source?.objeto_imp       || '02',
      taxFactor:       source?.tax_factor       || 'Tasa',
      taxRate:         source?.tax_rate != null ? Number(source.tax_rate) : 16,
      // Un producto clonado nace activo (no se copia el is_active del origen).
      isActive:        product?.is_active        ?? true,
      leadTimeDays:    source?.lead_time_days   ?? 7,
      basePrice:       source?.base_price != null ? Number(source.base_price) : '',
      baseCurrency:    source?.base_currency    || 'MXN',
      // Campos del modelo lineal — vacíos por default. Si el origen ya tiene spec,
      // los precargamos para no perder datos (también al clonar).
      gramsPerLinearMeter: source?.qualitySpec?.grams_per_linear_meter
        ? parseFloat(source.qualitySpec.grams_per_linear_meter) : '',
      tolerancePct:        source?.qualitySpec?.tolerance_pct
        ? parseFloat(source.qualitySpec.tolerance_pct) : '',
      qualityNotes:        source?.qualitySpec?.notes || '',
    },
  })

  const watchLeadTime = watch('leadTimeDays')
  const watchIsProduced = watch('isProduced')

  // ¿El producto se mide en metros lineales? El usuario lo activa explícitamente
  // dentro de la sección "Especificaciones del producto". Auto-detectamos en
  // edición si el producto existente ya tiene length_mm o gramsPerLinearMeter
  // capturados (para no esconder datos guardados).
  const hasExistingLinearData =
    (source?.length_mm > 0)
    || !!source?.qualitySpec?.grams_per_linear_meter
  const [linealMode, setLinealMode] = useState(hasExistingLinearData)
  const [specsExpanded, setSpecsExpanded] = useState(hasExistingLinearData)

  // Modo 'auto' de la nomenclatura: pre-llenar el SKU al abrir el form en creación.
  useEffect(() => {
    if (!isEditing && codeSug.isAuto && codeSug.code && !watch('sku')) {
      setValue('sku', codeSug.code, { shouldDirty: false, shouldValidate: true })
    }
  }, [codeSug.isAuto, codeSug.code, isEditing])

  // Cargar catálogo de product_kinds del tenant para filtrar el selector de tipo.
  // Si el tenant no tiene un kind con código "corner_protector" o "esquinero",
  // ocultamos esa opción (el tenant no produce esquineros).
  const { data: kindsRaw } = useQuery({
    queryKey: ['product-kinds-active'],
    queryFn:  () => processConfigApi.listProductKinds({ isActive: true }),
    staleTime: 300000,
  })
  const productKinds = Array.isArray(kindsRaw) ? kindsRaw : (kindsRaw?.data || [])
  const TYPE_OPTS = TYPE_OPTS_BASE.filter(opt => {
    if (!opt.requiresKind) return true                          // 'resale' siempre disponible
    if (productKinds.length === 0) return true                  // tenants viejos: mantener compat
    return productKinds.some(k =>
      opt.requiresKind.includes(String(k.code || '').toLowerCase())
    )
  })

  // ── Stash para modo creación: assets que se suben tras crear el producto.
  const [pendingImage, setPendingImage]   = useState(null)
  const [pendingSheets, setPendingSheets] = useState([])
  const [pendingLevel, setPendingLevel]   = useState({
    warehouseId: null, minStock: '', maxStock: '', reorderPoint: '', safetyStock: '',
  })
  const [uploadProgress, setUploadProgress] = useState(null) // string|null

  const mutation = useMutation({
    mutationFn: async (data) => {
      const payload = {
        ...data,
        // type queda como dato legacy. Lo derivamos del flag para mantener
        // compatibilidad con código viejo: produced→corner_protector, no→resale.
        type: data.isProduced ? 'corner_protector' : 'resale',
        isProduced: !!data.isProduced,
        // El kind solo aplica si el producto se fabrica. Si el usuario lo
        // deselecciona o no aplica, enviamos null para que el backend lo borre.
        productKindId: data.isProduced && data.productKindId ? data.productKindId : null,
      }
      // Las specs de calidad ya no se gestionan desde este formulario.
      // Se editan en Producción → Especificaciones (versión por versión).
      delete payload.gramsPerLinearMeter
      delete payload.tolerancePct
      delete payload.qualityNotes

      // 1) Guardar producto (create o update)
      setUploadProgress(isEditing ? null : 'Creando producto…')
      const productResult = isEditing
        ? await productsApi.update(product.id, payload)
        : await productsApi.create(payload)

      const productId = productResult?.id || product?.id

      // 3) Modo creación: subir assets pendientes contra el ID nuevo.
      //    Estos uploads van fuera de transacción — si alguno falla, el
      //    producto ya quedó creado pero el operador puede reintentar
      //    desde el modo edición.
      if (!isEditing && productId) {
        if (pendingImage) {
          setUploadProgress('Subiendo imagen…')
          try {
            await productsApi.uploadAttachment(productId, pendingImage, 'image')
          } catch (e) {
            // Loguear pero seguir — el producto ya está creado
            console.warn('Imagen falló:', e.message)
          }
        }
        for (let i = 0; i < pendingSheets.length; i++) {
          setUploadProgress(`Subiendo ficha ${i + 1}/${pendingSheets.length}…`)
          try {
            await productsApi.uploadAttachment(productId, pendingSheets[i], 'technical_sheet')
          } catch (e) {
            console.warn(`Ficha ${pendingSheets[i].name} falló:`, e.message)
          }
        }
        if (pendingLevel.warehouseId && (pendingLevel.minStock !== '' || pendingLevel.reorderPoint !== '')) {
          setUploadProgress('Guardando niveles de inventario…')
          try {
            await inventoryApi.upsertLevel('product', productId, pendingLevel.warehouseId, {
              minStock:             parseFloat(pendingLevel.minStock || 0),
              maxStock:             pendingLevel.maxStock !== '' ? parseFloat(pendingLevel.maxStock) : null,
              reorderPoint:         parseFloat(pendingLevel.reorderPoint || 0),
              safetyStock:          parseFloat(pendingLevel.safetyStock || 0),
              isManualReorderPoint: true,
            })
          } catch (e) {
            console.warn('Niveles fallaron:', e.message)
          }
        }
      }

      setUploadProgress(null)
      return productResult
    },
    onSuccess: (productResult) => {
      queryClient.invalidateQueries({ queryKey: ['products'] })
      // base_price afecta la columna "Precio base" de Precios por cliente
      queryClient.invalidateQueries({ queryKey: ['customer-prices'] })
      queryClient.invalidateQueries({ queryKey: ['customer-prices-summary'] })
      queryClient.invalidateQueries({ queryKey: ['inv-levels'] })
      queryClient.invalidateQueries({ queryKey: ['inv-levels-summary'] })
      // Si era una creación nueva (no había producto previo), no cerramos:
      // transicionamos a modo edición para que el usuario pueda configurar
      // presentaciones de venta (rollo, millar, caja…). En cualquier guardado
      // posterior cerramos como antes.
      if (!savedProduct) {
        setSavedProduct(productResult)
      } else {
        onClose()
      }
    },
    onError: () => setUploadProgress(null),
  })

  // Borrado (solo admin). El backend rechaza con 409 si tiene movimientos.
  const deleteMut = useMutation({
    mutationFn: () => productsApi.remove(product.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['products'] })
      onClose()
    },
  })

  const serverError = mutation.error?.response?.data?.error
    || deleteMut.error?.response?.data?.error

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto"
      style={{ background: 'rgba(17,24,39,0.55)' }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div
        className="relative w-full max-w-2xl my-8 mx-4 bg-surface-primary rounded-2xl shadow-card"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-line-subtle">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-base font-semibold text-ink-primary">
                {isEditing ? 'Editar producto' : isCloning ? 'Duplicar producto' : 'Nuevo producto'}
              </h2>
            </div>
            <p className="text-xs text-ink-muted mt-0.5">
              {isEditing
                ? `${product.sku} — ${product.is_produced ? 'Se fabrica internamente' : 'Producto de reventa'}`
                : isCloning
                  ? `Copia de ${cloneFrom.sku} — ajusta SKU, nombre, descripción y precio`
                  : 'Captura SKU, datos fiscales y unidad de venta'}
            </p>
          </div>
          <button type="button" onClick={onClose} className="btn-ghost btn-icon">
            <IconX />
          </button>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit((d) => mutation.mutate(d))} className="px-6 py-5 space-y-4">

          {/* Aviso de captura rápida — solo en móvil */}
          <div className="sm:hidden rounded-lg bg-status-info/10 border border-status-info/30 px-3 py-2 text-xs text-status-info flex items-start gap-2">
            <span className="text-sm leading-none mt-0.5">⚡</span>
            <span><strong>Captura rápida.</strong> Registra lo esencial (incluida la clave SAT para facturar). El precio, presentaciones, imagen y demás se completan en la versión de escritorio.</span>
          </div>

          {justCreated && (
            <div className="px-4 py-3 rounded-xl border border-status-success/40 bg-status-success/10 text-sm text-status-success flex items-start gap-2.5">
              <span className="text-base leading-none mt-0.5">✓</span>
              <div className="flex-1">
                <p className="font-semibold">Producto creado.</p>
                <p className="text-[12px] text-status-success/90 leading-tight mt-0.5">
                  Configura las <strong>Presentaciones de venta</strong> abajo (sección 2b) si el producto se vende en varias unidades distintas a su unidad base — por ejemplo: rollo, millar, caja. Cuando termines, cierra el modal.
                </p>
              </div>
            </div>
          )}

          {/* ── 1. Datos generales ── */}
          <Section number="1" title="Datos generales" badge="requerido">
            {/* Checkbox is_produced: ¿este producto se fabrica internamente o solo se compra para reventa? */}
            <Controller name="isProduced" control={control} render={({ field }) => (
              <label className={clsx(
                'flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors',
                field.value
                  ? 'bg-brand-500/10 border-brand-500/40'
                  : 'bg-surface-primary border-line-subtle hover:bg-surface-elevated/40',
                isEditing && 'cursor-default'
              )}>
                <input type="checkbox"
                  checked={!!field.value}
                  onChange={e => !isEditing && field.onChange(e.target.checked)}
                  disabled={isEditing}
                  className="w-4 h-4 accent-brand-600 mt-0.5" />
                <span className="flex-1">
                  <span className={clsx('block text-sm font-medium',
                    field.value ? 'text-brand-300' : 'text-ink-primary')}>
                    Este producto se fabrica internamente
                  </span>
                  <span className="block text-[11px] text-ink-muted mt-0.5">
                    {field.value
                      ? 'Aparece en órdenes de producción y necesita receta de MP.'
                      : 'Solo se compra a proveedor para reventa — no genera órdenes de producción.'}
                  </span>
                  {isEditing && <span className="block text-[10px] text-ink-muted mt-1 italic">No se puede cambiar después de crear.</span>}
                </span>
              </label>
            )} />
            {errors.isProduced && <p className="field-error">{errors.isProduced.message}</p>}

            {/* Selector de tipo de producción (product_kind). Solo aparece si:
                - El producto se fabrica (isProduced=true), y
                - El tenant tiene al menos un kind configurado en su catálogo.
                Cada kind puede definir un capture_schema que dispara campos
                dinámicos en la captura de producción. */}
            {watchIsProduced && productKinds.length > 0 && (
              <Field label="Tipo de producción" required={watchIsProduced}
                error={errors.productKindId?.message}
                hint="Define qué se captura por paquete en producción (campos dinámicos).">
                <select {...register('productKindId')}
                  className={clsx('select', errors.productKindId && 'input-error')}>
                  <option value="">— Selecciona —</option>
                  {productKinds.map(k => (
                    <option key={k.id} value={k.id}>
                      {k.name}{k.code ? ` (${k.code})` : ''}
                    </option>
                  ))}
                </select>
              </Field>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <Field label="SKU" required error={errors.sku?.message}
                hint={!isEditing
                  ? (codeSug.canSuggest ? `Sugerencia: ${codeSug.code}` : 'No se puede cambiar después')
                  : undefined}>
                <div className="flex gap-2">
                  <input
                    {...register('sku')}
                    disabled={isEditing || codeSug.isAuto}
                    placeholder={codeSug.placeholder || 'REV-001'}
                    className={clsx('input flex-1',
                      (isEditing || codeSug.isAuto) && 'bg-surface-elevated/40 cursor-not-allowed',
                      errors.sku && 'input-error')}
                  />
                  {!isEditing && codeSug.canSuggest && (
                    <button type="button" onClick={() => setValue('sku', codeSug.code, { shouldDirty: true, shouldValidate: true })}
                      className="btn-secondary btn-sm shrink-0 whitespace-nowrap"
                      title={`Sugerir ${codeSug.code}`}>
                      ↻ Sugerir
                    </button>
                  )}
                </div>
              </Field>
              <Field label="Nombre" required error={errors.name?.message} className="sm:col-span-2">
                <input
                  {...register('name')}
                  placeholder="Nombre del producto"
                  className={clsx('input', errors.name && 'input-error')}
                />
              </Field>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Field label="Unidad de venta" required error={errors.saleUnit?.message}>
                <select {...register('saleUnit')} className={clsx('select', errors.saleUnit && 'input-error')}>
                  {SALE_UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
                </select>
              </Field>
              <Field label="Unidades por empaque"
                error={errors.unitsPerPackage?.message}
                hint="Cuántas piezas vienen por paquete (opcional)"
                className="hidden sm:block">
                <input {...register('unitsPerPackage')} type="number" min="1"
                  className={clsx('input', errors.unitsPerPackage && 'input-error')}
                  placeholder="1" />
              </Field>
            </div>

            <Field label="Descripción" hint="Opcional — aparece en cotizaciones y facturas" className="hidden sm:block">
              <textarea {...register('description')} rows={2}
                placeholder="Descripción para documentos..."
                className="input h-auto py-2 resize-none" />
            </Field>
          </Section>

          {/* ── 1b. Especificaciones del producto (colapsable — solo si aplica) ── */}
          <section className="rounded-xl border border-line-subtle overflow-hidden hidden sm:block">
            <button
              type="button"
              onClick={() => setSpecsExpanded(v => !v)}
              className="w-full px-4 py-3 flex items-center justify-between bg-surface-elevated/40 hover:bg-surface-elevated/60 transition-colors"
            >
              <div className="text-left">
                <p className="text-sm font-medium text-ink-primary">Dimensiones del producto (opcional)</p>
                <p className="text-[11px] text-ink-muted mt-0.5">
                  Si vendes/produces este producto por metros lineales (esquineros, tubos, perfiles), captura su largo aquí.
                  Las especificaciones de calidad (peso/m, tolerancia) se gestionan en{' '}
                  <span className="text-brand-300">Producción → Especificaciones</span>.
                </p>
              </div>
              <svg className={clsx('w-4 h-4 text-ink-muted transition-transform shrink-0', specsExpanded && 'rotate-180')}
                fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7"/>
              </svg>
            </button>

            {specsExpanded && (
              <div className="p-4 space-y-3 border-t border-line-subtle">
                <p className="text-xs text-ink-muted leading-relaxed">
                  Los campos de calidad (gramos por metro, tolerancia, piezas por paquete) se configuran ahora
                  desde <strong>Producción → Especificaciones</strong>. Ahí también puedes ver el historial
                  de versiones de cada especificación.
                </p>
                <p className="text-[11px] text-ink-muted leading-snug italic">
                  ⓘ Si quieres que un producto aparezca como "lineal" en la pantalla de Especificaciones,
                  asegúrate de capturar su <strong>largo (length_mm)</strong> en su ficha — la pantalla detecta
                  qué productos son lineales basándose en este campo.
                </p>
              </div>
            )}
          </section>

          {/* ── 1c. Imagen y fichas técnicas ── */}
          <Section number="1c" title="Imagen y fichas técnicas" badge="catálogo enriquecido" className="hidden sm:block">
            {isEditing ? (
              <>
                <ProductImageUploader
                  productId={product.id}
                  imageAttachmentId={product.image_attachment_id}
                />
                <div className="border-t border-line-subtle pt-3">
                  <TechSheetsList productId={product.id} />
                </div>
              </>
            ) : (
              <>
                <PendingImagePicker value={pendingImage} onChange={setPendingImage} />
                <div className="border-t border-line-subtle pt-3">
                  <PendingSheetsPicker value={pendingSheets} onChange={setPendingSheets} />
                </div>
              </>
            )}
            <p className="text-[11px] text-ink-muted mt-1">
              ⓘ La imagen aparece como miniatura en el listado y en cotizaciones.
              Las fichas técnicas son visibles desde aquí — útiles para tu equipo de ventas.
            </p>
          </Section>

          {/* ── 2. Precio base ── */}
          <Section number="2" title="Precio base de lista" badge="opcional" className="hidden sm:block">
            <div className="grid grid-cols-[1fr_auto] gap-2 items-end">
              <Field label="Precio"
                error={errors.basePrice?.message}
                hint="Precio default si el cliente no tiene precio especial.">
                <input {...register('basePrice')} type="number" step="0.01" min="0"
                  placeholder="0.00"
                  className={clsx('input', errors.basePrice && 'input-error')} />
              </Field>
              <Field label="Moneda">
                <select {...register('baseCurrency')} className="select w-24">
                  <option value="MXN">MXN</option>
                  <option value="USD">USD</option>
                </select>
              </Field>
            </div>
            <p className="text-[11px] text-ink-muted mt-2 leading-tight">
              ⓘ Los precios negociados por cliente se gestionan en la página{' '}
              <strong>Comercial → Precios por cliente</strong>.
            </p>
          </Section>

          {/* ── 2c. Presentaciones de venta ── */}
          {isEditing && (
            <Section number="2b" title="Presentaciones de venta" badge="cómo se vende y factura" className="hidden sm:block">
              <PackOptionsEditor product={product} />
            </Section>
          )}

          {/* ── 3. Datos SAT ── */}
          <Section number="3" title="Datos SAT para facturación" badge="requerido para timbrar">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <Field label="Clave producto SAT" required error={errors.satProductCode?.message}
                hint="Catálogo c_ClaveProdServ. Busca por código (ej. 50202200) o por nombre (ej. palomitas).">
                <SatProductCodeCombobox
                  value={watch('satProductCode')}
                  onChange={v => setValue('satProductCode', v, { shouldValidate: true, shouldDirty: true })}
                  error={!!errors.satProductCode}
                />
              </Field>
              <Field label="Clave unidad SAT" required error={errors.satUnitCode?.message}
                hint="Busca por código (ej. KGM) o por nombre (ej. kilo). Acepta cualquier clave del catálogo SAT.">
                <SatUnitCombobox
                  value={watch('satUnitCode')}
                  onChange={v => setValue('satUnitCode', v, { shouldValidate: true, shouldDirty: true })}
                  error={!!errors.satUnitCode}
                />
              </Field>
              <Field label="Tratamiento de IVA" required error={errors.objetoImp?.message}
                hint="Define el IVA que llevará este producto al facturarse. Productos del campo (aguacate, caña) suelen ser 0%.">
                <IvaTreatmentSelect
                  objetoImp={watch('objetoImp')}
                  taxFactor={watch('taxFactor')}
                  taxRate={watch('taxRate')}
                  onChange={({ objetoImp, taxFactor, taxRate }) => {
                    setValue('objetoImp', objetoImp, { shouldDirty: true })
                    setValue('taxFactor', taxFactor, { shouldDirty: true })
                    setValue('taxRate',   taxRate,   { shouldDirty: true })
                  }}
                  error={!!errors.objetoImp}
                />
              </Field>
            </div>
          </Section>

          {/* ── 4. Niveles de inventario y reposición ── */}
          <Section number="4" title="Niveles de inventario y reposición" className="hidden sm:block">
            {isEditing ? (
              <InventoryLevelsPanel
                itemType="product"
                itemId={product?.id}
                leadTimeDays={watchLeadTime}
                onLeadTimeChange={(v) => setValue('leadTimeDays', v, { shouldDirty: true })}
                unit="pza"
              />
            ) : (
              <PendingInventoryLevel
                itemType="product" unit="pza"
                value={pendingLevel} onChange={setPendingLevel}
              />
            )}
          </Section>

          {/* ── Estado (solo edición) ── */}
          {isEditing && (
            <label className="flex items-center gap-3 px-4 py-3 bg-surface-elevated/40 rounded-xl border border-line-subtle cursor-pointer">
              <input type="checkbox" {...register('isActive')} className="w-4 h-4 accent-brand-600" />
              <span className="text-sm text-ink-secondary">
                Producto activo — aparece en órdenes de venta y compra
              </span>
            </label>
          )}

          {serverError && (
            <div className="px-4 py-3 bg-status-danger/10 border border-status-danger/40 rounded-xl text-sm text-status-danger">
              {serverError}
            </div>
          )}

          <div className="flex items-center justify-between gap-3 pt-2 border-t border-line-subtle">
            <div>
              {isEditing && (
                <Can do="products:delete">
                  <button type="button" disabled={deleteMut.isPending || isSubmitting}
                    onClick={() => {
                      if (confirm(`¿Eliminar el producto "${product.name}"?\n\nSolo se puede si no tiene movimientos asociados. Esta acción no se puede deshacer.`)) {
                        deleteMut.mutate()
                      }
                    }}
                    className="btn-ghost text-status-danger hover:bg-status-danger/10 disabled:opacity-50">
                    {deleteMut.isPending ? <Spinner className="w-4 h-4" /> : 'Eliminar'}
                  </button>
                </Can>
              )}
            </div>
            <div className="flex gap-3">
              <button type="button" onClick={onClose} className="btn-secondary" disabled={isSubmitting}>
                {justCreated ? 'Cerrar' : 'Cancelar'}
              </button>
              <button type="submit" disabled={isSubmitting} className="btn-primary">
                {isSubmitting && <Spinner className="w-4 h-4" />}
                {uploadProgress || (isEditing ? 'Guardar cambios' : 'Crear producto')}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>,
    document.body
  )
}

// ─── Editor de presentaciones (rollo, millar, caja...) ──────────────────────
function PackOptionsEditor({ product }) {
  const qc = useQueryClient()
  const { data: options = [], isLoading } = useQuery({
    queryKey: ['pack-options', product.id],
    queryFn:  () => productsApi.listPackOptions(product.id),
  })

  const [newRow, setNewRow] = useState({ packUnit: '', basePerPack: '', satUnitCode: 'H87' })
  const [editingId, setEditingId] = useState(null)
  const [editRow, setEditRow]     = useState({ packUnit: '', basePerPack: '', satUnitCode: '' })
  const [error, setError]   = useState(null)

  const invalidate = () => qc.invalidateQueries({ queryKey: ['pack-options', product.id] })

  const addMut = useMutation({
    mutationFn: () => productsApi.addPackOption(product.id, {
      packUnit:    newRow.packUnit.trim(),
      basePerPack: parseFloat(newRow.basePerPack),
      satUnitCode: newRow.satUnitCode,
      isDefault:   options.length === 0,
    }),
    onSuccess: () => { invalidate(); setNewRow({ packUnit: '', basePerPack: '', satUnitCode: 'H87' }); setError(null) },
    onError: (e) => setError(e.response?.data?.error || e.message),
  })

  const setDefaultMut = useMutation({
    mutationFn: (id) => productsApi.updatePackOption(product.id, id, { isDefault: true }),
    onSuccess: invalidate,
  })

  // Editar una presentación existente (incluida la default).
  const editMut = useMutation({
    mutationFn: () => productsApi.updatePackOption(product.id, editingId, {
      packUnit:    editRow.packUnit.trim(),
      basePerPack: parseFloat(editRow.basePerPack),
      satUnitCode: editRow.satUnitCode.trim().toUpperCase(),
    }),
    onSuccess: () => { invalidate(); setEditingId(null); setError(null) },
    onError: (e) => setError(e.response?.data?.error || e.message),
  })

  function startEdit(opt) {
    setError(null)
    setEditingId(opt.id)
    setEditRow({ packUnit: opt.pack_unit, basePerPack: String(opt.base_per_pack), satUnitCode: opt.sat_unit_code })
  }
  function saveEdit() {
    if (!editRow.packUnit.trim()) return setError('Captura el nombre de la unidad.')
    if (!editRow.basePerPack || parseFloat(editRow.basePerPack) <= 0) return setError('Captura cuántas unidades base contiene.')
    editMut.mutate()
  }

  const deleteMut = useMutation({
    mutationFn: (id) => productsApi.deletePackOption(product.id, id),
    onSuccess: invalidate,
    onError: (e) => setError(e.response?.data?.error || e.message),
  })

  function submitNew() {
    setError(null)
    if (!newRow.packUnit.trim()) return setError('Captura el nombre de la unidad.')
    if (!newRow.basePerPack || parseFloat(newRow.basePerPack) <= 0) return setError('Captura cuántas unidades base contiene.')
    addMut.mutate()
  }

  const baseUnit = product?.base_unit || 'unidad'

  return (
    <div className="space-y-3">
      <p className="text-xs text-ink-muted -mt-1">
        Define las formas de vender este producto. Inventario se lleva en <strong>{baseUnit}</strong>;
        cada presentación dice cuántas <strong>{baseUnit}</strong> contiene.
      </p>

      {isLoading ? (
        <div className="flex justify-center py-4"><Spinner /></div>
      ) : options.length > 0 ? (
        <div className="border border-line-subtle rounded-lg overflow-hidden">
          <table className="table text-xs">
            <thead>
              <tr>
                <th>Presentación</th>
                <th className="text-right">Contiene</th>
                <th>Clave SAT</th>
                <th className="text-center">Default</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {options.map(opt => {
                const isEd = editingId === opt.id
                return (
                <tr key={opt.id}>
                  <td className="font-medium text-ink-primary">
                    {isEd ? (
                      <input className="input text-xs py-1" value={editRow.packUnit}
                        onChange={e => setEditRow(r => ({ ...r, packUnit: e.target.value }))} />
                    ) : opt.pack_unit}
                  </td>
                  <td className="text-right font-mono tabular-nums">
                    {isEd ? (
                      <input className="input text-xs py-1 text-right w-24" type="number" step="0.01" min="0"
                        value={editRow.basePerPack}
                        onChange={e => setEditRow(r => ({ ...r, basePerPack: e.target.value }))} />
                    ) : <>{Number(opt.base_per_pack).toLocaleString('es-MX')} {baseUnit}</>}
                  </td>
                  <td className="font-mono text-ink-muted">
                    {isEd ? (
                      <SatUnitCombobox
                        value={editRow.satUnitCode}
                        onChange={v => setEditRow(r => ({ ...r, satUnitCode: v }))}
                      />
                    ) : opt.sat_unit_code}
                  </td>
                  <td className="text-center">
                    {opt.is_default ? (
                      <span className="text-[10px] font-bold uppercase tracking-wide bg-brand-500/15 text-brand-300 px-1.5 py-0.5 rounded">Default</span>
                    ) : (
                      <button type="button" onClick={() => setDefaultMut.mutate(opt.id)}
                        className="text-[10px] text-brand-300 hover:underline">marcar</button>
                    )}
                  </td>
                  <td className="text-right whitespace-nowrap">
                    {isEd ? (
                      <div className="flex items-center gap-2 justify-end">
                        <button type="button" onClick={saveEdit} disabled={editMut.isPending}
                          className="text-[10px] font-semibold text-brand-300 hover:underline">Guardar</button>
                        <button type="button" onClick={() => { setEditingId(null); setError(null) }}
                          className="text-[10px] text-ink-muted hover:underline">Cancelar</button>
                      </div>
                    ) : (
                      <div className="flex items-center gap-2 justify-end">
                        <button type="button" onClick={() => startEdit(opt)}
                          className="text-[10px] text-brand-300 hover:underline">Editar</button>
                        {!opt.is_default && (
                          <button type="button"
                            onClick={() => { if (confirm(`Eliminar presentación "${opt.pack_unit}"?`)) deleteMut.mutate(opt.id) }}
                            className="text-ink-muted hover:text-status-danger">
                            <IconX />
                          </button>
                        )}
                      </div>
                    )}
                  </td>
                </tr>
              )})}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="text-xs text-ink-muted">Sin presentaciones — agrega la primera abajo.</p>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-12 gap-2 items-end border-t border-line-subtle pt-3">
        <div className="col-span-4">
          <label className="label">Unidad</label>
          <input className="input text-sm" placeholder="rollo, caja, millar..."
            value={newRow.packUnit}
            onChange={e => setNewRow(r => ({ ...r, packUnit: e.target.value }))} />
        </div>
        <div className="col-span-3">
          <label className="label">Contiene ({baseUnit})</label>
          <input className="input text-sm" type="number" step="0.01" min="0" placeholder="5"
            value={newRow.basePerPack}
            onChange={e => setNewRow(r => ({ ...r, basePerPack: e.target.value }))} />
        </div>
        <div className="col-span-3">
          <label className="label">Clave SAT</label>
          <SatUnitCombobox
            value={newRow.satUnitCode}
            onChange={v => setNewRow(r => ({ ...r, satUnitCode: v }))}
          />
        </div>
        <div className="col-span-2">
          <button type="button" onClick={submitNew} disabled={addMut.isPending}
            className="btn-primary btn-sm w-full">
            {addMut.isPending ? '...' : 'Agregar'}
          </button>
        </div>
      </div>

      {error && <p className="field-error">{error}</p>}
    </div>
  )
}

// ─── TH ordenable ─────────────────────────────────────────────────────────────
function SortableTh({ field, sortBy, sortDir, onSort, children }) {
  const active = sortBy === field
  return (
    <th>
      <button
        type="button"
        onClick={() => onSort(field)}
        className={clsx(
          'inline-flex items-center gap-1 select-none',
          active ? 'text-ink-primary' : 'text-ink-muted hover:text-ink-secondary'
        )}>
        {children}
        <span className={clsx('text-[10px] leading-none', active ? 'opacity-100' : 'opacity-30')}>
          {active && sortDir === 'desc' ? '▼' : '▲'}
        </span>
      </button>
    </th>
  )
}

// ─── Página ───────────────────────────────────────────────────────────────────
const SORT_FIELDS = {
  sku:            (a, b) => (a.sku || '').localeCompare(b.sku || ''),
  name:           (a, b) => (a.name || '').localeCompare(b.name || ''),
  type:           (a, b) => (a.type || '').localeCompare(b.type || ''),
  is_produced:    (a, b) => (b.is_produced === true) - (a.is_produced === true),
  sale_unit:      (a, b) => (a.sale_unit || '').localeCompare(b.sale_unit || ''),
  lead_time_days: (a, b) => (a.lead_time_days ?? 0) - (b.lead_time_days ?? 0),
  is_active:      (a, b) => (b.is_active === true) - (a.is_active === true),
}

function useDebounced(value, delay = 300) {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay)
    return () => clearTimeout(t)
  }, [value, delay])
  return debounced
}

export default function Productos() {
  const [search,       setSearch]       = useState('')
  const [filterType,   setFilterType]   = useState('')
  const [filterActive, setFilterActive] = useState('')
  const [page,         setPage]         = useState(1)
  const [modal,        setModal]        = useState(null)
  const [sortBy,       setSortBy]       = useState(null)
  const [sortDir,      setSortDir]      = useState('asc')
  const [exporting,    setExporting]    = useState(false)

  const searchDebounced = useDebounced(search, 300)

  // ¿El tenant tiene esquineros (corner_protector)? Filtramos la opción del dropdown si no.
  const { data: kindsListRaw } = useQuery({
    queryKey: ['product-kinds-active'],
    queryFn:  () => processConfigApi.listProductKinds({ isActive: true }),
    staleTime: 300000,
  })
  const kindsList = Array.isArray(kindsListRaw) ? kindsListRaw : (kindsListRaw?.data || [])
  const tenantHasCorner = kindsList.length === 0
    || kindsList.some(k => ['corner_protector', 'esquinero'].includes(String(k.code || '').toLowerCase()))

  // Resetea a página 1 si la búsqueda cambia
  useEffect(() => { setPage(1) }, [searchDebounced])

  // Mapeo del select de filtro: "produced" → isProduced=true, "resale" → isProduced=false.
  const filterIsProduced = filterType === 'produced' ? true
    : filterType === 'resale' ? false
    : undefined

  const { data, isLoading } = useQuery({
    queryKey: ['products', { search: searchDebounced, filterType, filterActive, page }],
    queryFn: () => productsApi.list({
      search:     searchDebounced || undefined,
      isProduced: filterIsProduced,
      isActive:   filterActive !== '' ? filterActive === 'true' : undefined,
      page,
      limit: 50,
    }),
    keepPreviousData: true,
  })

  const rawProducts = data?.data  || []
  const total       = data?.total || 0
  const totalPages  = Math.ceil(total / 50)

  const products = useMemo(() => {
    if (!sortBy || !SORT_FIELDS[sortBy]) return rawProducts
    const sorted = [...rawProducts].sort(SORT_FIELDS[sortBy])
    return sortDir === 'desc' ? sorted.reverse() : sorted
  }, [rawProducts, sortBy, sortDir])

  function toggleSort(field) {
    if (sortBy === field) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    } else {
      setSortBy(field)
      setSortDir('asc')
    }
  }

  async function openEdit(prod) {
    const full = await productsApi.get(prod.id)
    setModal(full)
  }

  // Duplicar: carga el producto completo y abre el form en modo CREACIÓN
  // pre-llenado con sus datos (menos el SKU). Agiliza capturar productos similares.
  async function openClone(prod) {
    const full = await productsApi.get(prod.id)
    setModal({ clone: full })
  }

  async function exportCSV() {
    setExporting(true)
    try {
      // Traer todos los productos respetando filtros activos pero sin paginar
      const all = await productsApi.list({
        search:     searchDebounced || undefined,
        isProduced: filterIsProduced,
        isActive:   filterActive !== '' ? filterActive === 'true' : undefined,
        page:     1,
        limit:    100,
      })
      const rows = all.data || []
      const header = ['SKU', 'Nombre', '¿Se fabrica?', 'Unidad', 'Lead time (días)',
        'Precio base', 'Moneda base', 'Clave SAT', 'Unidad SAT', 'Activo']
      const lines = rows.map(p => [
        p.sku,
        `"${(p.name || '').replace(/"/g, '""')}"`,
        p.is_produced ? 'Sí' : 'No',
        p.sale_unit || '',
        p.lead_time_days ?? '',
        p.base_price ?? '',
        p.base_currency ?? '',
        p.sat_product_code || '',
        p.sat_unit_code || '',
        p.is_active ? 'Sí' : 'No',
      ].join(','))
      const csv = [header.join(','), ...lines].join('\n')
      const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `productos-${new Date().toISOString().slice(0, 10)}.csv`
      a.click()
      URL.revokeObjectURL(url)
    } finally {
      setExporting(false)
    }
  }

  return (
    <div className="page-enter">
      {/* Encabezado */}
      <div className="page-header">
        <div>
          <h1 className="page-title">Productos</h1>
          <p className="page-subtitle">{total} producto{total !== 1 ? 's' : ''} en catálogo</p>
        </div>
        <div className="flex gap-2">
          <button className="btn-ghost btn-sm"
            onClick={exportCSV}
            disabled={exporting || total === 0}
            title={total === 0 ? 'Sin productos para exportar' : 'Exportar CSV'}>
            {exporting ? (
              <Spinner className="w-4 h-4" />
            ) : (
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/>
              </svg>
            )}
            Exportar CSV
          </button>
          <Can do="products:create">
            <button className="btn-primary" onClick={() => setModal('new')}>
              <IconPlus /> Nuevo producto
            </button>
          </Can>
        </div>
      </div>

      {/* Filtros */}
      <div className="flex flex-wrap gap-3 mb-5">
        <input value={search} onChange={(e) => setSearch(e.target.value)}
          placeholder="Buscar por nombre o SKU..." className="input max-w-xs" />
        <select value={filterType} onChange={(e) => { setFilterType(e.target.value); setPage(1) }}
          className="select w-48">
          <option value="">Todos los productos</option>
          <option value="produced">Solo fabricados</option>
          <option value="resale">Solo de reventa</option>
        </select>
        <select value={filterActive} onChange={(e) => { setFilterActive(e.target.value); setPage(1) }}
          className="select w-36">
          <option value="">Todos</option>
          <option value="true">Activos</option>
          <option value="false">Inactivos</option>
        </select>
      </div>

      {/* Tabla */}
      <div className="card p-0 overflow-hidden">
        {isLoading ? (
          <div className="flex items-center justify-center py-16"><Spinner /></div>
        ) : products.length === 0 ? (
          <div className="empty-state">
            <div className="w-12 h-12 rounded-xl bg-surface-elevated/60 flex items-center justify-center text-ink-muted mb-3">
              <IconBox />
            </div>
            <p className="font-medium text-ink-secondary">Sin productos</p>
            <p>
              {search || filterType
                ? 'No hay resultados para los filtros aplicados.'
                : 'Aún no hay productos en el catálogo.'}
            </p>
          </div>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th className="w-12"></th>
                  <SortableTh field="sku"            sortBy={sortBy} sortDir={sortDir} onSort={toggleSort}>SKU</SortableTh>
                  <SortableTh field="name"           sortBy={sortBy} sortDir={sortDir} onSort={toggleSort}>Nombre</SortableTh>
                  <SortableTh field="is_produced"    sortBy={sortBy} sortDir={sortDir} onSort={toggleSort}>¿Se fabrica?</SortableTh>
                  <SortableTh field="sale_unit"      sortBy={sortBy} sortDir={sortDir} onSort={toggleSort}>Unidad</SortableTh>
                  <SortableTh field="lead_time_days" sortBy={sortBy} sortDir={sortDir} onSort={toggleSort}>Lead time</SortableTh>
                  <th>Clave SAT</th>
                  <SortableTh field="is_active"      sortBy={sortBy} sortDir={sortDir} onSort={toggleSort}>Estado</SortableTh>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {products.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <ProductThumbnail
                        productId={p.id}
                        attachmentId={p.image_attachment_id}
                        size={40}
                        caption={`${p.sku} · ${p.name}`}
                      />
                    </td>
                    <td>
                      <span className="font-mono text-xs text-ink-muted">{p.sku}</span>
                    </td>
                    <td>
                      <div className="flex items-center gap-1.5">
                        <span className="font-medium text-ink-primary">{p.name}</span>
                        {p.type === 'corner_protector' && !p.has_quality_spec && (
                          <span
                            title="Este esquinero no tiene specs de calidad — edítalo para agregarlas"
                            className="inline-flex items-center gap-1 text-[10px] font-bold px-1.5 py-0.5 rounded bg-status-danger/15 text-status-danger">
                            <IconAlert /> Sin specs
                          </span>
                        )}
                      </div>
                    </td>
                    <td>
                      {p.is_produced
                        ? <Badge variant="blue"  label="Sí" />
                        : <Badge variant="gray"  label="—" />}
                    </td>
                    <td className="text-ink-muted text-xs">{p.sale_unit}</td>
                    <td className="text-ink-muted text-xs">{p.lead_time_days ?? 7} días</td>
                    <td>
                      <span className="font-mono text-xs text-ink-muted">{p.sat_product_code}</span>
                    </td>
                    <td>
                      <Badge
                        status={p.is_active ? 'confirmed' : 'cancelled'}
                        label={p.is_active ? 'Activo' : 'Inactivo'}
                      />
                    </td>
                    <td>
                      <div className="flex items-center justify-end gap-1">
                        <Can do="products:update">
                          <button onClick={() => openEdit(p)}
                            className="btn-ghost btn-icon btn-sm text-brand-300 hover:text-brand-200"
                            title="Editar">
                            <IconEdit />
                          </button>
                        </Can>
                        <Can do="products:create">
                          <button onClick={() => openClone(p)}
                            className="btn-ghost btn-icon btn-sm text-ink-muted hover:text-brand-300"
                            title="Duplicar (crear uno similar)">
                            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M8 7v8a2 2 0 002 2h6M8 7V5a2 2 0 012-2h4.586a1 1 0 01.707.293l4.414 4.414a1 1 0 01.293.707V15a2 2 0 01-2 2h-2M8 7H6a2 2 0 00-2 2v10a2 2 0 002 2h6a2 2 0 002-2v-2" />
                            </svg>
                          </button>
                        </Can>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {totalPages > 1 && (
          <div className="flex items-center justify-between px-4 py-3 border-t border-line-subtle">
            <span className="text-xs text-ink-muted">
              Página {page} de {totalPages} — {total} productos
            </span>
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
        <ProductModal
          product={(modal === 'new' || modal?.clone) ? null : modal}
          cloneFrom={modal?.clone || null}
          onClose={() => setModal(null)}
        />
      )}
    </div>
  )
}
