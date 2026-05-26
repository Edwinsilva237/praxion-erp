import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { productionApi } from '@/api/production'
import Spinner from '@/components/ui/Spinner'

const REASONS = [
  { value: 'abandono',          label: 'El operador abandonó la línea' },
  { value: 'no_responde',       label: 'No responde / no localizable' },
  { value: 'emergencia_medica', label: 'Emergencia médica' },
  { value: 'falla_operativa',   label: 'Falla operativa que requiere relevo inmediato' },
  { value: 'otro',              label: 'Otro motivo' },
]

/**
 * Modal de cierre forzado del turno (solo supervisor).
 *
 * Props:
 *   shiftId:         UUID del turno a force-cerrar.
 *   operatorName:    nombre del operador (saliente) para mostrar en confirmación.
 *   onClose:         callback al cerrar el modal sin actuar.
 *   onSuccess:       callback al completarse exitosamente. Recibe el response del backend.
 */
export default function ForceCloseModal({ shiftId, operatorName, onClose, onSuccess }) {
  const qc = useQueryClient()
  const [reasonCode, setReasonCode] = useState('')
  const [details, setDetails] = useState('')
  const [confirmed, setConfirmed] = useState(false)

  const mutation = useMutation({
    mutationFn: (body) => productionApi.forceCloseShift(shiftId, body),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ['active-shifts'] })
      qc.invalidateQueries({ queryKey: ['my-today-shifts'] })
      qc.invalidateQueries({ queryKey: ['shift-detail', shiftId] })
      onSuccess?.(data)
    },
  })

  const reasonLabel = REASONS.find(r => r.value === reasonCode)?.label
  const finalReason = reasonCode
    ? (details.trim()
        ? `${reasonLabel}: ${details.trim()}`
        : reasonLabel)
    : ''

  const canSubmit = !!reasonCode && (reasonCode !== 'otro' || details.trim().length >= 10) && confirmed

  function handleSubmit() {
    if (!canSubmit) return
    mutation.mutate({ reason: finalReason })
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
      <div className="bg-surface-primary rounded-2xl max-w-lg w-full p-5 space-y-4 max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="flex justify-between items-start">
          <div>
            <h3 className="font-bold text-status-danger text-lg">⚠ Forzar cierre del turno</h3>
            <p className="text-xs text-ink-secondary mt-0.5">
              Operador saliente: <span className="font-medium">{operatorName || '—'}</span>
            </p>
          </div>
          <button
            onClick={onClose}
            disabled={mutation.isPending}
            className="text-ink-muted hover:text-ink-secondary text-xl leading-none"
          >
            ✕
          </button>
        </div>

        {/* Advertencia */}
        <div className="bg-status-danger/10 border border-status-danger/40 rounded-xl p-3 text-sm text-status-danger space-y-1">
          <p className="font-semibold">Esta acción no se puede deshacer.</p>
          <ul className="text-xs list-disc pl-4 space-y-0.5">
            <li>El turno saliente se cerrará inmediatamente.</li>
            <li>El turno entrante se activará de forma automática.</li>
            <li>Quedará registrado quién y por qué se forzó el cierre.</li>
          </ul>
        </div>

        {/* Motivo */}
        <div>
          <label className="block text-sm font-medium text-ink-secondary mb-1.5">
            Motivo del cierre forzado <span className="text-status-danger">*</span>
          </label>
          <select
            value={reasonCode}
            onChange={(e) => setReasonCode(e.target.value)}
            disabled={mutation.isPending}
            className="w-full border border-line-strong rounded-lg p-2 text-sm focus:ring-2 focus:ring-status-danger/40"
          >
            <option value="">— Seleccionar motivo —</option>
            {REASONS.map(r => (
              <option key={r.value} value={r.value}>{r.label}</option>
            ))}
          </select>
        </div>

        {/* Detalles */}
        <div>
          <label className="block text-sm font-medium text-ink-secondary mb-1.5">
            Detalles adicionales
            {reasonCode === 'otro' && <span className="text-status-danger"> *</span>}
            {reasonCode !== 'otro' && <span className="text-ink-muted font-normal"> (opcional)</span>}
          </label>
          <textarea
            value={details}
            onChange={(e) => setDetails(e.target.value)}
            disabled={mutation.isPending}
            rows={3}
            placeholder={
              reasonCode === 'otro'
                ? 'Describe el motivo (mínimo 10 caracteres)'
                : 'Información adicional para el registro de auditoría'
            }
            className="w-full border border-line-strong rounded-lg p-2 text-sm focus:ring-2 focus:ring-status-danger/40"
          />
          {reasonCode === 'otro' && (
            <p className="text-xs text-ink-muted mt-0.5">
              {details.trim().length} / 10 caracteres mínimos
            </p>
          )}
        </div>

        {/* Confirmación checkbox */}
        <label className="flex items-start gap-2 text-sm text-ink-secondary cursor-pointer">
          <input
            type="checkbox"
            checked={confirmed}
            onChange={(e) => setConfirmed(e.target.checked)}
            disabled={mutation.isPending}
            className="mt-0.5"
          />
          <span>
            Confirmo que entiendo las consecuencias y que el operador saliente
            no pudo o no quiso cerrar su turno normalmente.
          </span>
        </label>

        {/* Error */}
        {mutation.isError && (
          <div className="bg-status-danger/10 border border-status-danger/40 rounded-xl p-3 text-sm text-status-danger">
            {mutation.error?.response?.data?.error || mutation.error?.message || 'Error al forzar el cierre'}
          </div>
        )}

        {/* Acciones */}
        <div className="flex gap-2 pt-2">
          <button
            onClick={onClose}
            disabled={mutation.isPending}
            className="flex-1 border border-line-strong hover:bg-surface-elevated/40 text-ink-secondary font-medium py-2 px-4 rounded-xl"
          >
            Cancelar
          </button>
          <button
            onClick={handleSubmit}
            disabled={!canSubmit || mutation.isPending}
            className="flex-1 bg-red-600 hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold py-2 px-4 rounded-xl"
          >
            {mutation.isPending ? <Spinner className="w-4 h-4 mx-auto" /> : 'Forzar cierre'}
          </button>
        </div>
      </div>
    </div>
  )
}
