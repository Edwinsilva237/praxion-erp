import { NavLink } from 'react-router-dom'
import useAuthStore from '@/store/useAuthStore'
import { MOBILE_TABS, MOBILE_TABS_BY_KEY, MAX_MOBILE_TABS } from '@/config/mobileTabs'
import clsx from 'clsx'

// ── Iconos inline ─────────────────────────────────────────────────────────
const icons = {
  home: (
    <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
      <path d="M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z" />
    </svg>
  ),
  capture: (
    <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
      <path d="M20 6h-2.18c.07-.44.18-.88.18-1.33C18 2.54 16.46 1 14.67 1c-1.08 0-1.9.5-2.59 1.28L12 2.41l-.08-.13C11.22 1.5 10.4 1 9.33 1 7.54 1 6 2.54 6 4.33c0 .45.1.89.18 1.33H4c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zM20 20H4v-2h16v2zm0-5H4V8h16v7z" />
    </svg>
  ),
  orders: (
    <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
      <path d="M7 18c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm10 0c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zM5.2 6H20l-1.7 8H7.5L5.2 6z" />
    </svg>
  ),
  calendar: (
    <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
      <path d="M19 4h-1V2h-2v2H8V2H6v2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 16H5V10h14v10zm0-12H5V6h14v2z" />
    </svg>
  ),
  history: (
    <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
      <path d="M13 3c-4.97 0-9 4.03-9 9H1l3.89 3.89.07.14L9 12H6c0-3.87 3.13-7 7-7s7 3.13 7 7-3.13 7-7 7c-1.93 0-3.68-.79-4.94-2.06l-1.42 1.42C8.27 19.99 10.51 21 13 21c4.97 0 9-4.03 9-9s-4.03-9-9-9zm-1 5v5l4.28 2.54.72-1.21-3.5-2.08V8H12z" />
    </svg>
  ),
  sales: (
    <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
      <path d="M7 18c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm10 0c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zM5.2 6H20l-1.7 8H7.5L5.2 6z" />
    </svg>
  ),
  purchase: (
    <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
      <path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-7 3c1.93 0 3.5 1.57 3.5 3.5S13.93 13 12 13s-3.5-1.57-3.5-3.5S10.07 6 12 6zm7 13H5v-.23c0-.62.28-1.2.76-1.58C7.47 15.82 9.64 15 12 15s4.53.82 6.24 2.19c.48.38.76.97.76 1.58V19z" />
    </svg>
  ),
  finance: (
    <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
      <path d="M20 4H4c-1.11 0-2 .89-2 2v12c0 1.11.89 2 2 2h16c1.11 0 2-.89 2-2V6c0-1.11-.89-2-2-2zm0 14H4v-6h16v6zm0-10H4V6h16v2z" />
    </svg>
  ),
  inventory: (
    <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
      <path d="M20 6H4v2h16V6zm-10 6h-2v2H6v2h2v2h2v-2h2v-2h-2v-2zm4 2v2h6v-2h-6zm0 4v2h4v-2h-4zM4 20h10v-2H4v2z" />
    </svg>
  ),
}

// Decora un tab del catálogo (sin icono) agregando su SVG inline.
const withIcon = (tab) => ({ ...tab, icon: icons[tab.iconKey] })

export default function BottomNav() {
  const { can } = useAuthStore()
  const permissions = useAuthStore((s) => s.permissions)
  const user        = useAuthStore((s) => s.user)
  const mobileTabs  = useAuthStore((s) => s.uiPrefs?.mobile_tabs)
  const isSuperAdmin = user?.roles?.includes?.('super_admin') || permissions.includes('*')

  // Si el rol del usuario tiene mobile_tabs configurado, respetamos esa lista
  // (orden incluido). Sino, filtramos el catálogo por permiso y dejamos los
  // primeros 5 (comportamiento histórico).
  let visibleTabs
  if (mobileTabs?.length) {
    visibleTabs = mobileTabs
      .map(key => MOBILE_TABS_BY_KEY[key])
      .filter(Boolean)
      .map(withIcon)
      .slice(0, MAX_MOBILE_TABS)
  } else {
    visibleTabs = MOBILE_TABS
      .filter(t => !t.permission || isSuperAdmin || can(...t.permission.split(':')))
      .slice(0, MAX_MOBILE_TABS)
      .map(withIcon)
  }

  if (visibleTabs.length === 0) return null

  return (
    <nav
      className="
        fixed bottom-0 left-0 right-0 z-10
        bg-bg-secondary/95 backdrop-blur border-t border-line-subtle
        flex items-stretch
      "
      style={{
        // Respeta la barra home virtual del iPhone (safe-area-inset-bottom)
        paddingBottom: 'env(safe-area-inset-bottom)',
        minHeight: 'calc(var(--bottomnav-height) + env(safe-area-inset-bottom))',
      }}
    >
      {visibleTabs.map((tab) => (
        <NavLink
          key={tab.key || tab.to}
          to={tab.to}
          end={tab.end}
          className={({ isActive }) =>
            clsx(
              'flex-1 flex flex-col items-center justify-center gap-0.5 text-[10px] transition-colors',
              isActive ? 'text-brand-300' : 'text-ink-muted'
            )
          }
        >
          {tab.icon}
          <span>{tab.label}</span>
        </NavLink>
      ))}
    </nav>
  )
}
