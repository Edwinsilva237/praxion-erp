import { useState, useRef, useEffect } from 'react'
import clsx from 'clsx'

/**
 * Ayuda contextual inline. Dos modos:
 *
 *   1. Tooltip corto (default): hover → muestra `text`
 *      <HelpTip text="Explicación breve" />
 *
 *   2. Popover detallado: click → abre panel con título, body y ejemplos
 *      <HelpTip
 *        title="¿Qué es la base de prorrateo?"
 *        body="Determina cómo se reparte el costo entre turnos…"
 *        examples={[
 *          { label: 'Renta', value: 'Partes iguales' },
 *          { label: 'Luz',   value: 'Por kg producido' },
 *        ]}
 *      />
 *
 *  Props:
 *    text     — string corto para tooltip simple
 *    title    — título del popover
 *    body     — string o ReactNode con la explicación principal
 *    examples — array de {label, value} para casos de uso típicos
 *    size     — 'sm' (default) | 'md'
 *    align    — 'start' | 'center' (default) | 'end' — alineación horizontal del popover
 *    className — clases extras al ícono
 */
export default function HelpTip({
  text, title, body, examples,
  size = 'sm', align = 'center', className,
}) {
  const isPopover = !!(title || body || examples)
  const [open, setOpen] = useState(false)
  const ref = useRef(null)

  // Cierra el popover al hacer click fuera
  useEffect(() => {
    if (!open) return
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    const onKey  = (e) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const iconSize = size === 'md' ? 'w-4 h-4' : 'w-3.5 h-3.5'

  if (!isPopover) {
    // Tooltip simple — usa el atributo title nativo
    return (
      <span title={text} className={clsx('inline-flex items-center text-ink-muted hover:text-ink-secondary cursor-help', className)}>
        <Icon className={iconSize} />
      </span>
    )
  }

  const alignCls = align === 'start' ? 'left-0' : align === 'end' ? 'right-0' : 'left-1/2 -translate-x-1/2'

  return (
    <span ref={ref} className={clsx('relative inline-flex items-center', className)}>
      <button
        type="button"
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); setOpen(v => !v) }}
        aria-expanded={open}
        className={clsx(
          'inline-flex items-center justify-center rounded-full transition-colors',
          open ? 'text-brand-300' : 'text-ink-muted hover:text-ink-secondary',
        )}
        title={title}
      >
        <Icon className={iconSize} />
      </button>

      {open && (
        <div
          className={clsx(
            'absolute z-50 mt-1 top-full w-72 sm:w-80 rounded-lg border border-line-subtle bg-surface-primary shadow-lg p-3.5 text-left',
            alignCls,
          )}
        >
          {title && (
            <p className="text-xs font-semibold text-ink-primary mb-1.5">{title}</p>
          )}
          {body && (
            <div className="text-xs leading-relaxed text-ink-secondary mb-2 last:mb-0">{body}</div>
          )}
          {examples?.length > 0 && (
            <div className="mt-2 pt-2 border-t border-line-subtle">
              <p className="text-[10px] uppercase tracking-wide font-semibold text-ink-muted mb-1.5">Ejemplos</p>
              <ul className="space-y-1">
                {examples.map((e, i) => (
                  <li key={i} className="text-xs flex items-baseline gap-2">
                    <span className="font-medium text-ink-secondary">{e.label}:</span>
                    <span className="text-ink-muted">{e.value}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </span>
  )
}

function Icon({ className }) {
  return (
    <svg className={className} fill="currentColor" viewBox="0 0 20 20" aria-hidden="true">
      <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1.5 1.5 0 00-1.5 1.5.75.75 0 11-1.5 0 3 3 0 116 0c0 1.045-.535 1.674-1.103 2.062a3.06 3.06 0 00-.572.531c-.082.105-.094.149-.094.157V11a.75.75 0 11-1.5 0v-.75c0-.605.366-1.026.711-1.4l.029-.032c.318-.347.66-.682.66-1.318A1.5 1.5 0 0010 5z" clipRule="evenodd"/>
    </svg>
  )
}
