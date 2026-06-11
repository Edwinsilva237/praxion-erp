import clsx from 'clsx'

/**
 * Encabezado de tabla clickeable para ordenar. Reusable en todas las tablas de
 * documentos. Muestra una flecha ▲/▼ cuando la columna está activa y ↕ tenue
 * cuando no.
 *
 * Uso:
 *   <SortableHeader sortKey="folio" sortBy={sortBy} sortDir={sortDir} onSort={onSort}>
 *     Folio
 *   </SortableHeader>
 *
 * Props:
 *  - sortKey: clave de la columna (debe existir en el allowlist del backend).
 *  - sortBy/sortDir: estado actual (de useTableSort).
 *  - onSort: callback (de useTableSort). Recibe (sortKey, initialDir?).
 *  - initialDir: dirección al activar esta columna por primera vez ('desc' por
 *    defecto; usa 'asc' para columnas de texto como nombre del cliente).
 *  - align: 'right' alinea contenido y flecha a la derecha (para columnas de monto).
 */
export function SortableHeader({
  sortKey, sortBy, sortDir, onSort,
  initialDir = 'desc', align, className, children,
}) {
  const active = sortBy === sortKey
  return (
    <th
      onClick={() => onSort(sortKey, initialDir)}
      className={clsx('cursor-pointer select-none hover:text-ink-primary transition-colors',
        align === 'right' && 'text-right', className)}
      title="Ordenar por esta columna"
    >
      <span className={clsx('inline-flex items-center gap-1', align === 'right' && 'flex-row-reverse')}>
        {children}
        <span className={clsx('text-[9px] leading-none',
          active ? 'text-brand-300' : 'text-ink-muted/40')}>
          {active ? (sortDir === 'asc' ? '▲' : '▼') : '↕'}
        </span>
      </span>
    </th>
  )
}
