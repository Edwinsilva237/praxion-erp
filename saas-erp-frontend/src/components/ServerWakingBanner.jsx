import useServerStatus from '@/store/useServerStatus'

// Aviso discreto y NO bloqueante que aparece solo cuando una petición se está
// demorando (servidor "despertando" tras inactividad). Lo controla el
// interceptor de axios vía useServerStatus. En condiciones normales (respuestas
// rápidas) nunca se muestra.
export default function ServerWakingBanner() {
  const waking = useServerStatus((s) => s.waking)
  if (!waking) return null

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed left-1/2 -translate-x-1/2 z-[10001] flex items-center gap-2.5
                 rounded-full bg-surface-elevated/95 border border-line-strong shadow-card
                 px-4 py-2 text-sm text-ink-secondary backdrop-blur max-w-[92vw]"
      style={{ top: 'calc(0.75rem + env(safe-area-inset-top))' }}
    >
      <span className="inline-block w-4 h-4 shrink-0 rounded-full border-2 border-brand-500/30 border-t-brand-400 animate-spin" />
      <span className="truncate">Conectando con el servidor… puede tardar si estuvo inactivo.</span>
    </div>
  )
}
