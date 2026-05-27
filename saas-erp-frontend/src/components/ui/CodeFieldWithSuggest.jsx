import { useQuery } from '@tanstack/react-query'
import { codeFormatsApi } from '@/api/codeFormats'
import clsx from 'clsx'

/**
 * Input para código (SKU / internal_code) que respeta la nomenclatura
 * configurada en Configuración → Nomenclatura de códigos.
 *
 * Comportamiento según el modo configurado:
 *   - manual / sin config → input normal, sin botón ni placeholder extra.
 *   - suggested → muestra placeholder con el siguiente código y botón "Sugerir"
 *                  que llena el input.
 *   - auto      → input readonly con el código pre-llenado; el caller debe
 *                  asegurar que el value esté seteado al abrir el form.
 *
 * Props:
 *   - entityType: 'product' | 'raw_material' | 'customer' | 'supplier'
 *   - value, onChange: controlado
 *   - disabled: forzar disabled (ej. en modo edición donde el código no cambia)
 *   - inputProps: pasa al <input> (className, placeholder fallback, etc.)
 */
export default function CodeFieldWithSuggest({
  entityType,
  value,
  onChange,
  disabled = false,
  inputProps = {},
  className,
}) {
  const { data: cfg, isLoading } = useQuery({
    queryKey: ['code-format-preview', entityType],
    queryFn:  () => codeFormatsApi.previewNext(entityType),
    enabled:  !!entityType && !disabled,
    staleTime: 30_000,
  })

  const mode = cfg?.mode || 'manual'
  const suggestedCode = cfg?.code || null
  const isAuto = mode === 'auto' && suggestedCode
  const isSuggested = mode === 'suggested' && suggestedCode

  function handleSuggest() {
    if (suggestedCode) onChange(suggestedCode)
  }

  return (
    <div className={clsx('flex gap-2 items-stretch', className)}>
      <input
        {...inputProps}
        value={value || ''}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled || isAuto}
        placeholder={isSuggested ? suggestedCode : (inputProps.placeholder || '')}
        className={clsx(
          inputProps.className || 'input',
          (disabled || isAuto) && 'bg-surface-elevated/40 cursor-not-allowed',
          'flex-1 font-mono'
        )}
      />
      {isSuggested && !disabled && (
        <button
          type="button"
          onClick={handleSuggest}
          title={`Sugerir siguiente código: ${suggestedCode}`}
          className="btn-secondary btn-sm shrink-0 px-3"
        >
          ↻ Sugerir
        </button>
      )}
      {isAuto && (
        <span className="text-[10px] text-ink-muted self-center shrink-0">
          (auto)
        </span>
      )}
    </div>
  )
}
