/**
 * Catálogo de botones controlables por rol.
 *
 * Cada entrada describe UN botón visible en alguna pantalla, atado a un
 * permiso del sistema (formato "resource:action"). En el editor de rol
 * se renderizan agrupados por pantalla; marcar/desmarcar la fila enciende
 * o apaga el permiso atado.
 *
 * Campos:
 *   - key:               id estable interno
 *   - label:             texto visible en el editor
 *   - screen:            grupo (pantalla) para agrupar
 *   - permission:        permiso que controla el botón (resource:action)
 *   - accessPermission:  permiso de "puede ver esta pantalla". Si el rol
 *                        no lo tiene, el editor oculta toda la pantalla.
 *                        Si se omite, la pantalla siempre se muestra.
 *
 * Mantenimiento: al envolver un botón nuevo con <Can do="...">, agrega
 * la entrada aquí para que el admin lo pueda gobernar desde el editor.
 */

export const BUTTON_CATALOG = [
  // ── Catálogos comerciales ────────────────────────────────────────────────
  {
    key:              'products.create',
    label:            'Nuevo producto',
    screen:           'Comercial · Productos',
    accessPermission: 'products:read',
    permission:       'products:create',
  },
  {
    key:              'products.update',
    label:            'Editar producto',
    screen:           'Comercial · Productos',
    accessPermission: 'products:read',
    permission:       'products:update',
  },
  {
    key:              'products.delete',
    label:            'Eliminar producto',
    screen:           'Comercial · Productos',
    accessPermission: 'products:read',
    permission:       'products:delete',
  },
  {
    key:              'partners.create',
    label:            'Captura completa / rápida de socio',
    screen:           'Comercial · Clientes y proveedores',
    accessPermission: 'business_partners:read',
    permission:       'business_partners:create',
  },
  {
    key:              'partners.update',
    label:            'Editar socio',
    screen:           'Comercial · Clientes y proveedores',
    accessPermission: 'business_partners:read',
    permission:       'business_partners:update',
  },
  {
    key:              'partners.delete',
    label:            'Eliminar socio',
    screen:           'Comercial · Clientes y proveedores',
    accessPermission: 'business_partners:read',
    permission:       'business_partners:delete',
  },

  // ── Comercial ────────────────────────────────────────────────────────────
  {
    key:              'sales.new-order',
    label:            'Nuevo pedido',
    screen:           'Comercial · Pedidos',
    accessPermission: 'sales:read',
    permission:       'sales:create',
  },
  {
    key:              'sales.new-quotation',
    label:            'Nueva cotización',
    screen:           'Comercial · Cotizaciones',
    accessPermission: 'sales:read',
    permission:       'sales:create',
  },
  {
    key:              'sales.new-delivery-note',
    label:            'Nueva remisión',
    screen:           'Comercial · Remisiones',
    accessPermission: 'sales:read',
    permission:       'sales:create',
  },
  {
    key:              'sales.delete-order',
    label:            'Eliminar pedido sin documentos asociados',
    screen:           'Comercial · Pedidos',
    accessPermission: 'sales:read',
    permission:       'sales:delete',
  },
  {
    key:              'sales.delete-delivery-note',
    label:            'Eliminar remisión sin movimientos asociados',
    screen:           'Comercial · Remisiones',
    accessPermission: 'sales:read',
    permission:       'sales:delete',
  },
  {
    key:              'invoicing.new-invoice',
    label:            'Nueva factura',
    screen:           'Comercial · Facturación',
    accessPermission: 'invoicing:read',
    permission:       'invoicing:create',
  },
  {
    key:              'invoicing.delete-invoice',
    label:            'Eliminar factura en borrador (no timbrada)',
    screen:           'Comercial · Facturación',
    accessPermission: 'invoicing:read',
    permission:       'invoicing:delete',
  },
  {
    key:              'financials.register-receipt',
    label:            'Registrar pago recibido',
    screen:           'Comercial · Pagos recibidos (CxC)',
    accessPermission: 'financials:read',
    permission:       'financials:create',
  },

  // ── Compras ──────────────────────────────────────────────────────────────
  {
    key:              'purchases.new-order',
    label:            'Nueva orden de compra',
    screen:           'Compras · Órdenes',
    accessPermission: 'purchases:read',
    permission:       'purchases:create',
  },
  {
    key:              'purchases.new-receipt',
    label:            'Nueva recepción',
    screen:           'Compras · Recepciones',
    accessPermission: 'purchases:read',
    permission:       'purchases:create',
  },
  {
    key:              'purchases.new-bill',
    label:            'Capturar comprobante de proveedor',
    screen:           'Compras · Comprobantes recibidos',
    accessPermission: 'purchases:read',
    permission:       'purchases:create',
  },
  {
    key:              'financials.register-payment',
    label:            'Registrar pago emitido',
    screen:           'Compras · Pagos emitidos (CxP)',
    accessPermission: 'financials:read',
    permission:       'financials:create',
  },
  {
    key:              'financials.register-advance',
    label:            'Registrar anticipo a proveedor',
    screen:           'Compras · Anticipos a proveedor',
    accessPermission: 'financials:read',
    permission:       'financials:create',
  },

  // ── Almacenes ────────────────────────────────────────────────────────────
  {
    key:              'warehouses.create',
    label:            'Nuevo almacén',
    screen:           'Inventario · Almacenes',
    accessPermission: 'warehouses:read',
    permission:       'warehouses:create',
  },
  {
    key:              'warehouses.update',
    label:            'Editar almacén / marcar default / activar-desactivar',
    screen:           'Inventario · Almacenes',
    accessPermission: 'warehouses:read',
    permission:       'warehouses:update',
  },
  {
    key:              'warehouses.delete',
    label:            'Eliminar almacén',
    screen:           'Inventario · Almacenes',
    accessPermission: 'warehouses:read',
    permission:       'warehouses:delete',
  },

  // ── Trazabilidad ─────────────────────────────────────────────────────────
  {
    key:              'traceability.run-expiration-check',
    label:            'Ejecutar chequeo de vencimientos',
    screen:           'Trazabilidad · Vencimientos',
    accessPermission: 'traceability:read',
    permission:       'traceability:update',
  },

  // ── Inventario ───────────────────────────────────────────────────────────
  {
    key:              'inventory.new-adjustment',
    label:            'Nuevo ajuste de inventario',
    screen:           'Inventario · Stock y kardex',
    accessPermission: 'inventory:read',
    permission:       'inventory:adjust',
  },
  {
    key:              'inventory.new-count',
    label:            'Nuevo conteo físico',
    screen:           'Inventario · Conteos físicos',
    accessPermission: 'inventory:read',
    permission:       'inventory:create',
  },
  {
    key:              'inventory.apply-count',
    label:            'Aplicar conteo (ajusta stock)',
    screen:           'Inventario · Conteos físicos',
    accessPermission: 'inventory:read',
    permission:       'inventory:adjust',
  },

  // ── Materias primas ──────────────────────────────────────────────────────
  {
    key:              'raw-materials.create',
    label:            'Nueva materia prima',
    screen:           'Producción · Materias primas',
    accessPermission: 'raw_materials:read',
    permission:       'raw_materials:create',
  },
  {
    key:              'raw-materials.update',
    label:            'Editar materia prima',
    screen:           'Producción · Materias primas',
    accessPermission: 'raw_materials:read',
    permission:       'raw_materials:update',
  },
  {
    key:              'raw-materials.delete',
    label:            'Eliminar materia prima',
    screen:           'Producción · Materias primas',
    accessPermission: 'raw_materials:read',
    permission:       'raw_materials:delete',
  },

  // ── Producción ───────────────────────────────────────────────────────────
  {
    key:              'production.new-order',
    label:            'Nueva orden de producción',
    screen:           'Producción · Órdenes',
    accessPermission: 'production:read',
    permission:       'production:manage',
  },
  {
    key:              'production.view-recipe',
    label:            'Ver fórmula de mezcla (ingredientes y kg) en la orden',
    screen:           'Producción · Órdenes',
    accessPermission: 'production:read',
    permission:       'production:read_recipe',
  },
  {
    key:              'production.view-recipe-costs',
    label:            'Ver costos por kg y costo mezclado en la fórmula',
    screen:           'Producción · Órdenes',
    accessPermission: 'production:read_recipe',
    permission:       'production:read_recipe_costs',
  },
  {
    key:              'production.revert-validation',
    label:            'Revertir validación de turno (corrige post-validación)',
    screen:           'Producción · Resumen de turno',
    accessPermission: 'production:read',
    permission:       'production:revert_validation',
  },
  {
    key:              'production.configure-shifts',
    label:            'Configurar horarios de turnos',
    screen:           'Producción · Programación',
    accessPermission: 'production:read',
    permission:       'production:manage',
  },
  {
    key:              'production.schedule-shift',
    label:            'Programar turno (botón superior)',
    screen:           'Producción · Programación',
    accessPermission: 'production:read',
    permission:       'production:manage',
  },
  {
    key:              'production.assign-shift',
    label:            'Asignar turno (celda vacía del calendario)',
    screen:           'Producción · Programación',
    accessPermission: 'production:read',
    permission:       'production:manage',
  },

  // ── Tesorería ────────────────────────────────────────────────────────────
  {
    key:              'petty-cash.entry',
    label:            'Capturar entrada a caja',
    screen:           'Tesorería · Caja chica',
    accessPermission: 'petty_cash:read',
    permission:       'petty_cash:create',
  },
  {
    key:              'petty-cash.expense',
    label:            'Capturar salida de caja',
    screen:           'Tesorería · Caja chica',
    accessPermission: 'petty_cash:read',
    permission:       'petty_cash:create',
  },

  // ── Sistema ──────────────────────────────────────────────────────────────
  {
    key:              'users.invite',
    label:            'Invitar usuario nuevo',
    screen:           'Sistema · Usuarios',
    accessPermission: 'users:read',
    permission:       'users:create',
  },
  {
    key:              'roles.create',
    label:            'Crear rol nuevo',
    screen:           'Sistema · Roles y permisos',
    accessPermission: 'roles:read',
    permission:       'roles:create',
  },

  // ── Configuración del proceso (Process Template) ─────────────────────────
  {
    key:              'process-config.update-flags',
    label:            'Editar banderas globales del proceso',
    screen:           'Configuración · Proceso (banderas)',
    accessPermission: 'process_config:read',
    permission:       'process_config:update',
  },
  {
    key:              'tenant-catalogs.units',
    label:            'Editar catálogo de Unidades',
    screen:           'Configuración · Catálogos del proceso',
    accessPermission: 'tenant_catalogs:read',
    permission:       'tenant_catalogs:update',
  },
  {
    key:              'tenant-catalogs.product-kinds',
    label:            'Editar catálogo de Tipos de producto',
    screen:           'Configuración · Catálogos del proceso',
    accessPermission: 'tenant_catalogs:read',
    permission:       'tenant_catalogs:update',
  },
  {
    key:              'tenant-catalogs.scrap-types',
    label:            'Editar catálogo de Tipos de merma',
    screen:           'Configuración · Catálogos del proceso',
    accessPermission: 'tenant_catalogs:read',
    permission:       'tenant_catalogs:update',
  },
  {
    key:              'tenant-catalogs.quality-grades',
    label:            'Editar catálogo de Grados de calidad',
    screen:           'Configuración · Catálogos del proceso',
    accessPermission: 'tenant_catalogs:read',
    permission:       'tenant_catalogs:update',
  },
  {
    key:              'tenant-catalogs.shift-roles',
    label:            'Editar catálogo de Roles de turno',
    screen:           'Configuración · Catálogos del proceso',
    accessPermission: 'tenant_catalogs:read',
    permission:       'tenant_catalogs:update',
  },
  {
    key:              'tenant-catalogs.allergens',
    label:            'Editar catálogo de Alérgenos',
    screen:           'Configuración · Catálogos del proceso',
    accessPermission: 'tenant_catalogs:read',
    permission:       'tenant_catalogs:update',
  },

  // ── Configuración ───────────────────────────────────────────────────────
  {
    key:              'settings.notifications.save',
    label:            'Editar correo de notificaciones',
    screen:           'Configuración · Notificaciones',
    accessPermission: 'settings:read',
    permission:       'settings:update',
  },
  {
    key:              'settings.brand.save',
    label:            'Editar identidad de marca (logo, nombre, colores)',
    screen:           'Configuración · Identidad de marca',
    accessPermission: 'settings:update',
    permission:       'settings:update',
  },
  {
    key:              'settings.fiscal.edit',
    label:            'Editar datos fiscales (RFC, régimen, etc.)',
    screen:           'Configuración · Datos fiscales',
    accessPermission: 'settings:read',
    permission:       'settings:update',
  },
  {
    key:              'settings.fiscal.csd',
    label:            'Subir/Reemplazar CSD del SAT',
    screen:           'Configuración · Datos fiscales',
    accessPermission: 'settings:read',
    permission:       'settings:update',
  },
  {
    key:              'bank-accounts.create',
    label:            'Crear cuenta bancaria',
    screen:           'Configuración · Cuentas bancarias',
    accessPermission: 'financials:read',
    permission:       'financials:create',
  },
  {
    key:              'bank-accounts.update',
    label:            'Editar cuenta bancaria',
    screen:           'Configuración · Cuentas bancarias',
    accessPermission: 'financials:read',
    permission:       'financials:update',
  },
  {
    key:              'bank-accounts.delete',
    label:            'Desactivar cuenta bancaria',
    screen:           'Configuración · Cuentas bancarias',
    accessPermission: 'financials:read',
    permission:       'financials:delete',
  },
  {
    key:              'billing.change-plan',
    label:            'Cambiar de plan / contratar',
    screen:           'Configuración · Mi suscripción',
    accessPermission: 'billing:manage',
    permission:       'billing:manage',
  },
  {
    key:              'billing.portal',
    label:            'Abrir portal de Stripe (tarjeta y facturas)',
    screen:           'Configuración · Mi suscripción',
    accessPermission: 'billing:manage',
    permission:       'billing:manage',
  },
]

/**
 * Agrupa el catálogo por pantalla, opcionalmente filtrando aquellas que
 * requieren un accessPermission que el rol no tiene.
 *
 * @param {Set<string>} accessPermissionsSet conjunto de "resource:action"
 *        que el rol/usuario tiene marcados. Si se omite, no filtra.
 */
export function groupedByScreen(accessPermissionsSet = null) {
  const groups = new Map()
  for (const b of BUTTON_CATALOG) {
    if (accessPermissionsSet &&
        b.accessPermission &&
        !accessPermissionsSet.has(b.accessPermission)) {
      continue  // este rol no puede ver esta pantalla
    }
    if (!groups.has(b.screen)) groups.set(b.screen, [])
    groups.get(b.screen).push(b)
  }
  return [...groups.entries()].map(([screen, buttons]) => ({ screen, buttons }))
}

// Devuelve qué otros botones del catálogo comparten el mismo permiso
// que `button`, excluyéndolo a sí mismo. Útil para mostrar la advertencia
// "comparte interruptor con…".
export function buttonsSharingPermission(button) {
  return BUTTON_CATALOG.filter(b => b.permission === button.permission && b.key !== button.key)
}
