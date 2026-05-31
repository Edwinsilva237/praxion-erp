import clsx from 'clsx'

/**
 * Cuadro de ayuda colapsable. Por defecto muestra solo el título en una línea
 * y despliega el contenido al tocarlo. Usa <details> nativo — accesible, sin
 * estado, y la flecha gira al abrir.
 *
 * Uso:
 *   <CollapsibleHelp title="¿Qué es esto?" className="mb-5">
 *     <p className="leading-relaxed">…explicación…</p>
 *   </CollapsibleHelp>
 */
export default function CollapsibleHelp({ title, children, className }) {
  return (
    <details className={clsx(
      'group bg-status-info/10 border border-status-info/40 rounded-xl text-sm text-status-info',
      className
    )}>
      <summary className="font-medium px-4 py-3 cursor-pointer flex items-center justify-between gap-2 list-none select-none [&::-webkit-details-marker]:hidden">
        {title}
        <svg className="w-4 h-4 shrink-0 transition-transform group-open:rotate-180" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </summary>
      <div className="px-4 pb-3">
        {children}
      </div>
    </details>
  )
}
