import { useState, useEffect } from 'react'
import { useQuery, useMutation } from '@tanstack/react-query'
import { platformAdminApi } from '@/api/platformAdmin'
import Spinner from '@/components/ui/Spinner'
import HelpTip from '@/components/ui/HelpTip'
import clsx from 'clsx'
import IndustryWizard from './IndustryWizard'
import { HELP, FIELD_LABELS, validateConfig } from './helpTexts'
import { detectClosestPreset } from './presets'

// ── Componentes de fila (con HelpTip integrado) ───────────────────────────────
function PToggle({ checked, onChange, disabled }) {
  return (
    <button type="button" role="switch" aria-checked={checked}
      disabled={disabled} onClick={() => onChange(!checked)}
      className={clsx(
        'relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors focus:outline-none',
        checked ? 'bg-brand-500' : 'bg-surface-elevated border border-line-subtle',
        disabled && 'opacity-40 cursor-not-allowed'
      )}>
      <span className={clsx(
        'inline-block h-4 w-4 transform rounded-full bg-white shadow-sm transition-transform',
        checked ? 'translate-x-6' : 'translate-x-1'
      )} />
    </button>
  )
}

function FieldHeader({ field }) {
  const help = HELP[field]
  return (
    <div className="min-w-0 flex-1">
      <div className="flex items-center gap-1.5">
        <p className="text-sm font-medium text-ink-primary">{FIELD_LABELS[field] || field}</p>
        {help && <HelpTip title={help.title} body={help.body} examples={help.examples} align="start" />}
      </div>
    </div>
  )
}

function PRow({ field, values, onChange, disabled }) {
  return (
    <div className="flex items-start justify-between gap-6 py-3 border-b border-line-subtle last:border-0">
      <FieldHeader field={field} />
      <PToggle checked={!!values[field]} onChange={v => onChange(field, v)} disabled={disabled} />
    </div>
  )
}

function PSelect({ field, values, onChange, disabled, options }) {
  return (
    <div className="flex items-start justify-between gap-6 py-3 border-b border-line-subtle last:border-0">
      <FieldHeader field={field} />
      <select value={values[field] ?? ''} onChange={e => onChange(field, e.target.value)}
        disabled={disabled} className="select w-44 shrink-0 text-sm">
        {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </div>
  )
}

function PNumber({ field, values, onChange, disabled, min }) {
  return (
    <div className="flex items-start justify-between gap-6 py-3 border-b border-line-subtle last:border-0">
      <FieldHeader field={field} />
      <input type="number" min={min ?? 0} value={values[field] ?? ''}
        onChange={e => onChange(field, e.target.value === '' ? null : parseInt(e.target.value, 10))}
        disabled={disabled} className="input w-20 shrink-0 text-right text-sm" />
    </div>
  )
}

// ── Hero card ─────────────────────────────────────────────────────────────────
function ProcesoHero({ values, onOpenWizard }) {
  const closest = detectClosestPreset(values)
  return (
    <section className="card p-5 flex flex-col gap-3">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="flex-1 min-w-0">
          <h2 className="text-sm font-semibold text-ink-primary">Configuración de proceso</h2>
          <p className="text-xs text-ink-secondary mt-1 leading-relaxed">
            Estos 16 ajustes controlan <strong>cómo opera</strong> el tenant: si maneja lotes, si los productos
            pasan por WIP, qué método de costo usa, qué pasa con la merma… Cada flag tiene su ayuda con ejemplos —
            haz clic en el ⓘ junto a cada nombre. Si no estás seguro por dónde empezar, aplica un preset de industria.
          </p>
        </div>
        <button onClick={onOpenWizard} className="btn-primary btn-sm shrink-0">
          ✨ Aplicar preset de industria
        </button>
      </div>

      {closest && (
        <div className="bg-surface-elevated/40 border border-line-subtle rounded-lg px-3 py-2 text-xs text-ink-secondary flex items-center gap-2">
          <span className="text-base">{closest.preset.icon}</span>
          <span>
            Tu configuración actual se parece a <strong>{closest.preset.title}</strong>
            {' '}({closest.matchCount}/{closest.totalFields} flags coinciden).
          </span>
        </div>
      )}
    </section>
  )
}

// ── Warnings cruzados ─────────────────────────────────────────────────────────
function ValidationBanner({ warnings }) {
  if (!warnings?.length) return null
  return (
    <section className="flex flex-col gap-2">
      {warnings.map((w, i) => {
        const cls = w.severity === 'error'
          ? 'bg-status-danger/10 border-status-danger/40 text-status-danger'
          : w.severity === 'warn'
            ? 'bg-status-warning/10 border-status-warning/40 text-status-warning'
            : 'bg-status-info/10 border-status-info/40 text-status-info'
        const icon = w.severity === 'error' ? '⛔' : w.severity === 'warn' ? '⚠' : 'ⓘ'
        return (
          <div key={i} className={clsx('border rounded-xl px-3 py-2 text-xs flex items-start gap-2', cls)}>
            <span className="shrink-0">{icon}</span>
            <span className="leading-relaxed">
              {w.field && <strong>{FIELD_LABELS[w.field] || w.field}:</strong>} {w.message}
            </span>
          </div>
        )
      })}
    </section>
  )
}

// ── Tab principal ─────────────────────────────────────────────────────────────
export default function ProcesoTab({ tenantId }) {
  const [values, setValues] = useState(null)
  const [dirty, setDirty]   = useState(false)
  const [error, setError]   = useState(null)
  const [msg,   setMsg]     = useState(null)
  const [showWizard, setShowWizard] = useState(false)

  const { data: config, isLoading, refetch } = useQuery({
    queryKey: ['platform-admin', 'tenant', tenantId, 'process-config'],
    queryFn:  () => platformAdminApi.getTenantProcessConfig(tenantId),
    staleTime: 30000,
  })

  useEffect(() => {
    if (config && !dirty) setValues(config)
  }, [config, dirty])

  const save = useMutation({
    mutationFn: (patch) => platformAdminApi.updateTenantProcessConfig(tenantId, patch),
    onSuccess: (updated) => {
      setValues(updated)
      setDirty(false)
      setMsg('Configuración guardada.')
      setError(null)
      setTimeout(() => setMsg(null), 3000)
    },
    onError: (e) => setError(e.response?.data?.error || e.message),
  })

  function change(field, value) {
    setValues(prev => ({ ...prev, [field]: value }))
    setDirty(true)
    setError(null)
  }

  function handleSave() {
    if (!values) return
    save.mutate({
      uses_lots:                     values.uses_lots,
      uses_expiry:                   values.uses_expiry,
      uses_fefo:                     values.uses_fefo,
      expiry_alert_days:             values.expiry_alert_days,
      pt_goes_to_wip_first:          values.pt_goes_to_wip_first,
      mp_goes_to_wip_first:          values.mp_goes_to_wip_first,
      uses_handover:                 values.uses_handover,
      uses_supervisor:               values.uses_supervisor,
      supervisor_validates:          values.supervisor_validates,
      allow_adhoc_shifts:            values.allow_adhoc_shifts,
      allow_second_quality_in_order: values.allow_second_quality_in_order,
      treat_abnormal_scrap_as_loss:  values.treat_abnormal_scrap_as_loss,
      cost_method:                   values.cost_method,
      allergen_mode:                 values.allergen_mode,
      operation_mode:                values.operation_mode,
      simplified_overhead:           values.simplified_overhead,
      uses_resin_types:              values.uses_resin_types,
      tracks_material_origin:        values.tracks_material_origin,
    })
  }

  if (isLoading || !values) return <div className="flex justify-center py-10"><Spinner /></div>

  const disabled = save.isPending
  const warnings = validateConfig(values)

  return (
    <div className="flex flex-col gap-4">
      <ProcesoHero values={values} onOpenWizard={() => setShowWizard(true)} />

      <ValidationBanner warnings={warnings} />

      {error && <div className="alert-error">{error}</div>}
      {msg && <div className="alert-success">{msg}</div>}
      {dirty && !save.isPending && (
        <div className="alert-warning text-xs">Cambios sin guardar.</div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Lotes y trazabilidad */}
        <div className="card p-4">
          <SectionHeader
            color="bg-brand-500"
            title="Trazabilidad y lotes"
            help="Controla si el tenant maneja lotes de MP/PT, fechas de caducidad y FEFO. Esencial para alimentos y farma; opcional para plásticos e industria pesada."
          />
          <PRow    field="uses_lots"          values={values} onChange={change} disabled={disabled} />
          <PRow    field="uses_expiry"        values={values} onChange={change} disabled={disabled} />
          <PRow    field="uses_fefo"          values={values} onChange={change} disabled={disabled} />
          <PNumber field="expiry_alert_days"  values={values} onChange={change} disabled={disabled} min={0} />
        </div>

        {/* Atributos específicos de plástico */}
        <div className="card p-4">
          <SectionHeader
            color="bg-purple-500"
            title="Atributos de materias primas"
            help="Activa estos atributos solo si tu tenant trabaja con plástico. Si están apagados, no aparecen los campos en MP ni almacenes."
          />
          <PRow field="uses_resin_types"       values={values} onChange={change} disabled={disabled} />
          <PRow field="tracks_material_origin" values={values} onChange={change} disabled={disabled} />
        </div>

        {/* Proceso y WIP */}
        <div className="card p-4">
          <SectionHeader
            color="bg-status-info"
            title="Proceso y flujo WIP"
            help="Determina si MP/PT pasan por una etapa de WIP (work-in-progress) antes de afectar inventario, y reglas de calidad y merma."
          />
          <PRow field="pt_goes_to_wip_first"          values={values} onChange={change} disabled={disabled} />
          <PRow field="mp_goes_to_wip_first"          values={values} onChange={change} disabled={disabled} />
          <PRow field="allow_second_quality_in_order" values={values} onChange={change} disabled={disabled} />
          <PRow field="treat_abnormal_scrap_as_loss"  values={values} onChange={change} disabled={disabled} />
        </div>

        {/* Turnos */}
        <div className="card p-4">
          <SectionHeader
            color="bg-status-warning"
            title="Turnos y roles"
            help="Configura cómo se manejan los relevos entre turnos y qué roles intervienen en la captura y validación."
          />
          <PRow field="uses_handover"        values={values} onChange={change} disabled={disabled} />
          <PRow field="uses_supervisor"      values={values} onChange={change} disabled={disabled} />
          <PRow field="supervisor_validates" values={values} onChange={change} disabled={disabled} />
          <PRow field="allow_adhoc_shifts"   values={values} onChange={change} disabled={disabled} />
        </div>

        {/* Costos y alérgenos */}
        <div className="card p-4">
          <SectionHeader
            color="bg-status-success"
            title="Costos, alérgenos y modo"
            help="Método de valoración de MP, manejo de alérgenos y nivel de detalle global de la operación."
          />
          <PSelect
            field="cost_method" values={values} onChange={change} disabled={disabled}
            options={[
              { value: 'weighted_avg', label: 'Promedio ponderado' },
              { value: 'fifo',         label: 'FIFO' },
              { value: 'standard',     label: 'Costo estándar' },
            ]}
          />
          <PSelect
            field="allergen_mode" values={values} onChange={change} disabled={disabled}
            options={[
              { value: 'strict',        label: 'Estricto — bloquea cierre' },
              { value: 'priority_only', label: 'Solo prioritarios — bloquea' },
              { value: 'alert_only',    label: 'Solo alerta — no bloquea' },
            ]}
          />
          <PSelect
            field="operation_mode" values={values} onChange={change} disabled={disabled}
            options={[
              { value: 'industrial', label: 'Industrial — flujo completo' },
              { value: 'small',      label: 'Pequeño — simplificado' },
              { value: 'micro',      label: 'Micro — mínimo operativo' },
            ]}
          />
          <PRow field="simplified_overhead" values={values} onChange={change} disabled={disabled} />
        </div>
      </div>

      <div className="flex justify-end">
        <button className="btn-primary min-w-32" disabled={!dirty || save.isPending}
          onClick={handleSave}>
          {save.isPending ? <Spinner className="w-4 h-4" /> : dirty ? 'Guardar configuración' : 'Sin cambios'}
        </button>
      </div>

      {showWizard && (
        <IndustryWizard
          tenantId={tenantId}
          config={values}
          onClose={({ applied }) => {
            setShowWizard(false)
            if (applied) {
              refetch()
              setMsg('Preset aplicado correctamente.')
              setTimeout(() => setMsg(null), 3000)
            }
          }}
        />
      )}
    </div>
  )
}

function SectionHeader({ color, title, help }) {
  return (
    <h3 className="text-xs font-semibold text-ink-muted uppercase tracking-wide mb-3 flex items-center gap-2">
      <span className={clsx('w-2 h-2 rounded-full inline-block', color)} />
      {title}
      {help && <HelpTip text={help} />}
    </h3>
  )
}
