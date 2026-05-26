import { useState } from 'react'
import clsx from 'clsx'

/**
 * Envoltorio para barras de filtros en pantallas de listado.
 *
 * - Desktop (≥sm): renderiza los hijos siempre visibles.
 * - Móvil (<sm): los esconde detrás de un botón "Filtros" con contador
 *   de filtros activos. Toca el botón para mostrarlos/ocultarlos.
 *
 * Uso:
 *   <CollapsibleFilters activeCount={n}>
 *     <div className="card p-4 flex flex-wrap gap-3 items-end">...</div>
 *   </CollapsibleFilters>
 */
export default function CollapsibleFilters({ children, activeCount = 0, className }) {
  const [open, setOpen] = useState(false)

  return (
    <div className={clsx('flex flex-col gap-2', className)}>
      {/* Toggle: solo en móvil */}
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        className="sm:hidden card-sm flex items-center justify-between text-sm font-semibold text-ink-secondary"
      >
        <span className="flex items-center gap-2">
          <svg className="w-4 h-4 text-brand-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
              d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z" />
          </svg>
          Filtros
          {activeCount > 0 && (
            <span className="badge badge-green">{activeCount} activo{activeCount === 1 ? '' : 's'}</span>
          )}
        </span>
        <svg
          className={clsx('w-4 h-4 text-ink-muted transition-transform', open && 'rotate-180')}
          fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {/* Contenido: visible siempre en desktop, condicional en móvil */}
      <div className={clsx(open ? 'block' : 'hidden', 'sm:block')}>
        {children}
      </div>
    </div>
  )
}
