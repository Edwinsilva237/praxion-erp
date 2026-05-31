import { useQuery } from '@tanstack/react-query'
import { productionApi } from '@/api/production'
import Spinner from '@/components/ui/Spinner'

/**
 * Pantalla de resumen del turno cerrado.
 *
 * Aparece cuando el operador acaba de cerrar su turno (o cuando recarga la
 * página y su production_shift sigue en `pending_handover` con closed_at
 * poblado — es decir, ya cerró y está esperando validación del supervisor).
 *
 * Props:
 *   shiftId:      UUID del production_shift recién cerrado.
 *   onReopen:     callback al presionar "Reabrir turno". Recibe shiftId.
 *   onExit:       callback al presionar "Volver". Cierra la pantalla.
 *   reopenPending: boolean — true mientras la mutation de reabrir está en curso.
 */
export default function ClosedShiftSummary({ shiftId, onReopen, onExit, reopenPending, allowSelfStart, onStartNew }) {
  const { data: summary, isLoading, error } = useQuery({
    queryKey: ['closed-shift-summary', shiftId],
    queryFn: () => productionApi.getClosedSummary(shiftId),
    enabled: !!shiftId,
    refetchInterval: 30000, // refresca por si el supervisor valida mientras lo veo
    staleTime: 0,
  })

  if (isLoading) {
    return (
      <div className="max-w-2xl mx-auto p-6 text-center">
        <Spinner />
      </div>
    )
  }

  if (error) {
    return (
      <div className="max-w-2xl mx-auto p-6">
        <div className="bg-status-danger/10 border-2 border-status-danger/40 rounded-2xl p-6">
          <p className="text-sm font-bold text-status-danger">No se pudo cargar el resumen del turno.</p>
          <p className="text-xs text-status-danger mt-1">
            {error.response?.data?.error || error.message}
          </p>
          <button onClick={onExit} className="mt-3 btn-secondary">
            Volver
          </button>
        </div>
      </div>
    )
  }

  if (!summary) return null

  const minutesSinceClosed = summary.closed_at
    ? Math.floor((Date.now() - new Date(summary.closed_at).getTime()) / 60000)
    : 0
  const canReopen = summary.status === 'pending_handover' && minutesSinceClosed < 30

  return (
    <div className="page-enter max-w-2xl mx-auto p-4 sm:p-6 space-y-4">
      {/* Header: turno finalizado */}
      <div className="bg-status-success/10 border-2 border-status-success/40 rounded-2xl p-5 text-center">
        <div className="w-12 h-12 rounded-full bg-status-success/15 flex items-center justify-center mx-auto mb-2">
          <svg className="w-6 h-6 text-status-success" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7"/>
          </svg>
        </div>
        <p className="font-semibold text-ink-primary">Turno finalizado</p>
        <p className="text-sm text-ink-secondary mt-1">
          {summary.status === 'reviewed'
            ? 'Tu turno ya fue validado por el supervisor.'
            : 'Tu turno fue enviado para validación del supervisor.'}
        </p>
      </div>

      {/* Resumen del turno */}
      <div className="bg-surface-primary border border-line-subtle rounded-2xl p-4 sm:p-5 space-y-4">
        <h2 className="font-bold text-ink-primary flex items-center gap-2">
          <span>📋</span> Resumen del turno
        </h2>

        {/* Datos generales */}
        <div className="grid grid-cols-2 gap-2 text-sm">
          <div className="text-ink-secondary">Operador:</div>
          <div className="font-medium">{summary.operator_name}</div>

          <div className="text-ink-secondary">Turno:</div>
          <div className="font-medium">
            {summary.shift_number} · Línea {summary.line_id}
          </div>

          <div className="text-ink-secondary">Fecha:</div>
          <div className="font-medium">
            {summary.shift_date_formatted || summary.shift_date}
          </div>

          <div className="text-ink-secondary">Duración:</div>
          <div className="font-medium">{summary.duration_text || '—'}</div>
        </div>

        <hr className="border-line-subtle" />

        {/* Producción */}
        <div>
          <h3 className="text-sm font-semibold text-ink-primary mb-2 flex items-center gap-1.5">
            <span>📦</span> Producción
          </h3>
          <div className="grid grid-cols-2 gap-2 text-sm">
            <div className="text-ink-secondary">Paquetes capturados:</div>
            <div className="font-medium">{summary.packages_total ?? 0}</div>

            <div className="text-ink-secondary pl-3">• Primera calidad:</div>
            <div className="font-medium">{summary.packages_first ?? 0}</div>

            <div className="text-ink-secondary pl-3">• Segunda calidad:</div>
            <div className="font-medium">{summary.packages_second ?? 0}</div>

            <div className="text-ink-secondary">Piezas producidas:</div>
            <div className="font-medium">{summary.units_produced ?? 0}</div>
          </div>
        </div>

        {/* Materia prima */}
        <div>
          <h3 className="text-sm font-semibold text-ink-primary mb-2 flex items-center gap-1.5">
            <span>⚖️</span> Materia prima
          </h3>
          <div className="grid grid-cols-2 gap-2 text-sm">
            <div className="text-ink-secondary">MP consumida:</div>
            <div className="font-medium">
              {Number(summary.mp_total_kg || 0).toFixed(2)} kg
            </div>

            <div className="text-ink-secondary pl-3">• En paquetes:</div>
            <div className="font-medium">
              {Number(summary.mp_packages_kg || 0).toFixed(2)} kg
            </div>

            <div className="text-ink-secondary pl-3">• En merma:</div>
            <div className="font-medium">
              {Number(summary.mp_scrap_kg || 0).toFixed(2)} kg
            </div>
          </div>
        </div>

        {/* Incidentes (solo si hubo) */}
        {summary.incidents_by_category && summary.incidents_by_category.length > 0 && (
          <div>
            <h3 className="text-sm font-semibold text-ink-primary mb-2 flex items-center gap-1.5">
              <span>⚠️</span> Incidentes
            </h3>
            <div className="space-y-1 text-sm">
              {summary.incidents_by_category.map((inc) => (
                <div key={inc.category} className="flex justify-between">
                  <span className="text-ink-secondary">{inc.category_label}:</span>
                  <span className="font-medium">
                    {inc.count} {inc.count === 1 ? 'incidente' : 'incidentes'}
                    {inc.total_minutes > 0 && ` (${inc.total_minutes} min)`}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Orden activa al cerrar (solo si hubo) */}
        {summary.active_order && (
          <>
            <hr className="border-line-subtle" />
            <div>
              <h3 className="text-sm font-semibold text-ink-primary mb-2 flex items-center gap-1.5">
                <span>🎯</span> Orden activa al cerrar
              </h3>
              <div className="text-sm space-y-0.5">
                <p>
                  <span className="font-mono text-xs text-ink-muted">
                    {summary.active_order.order_number}
                  </span>
                </p>
                <p className="font-medium">{summary.active_order.product_name}</p>
                <p className="text-ink-secondary">
                  Avance: {summary.active_order.units_produced} / {summary.active_order.units_target} piezas
                  {' '}({summary.active_order.progress_pct?.toFixed(0)}%)
                </p>
              </div>
            </div>
          </>
        )}
      </div>

      {/* Acciones */}
      <div className="flex flex-col sm:flex-row gap-3 pt-2">
        {/* Micro pyme: iniciar OTRO turno sin esperar a que se valide el cerrado. */}
        {allowSelfStart && onStartNew && (
          <button
            onClick={onStartNew}
            className="flex-1 bg-brand-500/10 hover:bg-brand-500/15 border-2 border-brand-500/40 text-brand-300 font-semibold py-3 px-4 rounded-xl"
          >
            ▶ Iniciar nuevo turno
          </button>
        )}
        {canReopen && (
          <button
            onClick={() => onReopen?.(shiftId)}
            disabled={reopenPending}
            className="flex-1 bg-status-warning/10 hover:bg-status-warning/15 border-2 border-status-warning/40 text-status-warning font-semibold py-3 px-4 rounded-xl disabled:opacity-50"
          >
            {reopenPending
              ? <Spinner className="w-4 h-4 mx-auto" />
              : `Reabrir turno (${30 - minutesSinceClosed} min restantes)`}
          </button>
        )}
        <button
          onClick={onExit}
          className="flex-1 bg-surface-elevated/60 hover:bg-surface-elevated text-ink-secondary font-semibold py-3 px-4 rounded-xl"
        >
          Volver al menú
        </button>
      </div>

      {canReopen && (
        <p className="text-xs text-ink-muted text-center">
          Solo puedes reabrir tu turno dentro de los 30 min posteriores al cierre.
        </p>
      )}
    </div>
  )
}
