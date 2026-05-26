import { useLocation } from 'react-router-dom'
import TenantSwitcher from './TenantSwitcher'

const ROUTE_LABELS = {
  '/':                    'Inicio',
  '/socios':              'Socios de negocio',
  '/clientes':            'Socios de negocio',
  '/ventas':              'Órdenes de venta',
  '/cotizaciones':        'Cotizaciones',
  '/remisiones':          'Remisiones',
  '/compras/ordenes':     'Órdenes de compra',
  '/compras/recepciones': 'Recepciones',
  '/compras/facturas':    'Facturas de proveedor',
  '/facturacion':         'Facturación',
  '/cxc':                 'Pagos recibidos',
  '/cxp':                 'Pagos emitidos',
  '/inventario':          'Inventario',
  '/produccion':          'Producción',
  '/reportes/ventas':                 'Reporte de ventas',
  '/reportes/produccion':             'Reporte de producción',
  '/reportes/cuentas-por-cobrar':     'Cuentas por cobrar',
  '/reportes/cuentas-por-pagar':      'Cuentas por pagar',
  '/caja-chica':                      'Caja chica',
  '/configuracion/caja-chica':                 'Cajas chicas',
  '/configuracion/caja-chica/categorias':      'Categorías de caja chica',
}

export default function Topbar({ onMenuClick }) {
  const location = useLocation()
  const pageTitle = ROUTE_LABELS[location.pathname] || 'ERP'

  return (
    <header
      className="
        h-[var(--topbar-height)] bg-bg-secondary/80 backdrop-blur border-b border-line-subtle
        flex items-center px-4 gap-3 shrink-0
      "
    >
      {/* Botón hamburguesa — solo en móvil */}
      <button
        onClick={onMenuClick}
        className="md:hidden p-1.5 rounded-md text-ink-secondary hover:bg-surface-primary/[0.04] hover:text-ink-primary transition-colors"
        aria-label="Abrir menú"
      >
        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
            d="M4 6h16M4 12h16M4 18h16" />
        </svg>
      </button>

      {/* Título de página */}
      <h1 className="text-sm font-semibold text-ink-primary flex-1 truncate tracking-wide">
        {pageTitle}
      </h1>

      {/* Badges de contexto */}
      <div className="flex items-center gap-2">
        <TenantSwitcher />
        <span className="badge badge-green text-[11px]">MXN</span>
      </div>
    </header>
  )
}
