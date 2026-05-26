import { useEffect, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { inventoryApi } from '@/api/inventory'
import Spinner from '@/components/ui/Spinner'

const COMPATIBLE = {
  raw_material: ['raw_material', 'regrind'],
  product:      ['finished_product', 'resale'],
}

/**
 * Captura inicial de niveles de stock para el modo creación.
 * Selecciona un almacén y captura min/max/reorden/seguridad.
 * El padre persiste los valores tras crear el producto.
 *
 * Props:
 *   itemType: 'product' | 'raw_material'
 *   unit:     'pza' | 'kg'
 *   value:    { warehouseId, minStock, maxStock, reorderPoint, safetyStock }
 *   onChange: callback
 */
export function PendingInventoryLevel({ itemType, unit = 'pza', value, onChange }) {
  const { data: warehouses = [], isLoading } = useQuery({
    queryKey: ['inv-warehouses'],
    queryFn:  inventoryApi.getWarehouses,
  })

  const compatible = useMemo(() => {
    const types = COMPATIBLE[itemType] || []
    return warehouses.filter(w => types.includes(w.type))
  }, [warehouses, itemType])

  // Auto-seleccionar el almacén default (o primero compatible) si no hay valor
  useEffect(() => {
    if (value.warehouseId || compatible.length === 0) return
    const def = compatible.find(w => w.is_default) || compatible[0]
    onChange({ ...value, warehouseId: def.id })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [compatible.length])

  function set(k, v) { onChange({ ...value, [k]: v }) }

  if (isLoading) return <div className="flex justify-center py-4"><Spinner size="sm" /></div>
  if (compatible.length === 0) {
    return (
      <div className="bg-status-warning/10 border border-status-warning/40 rounded-lg p-3 text-sm text-status-warning">
        No hay almacenes compatibles configurados. Crea un almacén de tipo{' '}
        <strong>{COMPATIBLE[itemType].join(' o ')}</strong> primero.
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <p className="text-[11px] text-ink-muted">
        Niveles iniciales para el almacén seleccionado · se aplican al crear el producto.
        Después podrás configurar más almacenes desde la edición.
      </p>

      {compatible.length > 1 && (
        <div>
          <label className="label">Almacén</label>
          <select className="select" value={value.warehouseId || ''}
            onChange={e => set('warehouseId', e.target.value)}>
            {compatible.map(w => (
              <option key={w.id} value={w.id}>
                {w.name}{w.is_default ? ' ⭐' : ''}
              </option>
            ))}
          </select>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label">Stock mínimo</label>
          <div className="relative">
            <input type="number" min="0" step="0.0001" className="input pr-10"
              value={value.minStock}
              onChange={e => set('minStock', e.target.value)} placeholder="0" />
            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[10px] text-ink-muted">{unit}</span>
          </div>
        </div>
        <div>
          <label className="label">Stock máximo
            <span className="text-ink-muted font-normal text-[10px] ml-1">(opcional)</span>
          </label>
          <div className="relative">
            <input type="number" min="0" step="0.0001" className="input pr-10"
              value={value.maxStock}
              onChange={e => set('maxStock', e.target.value)} placeholder="Sin límite" />
            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[10px] text-ink-muted">{unit}</span>
          </div>
        </div>
        <div>
          <label className="label">Punto de reorden</label>
          <div className="relative">
            <input type="number" min="0" step="0.0001" className="input pr-10"
              value={value.reorderPoint}
              onChange={e => set('reorderPoint', e.target.value)} placeholder="0" />
            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[10px] text-ink-muted">{unit}</span>
          </div>
        </div>
        <div>
          <label className="label">Stock seguridad</label>
          <div className="relative">
            <input type="number" min="0" step="0.0001" className="input pr-10"
              value={value.safetyStock}
              onChange={e => set('safetyStock', e.target.value)} placeholder="0" />
            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[10px] text-ink-muted">{unit}</span>
          </div>
        </div>
      </div>
    </div>
  )
}
