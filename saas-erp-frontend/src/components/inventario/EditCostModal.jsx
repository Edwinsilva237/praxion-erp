import { useState } from 'react'
import { createPortal } from 'react-dom'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { inventoryApi } from '@/api/inventory'
import Spinner from '@/components/ui/Spinner'

const fmtMXN = (n) => new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 2 }).format(n || 0)
const fmtNum = (n) => new Intl.NumberFormat('es-MX', { maximumFractionDigits: 4 }).format(n || 0)

/**
 * Edita manualmente el COSTO UNITARIO (avg_cost) de un artículo en un almacén.
 * Para corregir productos a $0 o con costo mal calculado. Registra auditoría.
 */
export default function EditCostModal({ row, onClose, onSaved }) {
  const qc = useQueryClient()
  const [cost, setCost] = useState(row.avg_cost != null ? String(row.avg_cost) : '')
  const [note, setNote] = useState('')
  const [error, setError] = useState(null)

  const qty = parseFloat(row.quantity) || 0
  const newCost = cost === '' ? 0 : parseFloat(cost)
  const newValue = qty * (isNaN(newCost) ? 0 : newCost)

  const saveMut = useMutation({
    mutationFn: () => inventoryApi.setStockCost({
      itemType:    row.item_type,
      itemId:      row.item_id,
      warehouseId: row.warehouse_id,
      status:      row.status || 'available',
      unitCost:    newCost,
      note:        note.trim() || null,
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['inv-stock'] })
      qc.invalidateQueries({ queryKey: ['inv-summary'] })
      qc.invalidateQueries({ queryKey: ['inventory-report'] })
      onSaved?.()
    },
    onError: (e) => setError(e.response?.data?.error || e.message || 'No se pudo guardar el costo.'),
  })

  const valid = cost !== '' && !isNaN(newCost) && newCost >= 0

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40 p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="card w-full max-w-md p-6">
        <p className="eyebrow">INVENTARIO</p>
        <h2 className="text-base font-semibold text-ink-primary mt-1">Editar costo unitario</h2>
        <p className="text-sm text-ink-secondary mt-2">
          {row.item_name}{row.sku && <span className="text-ink-muted"> #{row.sku}</span>}
        </p>
        <p className="text-xs text-ink-muted">
          {row.warehouse_name} · Existencia {fmtNum(qty)} {row.unit}
        </p>

        <div className="grid grid-cols-2 gap-3 mt-4 text-sm">
          <div className="rounded-lg bg-surface-elevated/40 border border-line-subtle p-3">
            <p className="text-[10px] uppercase tracking-wide text-ink-muted">Costo actual</p>
            <p className="font-semibold tabular-nums">{fmtMXN(row.avg_cost)}</p>
            <p className="text-[10px] text-ink-muted mt-1">Valor {fmtMXN(qty * (parseFloat(row.avg_cost) || 0))}</p>
          </div>
          <div className="rounded-lg bg-brand-500/10 border border-brand-500/30 p-3">
            <p className="text-[10px] uppercase tracking-wide text-ink-muted">Nuevo costo</p>
            <p className="font-semibold tabular-nums text-brand-300">{fmtMXN(isNaN(newCost) ? 0 : newCost)}</p>
            <p className="text-[10px] text-ink-muted mt-1">Valor {fmtMXN(newValue)}</p>
          </div>
        </div>

        <label className="label mt-4">Costo unitario (por {row.unit || 'unidad'})</label>
        <input type="number" step="0.0001" min="0" className="input tabular-nums"
          value={cost} onChange={e => setCost(e.target.value)} autoFocus placeholder="0.00" />

        <label className="label mt-3">Nota (opcional)</label>
        <input type="text" className="input text-sm"
          value={note} onChange={e => setNote(e.target.value)}
          placeholder="Ej. costo del maquilador, corrección de costeo…" />

        <p className="text-[11px] text-ink-muted mt-2">
          Ajusta el costo promedio de este renglón. Queda registrado en la bitácora de auditoría.
          No genera movimiento de kardex ni cambia la cantidad.
        </p>

        {error && <div className="bg-status-danger/10 border border-status-danger/40 rounded-lg p-3 mt-3 text-xs text-status-danger">{error}</div>}

        <div className="flex gap-2 mt-4">
          <button onClick={onClose} className="btn-secondary flex-1">Cancelar</button>
          <button onClick={() => { setError(null); saveMut.mutate() }}
            disabled={!valid || saveMut.isPending} className="btn-primary flex-1 disabled:opacity-50">
            {saveMut.isPending ? <Spinner size="sm" /> : 'Guardar costo'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
