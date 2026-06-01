'use strict'

/**
 * Mig 185 — Permisos de borrado de documentos (solo admin).
 *
 * Agrega dos acciones `delete` y las otorga ÚNICAMENTE al rol `super_admin`
 * (el rol del dueño del tenant — ver tenantService.provision). Los roles que
 * el tenant cree después NO las reciben, así el borrado queda restringido a
 * admin como pidió el usuario.
 *
 *   - `sales:delete`     → eliminar pedidos / remisiones SIN movimientos
 *                          asociados (el servicio valida que no haya inventario,
 *                          factura activa ni CXC con pagos).
 *   - `invoicing:delete` → eliminar facturas en BORRADOR (no timbradas). El
 *                          servicio revierte la CXC y bloquea cualquier factura
 *                          con cfdi_uuid (timbrada ante el SAT).
 *
 * Mismo patrón idempotente que la mig 184 (products:delete). Idempotente vía
 * NOT EXISTS (no depende de constraints con nombre).
 */

const up = `
  INSERT INTO permissions (resource, action, description)
  SELECT 'sales', 'delete', 'Eliminar pedidos y remisiones sin movimientos asociados (solo admin)'
   WHERE NOT EXISTS (
     SELECT 1 FROM permissions WHERE resource = 'sales' AND action = 'delete'
   );

  INSERT INTO permissions (resource, action, description)
  SELECT 'invoicing', 'delete', 'Eliminar facturas en borrador no timbradas (solo admin)'
   WHERE NOT EXISTS (
     SELECT 1 FROM permissions WHERE resource = 'invoicing' AND action = 'delete'
   );

  INSERT INTO role_permissions (role_id, permission_id)
  SELECT r.id, p.id
    FROM roles r, permissions p
   WHERE r.name = 'super_admin'
     AND p.action = 'delete'
     AND p.resource IN ('sales', 'invoicing')
     AND NOT EXISTS (
       SELECT 1 FROM role_permissions rp
        WHERE rp.role_id = r.id AND rp.permission_id = p.id
     );
`

const down = `
  DELETE FROM permissions WHERE resource IN ('sales', 'invoicing') AND action = 'delete';
`

module.exports = { up, down }
