import { useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { processConfigApi } from '@/api/processConfig'
import Spinner from '@/components/ui/Spinner'
import CollapsibleHelp from '@/components/ui/CollapsibleHelp'
import HelpTip from '@/components/ui/HelpTip'
import useAuthStore from '@/store/useAuthStore'
import clsx from 'clsx'
import { HELP, FIELD_LABELS, validateConfig } from '@/pages/SuperAdmin/tenant-process/helpTexts'

// ── Toggle switch ─────────────────────────────────────────────────────────────
function Toggle({ checked, onChange, disabled }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={clsx(
        'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500',
        checked ? 'bg-brand-500' : 'bg-line-base',
        disabled && 'opacity-40 cursor-not-allowed'
      )}
    >
      <span className={clsx(
        'inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow-sm transition-transform',
        checked ? 'translate-x-[18px]' : 'translate-x-[2px]'
      )} />
    </button>
  )
}

// ── Cabecera de campo con HelpTip ─────────────────────────────────────────────
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

// ── Fila de bandera booleana ──────────────────────────────────────────────────
function FlagRow({ field, values, onChange, disabled }) {
  return (
    <div className="flex items-start justify-between gap-6 py-3 border-b border-line-subtle last:border-0">
      <FieldHeader field={field} />
      <Toggle
        checked={!!values[field]}
        onChange={v => onChange(field, v)}
        disabled={disabled}
      />
    </div>
  )
}

// ── Fila de selector ──────────────────────────────────────────────────────────
function SelectRow({ field, values, onChange, disabled, options }) {
  return (
    <div className="flex items-start justify-between gap-6 py-3 border-b border-line-subtle last:border-0">
      <FieldHeader field={field} />
      <select
        value={values[field] ?? ''}
        onChange={e => onChange(field, e.target.value)}
        disabled={disabled}
        className="select w-44 shrink-0"
      >
        {options.map(o => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </div>
  )
}

// ── Fila de número ────────────────────────────────────────────────────────────
function NumberRow({ field, values, onChange, disabled, min, nullable }) {
  return (
    <div className="flex items-start justify-between gap-6 py-3 border-b border-line-subtle last:border-0">
      <FieldHeader field={field} />
      <input
        type="number"
        min={min ?? 0}
        value={values[field] ?? ''}
        onChange={e => {
          const v = e.target.value === '' ? (nullable ? null : 0) : parseInt(e.target.value, 10)
          onChange(field, v)
        }}
        disabled={disabled}
        className="input w-24 shrink-0 text-right"
        placeholder={nullable ? '(sin límite)' : '0'}
      />
    </div>
  )
}

// ── Banner de validaciones cruzadas ───────────────────────────────────────────
function ValidationBanner({ warnings }) {
  if (!warnings?.length) return null
  return (
    <div className="flex flex-col gap-2">
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
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
export default function Flags() {
  const qc = useQueryClient()
  const can = useAuthStore(s => s.can)
  const permissions = useAuthStore(s => s.permissions)
  const isSuperAdmin = permissions?.includes?.('*')
  const canManage = isSuperAdmin || can?.('process_config', 'update')

  const [values, setValues] = useState(null)
  const [dirty, setDirty] = useState(false)
  const [serverError, setServerError] = useState(null)
  const [successMsg, setSuccessMsg] = useState(null)

  const { data: config, isLoading } = useQuery({
    queryKey: ['process-config'],
    queryFn:  processConfigApi.getConfig,
    staleTime: 30 * 1000,
  })

  useEffect(() => {
    if (config && !dirty) {
      setValues(config)
    }
  }, [config, dirty])

  const saveMut = useMutation({
    mutationFn: (patch) => processConfigApi.updateConfig(patch),
    onSuccess: (updated) => {
      qc.setQueryData(['process-config'], updated)
      // El Sidebar lee flags de módulo (ej. expenses_enabled) desde
      // ['tenant', 'current']; invalidar para que el menú refleje el cambio sin recargar.
      qc.invalidateQueries({ queryKey: ['tenant', 'current'] })
      setDirty(false)
      setSuccessMsg('Configuración guardada.')
      setTimeout(() => setSuccessMsg(null), 3000)
    },
    onError: (err) => setServerError(err.response?.data?.error || err.message),
  })

  function handleChange(field, value) {
    setValues(prev => ({ ...prev, [field]: value }))
    setDirty(true)
    setServerError(null)
  }

  function handleSave() {
    if (!values) return
    // Solo enviar los campos editables
    const patch = {
      uses_lots:                      values.uses_lots,
      uses_expiry:                    values.uses_expiry,
      uses_fefo:                      values.uses_fefo,
      expiry_alert_days:              values.expiry_alert_days,
      lot_number_pattern:             values.lot_number_pattern,
      uses_handover:                  values.uses_handover,
      uses_supervisor:                values.uses_supervisor,
      supervisor_validates:           values.supervisor_validates,
      allow_adhoc_shifts:             values.allow_adhoc_shifts,
      pt_goes_to_wip_first:           values.pt_goes_to_wip_first,
      mp_goes_to_wip_first:           values.mp_goes_to_wip_first,
      allow_second_quality_in_order:  values.allow_second_quality_in_order,
      treat_abnormal_scrap_as_loss:   values.treat_abnormal_scrap_as_loss,
      cost_method:                    values.cost_method,
      default_intra_shift_proration:  values.default_intra_shift_proration,
      simplified_overhead:            values.simplified_overhead,
      allergen_mode:                  values.allergen_mode,
      operation_mode:                 values.operation_mode,
      uses_resin_types:               values.uses_resin_types,
      tracks_material_origin:         values.tracks_material_origin,
      // Reversión de validación (tarjeta "Reversión de validación")
      allow_revert_validation:         values.allow_revert_validation,
      revert_validation_window_hours:  values.revert_validation_window_hours,
      block_revert_if_order_fulfilled: values.block_revert_if_order_fulfilled,
      block_revert_if_period_closed:   values.block_revert_if_period_closed,
      require_revert_dual_approval:    values.require_revert_dual_approval,
      // Inventario
      allow_negative_stock:           values.allow_negative_stock,
      // Módulos opcionales
      expenses_enabled:               values.expenses_enabled,
    }
    saveMut.mutate(patch)
  }

  if (isLoading || !values) {
    return <div className="flex justify-center py-16"><Spinner /></div>
  }

  const saving = saveMut.isPending
  const disabled = !canManage || saving

  return (
    <div className="page-enter flex flex-col gap-6">
      {/* ── Header ───────────────────────────────────────────────────────── */}
      <div className="page-header">
        <div>
          <h1 className="page-title">Configuración de proceso</h1>
          <p className="page-subtitle">Cómo opera tu producción — manejo de lotes, turnos, costos y calidad</p>
        </div>
        {canManage && (
          <button
            onClick={handleSave}
            disabled={!dirty || saving}
            className={clsx('btn-primary', (!dirty || saving) && 'opacity-50 cursor-not-allowed')}
          >
            {saving ? <Spinner className="w-4 h-4" /> : null}
            {dirty ? 'Guardar cambios' : 'Sin cambios'}
          </button>
        )}
      </div>

      {/* ── Alertas ──────────────────────────────────────────────────────── */}
      {successMsg && (
        <div className="bg-status-success/10 border border-status-success/40 rounded-xl px-4 py-3 text-sm text-status-success flex items-center justify-between">
          <span>{successMsg}</span>
          <button onClick={() => setSuccessMsg(null)} className="text-green-400">✕</button>
        </div>
      )}
      {serverError && (
        <div className="bg-status-danger/10 border border-status-danger/40 rounded-xl px-4 py-3 text-sm text-status-danger flex items-center justify-between">
          <span>{serverError}</span>
          <button onClick={() => setServerError(null)} className="text-red-400">✕</button>
        </div>
      )}
      {dirty && !saving && (
        <div className="bg-status-warning/10 border border-status-warning/40 rounded-xl px-4 py-2.5 text-sm text-status-warning">
          Tienes cambios sin guardar.
        </div>
      )}

      <CollapsibleHelp title="¿Qué es esto?">
        <p className="leading-relaxed">
          Estos ajustes controlan cómo funciona tu producción: si manejas lotes, cómo se valora la materia prima,
          quién valida los turnos, qué pasa con la merma… Cada opción tiene su explicación — haz clic en el ⓘ junto
          a cada nombre para ver detalles y ejemplos.
        </p>
      </CollapsibleHelp>

      <ValidationBanner warnings={validateConfig(values)} />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">

        {/* ── Trazabilidad y lotes ─────────────────────────────────────── */}
        <div className="card p-4">
          <h2 className="text-sm font-semibold text-ink-primary mb-3 flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-brand-500 inline-block" />
            Trazabilidad y lotes
            <HelpTip text="Controla si manejas lotes de materia prima y producto terminado, fechas de caducidad y FEFO. Esencial para alimentos y farma; opcional para plástico e industria pesada." />
          </h2>
          <FlagRow   field="uses_lots"          values={values} onChange={handleChange} disabled={disabled} />
          <FlagRow   field="uses_expiry"        values={values} onChange={handleChange} disabled={disabled} />
          <FlagRow   field="uses_fefo"          values={values} onChange={handleChange} disabled={disabled} />
          <NumberRow field="expiry_alert_days"  values={values} onChange={handleChange} disabled={disabled} min={0} nullable />
        </div>

        {/* ── Proceso y calidad ────────────────────────────────────────── */}
        <div className="card p-4">
          <h2 className="text-sm font-semibold text-ink-primary mb-3 flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-status-info inline-block" />
            Proceso y calidad
            <HelpTip text="Define si materia prima y producto terminado pasan por una etapa intermedia (proceso) antes de afectar inventario, y reglas de calidad y merma." />
          </h2>
          <FlagRow field="pt_goes_to_wip_first"          values={values} onChange={handleChange} disabled={disabled} />
          <FlagRow field="mp_goes_to_wip_first"          values={values} onChange={handleChange} disabled={disabled} />
          <FlagRow field="allow_second_quality_in_order" values={values} onChange={handleChange} disabled={disabled} />
          <FlagRow field="treat_abnormal_scrap_as_loss"  values={values} onChange={handleChange} disabled={disabled} />
        </div>

        {/* ── Turnos y roles ───────────────────────────────────────────── */}
        <div className="card p-4">
          <h2 className="text-sm font-semibold text-ink-primary mb-3 flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-status-warning inline-block" />
            Turnos y roles
            <HelpTip text="Cómo se manejan los relevos entre turnos y qué roles intervienen en la captura y validación." />
          </h2>
          <FlagRow field="uses_handover"        values={values} onChange={handleChange} disabled={disabled} />
          <FlagRow field="uses_supervisor"      values={values} onChange={handleChange} disabled={disabled} />
          <FlagRow field="supervisor_validates" values={values} onChange={handleChange} disabled={disabled} />
          <FlagRow field="allow_adhoc_shifts"   values={values} onChange={handleChange} disabled={disabled} />
        </div>

        {/* ── Reversión de validación ──────────────────────────────────── */}
        <div className="card p-4">
          <h2 className="text-sm font-semibold text-ink-primary mb-3 flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-status-danger inline-block" />
            Reversión de validación
            <HelpTip text="Qué condiciones permiten al supervisor revertir un turno que ya fue validado para corregirlo. Las reversiones reversean los movimientos de inventario del turno." />
          </h2>
          <FlagRow   field="allow_revert_validation"         values={values} onChange={handleChange} disabled={disabled} />
          <NumberRow field="revert_validation_window_hours"  values={values} onChange={handleChange} disabled={disabled || !values.allow_revert_validation} min={1} nullable />
          <FlagRow   field="block_revert_if_order_fulfilled" values={values} onChange={handleChange} disabled={disabled || !values.allow_revert_validation} />
          <FlagRow   field="block_revert_if_period_closed"   values={values} onChange={handleChange} disabled={disabled || !values.allow_revert_validation} />
          <FlagRow   field="require_revert_dual_approval"    values={values} onChange={handleChange} disabled={disabled || !values.allow_revert_validation} />
        </div>

        {/* ── Costos ───────────────────────────────────────────────────── */}
        <div className="card p-4">
          <h2 className="text-sm font-semibold text-ink-primary mb-3 flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-status-success inline-block" />
            Costos
            <HelpTip text="Método de valoración de la materia prima y cómo se reparten los costos entre paquetes producidos en el mismo turno." />
          </h2>
          <SelectRow
            field="cost_method" values={values} onChange={handleChange} disabled={disabled}
            options={[
              { value: 'weighted_avg', label: 'Promedio ponderado' },
              { value: 'fifo',         label: 'FIFO (primero en entrar, primero en salir)' },
              { value: 'standard',     label: 'Costo estándar' },
            ]}
          />
          <SelectRow
            field="default_intra_shift_proration" values={values} onChange={handleChange} disabled={disabled}
            options={[
              { value: 'weight',  label: 'Por peso (kg)' },
              { value: 'units',   label: 'Por unidades' },
              { value: 'time',    label: 'Por tiempo' },
              { value: 'manual',  label: 'Manual' },
            ]}
          />
          <FlagRow field="simplified_overhead" values={values} onChange={handleChange} disabled={disabled} />
        </div>

        {/* ── Atributos específicos de plástico ─────────────────────────── */}
        <div className="card p-4">
          <h2 className="text-sm font-semibold text-ink-primary mb-3 flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-purple-500 inline-block" />
            Atributos de materias primas
            <HelpTip text="Activa estos atributos solo si tu operación es de plástico. Si están apagados, los campos Tipo de resina y Virgen/Regrind no aparecen en MP ni almacenes." />
          </h2>
          <FlagRow field="uses_resin_types"       values={values} onChange={handleChange} disabled={disabled} />
          <FlagRow field="tracks_material_origin" values={values} onChange={handleChange} disabled={disabled} />
        </div>

        {/* ── Alérgenos y modo operativo ───────────────────────────────── */}
        <div className="card p-4 lg:col-span-2">
          <h2 className="text-sm font-semibold text-ink-primary mb-3 flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-status-danger inline-block" />
            Alérgenos y modo operativo
            <HelpTip text="Reglas de seguridad alimentaria (alérgenos) y nivel de detalle global del flujo de producción." />
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-0 md:gap-6">
            <div>
              <SelectRow
                field="allergen_mode" values={values} onChange={handleChange} disabled={disabled}
                options={[
                  { value: 'strict',        label: 'Estricto — bloquea el cierre' },
                  { value: 'priority_only', label: 'Solo prioritarios — bloquea si es prioritario' },
                  { value: 'alert_only',    label: 'Solo alerta — no bloquea' },
                ]}
              />
            </div>
            <div>
              <SelectRow
                field="operation_mode" values={values} onChange={handleChange} disabled={disabled}
                options={[
                  { value: 'industrial', label: 'Industrial — flujo completo' },
                  { value: 'small',      label: 'Pequeño — flujo simplificado' },
                  { value: 'micro',      label: 'Micro — mínimo operativo' },
                ]}
              />
            </div>
          </div>
        </div>

        {/* ── Inventario ───────────────────────────────────────────────── */}
        <div className="card p-4 lg:col-span-2">
          <h2 className="text-sm font-semibold text-ink-primary mb-3 flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-status-warning inline-block" />
            Inventario
            <HelpTip text="Cómo se comporta el stock cuando una venta/remisión sale sin existencia capturada. Permitir negativo deja el saldo en rojo como bandera de que falta validar producción o capturar una entrada." />
          </h2>
          <FlagRow field="allow_negative_stock" values={values} onChange={handleChange} disabled={disabled} />
        </div>

        {/* ── Módulos opcionales ───────────────────────────────────────── */}
        <div className="card p-4 lg:col-span-2">
          <h2 className="text-sm font-semibold text-ink-primary mb-3 flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-status-info inline-block" />
            Módulos opcionales
            <HelpTip text="Activa módulos adicionales del ERP. Al prenderlos aparecen sus pantallas en el menú." />
          </h2>
          <FlagRow field="expenses_enabled" values={values} onChange={handleChange} disabled={disabled} />
        </div>
      </div>
    </div>
  )
}
