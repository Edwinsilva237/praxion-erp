import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { productionApi } from '../../../api/production'

/**
 * Pantalla de recepción de turno.
 *
 * Aparece cuando el operador entrante tiene un production_shift en
 * estado `pending_handover` Y el turno saliente ya cerró
 * (también está en `pending_handover`).
 *
 * Props:
 *   incomingShiftId: UUID del production_shift del operador entrante (el actual)
 *   onAccepted:      callback al activar el turno (refresca el state del padre)
 */
export default function HandoverReceptionScreen({ incomingShiftId, onAccepted }) {
  const qc = useQueryClient()
  const [showIssueModal, setShowIssueModal] = useState(false)
  const [issueText, setIssueText] = useState('')
  const [submitError, setSubmitError] = useState(null)

  // Trae el resumen del turno saliente (calculado en backend)
  const { data: summary, isLoading, error } = useQuery({
    queryKey: ['handover-summary', incomingShiftId],
    queryFn: () => productionApi.getHandoverSummary(incomingShiftId),
    refetchInterval: 5000, // por si el saliente aún no ha cerrado
    enabled: !!incomingShiftId,
  })

  const acceptMutation = useMutation({
    mutationFn: (body) => productionApi.acceptHandover(incomingShiftId, body),
    onSuccess: () => {
      setSubmitError(null)
      qc.invalidateQueries({ queryKey: ['active-shifts'] })
      qc.invalidateQueries({ queryKey: ['my-today-shifts'] })
      qc.invalidateQueries({ queryKey: ['handover-summary', incomingShiftId] })
      setShowIssueModal(false)
      setIssueText('')
      if (onAccepted) onAccepted()
    },
    onError: (e) => setSubmitError(e.response?.data?.error || 'Error al recibir el turno'),
  })

  if (isLoading) {
    return (
      <div className="p-6 text-center text-ink-secondary">
        Cargando resumen del turno saliente...
      </div>
    )
  }

  // Si el saliente aún no cerró, mostramos pantalla de espera
  if (error?.response?.status === 409 || summary?.outgoing_status === 'active') {
    return (
      <div className="max-w-2xl mx-auto p-6 mt-8">
        <div className="bg-status-warning/10 border-2 border-status-warning/40 rounded-2xl p-6 text-center">
          <div className="text-4xl mb-3">⏳</div>
          <h2 className="text-lg font-bold text-status-warning">
            Esperando cierre del turno anterior
          </h2>
          <p className="text-sm text-status-warning mt-2">
            {summary?.outgoing_operator_name || 'El operador anterior'} aún tiene el turno activo.
            Cuando cierre, podrás recibir la línea.
          </p>
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="max-w-2xl mx-auto p-6 mt-8">
        <div className="bg-status-danger/10 border-2 border-status-danger/40 rounded-2xl p-6">
          <p className="text-sm font-bold text-status-danger">No se pudo cargar el resumen del turno.</p>
          <p className="text-xs text-status-danger mt-1">
            {error.response?.data?.error || error.message}
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="max-w-2xl mx-auto p-4 sm:p-6 space-y-4">
      {/* Header */}
      <div className="bg-status-info/10 border-2 border-status-info/40 rounded-2xl p-4">
        <h1 className="text-lg font-bold text-status-info">Recepción de turno</h1>
        <p className="text-sm text-status-info mt-1">
          Turno saliente: <span className="font-semibold">{summary.outgoing_operator_name}</span>
          {' '}(Turno {summary.outgoing_shift_number})
        </p>
      </div>

      {/* Resumen del turno saliente */}
      <div className="bg-surface-primary border border-line-subtle rounded-2xl p-4 space-y-3">
        <h2 className="font-bold text-ink-primary flex items-center gap-2">
          <span>📊</span> Resumen del turno saliente
        </h2>
        <div className="grid grid-cols-2 gap-2 text-sm">
          <div className="text-ink-secondary">Duración:</div>
          <div className="font-medium">{summary.duration_text || '—'}</div>

          <div className="text-ink-secondary">Paquetes capturados:</div>
          <div className="font-medium">{summary.packages_count ?? 0}</div>

          <div className="text-ink-secondary">Piezas producidas:</div>
          <div className="font-medium">{summary.units_produced ?? 0}</div>

          <div className="text-ink-secondary">MP consumida:</div>
          <div className="font-medium">{Number(summary.mp_consumed_kg || 0).toFixed(2)} kg</div>

          <div className="text-ink-secondary">Scrap reportado:</div>
          <div className="font-medium">{Number(summary.scrap_kg || 0).toFixed(2)} kg</div>

          <div className="text-ink-secondary">Desviaciones:</div>
          <div className="font-medium">
            {summary.deviation_count > 0
              ? `${summary.deviation_count} paquete(s) fuera de rango`
              : 'Ninguna'}
          </div>
        </div>
      </div>

      {/* Orden activa */}
      {summary.active_order && (
        <div className="bg-surface-primary border border-line-subtle rounded-2xl p-4 space-y-2">
          <h2 className="font-bold text-ink-primary flex items-center gap-2">
            <span>🎯</span> Orden activa
          </h2>
          <div className="text-sm">
            <p>
              <span className="font-semibold">{summary.active_order.order_number}</span>
              {' '}— {summary.active_order.product_code}
            </p>
            <p className="text-ink-secondary">
              Avance: {summary.active_order.units_produced} / {summary.active_order.units_target} piezas
              {' '}({summary.active_order.progress_pct?.toFixed(0)}%)
            </p>
          </div>
        </div>
      )}

      {/* Acciones */}
      <div className="flex flex-col sm:flex-row gap-3 pt-2">
        <button
          onClick={() => acceptMutation.mutate({ accepted: true })}
          disabled={acceptMutation.isPending}
          className="flex-1 bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white font-semibold py-3 px-4 rounded-xl"
        >
          ✓ Acepto la línea
        </button>
        <button
          onClick={() => setShowIssueModal(true)}
          disabled={acceptMutation.isPending}
          className="flex-1 bg-amber-500 hover:bg-amber-600 disabled:opacity-50 text-white font-semibold py-3 px-4 rounded-xl"
        >
          ⚠ Recibo con observaciones
        </button>
      </div>

      {submitError && (
        <div className="bg-status-danger/10 border border-status-danger/40 rounded-xl p-3 text-sm text-status-danger">
          {submitError}
        </div>
      )}

      {/* Modal de observaciones */}
      {showIssueModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
          <div className="bg-surface-primary rounded-2xl max-w-lg w-full p-5 space-y-4">
            <div className="flex justify-between items-start">
              <h3 className="font-bold text-ink-primary">Observaciones de recepción</h3>
              <button
                onClick={() => { setShowIssueModal(false); setIssueText(''); setSubmitError(null) }}
                className="text-ink-muted hover:text-ink-secondary"
              >
                ✕
              </button>
            </div>

            <div>
              <label className="block text-sm font-medium text-ink-secondary mb-1">
                Describe qué encontraste mal:
              </label>
              <textarea
                value={issueText}
                onChange={(e) => setIssueText(e.target.value)}
                rows={5}
                placeholder="Mínimo 20 caracteres. Sé claro y específico."
                className="w-full border border-line-strong rounded-lg p-2 text-sm focus:ring-2 focus:ring-blue-400"
              />
              <p className="text-xs text-ink-muted mt-1">
                {issueText.trim().length} / 20 caracteres mínimos
              </p>
            </div>

            <div className="bg-status-warning/10 border border-status-warning/40 rounded-lg p-3 text-xs text-status-warning">
              Esta observación quedará registrada permanentemente y se mostrará
              al supervisor cuando valide el turno saliente. El turno se activará igualmente.
            </div>

            {submitError && (
              <div className="bg-status-danger/10 border border-status-danger/40 rounded-xl p-3 text-sm text-status-danger">
                {submitError}
              </div>
            )}

            <div className="flex gap-2 pt-2">
              <button
                onClick={() => { setShowIssueModal(false); setIssueText(''); setSubmitError(null) }}
                className="flex-1 border border-line-strong hover:bg-surface-elevated/40 text-ink-secondary font-medium py-2 px-4 rounded-xl"
              >
                Cancelar
              </button>
              <button
                onClick={() => acceptMutation.mutate({
                  accepted: false,
                  issue_description: issueText.trim()
                })}
                disabled={
                  issueText.trim().length < 20 ||
                  acceptMutation.isPending
                }
                className="flex-1 bg-amber-500 hover:bg-amber-600 disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold py-2 px-4 rounded-xl"
              >
                Registrar y recibir turno
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
