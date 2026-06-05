import { useState } from 'react'
import { createPortal } from 'react-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { inventoryApi } from '@/api/inventory'
import Spinner from '@/components/ui/Spinner'
import clsx from 'clsx'

const fmtNum = (n) => Number(n ?? 0).toLocaleString('es-MX', { minimumFractionDigits: 0, maximumFractionDigits: 4 })

const STATUS_LABEL = { available: 'Disponible', wip: 'En proceso', blocked: 'Bloqueado' }

/**
 * Recalcula los saldos de inventario a partir del kardex (suma de movimientos).
 * Primero muestra una VISTA PREVIA del diff (antes → después) y solo aplica al
 * confirmar. Revela negativos por sobreventas que el clamp histórico ocultó.
 */
export default function RecomputeStockModal({ onClose, onApplied }) {
  const qc = useQueryClient()
  const [applyError, setApplyError] = useState(null)

  // Vista previa (apply=false): NO escribe nada.
  const { data: preview, isLoading, error } = useQuery({
    queryKey: ['inv-recompute-preview'],
    queryFn:  () => inventoryApi.recomputeStock(false),
    staleTime: 0,
    gcTime: 0,
  })

  const applyMut = useMutation({
    mutationFn: () => inventoryApi.recomputeStock(true),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['inv-stock'] })
      qc.invalidateQueries({ queryKey: ['inv-summary'] })
      qc.invalidateQueries({ queryKey: ['inv-levels'] })
      qc.invalidateQueries({ queryKey: ['inv-levels-summary'] })
      onApplied?.(res)
    },
    onError: (e) => setApplyError(e.response?.data?.error || e.message || 'No se pudo recalcular.'),
  })

  const diffs = preview?.diffs || []

  return createPortal(
    <div className="fixed inset-0 z-[9998] flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="card w-full max-w-3xl max-h-[90vh] overflow-hidden flex flex-col p-0"
        onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-start justify-between p-5 border-b border-line-subtle gap-4">
          <div className="min-w-0">
            <p className="eyebrow">INVENTARIO</p>
            <h2 className="text-lg font-semibold text-ink-primary mt-1">Recalcular saldos desde el kardex</h2>
            <p className="text-sm text-ink-muted mt-1">
              Compara el saldo actual contra la suma real de movimientos. Aquí ves qué cambiaría
              antes de aplicarlo — revela negativos por ventas sin existencia capturada.
            </p>
          </div>
          <button onClick={onClose} className="btn-ghost btn-icon text-ink-muted shrink-0">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12"/>
            </svg>
          </button>
        </div>

        {/* Cuerpo */}
        <div className="flex-1 overflow-y-auto p-5">
          {isLoading ? (
            <div className="flex justify-center py-12"><Spinner /></div>
          ) : error ? (
            <div className="alert-error text-sm">
              {error.response?.data?.error || error.message || 'Error al calcular la vista previa.'}
            </div>
          ) : diffs.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-12 text-center">
              <p className="font-medium text-status-success">✓ Todo cuadra</p>
              <p className="text-sm text-ink-muted">Los saldos ya coinciden con el kardex. No hay nada que recalcular.</p>
            </div>
          ) : (
            <>
              <p className="text-sm text-ink-secondary mb-3">
                <strong>{diffs.length}</strong> saldo(s) no cuadran con el kardex y se corregirían:
              </p>
              <div className="overflow-x-auto">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Artículo</th>
                      <th>Almacén</th>
                      <th>Estado</th>
                      <th className="text-right">Actual</th>
                      <th className="text-right">Calculado</th>
                      <th className="text-right">Δ</th>
                    </tr>
                  </thead>
                  <tbody>
                    {diffs.map((d, i) => (
                      <tr key={`${d.itemType}-${d.itemId}-${d.warehouseId}-${d.status}-${i}`}>
                        <td className="font-medium text-ink-primary">
                          {d.itemName}
                          {d.sku && <span className="ml-1 text-xs text-ink-muted">#{d.sku}</span>}
                          <span className="ml-1 text-[10px] text-ink-muted">
                            {d.itemType === 'raw_material' ? 'MP' : 'PT'}
                          </span>
                        </td>
                        <td className="text-ink-secondary text-sm">{d.warehouseName}</td>
                        <td className="text-xs text-ink-muted">{STATUS_LABEL[d.status] || d.status}</td>
                        <td className="text-right font-mono text-sm text-ink-secondary">{fmtNum(d.currentQty)}</td>
                        <td className={clsx('text-right font-mono text-sm font-semibold',
                          d.computedQty < 0 ? 'text-status-danger' : 'text-ink-primary')}>
                          {fmtNum(d.computedQty)}
                        </td>
                        <td className={clsx('text-right font-mono text-xs',
                          d.delta < 0 ? 'text-status-danger' : 'text-status-success')}>
                          {d.delta > 0 ? '+' : ''}{fmtNum(d.delta)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {applyError && <p className="field-error mt-3">{applyError}</p>}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 p-4 border-t border-line-subtle">
          <button onClick={onClose} className="btn-secondary">Cerrar</button>
          {diffs.length > 0 && (
            <button onClick={() => { setApplyError(null); applyMut.mutate() }}
              disabled={applyMut.isPending}
              className="btn-primary">
              {applyMut.isPending ? <Spinner size="sm" /> : `Aplicar ${diffs.length} corrección(es)`}
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body
  )
}
