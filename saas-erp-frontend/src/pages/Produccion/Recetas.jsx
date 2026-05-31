import { useState } from 'react'
import { createPortal } from 'react-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { recipesApi } from '@/api/recipes'
import { productsApi } from '@/api/products'
import { rawMaterialsApi } from '@/api/rawMaterials'
import { processConfigApi } from '@/api/processConfig'
import Badge from '@/components/ui/Badge'
import Spinner from '@/components/ui/Spinner'
import HelpTip from '@/components/ui/HelpTip'
import CollapsibleHelp from '@/components/ui/CollapsibleHelp'
import useAuthStore from '@/store/useAuthStore'
import clsx from 'clsx'

const KIND_LABEL   = { raw_material: 'Materia prima', packaging: 'Embalaje', additive: 'Aditivo' }
const KIND_VARIANT = { raw_material: 'amber', packaging: 'teal', additive: 'purple' }

const fmtNum = (n, d = 2) =>
  Number(n || 0).toLocaleString('es-MX', { minimumFractionDigits: 0, maximumFractionDigits: d })

const fmtDate = (d) => d
  ? new Date(d).toLocaleDateString('es-MX', { day: 'numeric', month: 'short', year: 'numeric' })
  : '—'

// ═══════════════════════════════════════════════════════════════════════════
//  Página principal
// ═══════════════════════════════════════════════════════════════════════════
export default function Recetas() {
  const can = useAuthStore(s => s.can)
  const permissions = useAuthStore(s => s.permissions)
  const isSuperAdmin = permissions?.includes?.('*')
  const canManage = isSuperAdmin || can?.('recipes', 'update')

  const [search, setSearch] = useState('')
  const [editing, setEditing] = useState(null) // null | 'new' | recipeId

  // Cargamos solo las recetas vigentes (la última versión activa por producto)
  const { data: recipes = [], isLoading } = useQuery({
    queryKey: ['recipes-vigentes'],
    queryFn:  () => recipesApi.list({ vigentOnly: true }),
  })

  const filtered = recipes.filter(r => {
    if (!search) return true
    const s = search.toLowerCase()
    return r.product_name?.toLowerCase().includes(s)
        || r.product_sku?.toLowerCase().includes(s)
        || r.name?.toLowerCase().includes(s)
  })

  return (
    <div className="page-enter">
      <div className="page-header">
        <div>
          <h1 className="page-title">Recetas de producción</h1>
          <p className="page-subtitle">Plantillas reutilizables con ingredientes y empaques por producto</p>
        </div>
        {canManage && (
          <button onClick={() => setEditing('new')} className="btn-primary">
            + Nueva receta
          </button>
        )}
      </div>

      <CollapsibleHelp title="¿Para qué sirve esto?" className="mb-5">
        <p className="leading-relaxed">
          Define una vez los ingredientes (MP + empaque + aditivos) que componen un producto.
          Al crear una orden de producción de ese producto, los componentes se cargan automáticamente y solo
          ajustas cantidades si el lote es distinto. Cada vez que cambies la receta se crea una nueva versión —
          las órdenes ya creadas mantienen la versión bajo la que se generaron.
        </p>
      </CollapsibleHelp>

      <div className="flex gap-3 mb-5">
        <input value={search} onChange={(e) => setSearch(e.target.value)}
          placeholder="Buscar por producto o SKU..." className="input max-w-md" />
      </div>

      {isLoading ? (
        <div className="flex justify-center py-16"><Spinner /></div>
      ) : filtered.length === 0 ? (
        <div className="empty-state">
          <p className="font-medium text-ink-secondary">
            {recipes.length === 0 ? 'Sin recetas configuradas' : 'Sin resultados'}
          </p>
          <p className="text-sm text-ink-muted mt-1 max-w-md mx-auto">
            {recipes.length === 0
              ? 'Crea tu primera receta para que el sistema autocargue los ingredientes al generar órdenes de producción.'
              : 'Ajusta los filtros para ver otras recetas.'}
          </p>
          {canManage && recipes.length === 0 && (
            <button onClick={() => setEditing('new')} className="btn-primary btn-sm mt-3">+ Crear primera</button>
          )}
        </div>
      ) : (
        <div className="card p-0 overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th>Producto</th>
                <th className="text-center">Versión</th>
                <th className="text-right">Rendimiento</th>
                <th className="text-right">Componentes</th>
                <th className="text-right">Merma esperada</th>
                <th>Vigente desde</th>
                <th>Estado</th>
                {canManage && <th className="w-20"></th>}
              </tr>
            </thead>
            <tbody>
              {filtered.map(r => (
                <tr key={r.id} className={clsx(!r.is_active && 'opacity-50')}>
                  <td>
                    <p className="font-medium text-sm text-ink-primary">{r.product_name}</p>
                    <p className="text-xs font-mono text-ink-muted">{r.product_sku}</p>
                  </td>
                  <td className="text-center">
                    <Badge variant="blue" label={`v${r.version}`} />
                  </td>
                  <td className="text-right tabular-nums text-sm">
                    {fmtNum(r.yield_quantity, 2)} {r.yield_unit_symbol || r.yield_unit_code}
                  </td>
                  <td className="text-right tabular-nums text-sm">{r.components_count}</td>
                  <td className="text-right tabular-nums text-sm text-ink-muted">
                    {r.expected_scrap_pct != null ? `${r.expected_scrap_pct}%` : '—'}
                  </td>
                  <td className="text-xs text-ink-muted">{fmtDate(r.valid_from)}</td>
                  <td>
                    <Badge variant={r.is_active ? 'green' : 'gray'} label={r.is_active ? 'Activa' : 'Inactiva'} />
                  </td>
                  {canManage && (
                    <td>
                      <button onClick={() => setEditing(r.id)} className="btn-ghost btn-sm text-xs">Editar</button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editing && (
        <RecipeModal
          recipeId={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════
//  Modal CRUD
// ═══════════════════════════════════════════════════════════════════════════
function RecipeModal({ recipeId, onClose }) {
  const qc = useQueryClient()
  const isEditing = !!recipeId

  // Catálogos
  const { data: unitsRaw } = useQuery({
    queryKey: ['process-config-units-active'],
    queryFn:  () => processConfigApi.listUnits({ is_active: true }),
    staleTime: 60000,
  })
  const units = Array.isArray(unitsRaw) ? unitsRaw : (unitsRaw?.data || [])

  const { data: productsData } = useQuery({
    queryKey: ['products-producible-for-recipes'],
    queryFn:  () => productsApi.list({ isActive: true, isProduced: true, limit: 200 }),
  })
  const products = productsData?.data || []

  const { data: rmData } = useQuery({
    queryKey: ['raw-materials-active'],
    queryFn:  () => rawMaterialsApi.list({ isActive: true, limit: 200 }),
  })
  const rawMaterials = rmData?.data || []

  // Cargar receta existente si estamos editando
  const { data: existingRecipe } = useQuery({
    queryKey: ['recipe', recipeId],
    queryFn:  () => recipesApi.get(recipeId),
    enabled:  !!recipeId,
  })

  // Estado del form
  const [productId, setProductId]     = useState('')
  const [name, setName]               = useState('')
  const [yieldQty, setYieldQty]       = useState('')
  const [yieldUnitId, setYieldUnitId] = useState('')
  const [scrapPct, setScrapPct]       = useState('')
  const [components, setComponents]   = useState([
    { rawMaterialId: '', quantity: '', unitId: '', notes: '' },
  ])
  const [error, setError] = useState(null)
  const [initialized, setInitialized] = useState(false)

  // Hidratar form al cargar receta existente
  if (existingRecipe && !initialized) {
    setProductId(existingRecipe.product_id)
    setName(existingRecipe.name || '')
    setYieldQty(existingRecipe.yield_quantity || '')
    setYieldUnitId(existingRecipe.yield_unit_id || '')
    setScrapPct(existingRecipe.expected_scrap_pct ?? '')
    setComponents(
      (existingRecipe.components || []).map(c => ({
        rawMaterialId: c.raw_material_id,
        quantity:      c.quantity,
        unitId:        c.unit_id,
        notes:         c.notes || '',
      })),
    )
    setInitialized(true)
  }

  const addComponent = () => setComponents(prev =>
    [...prev, { rawMaterialId: '', quantity: '', unitId: '', notes: '' }])
  const removeComponent = (i) => setComponents(prev => prev.filter((_, idx) => idx !== i))
  const updateComponent = (i, field, value) =>
    setComponents(prev => prev.map((c, idx) => idx === i ? { ...c, [field]: value } : c))

  const submitMut = useMutation({
    mutationFn: async () => {
      if (!productId) throw new Error('Selecciona un producto.')
      if (!yieldQty || parseFloat(yieldQty) <= 0) throw new Error('Rendimiento debe ser > 0.')
      if (!yieldUnitId) throw new Error('Selecciona la unidad de rendimiento.')
      const validComps = components.filter(c => c.rawMaterialId && c.quantity > 0 && c.unitId)
      if (validComps.length === 0) throw new Error('Agrega al menos un componente con cantidad y unidad.')

      return recipesApi.create({
        product_id:         productId,
        name:               name || null,
        yield_quantity:     parseFloat(yieldQty),
        yield_unit_id:      yieldUnitId,
        expected_scrap_pct: scrapPct !== '' ? parseFloat(scrapPct) : null,
        components: validComps.map((c, idx) => ({
          raw_material_id: c.rawMaterialId,
          quantity:        parseFloat(c.quantity),
          unit_id:         c.unitId,
          notes:           c.notes || null,
          sort_order:      idx,
        })),
      })
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['recipes-vigentes'] })
      onClose()
    },
    onError: (e) => setError(e?.response?.data?.error || e?.message || 'Error al guardar.'),
  })

  const componentsTotal = components.reduce((s, c) => s + (parseFloat(c.quantity) || 0), 0)

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-0 sm:p-4">
      <div className="bg-surface-primary shadow-xl border border-line-subtle w-full max-w-3xl flex flex-col overflow-hidden rounded-none sm:rounded-2xl h-[100dvh] max-h-[100dvh] sm:h-auto sm:max-h-[92vh]">
        <div className="flex items-center justify-between px-5 py-4 border-b border-line-subtle"
          style={{ paddingTop: 'max(1rem, env(safe-area-inset-top))' }}>
          <div>
            <h2 className="text-base font-semibold text-ink-primary">
              {isEditing
                ? `Editar receta · v${existingRecipe?.version || '?'} → v${(existingRecipe?.version || 0) + 1}`
                : 'Nueva receta'}
            </h2>
            <p className="text-xs text-ink-muted mt-0.5">
              {isEditing
                ? 'Guardar creará una nueva versión y cerrará la actual. Las órdenes ya creadas mantienen su versión.'
                : 'Define los componentes que se cargan automáticamente al crear órdenes de este producto.'}
            </p>
          </div>
          <button onClick={onClose} className="text-ink-muted hover:text-ink-primary">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12"/>
            </svg>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-5">
          {/* Producto + rendimiento */}
          <section className="space-y-3">
            <div>
              <label className="label">Producto a fabricar <span className="text-status-danger">*</span></label>
              <select value={productId} onChange={e => setProductId(e.target.value)}
                disabled={isEditing}
                className={clsx('select', isEditing && 'bg-surface-elevated/40 cursor-not-allowed')}>
                <option value="">— Seleccionar producto —</option>
                {products.map(p => (
                  <option key={p.id} value={p.id}>{p.name} — {p.sku}</option>
                ))}
              </select>
              {isEditing && (
                <p className="text-xs text-ink-muted mt-1">
                  El producto no se puede cambiar (esto es solo nueva versión de la misma receta).
                </p>
              )}
            </div>

            <div>
              <label className="label">Nombre interno</label>
              <input value={name} onChange={e => setName(e.target.value)}
                placeholder="Ej: Receta estándar, Versión otoño 2026..." className="input" />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <label className="label flex items-center gap-1">
                  Rendimiento <span className="text-status-danger">*</span>
                  <HelpTip text="Cuánto producto terminado se obtiene de una corrida estándar con estos componentes. Ej: 1 (pieza), 10 (kg), 100 (paquetes)." />
                </label>
                <input type="number" step="0.01" min="0.01" value={yieldQty}
                  onChange={e => setYieldQty(e.target.value)} className="input" />
              </div>
              <div>
                <label className="label">Unidad <span className="text-status-danger">*</span></label>
                <select value={yieldUnitId} onChange={e => setYieldUnitId(e.target.value)} className="select">
                  <option value="">—</option>
                  {units.map(u => (
                    <option key={u.id} value={u.id}>{u.symbol || u.code} — {u.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="label flex items-center gap-1">
                  % merma esperada
                  <HelpTip text="Cuánta merma considerada normal sale por corrida. Si se excede, la diferencia se trata como anormal (problema de proceso)." />
                </label>
                <div className="relative">
                  <input type="number" step="0.1" min="0" max="100" value={scrapPct}
                    onChange={e => setScrapPct(e.target.value)}
                    placeholder="opcional" className="input pr-7" />
                  <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-ink-muted">%</span>
                </div>
              </div>
            </div>
          </section>

          {/* Componentes */}
          <section>
            <div className="flex items-center justify-between mb-2">
              <div>
                <h3 className="text-sm font-semibold text-ink-primary">Componentes</h3>
                <p className="text-xs text-ink-muted">
                  Ingredientes, empaques y aditivos que se consumen al producir el rendimiento indicado.
                </p>
              </div>
              <button onClick={addComponent} className="btn-ghost btn-sm text-brand-300">
                + Agregar componente
              </button>
            </div>

            <div className="space-y-2">
              {components.map((c, i) => {
                const rm = rawMaterials.find(r => r.id === c.rawMaterialId)
                const kind = rm?.item_kind || 'raw_material'
                return (
                  <div key={i} className="border border-line-subtle rounded-lg p-3 space-y-2">
                    <div className="flex flex-col sm:flex-row sm:items-start gap-3">
                      <div className="flex-1 min-w-0">
                        <label className="label">
                          {rm && <Badge variant={KIND_VARIANT[kind]} label={KIND_LABEL[kind]} className="mr-2" />}
                          Material
                        </label>
                        <select value={c.rawMaterialId}
                          onChange={e => updateComponent(i, 'rawMaterialId', e.target.value)}
                          className="select">
                          <option value="">— Elegir —</option>
                          {rawMaterials.map(m => (
                            <option key={m.id} value={m.id}>
                              {m.name} {m.resin_type ? `(${m.resin_type})` : ''} — {KIND_LABEL[m.item_kind || 'raw_material']}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div className="flex items-start gap-3">
                        <div className="w-24 sm:w-28 shrink-0">
                          <label className="label">Cantidad</label>
                          <input type="number" step="0.001" min="0" value={c.quantity}
                            onChange={e => updateComponent(i, 'quantity', e.target.value)}
                            placeholder="0.000" className="input text-right" />
                        </div>
                        <div className="flex-1 sm:flex-none sm:w-32 min-w-0">
                          <label className="label">Unidad</label>
                          <select value={c.unitId}
                            onChange={e => updateComponent(i, 'unitId', e.target.value)}
                            className="select">
                            <option value="">—</option>
                            {units.map(u => (
                              <option key={u.id} value={u.id}>{u.symbol || u.code}</option>
                            ))}
                          </select>
                        </div>
                        <button onClick={() => removeComponent(i)}
                          disabled={components.length === 1}
                          className="btn-ghost btn-icon text-ink-muted hover:text-status-danger mt-6 shrink-0"
                          title="Quitar componente">
                          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/>
                          </svg>
                        </button>
                      </div>
                    </div>
                    <input value={c.notes} onChange={e => updateComponent(i, 'notes', e.target.value)}
                      placeholder="Notas (opcional): proveedor preferido, especificación, etc."
                      className="input input-sm text-xs" />
                  </div>
                )
              })}
            </div>

            {components.length > 1 && (
              <p className="text-xs text-ink-muted mt-2">
                Total de componentes: <strong>{components.filter(c => c.rawMaterialId).length}</strong>
                {' · '}
                Cantidad sumada: <strong>{fmtNum(componentsTotal, 3)}</strong> (referencia)
              </p>
            )}
          </section>

          {error && (
            <div className="bg-status-danger/10 border border-status-danger/40 rounded-xl px-4 py-3 text-sm text-status-danger">
              {error}
            </div>
          )}
        </div>

        <div className="px-5 py-3 border-t border-line-subtle flex justify-end gap-2"
          style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))' }}>
          <button onClick={onClose} disabled={submitMut.isPending} className="btn-ghost btn-sm">Cancelar</button>
          <button onClick={() => { setError(null); submitMut.mutate() }}
            disabled={submitMut.isPending} className="btn-primary btn-sm">
            {submitMut.isPending && <Spinner className="w-3 h-3" />}
            {isEditing ? 'Guardar nueva versión' : 'Crear receta'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
