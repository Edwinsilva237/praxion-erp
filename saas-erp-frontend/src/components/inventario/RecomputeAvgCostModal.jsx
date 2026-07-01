import { useState } from 'react'
import { createPortal } from 'react-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { inventoryApi } from '@/api/inventory'
import Spinner from '@/components/ui/Spinner'
import clsx from 'clsx'

const fmtMXN = (n) => new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 2 }).format(n || 0)
const fmtMXN0 = (n) => new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 }).format(n || 0)

/**
 * Recalcula el COSTO PROMEDIO de inventario reproduciendo el kardex. Corrige
 * promedios "pegados" en un valor que los movimientos no justifican (importación,
 * saldo inicial o entradas $0 que no bajan el promedio). Muestra vista previa
 * (costo actual → recalculado, e impacto en valor) antes de aplicar.
 */
export default function RecomputeAvgCostModal({ onClose, onApplied }) {
  const qc = useQueryClient()
  const [applyError, setApplyError] = useState(null)

  const { data: preview, isLoading, error } = useQuery({
    queryKey: ['inv-recompute-avgcost-preview'],
    queryFn:  () => inventoryApi.recomputeAvgCost(false),
    staleTime: 0, gcTime: 0,
  })

  const applyMut = useMutation({
    mutationFn: () => inventoryApi.recomputeAvgCost(true),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['inv-stock'] })
      qc.invalidateQueries({ queryKey: ['inv-summary'] })
      qc.invalidateQueries({ queryKey: ['inventory-report'] })
      onApplied?.(res)
    },
    onError: (e) => setApplyError(e.response?.data?.error || e.message || 'No se pudo recalcular.'),
  })

  const diffs = preview?.diffs || []
  const totalDelta = diffs.reduce((s, d) => s + (d.valueDelta || 0), 0)

  return createPortal(
    <div className="fixed inset-0 z-[9998] flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="card w-full max-w-3xl max-h-[90vh] overflow-hidden flex flex-col p-0" onClick={e => e.stopPropagation()}>
        <div className="flex items-start justify-between p-5 border-b border-line-subtle gap-4">
          <div className="min-w-0">
            <p className="eyebrow">INVENTARIO</p>
            <h2 className="text-lg font-semibold text-ink-primary mt-1">Recalcular costo promedio desde el kardex</h2>
            <p className="text-sm text-ink-muted mt-1">
              Reproduce los movimientos y recalcula el costo promedio real de cada artículo.
              Corrige promedios "pegados" en un valor que el kardex no justifica.
            </p>
          </div>
          <button onClick={onClose} className="btn-ghost btn-icon text-ink-muted shrink-0">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12"/>
            </svg>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5">
          {isLoading ? (
            <div className="flex justify-center py-12"><Spinner /></div>
          ) : error ? (
            <div className="alert-error text-sm">{error.response?.data?.error || error.message || 'Error al calcular la vista previa.'}</div>
          ) : diffs.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-12 text-center">
              <p className="font-medium text-status-success">Todo cuadra</p>
              <p className="text-sm text-ink-muted">El costo promedio ya coincide con el kardex. No hay nada que recalcular.</p>
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
                <p className="text-sm text-ink-secondary">
                  <strong>{diffs.length}</strong> artículo(s) con costo promedio que no cuadra con el kardex:
                </p>
                <p className="text-sm">
                  Impacto en valor:{' '}
                  <span className={clsx('font-semibold tabular-nums', totalDelta < 0 ? 'text-status-danger' : 'text-status-success')}>
                    {totalDelta > 0 ? '+' : ''}{fmtMXN0(totalDelta)}
                  </span>
                </p>
              </div>
              <div className="overflow-x-auto">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Artículo</th>
                      <th>Almacén</th>
                      <th className="text-right">Existencia</th>
                      <th className="text-right">Costo actual</th>
                      <th className="text-right">Recalculado</th>
                      <th className="text-right">Valor Δ</th>
                    </tr>
                  </thead>
                  <tbody>
                    {diffs.map((d, i) => (
                      <tr key={`${d.stockId}-${i}`}>
                        <td className="font-medium text-ink-primary">
                          {d.itemName}{d.code && <span className="ml-1 text-xs text-ink-muted">#{d.code}</span>}
                        </td>
                        <td className="text-ink-secondary text-sm">{d.warehouseName}</td>
                        <td className="text-right font-mono text-sm text-ink-secondary">{new Intl.NumberFormat('es-MX').format(d.quantity)}</td>
                        <td className="text-right font-mono text-sm text-ink-secondary">{fmtMXN(d.currentAvgCost)}</td>
                        <td className="text-right font-mono text-sm font-semibold text-ink-primary">{fmtMXN(d.recomputedAvgCost)}</td>
                        <td className={clsx('text-right font-mono text-xs', d.valueDelta < 0 ? 'text-status-danger' : 'text-status-success')}>
                          {d.valueDelta > 0 ? '+' : ''}{fmtMXN0(d.valueDelta)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="text-[11px] text-ink-muted mt-3">
                Nota: si el kardex tiene entradas a costo $0 (producción sin costear o compras a $0), el recalculado bajará —
                esas entradas no tienen costo real. Costea esos movimientos (valida turnos, da de alta compras con costo) para el valor correcto.
              </p>
            </>
          )}
          {applyError && <p className="field-error mt-3">{applyError}</p>}
        </div>

        <div className="flex items-center justify-end gap-2 p-4 border-t border-line-subtle">
          <button onClick={onClose} className="btn-secondary">Cerrar</button>
          {diffs.length > 0 && (
            <button onClick={() => { setApplyError(null); applyMut.mutate() }} disabled={applyMut.isPending} className="btn-primary">
              {applyMut.isPending ? <Spinner size="sm" /> : `Aplicar ${diffs.length} corrección(es)`}
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body
  )
}
