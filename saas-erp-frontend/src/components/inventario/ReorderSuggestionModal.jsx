import { useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { useQuery } from '@tanstack/react-query'
import { inventoryApi } from '@/api/inventory'
import Spinner from '@/components/ui/Spinner'

const fmtNum = (n, decimals = 2) => {
  if (n == null || isNaN(n)) return '0'
  return Number(n).toLocaleString('es-MX', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
}

/**
 * Modal del sugeridor automático de reorder_point.
 * Calcula consumo histórico y sugiere un punto de reorden.
 *
 * Props:
 *   - itemType, itemId, warehouseId
 *   - leadTimeDays, safetyStock — usados en el cálculo
 *   - unit — para mostrar (kg / pza)
 *   - onApply(suggestedValue, dailyAvg) — al aceptar la sugerencia
 *   - onClose
 */
export default function ReorderSuggestionModal({
  itemType, itemId, warehouseId, leadTimeDays, safetyStock, unit = 'kg',
  onApply, onClose,
}) {
  const [days, setDays] = useState(90)

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['inv-consumption', itemType, itemId, warehouseId, leadTimeDays, safetyStock, days],
    queryFn:  () => inventoryApi.getConsumption(itemType, itemId, {
      warehouseId,
      leadTimeDays: leadTimeDays || 7,
      safetyStock:  safetyStock || 0,
      days,
    }),
    enabled: !!warehouseId,
  })

  return createPortal(
    <div className="fixed inset-0 z-[10001] flex items-center justify-center bg-black/50 p-4">
      <div className="bg-surface-primary rounded-2xl shadow-card w-full max-w-md p-6">
        <div className="flex items-start gap-3 mb-4">
          <div className="w-10 h-10 rounded-full bg-status-info/15 flex items-center justify-center shrink-0">
            <svg className="w-5 h-5 text-status-info" fill="currentColor" viewBox="0 0 24 24">
              <path d="M9 21c0 .55.45 1 1 1h4c.55 0 1-.45 1-1v-1H9v1zm3-19C8.14 2 5 5.14 5 9c0 2.38 1.19 4.47 3 5.74V17c0 .55.45 1 1 1h6c.55 0 1-.45 1-1v-2.26c1.81-1.27 3-3.36 3-5.74 0-3.86-3.14-7-7-7zm2.85 11.1l-.85.6V16h-4v-2.3l-.85-.6C7.8 12.16 7 10.63 7 9c0-2.76 2.24-5 5-5s5 2.24 5 5c0 1.63-.8 3.16-2.15 4.1z"/>
            </svg>
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="text-base font-semibold text-ink-primary">Sugerencia de punto de reorden</h3>
            <p className="text-xs text-ink-muted mt-1">
              Basado en el consumo histórico del kardex.
            </p>
          </div>
        </div>

        {/* Selector de período */}
        <div className="flex items-center gap-2 mb-4">
          <span className="text-xs text-ink-muted">Analizar últimos:</span>
          <div className="flex bg-surface-elevated/60 rounded-lg p-0.5 text-xs">
            {[30, 60, 90, 180].map(d => (
              <button
                key={d}
                onClick={() => setDays(d)}
                className={`px-3 py-1 rounded-md font-medium transition-all ${
                  days === d ? 'bg-surface-primary shadow text-brand-300' : 'text-ink-muted hover:text-ink-secondary'
                }`}
              >
                {d}d
              </button>
            ))}
          </div>
        </div>

        {isLoading && (
          <div className="flex justify-center py-10"><Spinner /></div>
        )}

        {isError && (
          <div className="bg-status-danger/10 border border-status-danger/40 rounded-xl px-4 py-3 text-sm text-status-danger">
            {error?.response?.data?.error || 'Error al calcular la sugerencia.'}
          </div>
        )}

        {data && (
          <>
            {/* Análisis */}
            <div className="bg-surface-elevated/60 border border-line-subtle rounded-xl p-4 space-y-2 mb-4 border border-line-subtle">
              <DataRow label="Salidas totales" value={`${fmtNum(data.totalOutflow, 2)} ${unit}`} />
              <DataRow label="Días con movimiento" value={data.daysWithMovement} />
              <DataRow label="Consumo diario promedio" value={`${fmtNum(data.dailyAvg, 4)} ${unit}/día`} highlight />
            </div>

            {/* Cálculo */}
            <div className="bg-status-info/10 rounded-xl p-4 mb-4 border border-status-info/40">
              <p className="text-[10px] uppercase font-semibold text-status-info tracking-wider mb-2">Cálculo</p>
              <p className="text-xs text-status-info font-mono mb-3">
                ({fmtNum(data.dailyAvg, 4)} × {data.leadTimeDays} días)
                + {fmtNum(data.safetyStock, 2)} seguridad
              </p>
              <p className="text-2xl font-bold text-status-info">
                = {fmtNum(data.suggestedReorderPoint, 2)} <span className="text-sm font-normal">{unit}</span>
              </p>
            </div>

            {/* Advertencias */}
            {!data.reliable && data.daysWithMovement > 0 && (
              <div className="bg-status-warning/10 border border-status-warning/40 rounded-xl px-3 py-2 text-xs text-status-warning mb-4">
                ⚠️ Solo {data.daysWithMovement} días con movimiento — la estimación puede ser poco confiable.
                Considera capturar el valor manualmente.
              </div>
            )}
            {data.daysWithMovement === 0 && (
              <div className="bg-status-warning/10 border border-status-warning/40 rounded-xl px-3 py-2 text-xs text-status-warning mb-4">
                ⚠️ Sin historial de salidas en este período. La sugerencia será 0 — captura el valor manualmente.
              </div>
            )}
          </>
        )}

        {/* Botones */}
        <div className="flex gap-2 pt-2">
          <button onClick={onClose} className="btn-secondary flex-1">Cerrar</button>
          <button
            onClick={() => {
              if (data) {
                onApply(data.suggestedReorderPoint, data.dailyAvg)
              }
            }}
            disabled={isLoading || isError}
            className="btn-primary flex-1 disabled:opacity-50"
          >
            Aplicar: {data ? fmtNum(data.suggestedReorderPoint, 2) : '...'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}

function DataRow({ label, value, highlight }) {
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="text-ink-secondary">{label}</span>
      <span className={highlight ? 'font-bold text-ink-primary' : 'font-medium text-ink-secondary'}>
        {value}
      </span>
    </div>
  )
}
