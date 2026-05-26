import { useState, useEffect, useMemo } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { inventoryApi } from '@/api/inventory'
import Spinner from '@/components/ui/Spinner'
import ReorderSuggestionModal from './ReorderSuggestionModal'
import clsx from 'clsx'

const fmtNum = (n, decimals = 2) => {
  if (n == null || isNaN(n)) return '0'
  return Number(n).toLocaleString('es-MX', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
}

// Tipos de almacén compatibles según el tipo de ítem
const COMPATIBLE_WAREHOUSE_TYPES = {
  raw_material: ['raw_material', 'regrind'],
  product:      ['finished_product', 'resale'],
}

/**
 * Sección de "Niveles de inventario y reposición" reutilizable.
 *
 * Props:
 *   - itemType: 'raw_material' | 'product'
 *   - itemId:   UUID del ítem (cuando ya existe)
 *   - leadTimeDays: lead time del ítem (controlado por el form padre)
 *   - onLeadTimeChange: callback al cambiar el lead time
 *   - readOnly: solo lectura
 *   - unit: 'kg' | 'pza'
 *   - initialWarehouseId: almacén pre-seleccionado (opcional). Útil cuando se
 *                         abre desde el panel de detalle con un almacén específico.
 */
export default function InventoryLevelsPanel({
  itemType, itemId,
  leadTimeDays = 7, onLeadTimeChange,
  readOnly = false, unit = 'kg',
  initialWarehouseId = null,
}) {
  const qc = useQueryClient()
  const [activeWh, setActiveWh] = useState(initialWarehouseId)
  const [showSuggestion, setShowSuggestion] = useState(false)
  const [form, setForm] = useState({
    minStock: '', maxStock: '', reorderPoint: '', safetyStock: '',
    isManualReorderPoint: true, lastCalculatedAvg: null,
  })
  const [serverError, setServerError] = useState(null)
  const [savedMsg, setSavedMsg] = useState(null)

  // Cargar almacenes
  const { data: warehouses = [] } = useQuery({
    queryKey: ['inv-warehouses'],
    queryFn:  inventoryApi.getWarehouses,
  })

  // Filtrar almacenes compatibles
  const compatibleWarehouses = useMemo(() => {
    const types = COMPATIBLE_WAREHOUSE_TYPES[itemType] || []
    return warehouses.filter(w => types.includes(w.type))
  }, [warehouses, itemType])

  // Cargar niveles del ítem
  const { data: levelsData, isLoading } = useQuery({
    queryKey: ['inv-levels-by-item', itemType, itemId],
    queryFn:  () => inventoryApi.getLevelsByItem(itemType, itemId),
    enabled:  !!itemId,
  })

  const configuredLevels = levelsData?.levels || []

  // Seleccionar primer almacén compatible al cargar
  useEffect(() => {
    if (!activeWh && compatibleWarehouses.length > 0) {
      // Prioridad: initialWarehouseId > almacén con niveles existentes > default > primero
      if (initialWarehouseId && compatibleWarehouses.find(w => w.id === initialWarehouseId)) {
        setActiveWh(initialWarehouseId)
      } else {
        const existing = configuredLevels[0]?.warehouse_id
        const defaultWh = compatibleWarehouses.find(w => w.is_default)?.id
        setActiveWh(existing || defaultWh || compatibleWarehouses[0].id)
      }
    }
  }, [compatibleWarehouses, configuredLevels, activeWh, initialWarehouseId])

  // Cargar form cuando cambie el almacén seleccionado
  useEffect(() => {
    if (!activeWh) return
    const lvl = configuredLevels.find(l => l.warehouse_id === activeWh)
    if (lvl) {
      setForm({
        minStock:              lvl.min_stock?.toString() || '0',
        maxStock:              lvl.max_stock?.toString() || '',
        reorderPoint:          lvl.reorder_point?.toString() || '0',
        safetyStock:           lvl.safety_stock?.toString() || '0',
        isManualReorderPoint:  lvl.is_manual_reorder_point,
        lastCalculatedAvg:     lvl.last_calculated_avg,
      })
    } else {
      setForm({
        minStock: '0', maxStock: '', reorderPoint: '0', safetyStock: '0',
        isManualReorderPoint: true, lastCalculatedAvg: null,
      })
    }
    setServerError(null)
  }, [activeWh, configuredLevels])

  const activeLevel = configuredLevels.find(l => l.warehouse_id === activeWh)
  const currentStock = activeLevel?.current_stock != null ? parseFloat(activeLevel.current_stock) : null
  const status = useMemo(() => {
    if (currentStock == null || !activeLevel) return null
    const min = parseFloat(form.minStock || 0)
    const reord = parseFloat(form.reorderPoint || 0)
    const max = form.maxStock ? parseFloat(form.maxStock) : null
    if (currentStock < min) return { code: 'below_min', label: 'Bajo mínimo', color: 'red' }
    if (currentStock < reord) return { code: 'at_reorder', label: 'En reorden', color: 'amber' }
    if (max != null && currentStock > max) return { code: 'overstock', label: 'Sobrestock', color: 'blue' }
    return { code: 'normal', label: 'Normal', color: 'green' }
  }, [currentStock, form, activeLevel])

  const upsertMut = useMutation({
    mutationFn: (body) => inventoryApi.upsertLevel(itemType, itemId, activeWh, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['inv-levels-by-item', itemType, itemId] })
      qc.invalidateQueries({ queryKey: ['inv-levels'] })
      qc.invalidateQueries({ queryKey: ['inv-levels-summary'] })
      qc.invalidateQueries({ queryKey: ['inv-item-detail'] })
      setSavedMsg('Niveles guardados.')
      setTimeout(() => setSavedMsg(null), 3000)
    },
    onError: (err) => setServerError(err.response?.data?.error || err.message),
  })

  const removeMut = useMutation({
    mutationFn: () => inventoryApi.removeLevel(itemType, itemId, activeWh),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['inv-levels-by-item', itemType, itemId] })
      qc.invalidateQueries({ queryKey: ['inv-levels'] })
      qc.invalidateQueries({ queryKey: ['inv-levels-summary'] })
      qc.invalidateQueries({ queryKey: ['inv-item-detail'] })
      setSavedMsg('Niveles eliminados.')
      setTimeout(() => setSavedMsg(null), 3000)
    },
    onError: (err) => setServerError(err.response?.data?.error || err.message),
  })

  function handleSave() {
    setServerError(null)
    const body = {
      minStock:              parseFloat(form.minStock || 0),
      maxStock:              form.maxStock !== '' ? parseFloat(form.maxStock) : null,
      reorderPoint:          parseFloat(form.reorderPoint || 0),
      safetyStock:           parseFloat(form.safetyStock || 0),
      isManualReorderPoint:  form.isManualReorderPoint,
      lastCalculatedAvg:     form.lastCalculatedAvg,
    }
    upsertMut.mutate(body)
  }

  function handleApplySuggestion(suggested, dailyAvg) {
    setForm(f => ({
      ...f,
      reorderPoint: suggested.toString(),
      isManualReorderPoint: false,
      lastCalculatedAvg: dailyAvg,
    }))
    setShowSuggestion(false)
  }

  if (!itemId) {
    return (
      <div className="bg-surface-elevated/40 border border-line-subtle rounded-xl p-4 text-center">
        <p className="text-sm text-ink-secondary">
          Guarda primero el ítem para poder configurar sus niveles de inventario.
        </p>
      </div>
    )
  }

  if (compatibleWarehouses.length === 0) {
    return (
      <div className="bg-status-warning/10 border border-status-warning/40 rounded-xl p-4 text-sm text-status-warning">
        No hay almacenes compatibles configurados para este tipo de ítem.
        Crea un almacén tipo {COMPATIBLE_WAREHOUSE_TYPES[itemType].join(' o ')} primero.
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {/* Lead time (solo se muestra si NO está pre-controlado por el form padre) */}
      {onLeadTimeChange && (
        <div>
          <label className="label">Tiempo de entrega del proveedor</label>
          <div className="flex items-center gap-2">
            <input
              type="number"
              min="0"
              max="365"
              className="input w-24"
              value={leadTimeDays}
              onChange={e => onLeadTimeChange?.(parseInt(e.target.value) || 0)}
              disabled={readOnly}
            />
            <span className="text-sm text-ink-muted">días</span>
          </div>
          <p className="text-[11px] text-ink-muted mt-1">
            Tiempo promedio que tarda el proveedor en entregar después de hacer el pedido.
          </p>
        </div>
      )}

      {/* Selector de almacén (solo si hay >1 compatible) */}
      {compatibleWarehouses.length > 1 && (
        <div>
          <label className="label">Almacén</label>
          <select
            className="select"
            value={activeWh || ''}
            onChange={e => setActiveWh(e.target.value)}
          >
            {compatibleWarehouses.map(w => (
              <option key={w.id} value={w.id}>
                {w.name}{w.is_default ? ' ⭐' : ''}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* Niveles */}
      {isLoading ? (
        <div className="flex justify-center py-6"><Spinner /></div>
      ) : (
        <div className={clsx(
          'border rounded-xl p-4 space-y-4',
          status?.color === 'red'   && 'border-status-danger/40 bg-status-danger/10/30',
          status?.color === 'amber' && 'border-status-warning/40 bg-status-warning/10/30',
          status?.color === 'blue'  && 'border-status-info/40 bg-status-info/10/30',
          status?.color === 'green' && 'border-line-subtle bg-surface-primary',
          !status                   && 'border-line-subtle bg-surface-primary'
        )}>
          {/* Header con almacén + estado */}
          {activeWh && (
            <div className="flex items-center justify-between text-xs">
              <span className="font-medium text-ink-secondary">
                {compatibleWarehouses.find(w => w.id === activeWh)?.name}
              </span>
              {status && (
                <span className={clsx(
                  'px-2 py-0.5 rounded-full font-medium text-[10px]',
                  status.color === 'red'   && 'bg-status-danger/15 text-status-danger',
                  status.color === 'amber' && 'bg-status-warning/15 text-status-warning',
                  status.color === 'blue'  && 'bg-status-info/15 text-status-info',
                  status.color === 'green' && 'bg-status-success/15 text-status-success',
                )}>
                  {status.label}
                </span>
              )}
            </div>
          )}

          {/* Inputs */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label">Stock mínimo *</label>
              <div className="relative">
                <input
                  type="number"
                  min="0"
                  step="0.0001"
                  className="input pr-10"
                  value={form.minStock}
                  onChange={e => setForm(f => ({ ...f, minStock: e.target.value }))}
                  readOnly={readOnly}
                />
                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[10px] text-ink-muted">{unit}</span>
              </div>
            </div>
            <div>
              <label className="label">Stock máximo <span className="text-ink-muted font-normal text-[10px]">(opcional)</span></label>
              <div className="relative">
                <input
                  type="number"
                  min="0"
                  step="0.0001"
                  className="input pr-10"
                  placeholder="Sin límite"
                  value={form.maxStock}
                  onChange={e => setForm(f => ({ ...f, maxStock: e.target.value }))}
                  readOnly={readOnly}
                />
                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[10px] text-ink-muted">{unit}</span>
              </div>
            </div>
            <div>
              <label className="label flex items-center justify-between">
                <span>Punto de reorden *</span>
                {!readOnly && (
                  <button
                    type="button"
                    onClick={() => setShowSuggestion(true)}
                    className="text-[11px] text-brand-300 hover:underline flex items-center gap-1"
                    title="Calcular automáticamente"
                  >
                    💡 Sugerir
                  </button>
                )}
              </label>
              <div className="relative">
                <input
                  type="number"
                  min="0"
                  step="0.0001"
                  className="input pr-10"
                  value={form.reorderPoint}
                  onChange={e => setForm(f => ({ ...f, reorderPoint: e.target.value, isManualReorderPoint: true }))}
                  readOnly={readOnly}
                />
                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[10px] text-ink-muted">{unit}</span>
              </div>
              {!form.isManualReorderPoint && form.lastCalculatedAvg && (
                <p className="text-[11px] text-status-info mt-1">
                  💡 Calculado del consumo histórico ({fmtNum(form.lastCalculatedAvg, 2)} {unit}/día prom.)
                </p>
              )}
            </div>
            <div>
              <label className="label">Stock seguridad</label>
              <div className="relative">
                <input
                  type="number"
                  min="0"
                  step="0.0001"
                  className="input pr-10"
                  value={form.safetyStock}
                  onChange={e => setForm(f => ({ ...f, safetyStock: e.target.value }))}
                  readOnly={readOnly}
                />
                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[10px] text-ink-muted">{unit}</span>
              </div>
            </div>
          </div>

          {/* Stock actual */}
          {currentStock != null && (
            <div className="border-t border-line-subtle pt-3">
              <p className="text-xs text-ink-muted">
                Stock actual: <span className="font-bold text-ink-primary">{fmtNum(currentStock, 4)} {unit}</span>
                {activeLevel?.avg_cost > 0 && (
                  <span className="text-ink-muted ml-2">
                    · costo prom. ${fmtNum(activeLevel.avg_cost, 4)}/{unit}
                  </span>
                )}
              </p>
            </div>
          )}

          {/* Botones */}
          {!readOnly && (
            <div className="flex gap-2 pt-2 border-t border-line-subtle">
              <button
                type="button"
                onClick={handleSave}
                disabled={upsertMut.isPending}
                className="btn-primary btn-sm flex-1 disabled:opacity-50"
              >
                {upsertMut.isPending ? <Spinner size="sm" /> : (activeLevel ? 'Guardar cambios' : 'Configurar niveles')}
              </button>
              {activeLevel && (
                <button
                  type="button"
                  onClick={() => {
                    if (confirm('¿Eliminar la configuración de niveles para este almacén?')) {
                      removeMut.mutate()
                    }
                  }}
                  disabled={removeMut.isPending}
                  className="btn-secondary btn-sm text-status-danger border-status-danger/40 hover:bg-status-danger/10"
                >
                  Eliminar
                </button>
              )}
            </div>
          )}

          {savedMsg && (
            <p className="text-xs text-status-success">{savedMsg}</p>
          )}
          {serverError && (
            <p className="text-xs text-status-danger">{serverError}</p>
          )}
        </div>
      )}

      {/* Modal de sugerencia */}
      {showSuggestion && activeWh && (
        <ReorderSuggestionModal
          itemType={itemType}
          itemId={itemId}
          warehouseId={activeWh}
          leadTimeDays={leadTimeDays}
          safetyStock={parseFloat(form.safetyStock || 0)}
          unit={unit}
          onApply={handleApplySuggestion}
          onClose={() => setShowSuggestion(false)}
        />
      )}
    </div>
  )
}
