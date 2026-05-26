import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { overheadApi } from '@/api/overhead'
import Spinner from '@/components/ui/Spinner'
import clsx from 'clsx'

const PRESETS = [
  { code: 'renta',             name: 'Renta del local',         allocation_base: 'shifts', capture_frequency: 'monthly', default_estimated_amount: 30000,
    why: 'Aplicar a todos los turnos por igual.',  base_label: 'Partes iguales por turno' },
  { code: 'energia_electrica', name: 'Energía eléctrica',       allocation_base: 'weight', capture_frequency: 'monthly', default_estimated_amount: 15000,
    why: 'Más producción ⇒ más consumo de luz.',   base_label: 'Por kg producido' },
  { code: 'sueldos_planta',    name: 'Sueldos de planta',       allocation_base: 'hours',  capture_frequency: 'monthly', default_estimated_amount: 80000,
    why: 'Turnos más largos absorben más sueldo.', base_label: 'Por horas trabajadas' },
  { code: 'admin_nomina',      name: 'Nómina administrativa',   allocation_base: 'shifts', capture_frequency: 'monthly', default_estimated_amount: 25000,
    why: 'Costo fijo independiente del volumen.',  base_label: 'Partes iguales por turno' },
  { code: 'mantenimiento',     name: 'Mantenimiento',           allocation_base: 'hours',  capture_frequency: 'monthly', default_estimated_amount: 8000,
    why: 'A más horas, más desgaste.',             base_label: 'Por horas trabajadas' },
  { code: 'consumibles',       name: 'Consumibles y empaque',   allocation_base: 'units',  capture_frequency: 'monthly', default_estimated_amount: 6000,
    why: 'Cada pieza usa un poco de empaque.',     base_label: 'Por unidades' },
]

const MONTHS = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre']

const fmtMoney = (n) =>
  `$${Number(n).toLocaleString('es-MX', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`

export default function BienvenidaWizard({ onDone }) {
  const qc = useQueryClient()
  const [step, setStep] = useState(1)
  const [selected, setSelected] = useState(() => new Set(['renta', 'energia_electrica', 'sueldos_planta']))
  const [amounts,  setAmounts]  = useState(() => Object.fromEntries(PRESETS.map(p => [p.code, p.default_estimated_amount])))
  const [creating, setCreating] = useState(false)
  const [error,    setError]    = useState(null)
  const [done,     setDone]     = useState(null)

  const now = new Date()
  const year  = now.getFullYear()
  const month = now.getMonth() + 1

  const togglePreset = (code) => {
    const next = new Set(selected)
    if (next.has(code)) next.delete(code); else next.add(code)
    setSelected(next)
  }
  const setAmount = (code, v) => setAmounts(prev => ({ ...prev, [code]: parseFloat(v) || 0 }))

  const finalizeMut = useMutation({
    mutationFn: async () => {
      const chosen = PRESETS.filter(p => selected.has(p.code))
      // 1. Crear cada item
      const created = []
      for (const p of chosen) {
        try {
          const item = await overheadApi.createItem({
            code: p.code, name: p.name,
            allocation_base: p.allocation_base,
            capture_frequency: p.capture_frequency,
            default_estimated_amount: amounts[p.code] ?? p.default_estimated_amount,
            sort_order: 0, notes: null,
          })
          created.push(item)
        } catch (err) {
          // si ya existe (409), seguimos; otros errores se propagan
          if (err?.response?.status !== 409) throw err
        }
      }
      // 2. Generar período del mes actual
      let periodsResult = null
      try {
        periodsResult = await overheadApi.ensurePeriods({ year, month })
      } catch (err) {
        // Falla no fatal: el usuario puede crearlos luego
        console.warn('[wizard] ensurePeriods failed:', err?.message)
      }
      return { created, periodsResult }
    },
    onSuccess: (data) => {
      setDone(data)
      qc.invalidateQueries({ queryKey: ['overhead-items'] })
      qc.invalidateQueries({ queryKey: ['overhead-periods'] })
      setStep(4)
    },
    onError: (err) => setError(err?.response?.data?.error || err?.message || 'Error inesperado.'),
  })

  const chosen = PRESETS.filter(p => selected.has(p.code))
  const totalEst = chosen.reduce((s, p) => s + (parseFloat(amounts[p.code]) || 0), 0)

  return (
    <div className="page-enter flex flex-col gap-6 max-w-4xl">
      <div className="page-header">
        <div>
          <h1 className="page-title">Bienvenido al módulo de Costeo</h1>
          <p className="page-subtitle">Configura tus gastos en 3 pasos. Después podrás ajustarlos sin problema.</p>
        </div>
      </div>

      {/* Stepper */}
      <Stepper step={step} labels={['Elige tus gastos', 'Ajusta los montos', 'Crear', 'Listo']} />

      {step === 1 && (
        <Step1 presets={PRESETS} selected={selected} toggle={togglePreset} onNext={() => setStep(2)} onSkip={onDone} />
      )}
      {step === 2 && (
        <Step2
          chosen={chosen} amounts={amounts} setAmount={setAmount} totalEst={totalEst}
          onBack={() => setStep(1)} onNext={() => setStep(3)}
        />
      )}
      {step === 3 && (
        <Step3
          chosen={chosen} amounts={amounts} totalEst={totalEst} monthLabel={`${MONTHS[month-1]} ${year}`}
          onBack={() => setStep(2)}
          onConfirm={() => finalizeMut.mutate()}
          isPending={finalizeMut.isPending}
          error={error}
        />
      )}
      {step === 4 && (
        <Step4 done={done} monthLabel={`${MONTHS[month-1]} ${year}`} onDone={onDone} />
      )}
    </div>
  )
}

// ─── Stepper ──────────────────────────────────────────────────────────────────
function Stepper({ step, labels }) {
  return (
    <div className="flex items-center gap-0 flex-wrap">
      {labels.map((label, i) => {
        const num = i + 1
        const active = step === num
        const done   = step > num
        return (
          <div key={num} className="flex items-center">
            <div className={clsx('flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors',
              active ? 'bg-brand-600 text-white' : done ? 'text-status-success' : 'text-ink-muted')}>
              <span className={clsx('w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold',
                active ? 'bg-white/20' : done ? 'bg-status-success/20' : 'bg-surface-elevated')}>
                {done ? '✓' : num}
              </span>
              {label}
            </div>
            {i < labels.length - 1 && <div className="w-6 h-px bg-line-subtle mx-1" />}
          </div>
        )
      })}
    </div>
  )
}

// ─── Step 1: elegir presets ───────────────────────────────────────────────────
function Step1({ presets, selected, toggle, onNext, onSkip }) {
  return (
    <div className="flex flex-col gap-5">
      <div className="bg-status-info/10 border border-status-info/40 rounded-xl px-4 py-3 text-sm text-status-info">
        Elige los tipos de gasto que aplican a tu operación. Cada uno se reparte de manera diferente entre los turnos
        — lee la razón para entender por qué.
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {presets.map(p => {
          const checked = selected.has(p.code)
          return (
            <button
              key={p.code}
              type="button"
              onClick={() => toggle(p.code)}
              className={clsx(
                'text-left border rounded-xl p-4 transition-colors hover:bg-surface-elevated/50',
                checked ? 'border-brand-500/50 bg-brand-500/5' : 'border-line-subtle'
              )}
            >
              <div className="flex items-start gap-3">
                <span className={clsx('mt-0.5 w-5 h-5 rounded border flex items-center justify-center shrink-0',
                  checked ? 'bg-brand-600 border-brand-600 text-white' : 'border-line-subtle')}>
                  {checked && (
                    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7"/>
                    </svg>
                  )}
                </span>
                <div className="flex-1">
                  <div className="flex items-baseline justify-between gap-2">
                    <p className="text-sm font-semibold text-ink-primary">{p.name}</p>
                    <span className="text-xs font-mono text-ink-muted">{fmtMoney(p.default_estimated_amount)}/mes</span>
                  </div>
                  <p className="text-xs text-ink-secondary mt-1">{p.base_label}</p>
                  <p className="text-[11px] text-ink-muted italic mt-0.5">{p.why}</p>
                </div>
              </div>
            </button>
          )
        })}
      </div>

      <div className="flex items-center justify-between gap-3 flex-wrap">
        <button onClick={onSkip} className="btn-ghost btn-sm text-ink-muted">Prefiero configurarlo yo desde cero</button>
        <button onClick={onNext} disabled={selected.size === 0} className="btn-primary">
          Continuar ({selected.size} seleccionado{selected.size === 1 ? '' : 's'}) →
        </button>
      </div>
    </div>
  )
}

// ─── Step 2: ajustar montos ───────────────────────────────────────────────────
function Step2({ chosen, amounts, setAmount, totalEst, onBack, onNext }) {
  return (
    <div className="flex flex-col gap-5">
      <div className="bg-status-info/10 border border-status-info/40 rounded-xl px-4 py-3 text-sm text-status-info">
        Ajusta los montos a tu realidad. Son <strong>estimados mensuales</strong> — no necesitan ser exactos; al cerrar
        el mes capturas el real y el sistema corrige.
      </div>

      <div className="card">
        {chosen.map((p, i) => (
          <div key={p.code} className={clsx('flex items-center gap-3 py-3', i > 0 && 'border-t border-line-subtle')}>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-ink-primary">{p.name}</p>
              <p className="text-xs text-ink-muted">{p.base_label}</p>
            </div>
            <div className="flex items-center gap-1">
              <span className="text-sm text-ink-muted">$</span>
              <input
                type="number" min={0} step={100}
                className="input input-sm w-32 text-right"
                value={amounts[p.code] ?? ''}
                onChange={e => setAmount(p.code, e.target.value)}
              />
              <span className="text-xs text-ink-muted whitespace-nowrap">/mes</span>
            </div>
          </div>
        ))}
        <div className="flex items-center justify-between pt-3 border-t border-line-subtle mt-1">
          <span className="text-sm font-medium text-ink-secondary">Total estimado mensual</span>
          <span className="text-base font-bold font-mono text-ink-primary">{fmtMoney(totalEst)}</span>
        </div>
      </div>

      <div className="flex items-center justify-between gap-3">
        <button onClick={onBack} className="btn-ghost btn-sm">← Volver</button>
        <button onClick={onNext} className="btn-primary">Revisar y crear →</button>
      </div>
    </div>
  )
}

// ─── Step 3: confirmar y crear ────────────────────────────────────────────────
function Step3({ chosen, amounts, totalEst, monthLabel, onBack, onConfirm, isPending, error }) {
  return (
    <div className="flex flex-col gap-5">
      <div className="bg-status-warning/10 border border-status-warning/40 rounded-xl px-4 py-3 text-sm text-status-warning">
        Al confirmar se crearán <strong>{chosen.length} gasto(s)</strong> en tu catálogo y se generará automáticamente
        el período de <strong>{monthLabel}</strong> con estos montos estimados.
      </div>

      <div className="card flex flex-col gap-3">
        <h3 className="text-sm font-semibold text-ink-primary">Resumen</h3>
        <ul className="space-y-1 text-sm">
          {chosen.map(p => (
            <li key={p.code} className="flex items-center justify-between gap-3 py-1">
              <span className="text-ink-secondary truncate">{p.name}</span>
              <span className="font-mono text-ink-primary">{fmtMoney(amounts[p.code] || 0)}</span>
            </li>
          ))}
        </ul>
        <div className="flex items-center justify-between pt-3 border-t border-line-subtle">
          <span className="text-sm font-medium text-ink-secondary">Total mensual</span>
          <span className="text-lg font-bold font-mono text-ink-primary">{fmtMoney(totalEst)}</span>
        </div>
      </div>

      {error && (
        <div className="bg-status-danger/10 border border-status-danger/40 rounded-xl px-4 py-3 text-sm text-status-danger">{error}</div>
      )}

      <div className="flex items-center justify-between gap-3">
        <button onClick={onBack} disabled={isPending} className="btn-ghost btn-sm">← Volver</button>
        <button onClick={onConfirm} disabled={isPending} className="btn-primary">
          {isPending ? <Spinner className="w-3 h-3" /> : null}
          Crear gastos y período →
        </button>
      </div>
    </div>
  )
}

// ─── Step 4: listo ────────────────────────────────────────────────────────────
function Step4({ done, monthLabel, onDone }) {
  const created = done?.created?.length || 0
  const periods = done?.periodsResult?.created ?? '?'

  return (
    <div className="flex flex-col gap-5 items-center text-center py-6">
      <div className="w-16 h-16 rounded-full bg-status-success/15 flex items-center justify-center">
        <svg className="w-8 h-8 text-status-success" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7"/>
        </svg>
      </div>
      <div>
        <h3 className="text-base font-semibold text-ink-primary">¡Todo listo!</h3>
        <p className="text-sm text-ink-secondary mt-2 max-w-md">
          Se crearon <strong>{created} gasto(s)</strong> en tu catálogo y <strong>{periods} período(s)</strong> de {monthLabel}.
          A partir de ahora, cada turno que cierres absorberá su parte proporcional.
        </p>
      </div>
      <div className="text-xs text-ink-muted max-w-md leading-relaxed">
        <strong>Siguiente paso natural:</strong> al final del mes, ve a "Cierre de mes" para capturar los montos reales
        y dejar las órdenes con costo definitivo.
      </div>
      <button onClick={onDone} className="btn-primary">Ir al resumen del módulo</button>
    </div>
  )
}
