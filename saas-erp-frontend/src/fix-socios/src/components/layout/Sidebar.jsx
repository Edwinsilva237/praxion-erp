import { NavLink } from 'react-router-dom'
import useAuthStore from '@/store/useAuthStore'
import clsx from 'clsx'

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
}

// ── Secciones de navegación ───────────────────────────────────────────────
// permission: si es null, siempre visible. Si es string, se verifica con can()
const NAV_SECTIONS = [
  {
    label: null,
    items: [
      { label: 'Inicio', to: '/', icon: icons.home, end: true, permission: null },
    ],
  },
  {
    label: 'Comercial',
    items: [
      { label: 'Ventas', to: '/ventas', icon: icons.orders, permission: 'ventas:read' },
      { label: 'Remisiones', to: '/remisiones', icon: icons.delivery, permission: 'ventas:read' },
      { label: 'Clientes', to: '/socios', icon: icons.partners, permission: null },
    ],
  },
  {
    label: 'Compras',
    items: [
      { label: 'Órdenes de compra', to: '/compras/ordenes', icon: icons.purchase, permission: 'compras:read' },
      { label: 'Recepciones', to: '/compras/recepciones', icon: icons.receipt, permission: 'compras:read' },
      { label: 'Facturas proveedor', to: '/compras/facturas', icon: icons.invoice, permission: 'compras:read' },
    ],
  },
  {
    label: 'Finanzas',
    items: [
      { label: 'Facturación', to: '/facturacion', icon: icons.invoice, permission: 'facturacion:read' },
      { label: 'Cuentas por cobrar', to: '/cxc', icon: icons.card, permission: 'finanzas:read' },
      { label: 'Cuentas por pagar', to: '/cxp', icon: icons.money, permission: 'finanzas:read' },
    ],
  },
  {
    label: 'Operaciones',
    items: [
      { label: 'Inventario', to: '/inventario', icon: icons.inventory, permission: 'inventario:read' },
      { label: 'Producción', to: '/produccion', icon: icons.gear, permission: 'produccion:read' },
    ],
  },
]

function NavItem({ item }) {
  return (
    <NavLink
      to={item.to}
      end={item.end}
      className={({ isActive }) =>
        clsx(
          'flex items-center gap-2.5 px-4 py-2 text-sm rounded-none transition-colors duration-100',
          'border-l-2',
          isActive
            ? 'bg-brand-500/10 text-brand-300 border-brand-600 font-medium'
            : 'text-ink-secondary border-transparent hover:bg-surface-elevated/40 hover:text-ink-primary'
        )
      }
    >
      {item.icon}
      <span className="truncate">{item.label}</span>
    </NavLink>
  )
}

export default function Sidebar({ onClose }) {
  const { user, tenant, can } = useAuthStore()
  const permissions = useAuthStore((s) => s.permissions)
  const isSuperAdmin = permissions.includes('*')

  return (
    <div className="flex flex-col h-full">
      {/* ── Brand ────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-2.5 px-4 py-4 border-b border-line-subtle">
        <div className="w-7 h-7 bg-brand-600 rounded-lg flex items-center justify-center shrink-0">
          <svg className="w-4 h-4 text-white" fill="currentColor" viewBox="0 0 24 24">
            <path d="M3 13h8V3H3v10zm0 8h8v-6H3v6zm10 0h8V11h-8v10zm0-18v6h8V3h-8z" />
          </svg>
        </div>
        <div className="min-w-0">
          <p className="text-sm font-semibold text-ink-primary truncate">SaaS ERP</p>
          <p className="text-xs text-ink-muted truncate">{tenant?.name || 'Manufactura'}</p>
        </div>
        {/* Botón cerrar — solo en móvil */}
        <button
          onClick={onClose}
          className="ml-auto p-1 rounded-md text-ink-muted hover:text-ink-secondary md:hidden"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* ── Navegación ───────────────────────────────────────────────── */}
      <nav className="flex-1 overflow-y-auto py-2">
        {NAV_SECTIONS.map((section, si) => {
          // Filtra ítems por permiso
          const visibleItems = section.items.filter(
            (item) => !item.permission || isSuperAdmin || can(...item.permission.split(':'))
          )
          if (visibleItems.length === 0) return null

          return (
            <div key={si} className="mb-1">
              {section.label && (
                <p className="px-4 pt-3 pb-1 text-[10px] font-medium text-ink-muted uppercase tracking-widest">
                  {section.label}
                </p>
              )}
              {visibleItems.map((item) => (
                <NavItem key={item.to} item={item} />
              ))}
            </div>
          )
        })}
      </nav>

      {/* ── Footer usuario ───────────────────────────────────────────── */}
      <div className="border-t border-line-subtle px-4 py-3 flex items-center gap-2.5">
        <div className="w-7 h-7 rounded-full bg-brand-500/15 text-brand-300 text-xs font-medium flex items-center justify-center shrink-0">
          {user?.fullName?.slice(0, 2).toUpperCase() || 'U'}
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-xs font-medium text-ink-primary truncate">{user?.fullName || 'Usuario'}</p>
          <p className="text-[10px] text-ink-muted truncate">{user?.email || ''}</p>
        </div>
        <button
          onClick={() => useAuthStore.getState().logout()}
          title="Cerrar sesión"
          className="p-1 text-ink-muted hover:text-status-danger transition-colors"
        >
          <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
            <path d="M17 7l-1.41 1.41L18.17 11H8v2h10.17l-2.58 2.58L17 17l5-5zM4 5h8V3H4c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h8v-2H4V5z" />
          </svg>
        </button>
      </div>
    </div>
  )
}
