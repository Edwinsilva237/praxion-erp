import { useState, useEffect } from 'react'
import { useLocation } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { tenantsApi } from '@/api/tenants'
import useAuthStore from '@/store/useAuthStore'
import Sidebar from './Sidebar'
import Topbar from './Topbar'
import BottomNav from './BottomNav'
import BillingBanner from './BillingBanner'
import SystemMessageBanner from '@/components/SystemMessageBanner'
import ImpersonationBanner from '@/components/ImpersonationBanner'

export default function AppShell({ children }) {
  const [drawerOpen, setDrawerOpen] = useState(false)
  const location = useLocation()
  const refresh = useAuthStore((s) => s.refresh)

  // Refresca permisos y roles desde /auth/me al cargar la app y al volver
  // del background. Así si un admin cambia los roles del usuario logueado,
  // se actualiza el sidebar sin necesidad de cerrar sesión.
  useEffect(() => {
    refresh()
    function onFocus() { refresh() }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [refresh])

  // Detectar si el tenant actual está en modo sandbox para mostrar banner.
  const { data: tenant } = useQuery({
    queryKey: ['tenant', 'current'],
    queryFn:  tenantsApi.getCurrent,
    staleTime: 5 * 60 * 1000,
  })
  const isSandbox = !!tenant?.is_sandbox

  // Cierra el drawer al navegar (móvil)
  useEffect(() => {
    setDrawerOpen(false)
  }, [location.pathname])

  // Cierra el drawer al redimensionar a desktop
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 768px)')
    const handler = (e) => { if (e.matches) setDrawerOpen(false) }
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [])

  return (
    <div className="flex h-screen overflow-hidden bg-bg-primary text-ink-primary">

      {/* ── Overlay móvil ──────────────────────────────────────────────── */}
      {drawerOpen && (
        <div
          className="fixed inset-0 z-20 bg-bg-primary/80 backdrop-blur-sm md:hidden"
          onClick={() => setDrawerOpen(false)}
        />
      )}

      {/* ── Sidebar ────────────────────────────────────────────────────── */}
      {/* Desktop: siempre visible | Móvil: drawer deslizable */}
      <aside
        className={`
          fixed inset-y-0 left-0 z-30 w-72 md:w-56 flex-shrink-0
          bg-bg-secondary border-r border-line-subtle
          transition-transform duration-200 ease-out
          md:static md:translate-x-0
          ${drawerOpen ? 'translate-x-0 drawer-enter' : '-translate-x-full'}
        `}
        style={{ paddingTop: 'env(safe-area-inset-top)' }}
      >
        <Sidebar onClose={() => setDrawerOpen(false)} />
      </aside>

      {/* ── Área principal ─────────────────────────────────────────────── */}
      {/* paddingTop = área segura: en Android edge-to-edge (targetSdk 36) el
          webview se dibuja bajo la barra de estado; sin esto, los banners y la
          barra superior (menú + cambio de empresa) quedan tapados y no se
          pueden tocar. */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden bg-bg-primary"
        style={{ paddingTop: 'env(safe-area-inset-top)' }}>
        {/* Banner: estás administrando la plataforma (afecta a TODOS los
            clientes). Color azul informativo para diferenciarlo del banner
            ámbar de sandbox y del rojo de errores. */}
        {location.pathname.startsWith('/superadmin') && (
          <div className="bg-status-info/15 border-b border-status-info/40 text-status-info text-center text-xs font-semibold py-1.5 px-3
                          flex items-center justify-center gap-2 tracking-wide">
            <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M2.166 4.999A11.954 11.954 0 0010 1.944 11.954 11.954 0 0017.834 5c.11.65.166 1.32.166 2.001 0 5.225-3.34 9.67-8 11.317C5.34 16.67 2 12.225 2 7c0-.682.057-1.35.166-2.001zm11.541 3.708a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd"/>
            </svg>
            MODO PLATAFORMA · Los cambios aquí afectan a todos los clientes de Praxion
          </div>
        )}
        {isSandbox && (
          <div className="bg-status-warning/15 border-b border-status-warning/40 text-status-warning text-center text-xs font-semibold py-1.5 px-3
                          flex items-center justify-center gap-2 tracking-wide">
            <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 5a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 5zm0 9a1 1 0 100-2 1 1 0 000 2z" clipRule="evenodd"/>
            </svg>
            MODO SANDBOX · {tenant?.name || ''} · Datos reseteables y sin valor fiscal
          </div>
        )}
        <ImpersonationBanner />
        <BillingBanner />
        <SystemMessageBanner />
        <Topbar onMenuClick={() => setDrawerOpen(true)} />

        <main
          className="flex-1 overflow-y-auto md:pb-0"
          style={{
            // En móvil dejamos espacio para el BottomNav + safe-area-inset-bottom
            paddingBottom: 'calc(var(--bottomnav-height) + env(safe-area-inset-bottom))',
          }}
        >
          <div className="page-enter p-4 md:p-6 max-w-7xl mx-auto">
            {children}
          </div>
        </main>

        {/* Bottom nav solo en móvil */}
        <div className="md:hidden">
          <BottomNav />
        </div>
      </div>
    </div>
  )
}
