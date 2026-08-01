import { useState, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { inventoryApi } from '@/api/inventory'
import Spinner from '@/components/ui/Spinner'
import { fmtDateOnly } from '@/utils/fmt'

const fmtMXN = (n) => new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 2 }).format(n || 0)
const fmtNum = (n) => new Intl.NumberFormat('es-MX', { maximumFractionDigits: 4 }).format(n || 0)

/**
 * Traspaso entre almacenes: mueve stock disponible de un almacén a otro con un
 * par de movimientos ligados en el kardex (salida en origen + entrada en
 * destino) al costo promedio del origen. Si el artículo maneja lotes, se mueven
 * LOTES COMPLETOS (el lote se reubica para que FEFO/trazabilidad lo encuentren
 * en el destino); sin lotes, se mueve una cantidad suelta.
 */
export default function TransferStockModal({ row, warehouses, onClose, onSaved }) {
  const qc = useQueryClient()
  const maxQty = parseFloat(row.quantity) || 0
  const cost   = parseFloat(row.avg_cost) || 0

  const [toWarehouseId, setToWH] = useState('')
  const [qty, setQty]            = useState('')
  const [selectedLots, setSelectedLots] = useState(new Set())
  const [note, setNote]          = useState('')
  const [error, setError]        = useState(null)

  // Lotes activos con saldo en el almacén de origen. Vacío = va por cantidad.
  const { data: lots = [], isLoading: lotsLoading } = useQuery({
    queryKey: ['inv-transfer-lots', row.item_type, row.item_id, row.warehouse_id],
    queryFn: () => inventoryApi.getTransferableLots({
      itemType: row.item_type, itemId: row.item_id, warehouseId: row.warehouse_id,
    }),
  })
  const byLots = lots.length > 0

  // Destinos: activos, distintos al origen y nunca WIP (solo producción los mueve).
  const destOptions = useMemo(
    () => (warehouses || []).filter(w => w.id !== row.warehouse_id && w.type !== 'wip'),
    [warehouses, row.warehouse_id])

  const selectedQty = byLots
    ? lots.filter(l => selectedLots.has(l.id)).reduce((s, l) => s + parseFloat(l.quantity_remaining), 0)
    : (qty === '' ? 0 : parseFloat(qty))

  function toggleLot(id) {
    setSelectedLots(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  const transferMut = useMutation({
    mutationFn: () => inventoryApi.transferStock({
      itemType:        row.item_type,
      itemId:          row.item_id,
      fromWarehouseId: row.warehouse_id,
      toWarehouseId,
      quantity:        byLots ? undefined : parseFloat(qty),
      lotIds:          byLots ? Array.from(selectedLots) : undefined,
      note:            note.trim(),
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['inv-stock'] })
      qc.invalidateQueries({ queryKey: ['inv-summary'] })
      qc.invalidateQueries({ queryKey: ['inv-movements'] })
      qc.invalidateQueries({ queryKey: ['inventory-report'] })
      onSaved?.()
    },
    onError: (e) => setError(e.response?.data?.error || e.message || 'No se pudo hacer el traspaso.'),
  })

  const valid = toWarehouseId && note.trim() && (byLots
    ? selectedLots.size > 0
    : (qty !== '' && !isNaN(selectedQty) && selectedQty > 0 && selectedQty <= maxQty + 1e-6))

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40 p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="card w-full max-w-md p-6 max-h-[90vh] overflow-y-auto">
        <p className="eyebrow">INVENTARIO · TRASPASO</p>
        <h2 className="text-base font-semibold text-ink-primary mt-1">Traspasar a otro almacén</h2>
        <p className="text-sm text-ink-secondary mt-2">
          {row.item_name}{row.sku && <span className="text-ink-muted"> #{row.sku}</span>}
        </p>
        <p className="text-xs text-ink-muted">
          Origen: {row.warehouse_name} · Disponible {fmtNum(maxQty)} {row.unit} · Costo {fmtMXN(cost)}
        </p>

        <label className="label mt-4">Almacén destino <span className="text-status-danger">*</span></label>
        <select className="select" value={toWarehouseId} onChange={e => setToWH(e.target.value)}>
          <option value="">Seleccionar almacén...</option>
          {destOptions.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
        </select>

        {lotsLoading ? (
          <div className="flex justify-center py-6"><Spinner /></div>
        ) : byLots ? (
          <>
            <label className="label mt-3">Lotes a mover (se mueven completos)</label>
            <div className="border border-line-subtle rounded-lg divide-y divide-line-subtle max-h-48 overflow-y-auto">
              {lots.map(l => (
                <label key={l.id} className="flex items-center gap-2 px-3 py-2 text-sm cursor-pointer hover:bg-surface-elevated/50">
                  <input type="checkbox" className="w-4 h-4 accent-brand-600"
                    checked={selectedLots.has(l.id)} onChange={() => toggleLot(l.id)} />
                  <span className="flex-1 min-w-0 font-mono text-xs truncate text-ink-primary">{l.lot_number}</span>
                  <span className="text-[11px] text-ink-muted shrink-0">
                    {fmtNum(l.quantity_remaining)} {row.unit}
                    {l.expiry_date && ` · cad. ${fmtDateOnly(l.expiry_date)}`}
                  </span>
                </label>
              ))}
            </div>
            <p className="text-[11px] text-ink-muted mt-1">
              Seleccionado: {fmtNum(selectedQty)} {row.unit} en {selectedLots.size} lote(s).
            </p>
          </>
        ) : (
          <>
            <label className="label mt-3">Cantidad a traspasar (máx. {fmtNum(maxQty)} {row.unit})</label>
            <div className="flex gap-2">
              <input type="number" step="0.0001" min="0" max={maxQty} className="input tabular-nums flex-1"
                value={qty} onChange={e => setQty(e.target.value)} autoFocus />
              <button type="button" className="btn-secondary shrink-0"
                onClick={() => setQty(String(maxQty))}>Todo</button>
            </div>
          </>
        )}

        <label className="label mt-3">Motivo <span className="text-status-danger">*</span></label>
        <input type="text" className="input text-sm"
          value={note} onChange={e => setNote(e.target.value)}
          placeholder="Ej. se recibió en el almacén equivocado, reacomodo…" />

        <p className="text-[11px] text-ink-muted mt-3">
          Sale de <b>{row.warehouse_name}</b> y entra al destino con su costo de {fmtMXN(cost)} — la
          valuación viaja intacta. Queda como un par de movimientos ligados en el kardex y en la
          bitácora de auditoría.
        </p>

        {error && <div className="bg-status-danger/10 border border-status-danger/40 rounded-lg p-3 mt-3 text-xs text-status-danger">{error}</div>}

        <div className="flex gap-2 mt-4">
          <button onClick={onClose} className="btn-secondary flex-1">Cancelar</button>
          <button onClick={() => { setError(null); transferMut.mutate() }}
            disabled={!valid || transferMut.isPending} className="btn-primary flex-1 disabled:opacity-50">
            {transferMut.isPending ? <Spinner size="sm" /> : '⇄ Traspasar'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
