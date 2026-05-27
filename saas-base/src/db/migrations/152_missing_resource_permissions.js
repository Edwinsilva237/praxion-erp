'use strict'

/**
 * Bug raíz descubierto al editar un rol nuevo en producción: el modulo
 * "Comercial" solo mostraba 3 catálogos (clientes, productos, pagos) y se
 * comía pedidos, cotizaciones, remisiones y facturación. La pantalla de
 * Roles agrupa permisos por proceso de negocio leyendo `permissions` de la
 * BD; si un resource no tiene ningún row, el grupo correspondiente
 * desaparece de la UI.
 *
 * Cruzando los `checkPermission(...)` usados en routes contra los
 * `INSERT INTO permissions` en migraciones, faltan registrados:
 *   - sales (read/create/update)        usado en sales + quotations
 *   - invoicing (read/create/update)    usado en invoicing
 *   - purchases (read/create/update)    usado en purchases
 *   - settings:delete                   usado en admin/jobs
 *
 * En GH Insumos prod estaban presentes solo porque alguien corrió scripts
 * ad-hoc (`scripts/add-invoicing-permissions.js`, `fix-purchases-permissions.js`).
 * Esos scripts no son migraciones — BDs nuevas (sandbox, test, dev nuevo)
 * quedan sin ellos. Y aunque super_admin pudiera acceder a las rutas en
 * prod, los roles propios del tenant no podían recibir esos permisos
 * porque la UI ni siquiera los listaba.
 *
 * Esta migración:
 *   1) Inserta los permisos faltantes (ON CONFLICT DO NOTHING — si los
 *      scripts ya los habían creado, no se duplica).
 *   2) Amarra al super_admin global con el mismo patrón que la mig 146.
 *
 * NO toca scripts/add-invoicing-permissions.js ni fix-purchases-permissions.js
 * — sobreviven como referencia histórica pero ya no son necesarios.
 *
 * Lección: cualquier `checkPermission('X','Y')` nuevo debe venir con un
 * INSERT INTO permissions correspondiente en la misma migración. La
 * pantalla de Roles depende de que la lista esté completa.
 */

const up = `
  INSERT INTO permissions (resource, action, description) VALUES
    ('sales',      'read',   'Ver pedidos, remisiones y cotizaciones'),
    ('sales',      'create', 'Crear pedidos, remisiones y cotizaciones'),
    ('sales',      'update', 'Editar pedidos, remisiones y cotizaciones (incluye conversión cotización→pedido, envío, etc.)'),

    ('invoicing',  'read',   'Ver facturas, notas de crédito y complementos de pago'),
    ('invoicing',  'create', 'Emitir facturas, notas de crédito y complementos de pago'),
    ('invoicing',  'update', 'Cancelar facturas'),

    ('purchases',  'read',   'Ver órdenes de compra, recepciones y facturas de proveedor'),
    ('purchases',  'create', 'Crear órdenes de compra, recepciones y registrar facturas de proveedor'),
    ('purchases',  'update', 'Confirmar/editar órdenes de compra, recepciones y facturas de proveedor'),

    ('settings',   'delete', 'Eliminar jobs en colas administrativas')
  ON CONFLICT (resource, action) DO NOTHING;

  -- Amarrar a super_admin global (mismo patrón que mig 146)
  INSERT INTO role_permissions (role_id, permission_id)
  SELECT r.id, p.id
    FROM roles r
    CROSS JOIN permissions p
   WHERE r.name = 'super_admin'
     AND r.tenant_id IS NULL
     AND p.resource IN ('sales', 'invoicing', 'purchases')
     AND NOT EXISTS (
       SELECT 1 FROM role_permissions rp
        WHERE rp.role_id = r.id AND rp.permission_id = p.id
     );

  -- settings:delete también
  INSERT INTO role_permissions (role_id, permission_id)
  SELECT r.id, p.id
    FROM roles r
    CROSS JOIN permissions p
   WHERE r.name = 'super_admin'
     AND r.tenant_id IS NULL
     AND p.resource = 'settings' AND p.action = 'delete'
     AND NOT EXISTS (
       SELECT 1 FROM role_permissions rp
        WHERE rp.role_id = r.id AND rp.permission_id = p.id
     );
`

const down = `
  DELETE FROM permissions
   WHERE (resource = 'sales'     AND action IN ('read','create','update'))
      OR (resource = 'invoicing' AND action IN ('read','create','update'))
      OR (resource = 'purchases' AND action IN ('read','create','update'))
      OR (resource = 'settings'  AND action = 'delete');
`

module.exports = { up, down }
