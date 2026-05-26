import { NavLink, useLocation } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { useState, useEffect, useMemo } from 'react'
import useAuthStore from '@/store/useAuthStore'
import { tenantsApi } from '@/api/tenants'
import { NAV_SECTIONS as NAV_SECTIONS_RAW } from '@/config/sidebarNav'
import clsx from 'clsx'

const COLLAPSE_KEY = 'praxion.sidebar.collapsed'
// Default en primer ingreso: todos los grupos y padres colapsados. Después
// se respeta lo que el usuario haya guardado en localStorage.
const buildDefaultCollapsed = (sections) => {
  const keys = []
  for (const s of sections) {
    if (s.label) keys.push(`s:${s.label}`)
    let lastParent = null
    for (const it of s.items) {
      if (it.label.startsWith('└') && lastParent) keys.push(`p:${lastParent}`)
      else lastParent = it.to
    }
  }
  return new Set(keys)
}
const loadCollapsed = (sections) => {
  const raw = localStorage.getItem(COLLAPSE_KEY)
  if (raw == null) return buildDefaultCollapsed(sections)
  try { return new Set(JSON.parse(raw)) }
  catch { return buildDefaultCollapsed(sections) }
}
const saveCollapsed = (set) => localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...set]))

// Convierte una lista plana de items en jerárquica: cualquier item cuya label
// empiece con '└ ' se cuelga del item inmediatamente anterior como hijo.
function nestItems(items) {
  const result = []
  for (const it of items) {
    if (it.label.startsWith('└') && result.length > 0) {
      const parent = result[result.length - 1]
      parent.children = parent.children || []
      parent.children.push({ ...it, label: it.label.replace(/^└\s*/, '') })
    } else {
      result.push({ ...it })
    }
  }
  return result
}

const isOn = (to, pathname) => pathname === to || pathname.startsWith(to + '/')

// ── Iconos inline ─────────────────────────────────────────────────────────
const icons = {
  home: (
    <svg className="w-4 h-4 shrink-0" fill="currentColor" viewBox="0 0 24 24">
      <path d="M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z" />
    </svg>
  ),
  orders: (
    <svg className="w-4 h-4 shrink-0" fill="currentColor" viewBox="0 0 24 24">
      <path d="M7 18c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm10 0c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zM5.2 6H20l-1.7 8H7.5L5.2 6zM3 4H1v2h2l3.6 7.6L5.2 16H19v-2H7.1l.8-1.6H18c.7 0 1.4-.4 1.7-1L22 5H5.2L4.3 3H1v2l1.9-.0z" />
    </svg>
  ),
  delivery: (
    <svg className="w-4 h-4 shrink-0" fill="currentColor" viewBox="0 0 24 24">
      <path d="M20 8h-3V4H3c-1.1 0-2 .9-2 2v11h2c0 1.66 1.34 3 3 3s3-1.34 3-3h6c0 1.66 1.34 3 3 3s3-1.34 3-3h2v-5l-3-4zM6 18.5c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5zM19.5 9l1.96 2.5H17V9.5h2.5zM18 18.5c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5z" />
    </svg>
  ),
  partners: (
    <svg className="w-4 h-4 shrink-0" fill="currentColor" viewBox="0 0 24 24">
      <path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z" />
    </svg>
  ),
  purchase: (
    <svg className="w-4 h-4 shrink-0" fill="currentColor" viewBox="0 0 24 24">
      <path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-7 3c1.93 0 3.5 1.57 3.5 3.5S13.93 13 12 13s-3.5-1.57-3.5-3.5S10.07 6 12 6zm7 13H5v-.23c0-.62.28-1.2.76-1.58C7.47 15.82 9.64 15 12 15s4.53.82 6.24 2.19c.48.38.76.97.76 1.58V19z" />
    </svg>
  ),
  receipt: (
    <svg className="w-4 h-4 shrink-0" fill="currentColor" viewBox="0 0 24 24">
      <path d="M20 6h-2.18c.07-.44.18-.88.18-1.33C18 2.54 16.46 1 14.67 1c-1.08 0-1.9.5-2.59 1.28L12 2.41l-.08-.13C11.22 1.5 10.4 1 9.33 1 7.54 1 6 2.54 6 4.33c0 .45.1.89.18 1.33H4c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zm-5.33-3c.74 0 1.33.59 1.33 1.33 0 .74-.59 1.34-1.33 1.34-.74 0-1.34-.6-1.34-1.34C13.33 3.59 13.93 3 14.67 3zM9.33 3c.74 0 1.34.59 1.34 1.33 0 .74-.6 1.34-1.34 1.34-.74 0-1.33-.6-1.33-1.34C8 3.59 8.59 3 9.33 3zM20 20H4v-2h16v2zm0-5H4V8h5.08L7 10.83 8.62 12 11 8.76l1-1.36 1 1.36L15.38 12 17 10.83 14.92 8H20v7z" />
    </svg>
  ),
  invoice: (
    <svg className="w-4 h-4 shrink-0" fill="currentColor" viewBox="0 0 24 24">
      <path d="M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z" />
    </svg>
  ),
  money: (
    <svg className="w-4 h-4 shrink-0" fill="currentColor" viewBox="0 0 24 24">
      <path d="M11.8 10.9c-2.27-.59-3-1.2-3-2.15 0-1.09 1.01-1.85 2.7-1.85 1.78 0 2.44.85 2.5 2.1h2.21c-.07-1.72-1.12-3.3-3.21-3.81V3h-3v2.16c-1.94.42-3.5 1.68-3.5 3.61 0 2.31 1.91 3.46 4.7 4.13 2.5.6 3 1.48 3 2.41 0 .69-.49 1.79-2.7 1.79-2.06 0-2.87-.92-2.98-2.1h-2.2c.12 2.19 1.76 3.42 3.68 3.83V21h3v-2.15c1.95-.37 3.5-1.5 3.5-3.55 0-2.84-2.43-3.81-4.7-4.4z" />
    </svg>
  ),
  card: (
    <svg className="w-4 h-4 shrink-0" fill="currentColor" viewBox="0 0 24 24">
      <path d="M20 4H4c-1.11 0-2 .89-2 2v12c0 1.11.89 2 2 2h16c1.11 0 2-.89 2-2V6c0-1.11-.89-2-2-2zm0 14H4v-6h16v6zm0-10H4V6h16v2z" />
    </svg>
  ),
  inventory: (
    <svg className="w-4 h-4 shrink-0" fill="currentColor" viewBox="0 0 24 24">
      <path d="M20 6H4v2h16V6zm-10 6h-2v2H6v2h2v2h2v-2h2v-2h-2v-2zm4 2v2h6v-2h-6zm0 4v2h4v-2h-4zM4 20h10v-2H4v2z" />
    </svg>
  ),
  gear: (
    <svg className="w-4 h-4 shrink-0" fill="currentColor" viewBox="0 0 24 24">
      <path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z" />
    </svg>
  ),
  calendar: (
    <svg className="w-4 h-4 shrink-0" fill="currentColor" viewBox="0 0 24 24">
      <path d="M19 4h-1V2h-2v2H8V2H6v2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 16H5V10h14v10zm0-12H5V6h14v2z" />
    </svg>
  ),
}

// La estructura completa vive en config/sidebarNav.js (sin JSX). Aquí solo
// le inyectamos los iconos mapeando iconKey → SVG inline.
const NAV_SECTIONS = NAV_SECTIONS_RAW.map(section => ({
  ...section,
  items: section.items.map(it => ({ ...it, icon: icons[it.iconKey] })),
}))

function Chevron({ open }) {
  return (
    <svg className={clsx('w-3 h-3 shrink-0 transition-transform duration-150', open && 'rotate-90')}
      fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M9 5l7 7-7 7" />
    </svg>
  )
}

function NavItem({ item, depth = 0 }) {
  return (
    <NavLink
      to={item.to}
      end={item.end}
      className={({ isActive }) =>
        clsx(
          'flex items-center gap-2.5 py-2 text-sm rounded-none transition-colors duration-150 border-l-[3px]',
          depth === 0 ? 'px-4' : 'pl-10 pr-4',
          isActive
            ? 'bg-brand-500/[0.10] text-ink-primary border-brand-500 font-medium'
            : 'text-ink-secondary border-transparent hover:bg-surface-primary/[0.04] hover:text-ink-primary'
        )
      }
    >
      {item.icon}
      <span className="truncate">{item.label}</span>
    </NavLink>
  )
}

function ParentNavItem({ item, depth = 0, isOpen, onToggle }) {
  return (
    <>
      <div className="flex items-stretch">
        <NavLink
          to={item.to}
          end={item.end}
          className={({ isActive }) =>
            clsx(
              'flex-1 flex items-center gap-2.5 py-2 text-sm border-l-[3px] transition-colors duration-150 min-w-0',
              depth === 0 ? 'pl-4 pr-2' : 'pl-10 pr-2',
              isActive
                ? 'bg-brand-500/[0.10] text-ink-primary border-brand-500 font-medium'
                : 'text-ink-secondary border-transparent hover:bg-surface-primary/[0.04] hover:text-ink-primary'
            )
          }
        >
          {item.icon}
          <span className="truncate">{item.label}</span>
        </NavLink>
        <button
          type="button"
          onClick={onToggle}
          aria-label={isOpen ? 'Cerrar submenú' : 'Abrir submenú'}
          className="px-3 text-ink-muted hover:text-ink-primary hover:bg-surface-primary/[0.04] transition-colors"
        >
          <Chevron open={isOpen} />
        </button>
      </div>
      {isOpen && item.children.map(child => (
        <NavItem key={child.to} item={child} depth={depth + 1} />
      ))}
    </>
  )
}

export default function Sidebar({ onClose }) {
  const { user, tenant, can } = useAuthStore()
  const permissions = useAuthStore((s) => s.permissions)
  const isSuperAdmin = permissions.includes('*')
  const isPlatformAdmin = user?.isPlatformAdmin === true
  const { pathname } = useLocation()

  // Modo dedicado: cuando el usuario está dentro de /superadmin, el sidebar
  // se transforma. Esconde todos los menús del ERP del cliente y muestra solo
  // los de la plataforma, con un botón visible para volver al tenant. Esto
  // separa los dos "mundos" (operar el ERP vs administrar la plataforma)
  // sin obligar a tener dos cuentas distintas.
  const isInPlatformMode = pathname.startsWith('/superadmin')

  const [collapsed, setCollapsed] = useState(() => loadCollapsed(NAV_SECTIONS))
  const toggle = (key) => setCollapsed(prev => {
    const next = new Set(prev)
    next.has(key) ? next.delete(key) : next.add(key)
    saveCollapsed(next)
    return next
  })

  // Branding del tenant. Si el cliente subió su propio logo y nombre comercial,
  // se muestran aquí. Si no, fallback al isotipo Praxion.
  const { data: tenantInfo } = useQuery({
    queryKey: ['tenant', 'current'],
    queryFn:  tenantsApi.getCurrent,
    staleTime: 5 * 60 * 1000,
  })
  const tenantLogo    = tenantInfo?.logo_url
  const displayName   = tenantInfo?.display_name || tenantInfo?.name || tenant?.name || 'Sistema'

  // Mapa de módulos apagados del tenant: { invoicing: false, ... }. Si el
  // panel super-admin apaga un módulo, sus items del menú se ocultan aquí.
  const tenantModules = tenantInfo?.modules || tenant?.modules || {}
  const moduleEnabled = (key) => tenantModules[key] !== false

  // Construye las secciones con permisos + módulos aplicados. En modo
  // plataforma SOLO se muestran las secciones marcadas platformAdminOnly.
  // En modo normal se ocultan ESAS secciones (la entrada al panel está en
  // el header, vía botón "Plataforma").
  const sections = useMemo(() => NAV_SECTIONS
    .filter(s => {
      if (s.platformAdminOnly) return isInPlatformMode && isPlatformAdmin
      return !isInPlatformMode
    })
    .map(section => {
      const visible = section.items.filter(it => {
        if (it.module && !moduleEnabled(it.module)) return false
        if (!it.permission) return true
        if (isSuperAdmin) return true
        return can(...it.permission.split(':'))
      })
      return { ...section, items: nestItems(visible) }
    })
    .filter(s => s.items.length > 0),
    [isSuperAdmin, isPlatformAdmin, isInPlatformMode, can, tenantModules]
  )

  // Auto-expandir secciones/padres que contengan la ruta activa, una vez por cambio
  // de pathname. Después el usuario puede volver a colapsar a mano.
  useEffect(() => {
    setCollapsed(prev => {
      let changed = false
      const next = new Set(prev)
      for (const s of sections) {
        const sectionHasActive = s.items.some(it =>
          isOn(it.to, pathname) || (it.children?.some(c => isOn(c.to, pathname)))
        )
        if (s.label && sectionHasActive && next.has(`s:${s.label}`)) {
          next.delete(`s:${s.label}`); changed = true
        }
        for (const it of s.items) {
          if (it.children?.some(c => isOn(c.to, pathname)) && next.has(`p:${it.to}`)) {
            next.delete(`p:${it.to}`); changed = true
          }
        }
      }
      if (!changed) return prev
      saveCollapsed(next)
      return next
    })
  }, [pathname, sections])

  return (
    <div className="flex flex-col h-full bg-bg-secondary">
      {/* ── Brand ────────────────────────────────────────────────────── */}
      <div className={clsx(
        'flex items-center gap-2.5 px-4 py-4 border-b',
        isInPlatformMode
          ? 'border-status-info/40 bg-status-info/5'
          : 'border-line-subtle'
      )}>
        <div className={clsx(
          'w-9 h-9 rounded-md flex items-center justify-center shrink-0 overflow-hidden border',
          isInPlatformMode
            ? 'bg-bg-tertiary border-status-info/40'
            : 'bg-bg-tertiary border-line-subtle'
        )}>
          {isInPlatformMode ? (
            <img src="/praxion-isotipo.svg" alt="Praxion" className="w-7 h-7 object-contain" />
          ) : tenantLogo ? (
            <img src={tenantLogo} alt={displayName} className="w-full h-full object-contain" />
          ) : (
            <img src="/praxion-isotipo.svg" alt="Praxion" className="w-7 h-7 object-contain" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          {isInPlatformMode ? (
            <>
              <p className="text-sm font-semibold text-ink-primary truncate tracking-wide">PRAXION</p>
              <p className="text-[10px] text-status-info truncate uppercase tracking-widest">Modo plataforma</p>
            </>
          ) : (
            <>
              <p className="text-sm font-semibold text-ink-primary truncate tracking-wide">
                {tenantLogo ? displayName : 'PRAXION'}
              </p>
              <p className="text-[10px] text-ink-muted truncate uppercase tracking-widest">
                {tenantLogo ? 'SISTEMA OPERATIVO' : displayName}
              </p>
            </>
          )}
        </div>
        {/* Botón cerrar — solo en móvil */}
        <button
          onClick={onClose}
          className="ml-auto p-1 rounded-md text-ink-muted hover:text-ink-primary md:hidden"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* ── Switch de contexto ───────────────────────────────────────── */}
      {isInPlatformMode ? (
        <NavLink to="/"
          className="flex items-center gap-2 px-4 py-2.5 text-sm text-ink-secondary hover:text-ink-primary hover:bg-surface-primary/[0.04] border-b border-line-subtle transition-colors">
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 19l-7-7m0 0l7-7m-7 7h18" />
          </svg>
          <span className="truncate">Volver a {displayName}</span>
        </NavLink>
      ) : isPlatformAdmin && (
        <NavLink to="/superadmin"
          className="flex items-center gap-2 px-4 py-2.5 text-sm text-status-info hover:text-ink-primary hover:bg-status-info/10 border-b border-line-subtle transition-colors group">
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
          </svg>
          <span className="truncate flex-1">Panel de plataforma</span>
          <svg className="w-3 h-3 opacity-0 group-hover:opacity-100 transition-opacity" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M9 5l7 7-7 7" />
          </svg>
        </NavLink>
      )}

      {/* ── Navegación ───────────────────────────────────────────────── */}
      <nav className="flex-1 overflow-y-auto py-2">
        {sections.map((section, si) => {
          const sectionKey = section.label ? `s:${section.label}` : null
          const sectionOpen = !sectionKey || !collapsed.has(sectionKey)

          const renderItem = (item) => {
            if (item.children?.length) {
              const parentKey = `p:${item.to}`
              const parentOpen = !collapsed.has(parentKey)
              return (
                <ParentNavItem key={item.to} item={item}
                  isOpen={parentOpen}
                  onToggle={() => toggle(parentKey)} />
              )
            }
            return <NavItem key={item.to} item={item} />
          }

          return (
            <div key={si} className="mb-1">
              {section.label ? (
                <button type="button"
                  onClick={() => toggle(sectionKey)}
                  className="w-full flex items-center justify-between px-4 pt-3 pb-1 text-[10px] font-semibold text-ink-muted uppercase tracking-[0.18em] hover:text-ink-secondary transition-colors">
                  <span>{section.label}</span>
                  <Chevron open={sectionOpen} />
                </button>
              ) : null}
              {sectionOpen && section.items.map(renderItem)}
            </div>
          )
        })}
      </nav>

      {/* ── Footer usuario ───────────────────────────────────────────── */}
      <div className="border-t border-line-subtle px-2 py-2 flex items-center gap-1">
        <NavLink
          to="/mi-perfil"
          className={({ isActive }) => clsx(
            'flex items-center gap-2.5 flex-1 min-w-0 px-2 py-1.5 rounded-md transition-colors',
            isActive ? 'bg-surface-primary/[0.06]' : 'hover:bg-surface-primary/[0.04]'
          )}
          title="Editar perfil y cambiar contraseña"
        >
          <div className="w-7 h-7 rounded-full bg-brand-500/15 text-brand-300 text-xs font-semibold flex items-center justify-center shrink-0 border border-brand-500/30">
            {user?.fullName?.slice(0, 2).toUpperCase() || 'U'}
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-xs font-medium text-ink-primary truncate">{user?.fullName || 'Usuario'}</p>
            <p className="text-[10px] text-ink-muted truncate">{user?.email || ''}</p>
          </div>
        </NavLink>
        <button
          onClick={() => useAuthStore.getState().logout()}
          title="Cerrar sesión"
          className="p-1.5 text-ink-muted hover:text-status-danger rounded-md hover:bg-status-danger/10 transition-colors shrink-0"
        >
          <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
            <path d="M17 7l-1.41 1.41L18.17 11H8v2h10.17l-2.58 2.58L17 17l5-5zM4 5h8V3H4c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h8v-2H4V5z" />
          </svg>
        </button>
      </div>
    </div>
  )
}
