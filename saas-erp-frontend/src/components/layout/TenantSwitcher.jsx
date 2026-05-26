import { useState, useRef, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { useQuery } from '@tanstack/react-query'
import useAuthStore from '@/store/useAuthStore'
import { membershipsApi } from '@/api/memberships'

/**
 * Dropdown que lista todas las empresas a las que pertenece el usuario y
 * permite cambiar entre ellas sin re-loguear.
 *
 * Se oculta automáticamente si el usuario solo tiene 1 membresía (no hay
 * nada que elegir). En modo impersonación también se oculta — el actor
 * tiene su sesión "prestada", el switcher no aplica.
 *
 * El menú desplegable se renderiza vía React Portal en `document.body`
 * para escapar los contenedores con `overflow: hidden` y `z-index`
 * conflictivos del AppShell (sidebar y main area).
 */
export default function TenantSwitcher() {
  const activeTenant   = useAuthStore((s) => s.tenant)
  const impersonation  = useAuthStore((s) => s.impersonation)
  const switchTenant   = useAuthStore((s) => s.switchTenant)
  const [open, setOpen] = useState(false)
  const [switching, setSwitching] = useState(null)
  const [coords, setCoords] = useState(null)
  const btnRef = useRef(null)
  const menuRef = useRef(null)

  const { data, isLoading } = useQuery({
    queryKey: ['memberships', 'me'],
    queryFn:  membershipsApi.me,
    staleTime: 60 * 1000,
    enabled: !impersonation,
  })

  const memberships = data?.memberships || []
  const showSwitcher = memberships.length > 1 && !impersonation

  // Calcular posición del menú al abrir y al hacer scroll/resize del viewport.
  useEffect(() => {
    if (!open) return
    function position() {
      if (!btnRef.current) return
      const r = btnRef.current.getBoundingClientRect()
      setCoords({
        top:   r.bottom + 4,                  // 4px debajo del botón
        right: window.innerWidth - r.right,   // alineado al borde derecho del botón
      })
    }
    position()
    window.addEventListener('resize', position)
    window.addEventListener('scroll', position, true)
    return () => {
      window.removeEventListener('resize', position)
      window.removeEventListener('scroll', position, true)
    }
  }, [open])

  // Click outside cierra el menú (considerando portal: el menú no es hijo del botón).
  useEffect(() => {
    if (!open) return
    function onClick(e) {
      const inBtn  = btnRef.current  && btnRef.current.contains(e.target)
      const inMenu = menuRef.current && menuRef.current.contains(e.target)
      if (!inBtn && !inMenu) setOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [open])

  // Cerrar con Escape.
  useEffect(() => {
    if (!open) return
    function onKey(e) { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open])

  async function handlePick(tenantId) {
    if (tenantId === activeTenant?.id) {
      setOpen(false)
      return
    }
    setSwitching(tenantId)
    try {
      await switchTenant(tenantId)
      // switchTenant hace location.href = '/', no llegamos aquí
    } catch (err) {
      setSwitching(null)
      alert(err.response?.data?.error || 'No se pudo cambiar de empresa.')
    }
  }

  // Si solo hay una membresía, mostramos un badge simple (no clickeable).
  if (!showSwitcher) {
    return (
      <span className="hidden sm:inline-flex badge badge-gray text-[11px]">
        {activeTenant?.name || 'Empresa'}
      </span>
    )
  }

  const activeLabel = activeTenant?.name || 'Empresa'

  const menu = open && coords && createPortal(
    <div
      ref={menuRef}
      role="listbox"
      style={{
        position: 'fixed',
        top:      `${coords.top}px`,
        right:    `${coords.right}px`,
        zIndex:   9999,
      }}
      className="
        min-w-[260px] max-h-[60vh] overflow-y-auto
        bg-bg-primary border border-line-subtle rounded-lg shadow-lg
        py-1
      "
    >
      <div className="px-3 py-1.5 text-[10px] uppercase tracking-wider text-ink-tertiary">
        Empresas
      </div>
      {memberships.map((m) => {
        const isActive = m.id === activeTenant?.id
        const isLoadingThis = switching === m.id
        return (
          <button
            key={m.id}
            onClick={() => handlePick(m.id)}
            disabled={isLoadingThis}
            className={`
              w-full text-left px-3 py-2 text-xs flex items-center gap-2
              ${isActive ? 'bg-surface-primary/[0.08]' : 'hover:bg-surface-primary/[0.04]'}
              disabled:opacity-60 disabled:cursor-wait
              transition-colors
            `}
            role="option"
            aria-selected={isActive}
          >
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5">
                <span className="font-medium text-ink-primary truncate">{m.name}</span>
                {m.is_sandbox && (
                  <span className="badge badge-yellow text-[9px] px-1 py-0">sandbox</span>
                )}
                {!m.is_active && (
                  <span className="badge badge-red text-[9px] px-1 py-0">suspendida</span>
                )}
              </div>
              <div className="text-[10px] text-ink-tertiary mt-0.5 flex items-center gap-1.5">
                <span>{m.role}</span>
                <span>·</span>
                <span className="truncate">{m.slug}</span>
              </div>
            </div>
            {isActive && (
              <svg className="w-4 h-4 text-positive shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
            )}
            {isLoadingThis && (
              <svg className="w-3.5 h-3.5 animate-spin text-ink-tertiary shrink-0" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"></path>
              </svg>
            )}
          </button>
        )
      })}
    </div>,
    document.body
  )

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={isLoading || switching}
        className="
          inline-flex items-center gap-1.5 text-[11px] px-2 py-1 rounded-md
          bg-surface-primary/[0.04] hover:bg-surface-primary/[0.08]
          text-ink-secondary hover:text-ink-primary
          border border-line-subtle transition-colors
          disabled:opacity-60 disabled:cursor-not-allowed
        "
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <svg className="w-3.5 h-3.5 opacity-70" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
            d="M4 7h16M4 12h16M4 17h16" />
        </svg>
        <span className="truncate max-w-[160px]">{activeLabel}</span>
        <svg
          className={`w-3 h-3 transition-transform ${open ? 'rotate-180' : ''}`}
          fill="none" viewBox="0 0 24 24" stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
            d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {menu}
    </>
  )
}
