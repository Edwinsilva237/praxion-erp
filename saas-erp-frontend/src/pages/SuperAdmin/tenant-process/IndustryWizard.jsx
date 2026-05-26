import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { platformAdminApi } from '@/api/platformAdmin'
import Spinner from '@/components/ui/Spinner'
import clsx from 'clsx'
import { PRESETS, diffPresetVsConfig } from './presets'
import { FIELD_LABELS, formatValue } from './helpTexts'

/**
 * Wizard de aplicación de preset por industria.
 *
 * Props:
 *   tenantId  - UUID del tenant
 *   config    - configuración actual (objeto)
 *   onClose   - callback al cerrar (con flag `applied: bool`)
 */
export default function IndustryWizard({ tenantId, config, onClose }) {
  const [step, setStep]   = useState(1)
  const [picked, setPicked] = useState(null)
  const [error, setError] = useState(null)

  const apply = useMutation({
    mutationFn: () => platformAdminApi.updateTenantProcessConfig(tenantId, picked.config),
    onSuccess:  () => { setStep(3) },
    onError:    (e) => setError(e.response?.data?.error || e.message),
  })

  const diffs = picked ? diffPresetVsConfig(picked, config) : []

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-surface-primary rounded-2xl shadow-xl w-full max-w-3xl max-h-[90vh] overflow-hidden flex flex-col border border-line-subtle">
        {/* Header */}
        <div className="px-5 py-4 border-b border-line-subtle flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold text-ink-primary">Aplicar preset de industria</h3>
            <p className="text-xs text-ink-muted mt-0.5">Configura los 16 flags de proceso a valores recomendados según el tipo de operación</p>
          </div>
          <button onClick={() => onClose({ applied: step === 3 })} className="text-ink-muted hover:text-ink-primary">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12"/>
            </svg>
          </button>
        </div>

        {/* Stepper compacto */}
        <div className="px-5 py-3 border-b border-line-subtle flex items-center gap-2">
          <StepDot num={1} label="Elige industria" active={step === 1} done={step > 1} />
          <Bar />
          <StepDot num={2} label="Revisa cambios" active={step === 2} done={step > 2} />
          <Bar />
          <StepDot num={3} label="Listo" active={step === 3} done={false} />
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5">
          {step === 1 && (
            <Step1 picked={picked} setPicked={setPicked} />
          )}
          {step === 2 && picked && (
            <Step2 preset={picked} diffs={diffs} error={error} isPending={apply.isPending} />
          )}
          {step === 3 && picked && (
            <Step3 preset={picked} appliedCount={diffs.length} />
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-line-subtle flex items-center justify-between gap-3">
          {step === 1 && (
            <>
              <button onClick={() => onClose({ applied: false })} className="btn-ghost btn-sm">Cancelar</button>
              <button onClick={() => setStep(2)} disabled={!picked} className="btn-primary btn-sm">Continuar →</button>
            </>
          )}
          {step === 2 && (
            <>
              <button onClick={() => setStep(1)} disabled={apply.isPending} className="btn-ghost btn-sm">← Volver</button>
              <button
                onClick={() => { setError(null); apply.mutate() }}
                disabled={apply.isPending || diffs.length === 0}
                className="btn-primary btn-sm"
              >
                {apply.isPending && <Spinner className="w-3 h-3" />}
                {diffs.length === 0 ? 'Sin cambios' : `Aplicar ${diffs.length} cambio(s)`}
              </button>
            </>
          )}
          {step === 3 && (
            <>
              <span />
              <button onClick={() => onClose({ applied: true })} className="btn-primary btn-sm">Cerrar</button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── Stepper helpers ──────────────────────────────────────────────────────────
function StepDot({ num, label, active, done }) {
  return (
    <div className={clsx('flex items-center gap-1.5 text-xs',
      active ? 'text-ink-primary font-medium' : done ? 'text-status-success' : 'text-ink-muted')}>
      <span className={clsx('w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold',
        active ? 'bg-brand-600 text-white' : done ? 'bg-status-success/20 text-status-success' : 'bg-surface-elevated')}>
        {done ? '✓' : num}
      </span>
      {label}
    </div>
  )
}
function Bar() { return <div className="flex-1 h-px bg-line-subtle" /> }

// ─── Step 1: elegir industria ─────────────────────────────────────────────────
function Step1({ picked, setPicked }) {
  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-ink-secondary">
        Elige la opción que más se parezca a la operación del tenant. En el siguiente paso verás exactamente qué flags
        van a cambiar respecto a la configuración actual — siempre puedes ajustar después de aplicar.
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {PRESETS.map(p => (
          <button
            key={p.key}
            type="button"
            onClick={() => setPicked(p)}
            className={clsx(
              'text-left border rounded-xl p-4 transition-colors hover:bg-surface-elevated/50',
              picked?.key === p.key ? 'border-brand-500/60 bg-brand-500/5' : 'border-line-subtle',
            )}
          >
            <div className="flex items-start gap-3">
              <span className="text-2xl shrink-0">{p.icon}</span>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-ink-primary">{p.title}</p>
                <p className="text-xs text-ink-secondary mt-1 leading-snug">{p.short}</p>
                <p className="text-[11px] text-ink-muted italic mt-1.5">Ej: {p.examples}</p>
              </div>
            </div>
          </button>
        ))}
      </div>
    </div>
  )
}

// ─── Step 2: revisar diff ─────────────────────────────────────────────────────
function Step2({ preset, diffs, error, isPending }) {
  return (
    <div className="flex flex-col gap-4">
      <div className="bg-status-info/10 border border-status-info/40 rounded-xl px-4 py-3 text-sm text-status-info">
        <p className="font-medium mb-1">Preset seleccionado: {preset.title}</p>
        <p className="text-xs leading-relaxed">{preset.short}</p>
      </div>

      {diffs.length === 0 ? (
        <div className="empty-state">
          <p className="font-medium text-ink-secondary">Sin cambios necesarios</p>
          <p className="text-sm text-ink-muted mt-1">La configuración actual ya coincide con este preset.</p>
        </div>
      ) : (
        <div>
          <p className="text-xs text-ink-muted mb-2">
            Se van a modificar <strong>{diffs.length} de {Object.keys(preset.config).length}</strong> flags:
          </p>
          <div className="border border-line-subtle rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-surface-elevated/50 text-ink-muted text-xs uppercase tracking-wide">
                <tr>
                  <th className="px-3 py-2 text-left">Configuración</th>
                  <th className="px-3 py-2 text-left">Actual</th>
                  <th className="px-3 py-2 text-left">Nuevo</th>
                </tr>
              </thead>
              <tbody>
                {diffs.map(d => (
                  <tr key={d.field} className="border-t border-line-subtle">
                    <td className="px-3 py-2 text-ink-primary">{FIELD_LABELS[d.field] || d.field}</td>
                    <td className="px-3 py-2 text-ink-muted">{formatValue(d.field, d.currentValue)}</td>
                    <td className="px-3 py-2 text-ink-primary font-medium">{formatValue(d.field, d.newValue)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {error && (
        <div className="bg-status-danger/10 border border-status-danger/40 rounded-xl px-4 py-3 text-sm text-status-danger">
          {error}
        </div>
      )}

      {isPending && (
        <div className="text-xs text-ink-muted flex items-center gap-2">
          <Spinner className="w-3 h-3" /> Aplicando cambios…
        </div>
      )}
    </div>
  )
}

// ─── Step 3: éxito ────────────────────────────────────────────────────────────
function Step3({ preset, appliedCount }) {
  return (
    <div className="flex flex-col items-center gap-3 text-center py-4">
      <div className="w-14 h-14 rounded-full bg-status-success/15 flex items-center justify-center">
        <svg className="w-7 h-7 text-status-success" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7"/>
        </svg>
      </div>
      <div>
        <p className="text-sm font-semibold text-ink-primary">Preset aplicado</p>
        <p className="text-xs text-ink-muted mt-1">
          Configuración de <strong>{preset.title}</strong> aplicada — {appliedCount} cambio(s) guardado(s).
        </p>
      </div>
      <p className="text-[11px] text-ink-muted max-w-md leading-snug">
        El tenant verá el efecto al recargar. Puedes seguir ajustando flags individuales desde la pantalla anterior.
      </p>
    </div>
  )
}
