/**
 * Metadata de permisos y procesos del sistema.
 *
 * Lo usa la página de Roles para:
 *   - Agrupar los recursos por PROCESO de negocio (más intuitivo que alfabético).
 *   - Renombrar recursos técnicos a etiquetas humanas.
 *   - Ofrecer PLANTILLAS de roles típicos.
 *
 * Si agregas nuevos permisos en BD, actualiza este archivo para que aparezcan
 * en la sección correcta y con la etiqueta apropiada.
 */

// ── Etiquetas humanas por recurso ────────────────────────────────────────────
export const RESOURCE_LABELS = {
  sales:             'Pedidos, remisiones y cotizaciones',
  invoicing:         'Facturación CFDI',
  fiscal:            'Distribución de documentos fiscales (CSF/32-D) a clientes',
  financials:        'Pagos recibidos y emitidos',
  business_partners: 'Clientes y proveedores',
  products:          'Catálogo de productos',

  purchases:         'Órdenes de compra y recepciones',

  production:        'Órdenes y turnos de producción',
  scrap:             'Scrap y mermas',
  raw_materials:     'Materias primas',
  traceability:      'Trazabilidad de lotes (búsqueda y expiraciones)',

  process_config:    'Configuración del Process Template (flags globales)',
  tenant_catalogs:   'Catálogos del tenant (unidades, mermas, calidades, alérgenos, etc.)',

  inventory:         'Inventario y movimientos',
  warehouses:        'Almacenes',

  petty_cash:        'Caja chica (entradas/salidas)',

  reports:           'Reportes',

  hr:                'Recursos Humanos (empleados y vacaciones)',

  users:             'Usuarios del sistema',
  roles:             'Roles y permisos',
  settings:          'Configuración del tenant',
  attachments:       'Archivos adjuntos',
  audit_logs:        'Logs de auditoría',
  billing:           'Suscripción y facturación de la plataforma',
}

// ── Agrupación por proceso de negocio ────────────────────────────────────────
// El orden importa: define cómo se renderiza arriba a abajo.
export const PROCESS_GROUPS = [
  {
    key:   'commercial',
    label: '🛒 Comercial',
    description: 'Todo lo relacionado al cliente: pedidos, entregas, facturación, cobros.',
    resources: ['sales', 'invoicing', 'fiscal', 'financials', 'business_partners', 'products'],
  },
  {
    key:   'purchases',
    label: '🛍 Compras',
    description: 'Ciclo del proveedor: OC, recepciones, comprobantes recibidos, pagos.',
    resources: ['purchases'],
    // financials aparece también arriba — un rol de compras necesita ver CXP.
  },
  {
    key:   'production',
    label: '🏭 Producción',
    description: 'Manufactura: órdenes, turnos, captura, validación, scrap, MP.',
    resources: ['production', 'scrap', 'raw_materials', 'traceability'],
  },
  {
    key:   'inventory',
    label: '📦 Inventario',
    description: 'Existencias, kardex, ajustes y almacenes.',
    resources: ['inventory', 'warehouses'],
  },
  {
    key:   'treasury',
    label: '💵 Tesorería',
    description: 'Caja chica y movimientos en efectivo.',
    resources: ['petty_cash'],
  },
  {
    key:   'reports',
    label: '📊 Reportes',
    description: 'Acceso a cada reporte por separado: Ventas, CxC, CxP, Producción, Contable.',
    resources: ['reports'],
  },
  {
    key:   'process_template',
    label: '🧬 Configuración del proceso',
    description: 'Flags globales y catálogos del Process Template (unidades, mermas, alérgenos, etc.).',
    resources: ['process_config', 'tenant_catalogs'],
  },
  {
    key:   'hr',
    label: '👥 Recursos Humanos',
    description: 'Empleados, periodos vacacionales y saldos. Información sensible (salarios).',
    resources: ['hr'],
  },
  {
    key:   'system',
    label: '⚙ Sistema',
    description: 'Usuarios, roles, configuración, auditoría, archivos.',
    resources: ['users', 'roles', 'settings', 'attachments', 'audit_logs', 'billing'],
  },
]

// ── Plantillas de roles típicos ──────────────────────────────────────────────
// Cada plantilla es una función que recibe la lista de TODOS los permisos
// (con id, resource, action) y devuelve los ids que deben quedar marcados.
// Esto permite que sigan funcionando aunque cambies ids o agregues permisos.
export const ROLE_TEMPLATES = [
  {
    key:   'vendedor',
    label: '🛒 Vendedor',
    description: 'Captura pedidos, remisiones, ve clientes y productos. No factura ni cobra.',
    matches: (p) =>
      (p.resource === 'sales') ||
      (p.resource === 'business_partners') ||
      (p.resource === 'products' && p.action === 'read') ||
      (p.resource === 'inventory' && p.action === 'read') ||
      (p.resource === 'financials' && p.action === 'read') ||
      (p.resource === 'reports' && p.action === 'sales'),
  },
  {
    key:   'facturista',
    label: '🧾 Facturista',
    description: 'Emite facturas, complementos, NCs. Ve pedidos y remisiones para facturar.',
    matches: (p) =>
      (p.resource === 'invoicing') ||
      (p.resource === 'sales' && p.action === 'read') ||
      (p.resource === 'business_partners' && ['read', 'update'].includes(p.action)) ||
      (p.resource === 'financials') ||
      (p.resource === 'reports' && ['sales', 'accounting'].includes(p.action)),
  },
  {
    key:   'cobranza',
    label: '💰 Cobranza',
    description: 'Aplica pagos recibidos, registra anticipos y emite recibos.',
    matches: (p) =>
      (p.resource === 'financials') ||
      (p.resource === 'invoicing' && p.action === 'read') ||
      (p.resource === 'business_partners' && p.action === 'read') ||
      (p.resource === 'sales' && p.action === 'read') ||
      (p.resource === 'reports' && ['sales', 'cxc'].includes(p.action)),
  },
  {
    key:   'compras',
    label: '📋 Compras',
    description: 'Crea OC, recibe mercancía, registra facturas de proveedor y pagos emitidos.',
    matches: (p) =>
      (p.resource === 'purchases') ||
      (p.resource === 'business_partners') ||
      (p.resource === 'financials') ||
      (p.resource === 'products' && p.action === 'read') ||
      (p.resource === 'raw_materials' && p.action === 'read') ||
      (p.resource === 'inventory' && p.action === 'read') ||
      (p.resource === 'warehouses' && p.action === 'read') ||
      (p.resource === 'reports' && ['cxp', 'inventory'].includes(p.action)),
  },
  {
    key:   'almacenista',
    label: '📦 Almacenista',
    description: 'Confirma recepciones, hace conteos físicos y ajustes de inventario.',
    matches: (p) =>
      (p.resource === 'inventory') ||
      (p.resource === 'warehouses' && p.action === 'read') ||
      (p.resource === 'purchases' && ['read', 'update'].includes(p.action)) ||
      (p.resource === 'products' && p.action === 'read') ||
      (p.resource === 'raw_materials' && p.action === 'read'),
  },
  {
    key:   'produccion_capturista',
    label: '🏭 Producción (capturista)',
    description: 'Captura turnos, registra avances. No aprueba ni cierra.',
    matches: (p) =>
      (p.resource === 'production' && ['read', 'create', 'update', 'close_own_shift'].includes(p.action)) ||
      (p.resource === 'scrap' && ['read', 'create'].includes(p.action)) ||
      (p.resource === 'inventory' && p.action === 'read') ||
      (p.resource === 'products' && p.action === 'read') ||
      (p.resource === 'raw_materials' && p.action === 'read') ||
      (p.resource === 'traceability' && p.action === 'read'),
  },
  {
    key:   'produccion_supervisor',
    label: '👷 Producción (supervisor)',
    description: 'Todo de producción incluyendo fórmula de mezcla (kg + %), validación, cambio de fórmula, aprobación de scrap y reversión de validación. No ve costos.',
    matches: (p) =>
      // Producción completa EXCEPTO costos de receta (información financiera reservada
      // a costeo / admin). Incluye explícitamente read_recipe para que el supervisor
      // vea la composición que debe preparar el operador de mezcla. Incluye
      // revert_validation para corregir imprevistos post-validación.
      (p.resource === 'production' && p.action !== 'read_recipe_costs') ||
      (p.resource === 'scrap') ||
      (p.resource === 'inventory') ||
      (p.resource === 'products' && p.action === 'read') ||
      (p.resource === 'raw_materials') ||
      (p.resource === 'traceability') ||
      (p.resource === 'reports' && p.action === 'production'),
  },
  {
    key:   'solo_lectura',
    label: '👁 Solo lectura',
    description: 'Consulta todo el sistema pero no modifica nada. Incluye todos los reportes.',
    matches: (p) =>
      p.action === 'read' ||
      (p.resource === 'production' && ['read_schedule', 'read_history', 'read_orders', 'read_own_shifts'].includes(p.action)) ||
      p.resource === 'reports',
  },
]

/**
 * Devuelve, dada la lista total de permisos del sistema, los IDs que
 * corresponden a una plantilla.
 */
export function templatePermissionIds(template, allPermissions) {
  return allPermissions.filter(template.matches).map(p => p.id)
}

/**
 * Devuelve un resumen amigable de qué hace un rol — útil para mostrarlo
 * en la lista sin abrir el editor.
 *
 * Ejemplo: roleSummary(role) →
 *   "Pedidos (todo), Clientes (lectura), Productos (lectura)"
 */
export function roleSummary(rolePermissions) {
  if (!rolePermissions?.length) return '— sin permisos —'

  const byResource = {}
  for (const p of rolePermissions) {
    if (!byResource[p.resource]) byResource[p.resource] = new Set()
    byResource[p.resource].add(p.action)
  }

  return Object.entries(byResource)
    .map(([resource, actions]) => {
      const label = RESOURCE_LABELS[resource] || resource
      const isFullAccess = actions.size >= 3 && !actions.has('read') === false
      const isReadOnly = actions.size === 1 && actions.has('read')
      if (isReadOnly)    return `${label} (lectura)`
      if (isFullAccess && actions.has('read') && actions.has('create')) return `${label} (todo)`
      return `${label} (${[...actions].join(', ')})`
    })
    .join(' · ')
}
