'use strict'

/**
 * Mig 210 — Permiso para CANCELAR una remisión YA ENTREGADA (revierte inventario).
 *
 * Caso: se entregó una remisión mal hecha y quedó bloqueada — `cancelDelivery`
 * impedía cancelar una remisión `delivered`/`invoiced` porque entregar descuenta
 * inventario, descuenta lotes y genera la CXC, y no había reversa automática.
 *
 *   - `sales:reverse_delivery` → cancelar una remisión que YA movió inventario,
 *     revirtiéndolo todo en una transacción: regresa el stock (adjustment_in) +
 *     restaura saldo/estado de lotes + libera la CXC sin cobros + reabre los
 *     pedidos cubiertos. Bloquea si hay factura activa (cancela la factura antes)
 *     o si la CXC ya tiene un cobro (reversa el cobro antes).
 *
 * Cancelar una remisión que AÚN NO se entregó sigue con `sales:update` (no movió
 * nada). Este permiso es solo para la reversa destructiva.
 *
 * Se otorga ÚNICAMENTE al rol `super_admin` (dueño del tenant) — acción sensible,
 * mismo patrón que mig 187 (`sales:adjust_price`). Los roles que el tenant cree
 * después NO lo reciben; se activa a mano desde el editor de roles.
 *
 * ⚠️ El owner/admin ya logueado debe RE-LOGUEAR para que el permiso aparezca.
 */

const up = `
  INSERT INTO permissions (resource, action, description)
  SELECT 'sales', 'reverse_delivery',
         'Cancelar una remisión ya entregada revirtiendo inventario, lotes y CXC (solo admin)'
   WHERE NOT EXISTS (
     SELECT 1 FROM permissions WHERE resource = 'sales' AND action = 'reverse_delivery'
   );

  INSERT INTO role_permissions (role_id, permission_id)
  SELECT r.id, p.id
    FROM roles r, permissions p
   WHERE r.name = 'super_admin'
     AND p.resource = 'sales' AND p.action = 'reverse_delivery'
     AND NOT EXISTS (
       SELECT 1 FROM role_permissions rp
        WHERE rp.role_id = r.id AND rp.permission_id = p.id
     );
`

const down = `
  DELETE FROM permissions WHERE resource = 'sales' AND action = 'reverse_delivery';
`

module.exports = { up, down }
