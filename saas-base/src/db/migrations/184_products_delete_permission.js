'use strict'

/**
 * Mig 184 — Permiso `products:delete` (solo admin).
 *
 * Hasta hoy un producto no se podía eliminar (no había ruta ni permiso). Se
 * agrega la acción `delete` sobre `products` y se otorga ÚNICAMENTE al rol
 * `super_admin` (que es el rol del dueño del tenant — ver tenantService.provision).
 * Los roles que el tenant cree después (capturista, supervisor, etc.) NO lo
 * reciben, así el borrado queda restringido a admin como pidió el usuario.
 *
 * El borrado en sí está protegido en el servicio: solo procede si el producto
 * no tiene movimientos/actividad asociada (inventario, lotes, producción,
 * pedidos, remisiones, facturas, cotizaciones).
 *
 * Idempotente vía NOT EXISTS (no depende de constraints con nombre).
 */

const up = `
  INSERT INTO permissions (resource, action, description)
  SELECT 'products', 'delete', 'Eliminar productos sin movimientos asociados (solo admin)'
   WHERE NOT EXISTS (
     SELECT 1 FROM permissions WHERE resource = 'products' AND action = 'delete'
   );

  INSERT INTO role_permissions (role_id, permission_id)
  SELECT r.id, p.id
    FROM roles r, permissions p
   WHERE r.name = 'super_admin'
     AND p.resource = 'products' AND p.action = 'delete'
     AND NOT EXISTS (
       SELECT 1 FROM role_permissions rp
        WHERE rp.role_id = r.id AND rp.permission_id = p.id
     );
`

const down = `
  DELETE FROM permissions WHERE resource = 'products' AND action = 'delete';
`

module.exports = { up, down }
