/**
 * Estructura de navegación lateral compartida entre el Sidebar y el editor
 * de roles (pestaña "Menú lateral").
 *
 * Cada item lleva un `iconKey` (string) — el Sidebar lo mapea a su SVG en
 * tiempo de render. Mantener iconos como string aquí permite que este
 * archivo no contenga JSX y se pueda reusar desde donde sea.
 *
 * Items con label que empieza con "└" son hijos del item inmediatamente
 * anterior — el Sidebar los anida automáticamente. En el editor de roles
 * se muestran indentados.
 */

// Cada item puede llevar un `module` que el Sidebar usa para esconderlo cuando
// el tenant tiene ese módulo apagado en el panel super-admin. Items sin
// `module` son universales (siempre visibles si pasa el filtro de permisos).
export const NAV_SECTIONS = [
  {
    label: null,
    items: [
      { label: 'Inicio', to: '/', iconKey: 'home', end: true, permission: null },
    ],
  },
  {
    label: 'Comercial',
    items: [
      { label: 'Cotizaciones',        to: '/cotizaciones',    iconKey: 'quote',    permission: 'sales:read',              module: 'quotations' },
      { label: 'Pedidos',             to: '/ventas',          iconKey: 'orders',   permission: 'sales:read',              module: 'sales' },
      { label: 'Remisiones',          to: '/remisiones',      iconKey: 'delivery', permission: 'sales:read',              module: 'sales' },
      { label: 'Facturación',         to: '/facturacion',     iconKey: 'invoice',  permission: 'invoicing:read',          module: 'invoicing' },
      { label: 'Cuentas por cobrar',  to: '/cxc',             iconKey: 'card',     permission: 'financials:read',         module: 'sales' },
      { label: 'Pagos recibidos',     to: '/pagos-recibidos', iconKey: 'card',     permission: 'financials:read',         module: 'sales' },
      { label: 'Precios por cliente', to: '/precios-cliente', iconKey: 'tag',      permission: 'business_partners:read' },
      { label: 'Socios de negocio',   to: '/socios',          iconKey: 'partners', permission: 'business_partners:read' },
    ],
  },
  {
    label: 'Reportes',
    items: [
      { label: 'Ventas',              to: '/reportes/ventas',             iconKey: 'chartBar',  permission: 'reports:sales',       module: 'reports' },
      { label: 'Producción',          to: '/reportes/produccion',         iconKey: 'chartLine', permission: 'reports:production',  module: 'reports' },
      { label: 'Cuentas por cobrar',  to: '/reportes/cuentas-por-cobrar', iconKey: 'card',      permission: 'reports:cxc',         module: 'reports' },
      { label: 'Cuentas por pagar',   to: '/reportes/cuentas-por-pagar',  iconKey: 'money',     permission: 'reports:cxp',         module: 'reports' },
      { label: 'Contable',            to: '/finanzas/reporte-contable',   iconKey: 'book',      permission: 'reports:accounting',  module: 'reports' },
    ],
  },
  {
    label: 'Producción',
    items: [
      { label: 'Órdenes',         to: '/produccion/ordenes',      iconKey: 'factory',  permission: 'production:read_orders', module: 'production' },
      { label: 'Recetas',         to: '/produccion/recetas',      iconKey: 'receipt',  permission: 'recipes:read',       module: 'production' },
      { label: 'Especificaciones', to: '/produccion/especificaciones', iconKey: 'card', permission: 'products:read',     module: 'production' },
      { label: 'Captura',         to: '/produccion/captura',      iconKey: 'pencil',   permission: 'production:create',  module: 'production' },
      { label: 'Validación',      to: '/produccion/validacion',   iconKey: 'check',    permission: 'production:approve', module: 'production' },
      { label: 'Mis turnos',      to: '/produccion/mis-turnos',   iconKey: 'calendar', permission: 'production:read_own_shifts', module: 'production', hideWhenSelfStart: true },
      { label: 'Programación',    to: '/produccion/programacion', iconKey: 'calendar', permission: 'production:read_schedule', module: 'production', hideWhenSelfStart: true },
      { label: 'Histórico',       to: '/produccion/historico',    iconKey: 'history',  permission: 'production:read_history',  module: 'production' },
    ],
  },
  {
    label: 'Compras',
    items: [
      { label: 'Órdenes de compra',      to: '/compras/ordenes',     iconKey: 'purchase', permission: 'purchases:read',  module: 'purchases' },
      { label: 'Precios por proveedor',  to: '/precios-proveedor',   iconKey: 'tag',      permission: 'purchases:read',  module: 'purchases' },
      { label: 'Recepciones',            to: '/compras/recepciones', iconKey: 'receipt',  permission: 'purchases:read',  module: 'purchases' },
      { label: 'Devoluciones',           to: '/compras/devoluciones', iconKey: 'receipt', permission: 'purchases:read',  module: 'purchases' },
      { label: 'Comprobantes recibidos', to: '/compras/facturas',    iconKey: 'invoice',  permission: 'purchases:read',  module: 'purchases' },
      { label: 'Gastos',                 to: '/gastos',              iconKey: 'expense',  permission: 'expenses:read',   flag: 'expenses_enabled' },
      { label: 'Cuentas por pagar',      to: '/cxp',                 iconKey: 'money',    permission: 'financials:read', module: 'purchases', end: true },
      { label: 'Pagos emitidos',         to: '/pagos-emitidos',      iconKey: 'money',    permission: 'financials:read', module: 'purchases' },
      { label: '└ Anticipos a proveedor', to: '/cxp/anticipos',      iconKey: 'money',    permission: 'financials:read', module: 'purchases' },
    ],
  },
  {
    label: 'Inventario',
    items: [
      { label: 'Stock y kardex',  to: '/inventario',         iconKey: 'boxes',     permission: 'inventory:read',     module: 'inventory', end: true },
      { label: 'Conteos físicos', to: '/inventario/conteos', iconKey: 'clipboard', permission: 'inventory:read',     module: 'inventory' },
      { label: 'Productos',       to: '/productos',          iconKey: 'package',   permission: 'products:read',      module: 'inventory' },
      { label: 'Materias primas', to: '/materias-primas',    iconKey: 'flask',     permission: 'raw_materials:read', module: 'inventory' },
    ],
  },
  {
    label: 'Tesorería',
    items: [
      { label: 'Caja chica', to: '/caja-chica', iconKey: 'money', permission: 'petty_cash:read', module: 'petty_cash' },
    ],
  },
  {
    label: 'Trazabilidad',
    items: [
      { label: 'Rastreo de lotes',      to: '/trazabilidad/lotes',        iconKey: 'card',     permission: 'traceability:read', module: 'traceability' },
      { label: 'Vencimientos próximos', to: '/trazabilidad/vencimientos', iconKey: 'calendar', permission: 'traceability:read', module: 'traceability' },
    ],
  },
  {
    label: 'Costeo',
    items: [
      { label: 'Resumen',           to: '/costeo',                   iconKey: 'card',     permission: 'overhead:read',   module: 'production', end: true },
      { label: 'Gastos indirectos', to: '/costeo/gastos-indirectos', iconKey: 'coins',    permission: 'overhead:read',   module: 'production' },
      { label: 'Períodos del mes',  to: '/costeo/periodos',          iconKey: 'calendar', permission: 'overhead:read',   module: 'production' },
      { label: 'Cierre de mes',     to: '/costeo/cierre',            iconKey: 'receipt',  permission: 'overhead:update', module: 'production' },
      { label: 'Reporte varianza',  to: '/costeo/varianza',          iconKey: 'chartBar', permission: 'overhead:read',   module: 'production' },
    ],
  },
  {
    label: 'Configuración',
    items: [
      { label: 'Identidad de marca',      to: '/configuracion/identidad-marca',       iconKey: 'gear',     permission: 'settings:update' },
      { label: 'Cajas chicas',            to: '/configuracion/caja-chica',            iconKey: 'money',    permission: 'petty_cash:manage', module: 'petty_cash' },
      { label: '└ Categorías',            to: '/configuracion/caja-chica/categorias', iconKey: 'money',    permission: 'petty_cash:manage', module: 'petty_cash' },
      { label: 'Datos fiscales',          to: '/configuracion/datos-fiscales',        iconKey: 'invoice',  permission: 'settings:read',     module: 'invoicing' },
      { label: '└ Series y folios',        to: '/configuracion/series-folios',         iconKey: 'invoice',  permission: 'settings:read',     module: 'invoicing' },
      { label: 'Nomenclatura de códigos', to: '/configuracion/nomenclatura',          iconKey: 'gear',     permission: 'settings:read' },
      { label: 'Procesos (SaaS v2)',        to: '/configuracion/procesos',              iconKey: 'gear',     permission: 'settings:update',   module: 'production' },
      { label: '└ Flags de proceso',       to: '/configuracion/procesos/flags',        iconKey: 'gear',     permission: 'settings:update',   module: 'production' },
      { label: '└ Tipos de merma',         to: '/configuracion/procesos/tipos-merma',  iconKey: 'gear',     permission: 'settings:update',   module: 'production' },
      { label: '└ Grados de calidad',      to: '/configuracion/procesos/calidades',    iconKey: 'gear',     permission: 'settings:update',   module: 'production' },
      { label: '└ Unidades',               to: '/configuracion/procesos/unidades',     iconKey: 'gear',     permission: 'settings:update',   module: 'production' },
      { label: '└ Roles de turno',         to: '/configuracion/procesos/roles-turno',  iconKey: 'gear',     permission: 'settings:update',   module: 'production' },
      { label: '└ Tipos de producto',      to: '/configuracion/procesos/tipos-producto', iconKey: 'gear',   permission: 'settings:update',   module: 'production' },
      { label: '└ Alérgenos',              to: '/configuracion/procesos/alergenos',    iconKey: 'gear',     permission: 'settings:update',   module: 'production' },
      { label: 'Almacenes',               to: '/configuracion/almacenes',             iconKey: 'gear',     permission: 'warehouses:read',   module: 'inventory' },
      { label: 'Categorías de gasto',     to: '/configuracion/categorias-gasto',      iconKey: 'gear',     permission: 'tenant_catalogs:read', flag: 'expenses_enabled' },
      { label: 'Cuentas bancarias',       to: '/configuracion/cuentas-bancarias',     iconKey: 'gear',     permission: 'financials:read' },
      { label: 'Notificaciones',          to: '/configuracion/notificaciones',        iconKey: 'gear',     permission: 'settings:read' },
      { label: 'Usuarios',                to: '/configuracion/usuarios',              iconKey: 'partners', permission: 'users:read' },
      { label: 'Roles y permisos',        to: '/configuracion/roles',                 iconKey: 'gear',     permission: 'roles:read' },
      { label: 'Tareas en segundo plano', to: '/configuracion/tareas-fallidas',       iconKey: 'gear',     permission: 'settings:read' },
      { label: 'Mi suscripción',          to: '/configuracion/suscripcion',           iconKey: 'gear',     permission: 'billing:manage' },
      { label: 'Planes y precios',        to: '/configuracion/planes',                iconKey: 'gear',     permission: 'billing:manage' },
    ],
  },
  {
    label: 'Plataforma',
    platformAdminOnly: true,
    items: [
      { label: 'Organizaciones',     to: '/superadmin',                iconKey: 'partners', end: true },
      { label: 'Nueva organización', to: '/superadmin/tenants/nuevo',  iconKey: 'gear' },
      { label: 'Planes',             to: '/superadmin/plans',          iconKey: 'gear' },
      { label: 'Mensajes y mant.',   to: '/superadmin/mensajes',       iconKey: 'gear' },
    ],
  },
]
