import useAuthStore from '@/store/useAuthStore'

/**
 * Componente para mostrar/ocultar UI según permisos del usuario.
 *
 * Ejemplos:
 *
 *   // Botón solo visible para quien pueda crear órdenes:
 *   <Can do="production:create">
 *     <button>+ Nueva orden</button>
 *   </Can>
 *
 *   // Acepta cualquiera (OR):
 *   <Can do={['production:manage', 'production:approve']}>
 *     <button>Aprobar</button>
 *   </Can>
 *
 *   // Con fallback (ej. mostrar gris en lugar de ocultar):
 *   <Can do="production:manage" fallback={
 *     <button disabled title="Requiere permiso de administración" className="btn-primary opacity-50 cursor-not-allowed">
 *       Configurar
 *     </button>
 *   }>
 *     <button onClick={...}>Configurar</button>
 *   </Can>
 *
 * Para condicionales más complejos (no rodear JSX), usa directamente
 * `useAuthStore(s => s.can)(resource, action)` o el hook `useCan`.
 */
export default function Can({ do: perm, fallback = null, children }) {
  const can    = useAuthStore(s => s.can)
  const canAny = useAuthStore(s => s.canAny)

  let allowed
  if (Array.isArray(perm)) {
    allowed = canAny(...perm)
  } else {
    const [resource, action] = String(perm || '').split(':')
    allowed = resource && action ? can(resource, action) : false
  }

  return allowed ? <>{children}</> : fallback
}

/**
 * Hook compañero — útil cuando el chequeo está dentro de la lógica del
 * componente (no envolviendo JSX). Ejemplo: condicionar un `disabled` o
 * elegir qué acción correr al click.
 *
 *   const canManage = useCan('production:manage')
 *   <button disabled={!canManage} title={!canManage ? 'Sin permiso' : ''}>...</button>
 */
export function useCan(perm) {
  const can    = useAuthStore(s => s.can)
  const canAny = useAuthStore(s => s.canAny)
  if (Array.isArray(perm)) return canAny(...perm)
  const [resource, action] = String(perm || '').split(':')
  return resource && action ? can(resource, action) : false
}
