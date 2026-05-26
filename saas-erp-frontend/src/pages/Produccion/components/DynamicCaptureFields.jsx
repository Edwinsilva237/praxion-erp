import clsx from 'clsx'

/**
 * Renderiza un formulario dinámico a partir de un capture_schema definido en
 * tenant_product_kinds.capture_schema. El schema tiene la forma:
 *
 *   { version: N, fields: [{ code, label, type, required?, options?, validation?, ... }] }
 *
 * Tipos soportados: text, number, boolean, select, multiselect, date, color.
 * Los campos con `deprecated: true` no se renderizan.
 *
 * Props:
 *   schema    — el JSONB ya parseado (puede ser null/undefined → no se renderiza nada).
 *   values    — objeto {code: value} con los valores actuales.
 *   onChange  — (code, value) => void
 *   disabled  — boolean, deshabilita todos los inputs.
 *   compact   — boolean, layout más denso (para modales de captura).
 */
export default function DynamicCaptureFields({ schema, values = {}, onChange, disabled, compact }) {
  if (!schema || !Array.isArray(schema.fields) || schema.fields.length === 0) {
    return null
  }
  const fields = schema.fields.filter(f => !f.deprecated)
  if (fields.length === 0) return null

  return (
    <div className={clsx('grid gap-3', compact ? 'grid-cols-2' : 'grid-cols-1')}>
      {fields.map(f => (
        <DynamicField
          key={f.code}
          field={f}
          value={values[f.code]}
          onChange={(v) => onChange?.(f.code, v)}
          disabled={disabled}
        />
      ))}
    </div>
  )
}

function DynamicField({ field, value, onChange, disabled }) {
  const { code, label, type, required, unit_code, validation = {}, options = [] } = field
  const labelEl = (
    <label className="label">
      {label}
      {required && <span className="text-status-danger ml-0.5">*</span>}
      {unit_code && <span className="text-[10px] text-ink-muted ml-1.5 font-mono">({unit_code})</span>}
    </label>
  )

  switch (type) {
    case 'number':
      return (
        <div>
          {labelEl}
          <input type="number" className="input"
            value={value ?? ''}
            min={validation.min}
            max={validation.max}
            step="any"
            disabled={disabled}
            onChange={e => {
              const v = e.target.value
              onChange(v === '' ? null : parseFloat(v))
            }}
          />
        </div>
      )

    case 'boolean':
      return (
        <label className="flex items-center gap-2 px-3 py-2 rounded-lg border border-line-subtle cursor-pointer">
          <input type="checkbox"
            checked={!!value}
            disabled={disabled}
            onChange={e => onChange(e.target.checked)}
            className="w-4 h-4 accent-brand-600" />
          <span className="text-sm text-ink-secondary">{label}</span>
        </label>
      )

    case 'select':
      return (
        <div>
          {labelEl}
          <select className="select"
            value={value ?? ''}
            disabled={disabled}
            onChange={e => onChange(e.target.value || null)}>
            <option value="">— {required ? 'Selecciona' : 'Sin valor'} —</option>
            {options.map(o => <option key={o} value={o}>{o}</option>)}
          </select>
        </div>
      )

    case 'multiselect': {
      const arr = Array.isArray(value) ? value : []
      const toggle = (opt) => {
        const next = arr.includes(opt) ? arr.filter(x => x !== opt) : [...arr, opt]
        onChange(next.length > 0 ? next : null)
      }
      return (
        <div>
          {labelEl}
          <div className="flex flex-wrap gap-1.5 mt-1">
            {options.map(o => (
              <button key={o} type="button"
                disabled={disabled}
                onClick={() => toggle(o)}
                className={clsx(
                  'text-xs px-2 py-1 rounded-full border transition-colors',
                  arr.includes(o)
                    ? 'bg-brand-500/15 border-brand-500/40 text-brand-300'
                    : 'bg-surface-primary border-line-subtle text-ink-muted hover:text-ink-secondary',
                  disabled && 'opacity-50 cursor-not-allowed'
                )}>
                {o}
              </button>
            ))}
          </div>
        </div>
      )
    }

    case 'date':
      return (
        <div>
          {labelEl}
          <input type="date" className="input"
            value={value ?? ''}
            disabled={disabled}
            onChange={e => onChange(e.target.value || null)}
          />
        </div>
      )

    case 'color':
      return (
        <div>
          {labelEl}
          <div className="flex items-center gap-2">
            <input type="color"
              value={value || '#000000'}
              disabled={disabled}
              onChange={e => onChange(e.target.value)}
              className="h-9 w-12 rounded-lg border border-line-subtle bg-transparent cursor-pointer" />
            <input type="text"
              value={value ?? ''}
              placeholder="#RRGGBB o nombre"
              disabled={disabled}
              onChange={e => onChange(e.target.value || null)}
              className="input flex-1 font-mono text-sm" />
          </div>
        </div>
      )

    case 'text':
    default:
      return (
        <div>
          {labelEl}
          <input type="text" className="input"
            value={value ?? ''}
            minLength={validation.minLength}
            maxLength={validation.maxLength}
            pattern={validation.pattern}
            disabled={disabled}
            onChange={e => onChange(e.target.value || null)}
          />
        </div>
      )
  }
}

/**
 * Valida que `values` cumpla con los `required` de `schema`.
 * Retorna `null` si es válido, o un mensaje string con el primer error.
 */
export function validateDynamicValues(schema, values = {}) {
  if (!schema || !Array.isArray(schema.fields)) return null
  for (const f of schema.fields) {
    if (f.deprecated) continue
    if (!f.required) continue
    const v = values[f.code]
    if (v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0)) {
      return `El campo "${f.label}" es requerido.`
    }
  }
  return null
}
