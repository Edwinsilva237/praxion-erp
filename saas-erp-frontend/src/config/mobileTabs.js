// Catálogo de tabs disponibles para la barra inferior del móvil (BottomNav).
//
// Cada tab tiene una `key` estable que es la que se guarda en
// roles.mobile_tabs como JSON. Si cambian etiqueta/ruta/permiso, la key
// no se debe tocar — eso rompería los roles ya configurados.

export const MOBILE_TABS = [
  {
    key:         'home',
    label:       'Inicio',
    to:          '/',
    end:         true,
    permission:  null,
    iconKey:     'home',
  },
  {
    key:         'production-capture',
    label:       'Captura',
    to:          '/produccion/captura',
    permission:  'production:create',
    iconKey:     'capture',
  },
  {
    key:         'production-orders',
    label:       'Órdenes',
    to:          '/produccion/ordenes',
    permission:  'production:read_orders',
    iconKey:     'orders',
  },
  {
    key:         'production-schedule',
    label:       'Programación',
    to:          '/produccion/programacion',
    permission:  'production:read',
    iconKey:     'calendar',
  },
  {
    key:         'production-history',
    label:       'Histórico',
    to:          '/produccion/historico',
    permission:  'production:read',
    iconKey:     'history',
  },
  {
    key:         'sales',
    label:       'Pedidos',
    to:          '/ventas',
    permission:  'sales:read',
    iconKey:     'sales',
  },
  {
    key:         'sales-quotations',
    label:       'Cotizaciones',
    to:          '/cotizaciones',
    permission:  'sales:read',
    iconKey:     'sales',
  },
  {
    key:         'sales-delivery-notes',
    label:       'Remisiones',
    to:          '/remisiones',
    permission:  'sales:read',
    iconKey:     'sales',
  },
  {
    key:         'invoicing',
    label:       'Facturación',
    to:          '/facturacion',
    permission:  'invoicing:read',
    iconKey:     'sales',
  },
  {
    key:         'purchases',
    label:       'Compras',
    to:          '/compras/ordenes',
    permission:  'purchases:read',
    iconKey:     'purchase',
  },
  {
    key:         'finance',
    label:       'Pagos recibidos (CxC)',
    to:          '/cxc',
    permission:  'financials:read',
    iconKey:     'finance',
  },
  {
    key:         'cxp',
    label:       'Pagos emitidos (CxP)',
    to:          '/cxp',
    permission:  'financials:read',
    iconKey:     'finance',
  },
  {
    key:         'inventory',
    label:       'Inventario',
    to:          '/inventario',
    permission:  'inventory:read',
    iconKey:     'inventory',
  },
  {
    key:         'petty-cash',
    label:       'Caja chica',
    to:          '/caja-chica',
    permission:  'petty_cash:read',
    iconKey:     'finance',
  },
]

export const MOBILE_TABS_BY_KEY = Object.fromEntries(MOBILE_TABS.map(t => [t.key, t]))

export const MAX_MOBILE_TABS = 5
