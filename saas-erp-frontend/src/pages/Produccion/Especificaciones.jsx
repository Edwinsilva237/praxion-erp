import { useState } from 'react'
import { createPortal } from 'react-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { productsApi } from '@/api/products'
import { processConfigApi } from '@/api/processConfig'
import Badge from '@/components/ui/Badge'
import Spinner from '@/components/ui/Spinner'
import HelpTip from '@/components/ui/HelpTip'
import useAuthStore from '@/store/useAuthStore'
import clsx from 'clsx'

const fmtNum = (n, d = 2) =>
  n == null ? '—' : Number(n).toLocaleString('es-MX', { minimumFractionDigits: 0, maximumFractionDigits: d })

const fmtDate = (d) => d
  ? new Date(d).toLocaleDateString('es-MX', { day: 'numeric', month: 'short', year: 'numeric' })
  : '—'

// ═══════════════════════════════════════════════════════════════════════════
//  Página principal
// ═══════════════════════════════════════════════════════════════════════════
export default function Especificaciones() {
  const can = useAuthStore(s => s.can)
  const permissions = useAuthStore(s => s.permissions)
  const isSuperAdmin = permissions?.includes?.('*')
  const canManage = isSuperAdmin || can?.('products', 'update')

  const [search, setSearch] = useState('')
  const [filterStatus, setFilterStatus] = useState('all') // 'all' | 'with-spec' | 'without-spec'
  const [editing, setEditing]   = useState(null)
  const [historyOf, setHistory] = useState(null)

  // Productos producidos del tenant (solo los que pueden tener spec)
  const { data: productsData, isLoading } = useQuery({
    queryKey: ['products-for-quality-specs'],
    queryFn:  () => productsApi.list({ isProduced: true, isActive: true, limit: 200 }),
  })
  const products = productsData?.data || []

  // Flags del tenant para mostrar columnas relevantes
  const { data: tenantConfig } = useQuery({
    queryKey: ['tenant-process-config'],
    queryFn:  processConfigApi.getConfig,
    staleTime: 300000,
  })

  const filtered = products.filter(p => {
    if (search) {
      const s = search.toLowerCase()
      if (!p.name?.toLowerCase().includes(s) && !p.sku?.toLowerCase().includes(s)) return false
    }
    if (filterStatus === 'with-spec'    && !p.has_quality_spec) return false
    if (filterStatus === 'without-spec' &&  p.has_quality_spec) return false
    return true
  })

  // ¿Algún producto del tenant tiene length_mm? Eso indica industria lineal.
  const anyLinear = products.some(p => parseFloat(p.length_mm || 0) > 0)

  return (
    <div className="page-enter">
      <div className="page-header">
        <div>
          <h1 className="page-title">Especificaciones de calidad</h1>
          <p className="page-subtitle">Define los parámetros que el sistema usa para validar paquetes producidos</p>
        </div>
      </div>

      <div className="bg-status-info/10 border border-status-info/40 rounded-xl px-4 py-3 text-sm text-status-info mb-5">
        <p className="font-medium mb-1">¿Qué es esto?</p>
        <p className="leading-relaxed">
          Para cada producto que fabricas, defines los <strong>parámetros de calidad esperados</strong>: peso teórico,
          tolerancia, piezas por paquete. Durante la captura del turno, el sistema usa estos valores para calcular el
          peso esperado de cada paquete y marcar los que salen fuera de tolerancia.
        </p>
        <p className="leading-relaxed mt-1">
          Cada cambio crea una <strong>nueva versión</strong>. Las órdenes ya creadas mantienen la versión bajo la que se generaron.
        </p>
      </div>

      <div className="flex gap-3 mb-5 flex-wrap">
        <input value={search} onChange={(e) => setSearch(e.target.value)}
          placeholder="Buscar por nombre o SKU..." className="input max-w-md" />
        <select value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)} className="select w-48">
          <option value="all">Todos los productos</option>
          <option value="with-spec">Con especificación</option>
          <option value="without-spec">Sin especificación</option>
        </select>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-16"><Spinner /></div>
      ) : filtered.length === 0 ? (
        <div className="empty-state">
          <p className="font-medium text-ink-secondary">
            {products.length === 0 ? 'Sin productos fabricados' : 'Sin resultados'}
          </p>
          <p className="text-sm text-ink-muted mt-1 max-w-md mx-auto">
            {products.length === 0
              ? 'Aún no hay productos marcados como "se fabrica internamente". Agrega productos en Catálogo → Productos primero.'
              : 'Ajusta los filtros para ver otros productos.'}
          </p>
        </div>
      ) : (
        <div className="card p-0 overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th>Producto</th>
                {anyLinear && <th className="text-right">Largo</th>}
                {anyLinear && <th className="text-right">g/m lineal</th>}
                <th className="text-right">Tolerancia</th>
                <th className="text-right">Piezas/paq</th>
                <th>Estado</th>
                {canManage && <th className="w-32"></th>}
              </tr>
            </thead>
            <tbody>
              {filtered.map(p => {
                const lengthM = p.length_mm > 0 ? (p.length_mm / 1000).toFixed(2) : null
                return (
                  <tr key={p.id}>
                    <td>
                      <p className="font-medium text-sm text-ink-primary">{p.name}</p>
                      <p className="text-xs font-mono text-ink-muted">{p.sku}</p>
                    </td>
                    {anyLinear && (
                      <td className="text-right tabular-nums text-sm">
                        {lengthM ? `${lengthM} m` : <span className="text-ink-muted">—</span>}
                      </td>
                    )}
                    {anyLinear && (
                      <td className="text-right tabular-nums text-sm">
                        {p.grams_per_linear_meter ? `${fmtNum(p.grams_per_linear_meter, 2)} g/m` : <span className="text-ink-muted">—</span>}
                      </td>
                    )}
                    <td className="text-right tabular-nums text-sm">
                      {p.tolerance_pct ? `±${fmtNum(p.tolerance_pct, 1)}%` : <span className="text-ink-muted">—</span>}
                    </td>
                    <td className="text-right tabular-nums text-sm">
                      {p.spec_units_per_package || p.units_per_package || <span className="text-ink-muted">—</span>}
                    </td>
                    <td>
                      {p.has_quality_spec
                        ? <Badge variant="green" label="Configurada" />
                        : <Badge variant="amber" label="Sin spec" />}
                    </td>
                    {canManage && (
                      <td className="text-right">
                        <button onClick={() => setEditing(p)} className="btn-ghost btn-sm text-xs">
                          {p.has_quality_spec ? 'Editar' : 'Crear'}
                        </button>
                        {p.has_quality_spec && (
                          <button onClick={() => setHistory(p)} className="btn-ghost btn-sm text-xs ml-1">
                            Historial
                          </button>
                        )}
                      </td>
                    )}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {editing && (
        <SpecModal
          product={editing}
          isLineal={parseFloat(editing.length_mm || 0) > 0}
          onClose={() => setEditing(null)}
        />
      )}

      {historyOf && (
        <HistoryModal product={historyOf} onClose={() => setHistory(null)} />
      )}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════
//  Modal de edición — crea nueva versión
// ═══════════════════════════════════════════════════════════════════════════
function SpecModal({ product, isLineal, onClose }) {
  const qc = useQueryClient()
  const [gramsPerLinealMeter, setGpm] = useState(product.grams_per_linear_meter ?? '')
  const [tolerancePct,        setTol] = useState(product.tolerance_pct ?? 5)
  const [unitsPerPackage,     setUpp] = useState(
    product.spec_units_per_package ?? product.units_per_package ?? '',
  )
  const [notes, setNotes] = useState('')
  const [error, setError] = useState(null)

  const submit = useMutation({
    mutationFn: () => {
      if (isLineal && (!gramsPerLinealMeter || parseFloat(gramsPerLinealMeter) <= 0)) {
        throw new Error('Gramos por metro lineal requerido para productos lineales.')
      }
      if (!tolerancePct || parseFloat(tolerancePct) <= 0) {
        throw new Error('Tolerancia debe ser > 0.')
      }
      return productsApi.addQualitySpec(product.id, {
        gramsPerLinearMeter: parseFloat(gramsPerLinealMeter || 0) || null,
        tolerancePct:        parseFloat(tolerancePct),
        unitsPerPackage:     unitsPerPackage ? parseInt(unitsPerPackage) : 1,
        notes:               notes || null,
      })
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['products-for-quality-specs'] })
      qc.invalidateQueries({ queryKey: ['quality-specs-history', product.id] })
      onClose()
    },
    onError: (e) => setError(e?.response?.data?.error || e.message || 'Error al guardar.'),
  })

  const hasCurrent = !!product.has_quality_spec

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-surface-primary rounded-2xl shadow-xl w-full max-w-md border border-line-subtle">
        <div className="px-5 py-4 border-b border-line-subtle flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold text-ink-primary">
              {hasCurrent ? 'Editar especificación' : 'Crear especificación'}
            </h3>
            <p className="text-xs text-ink-muted mt-0.5">{product.name} · {product.sku}</p>
          </div>
          <button onClick={onClose} className="text-ink-muted hover:text-ink-primary">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12"/>
            </svg>
          </button>
        </div>

        <div className="p-5 space-y-4">
          {hasCurrent && (
            <div className="bg-status-info/10 border border-status-info/40 rounded-lg px-3 py-2 text-xs text-status-info">
              Al guardar se creará una <strong>nueva versión</strong> y la actual se cerrará.
              Las órdenes ya creadas mantienen su versión.
            </div>
          )}

          {isLineal && (
            <div>
              <label className="label flex items-center gap-1">
                Gramos por metro lineal *
                <HelpTip text="Peso teórico del producto por cada metro de longitud. Se usa junto con el largo del producto para calcular el peso esperado de cada paquete capturado." />
              </label>
              <div className="relative">
                <input type="number" step="0.01" min="0" value={gramsPerLinealMeter}
                  onChange={e => setGpm(e.target.value)}
                  placeholder="180" className="input pr-12" />
                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-ink-muted">g/m</span>
              </div>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label flex items-center gap-1">
                Tolerancia *
                <HelpTip text="± % aceptable sobre el peso esperado. Paquetes fuera de este rango se marcan en rojo durante validación." />
              </label>
              <div className="relative">
                <input type="number" step="0.1" min="0.1" max="50" value={tolerancePct}
                  onChange={e => setTol(e.target.value)}
                  placeholder="5" className="input pr-8" />
                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-ink-muted">%</span>
              </div>
            </div>
            <div>
              <label className="label flex items-center gap-1">
                Piezas por paquete
                <HelpTip text="Cuántas piezas se empacan juntas. Para productos individuales déjalo en 1." />
              </label>
              <input type="number" min="1" value={unitsPerPackage}
                onChange={e => setUpp(e.target.value)} className="input" />
            </div>
          </div>

          <div>
            <label className="label">Notas internas</label>
            <textarea value={notes} onChange={e => setNotes(e.target.value)}
              rows={2} placeholder="Observaciones sobre esta versión de la spec..."
              className="input h-auto py-2 resize-none" />
          </div>

          {!isLineal && (
            <p className="text-[11px] text-ink-muted leading-snug">
              ⓘ Este producto no tiene longitud lineal definida. Si quieres medir peso por metro,
              primero edita el producto y captura su largo en mm.
            </p>
          )}

          {error && (
            <div className="bg-status-danger/10 border border-status-danger/40 rounded-lg px-3 py-2 text-sm text-status-danger">
              {error}
            </div>
          )}
        </div>

        <div className="px-5 py-3 border-t border-line-subtle flex justify-end gap-2">
          <button onClick={onClose} disabled={submit.isPending} className="btn-ghost btn-sm">Cancelar</button>
          <button onClick={() => { setError(null); submit.mutate() }}
            disabled={submit.isPending} className="btn-primary btn-sm">
            {submit.isPending && <Spinner className="w-3 h-3" />}
            {hasCurrent ? 'Guardar nueva versión' : 'Crear especificación'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}

// ═══════════════════════════════════════════════════════════════════════════
//  Modal de historial
// ═══════════════════════════════════════════════════════════════════════════
function HistoryModal({ product, onClose }) {
  const { data: specs = [], isLoading } = useQuery({
    queryKey: ['quality-specs-history', product.id],
    queryFn:  () => productsApi.getQualitySpecs(product.id),
  })

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-surface-primary rounded-2xl shadow-xl w-full max-w-2xl max-h-[85vh] overflow-hidden flex flex-col border border-line-subtle">
        <div className="px-5 py-4 border-b border-line-subtle flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold text-ink-primary">Historial de especificaciones</h3>
            <p className="text-xs text-ink-muted mt-0.5">{product.name} · {product.sku}</p>
          </div>
          <button onClick={onClose} className="text-ink-muted hover:text-ink-primary">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12"/>
            </svg>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5">
          {isLoading ? (
            <div className="flex justify-center py-8"><Spinner /></div>
          ) : specs.length === 0 ? (
            <p className="text-sm text-ink-muted text-center py-8">Sin versiones registradas.</p>
          ) : (
            <table className="table text-xs">
              <thead>
                <tr>
                  <th>Vigencia</th>
                  <th className="text-right">g/m lineal</th>
                  <th className="text-right">Tolerancia</th>
                  <th className="text-right">Piezas/paq</th>
                  <th>Notas</th>
                </tr>
              </thead>
              <tbody>
                {specs.map((s, idx) => (
                  <tr key={s.id} className={clsx(s.valid_until === null && 'bg-status-success/5 font-medium')}>
                    <td>
                      <p className="text-sm">{fmtDate(s.valid_from)}</p>
                      <p className="text-[10px] text-ink-muted">
                        {s.valid_until ? `hasta ${fmtDate(s.valid_until)}` : <span className="text-status-success">vigente</span>}
                      </p>
                    </td>
                    <td className="text-right tabular-nums">{s.grams_per_linear_meter ? `${fmtNum(s.grams_per_linear_meter, 2)} g/m` : '—'}</td>
                    <td className="text-right tabular-nums">±{fmtNum(s.tolerance_pct, 1)}%</td>
                    <td className="text-right tabular-nums">{s.units_per_package || '—'}</td>
                    <td className="text-xs text-ink-muted italic max-w-xs truncate">{s.notes || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="px-5 py-3 border-t border-line-subtle flex justify-end">
          <button onClick={onClose} className="btn-ghost btn-sm">Cerrar</button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
