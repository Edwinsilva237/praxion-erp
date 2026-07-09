import { useState } from 'react'
import { createPortal } from 'react-dom'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { inventoryApi } from '@/api/inventory'
import Spinner from '@/components/ui/Spinner'

const fmtMXN = (n) => new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 2 }).format(n || 0)
const fmtNum = (n) => new Intl.NumberFormat('es-MX', { maximumFractionDigits: 4 }).format(n || 0)

/**
 * Libera stock de 2ª calidad ('blocked') a 'available' para poder venderlo.
 * Mueve dentro del mismo almacén conservando el costo (se promedia en disponible).
 * Registra dos movimientos de ajuste en el kardex.
 */
export default function ReleaseBlockedModal({ row, onClose, onSaved }) {
  const qc = useQueryClient()
  const maxQty = parseFloat(row.quantity) || 0
  const [qty, setQty]   = useState(String(maxQty))
  const [note, setNote] = useState('')
  const [error, setError] = useState(null)

  const relQty = qty === '' ? 0 : parseFloat(qty)
  const cost   = parseFloat(row.avg_cost) || 0

  const relMut = useMutation({
    mutationFn: () => inventoryApi.releaseBlockedStock({
      itemId:      row.item_id,
      warehouseId: row.warehouse_id,
      quantity:    relQty,
      note:        note.trim() || null,
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['inv-stock'] })
      qc.invalidateQueries({ queryKey: ['inv-summary'] })
      qc.invalidateQueries({ queryKey: ['inventory-report'] })
      onSaved?.()
    },
    onError: (e) => setError(e.response?.data?.error || e.message || 'No se pudo liberar el stock.'),
  })

  const valid = qty !== '' && !isNaN(relQty) && relQty > 0 && relQty <= maxQty + 1e-6

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40 p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="card w-full max-w-md p-6">
        <p className="eyebrow">INVENTARIO · 2ª CALIDAD</p>
        <h2 className="text-base font-semibold text-ink-primary mt-1">Liberar a disponible</h2>
        <p className="text-sm text-ink-secondary mt-2">
          {row.item_name}{row.sku && <span className="text-ink-muted"> #{row.sku}</span>}
        </p>
        <p className="text-xs text-ink-muted">
          {row.warehouse_name} · Bloqueado {fmtNum(maxQty)} {row.unit} · Costo {fmtMXN(cost)}
        </p>

        <label className="label mt-4">Cantidad a liberar (máx. {fmtNum(maxQty)} {row.unit})</label>
        <div className="flex gap-2">
          <input type="number" step="0.0001" min="0" max={maxQty} className="input tabular-nums flex-1"
            value={qty} onChange={e => setQty(e.target.value)} autoFocus />
          <button type="button" className="btn-secondary shrink-0"
            onClick={() => setQty(String(maxQty))}>Todo</button>
        </div>

        <label className="label mt-3">Nota (opcional)</label>
        <input type="text" className="input text-sm"
          value={note} onChange={e => setNote(e.target.value)}
          placeholder="Ej. aprobado para venta como 2ª, revisión de calidad…" />

        <p className="text-[11px] text-ink-muted mt-3">
          Mueve {fmtNum(isNaN(relQty) ? 0 : relQty)} {row.unit} de <b>Bloqueado</b> a <b>Disponible</b> en el mismo
          almacén, con su costo de {fmtMXN(cost)} (se promedia en el saldo disponible). Queda en el kardex y en la
          bitácora de auditoría. Después podrás venderlo normal.
        </p>

        {error && <div className="bg-status-danger/10 border border-status-danger/40 rounded-lg p-3 mt-3 text-xs text-status-danger">{error}</div>}

        <div className="flex gap-2 mt-4">
          <button onClick={onClose} className="btn-secondary flex-1">Cancelar</button>
          <button onClick={() => { setError(null); relMut.mutate() }}
            disabled={!valid || relMut.isPending} className="btn-primary flex-1 disabled:opacity-50">
            {relMut.isPending ? <Spinner size="sm" /> : 'Liberar a disponible'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
