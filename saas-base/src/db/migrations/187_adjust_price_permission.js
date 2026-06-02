'use strict'

/**
 * Mig 187 — Permiso para CORREGIR PRECIOS de una remisión no facturada.
 *
 * Caso: se generó un pedido con precio erróneo, se remisionó y quedó bloqueado.
 * La remisión respalda la ENTREGA de mercancía (cantidades), no los precios; el
 * CFDI es el documento que fija el precio. Corregir el precio ANTES de timbrar
 * evita una nota de crédito.
 *
 *   - `sales:adjust_price` → editar unit_price / discount_pct de las líneas de
 *     una remisión que aún NO se ha facturado, con observación obligatoria. El
 *     servicio recalcula el total + el CXC y espeja el precio al pedido; NO toca
 *     cantidades (eso falsearía la entrega).
 *
 * Se otorga ÚNICAMENTE al rol `super_admin` (dueño del tenant) — es una acción
 * sensible (override de precios). Los roles que el tenant cree después NO lo
 * reciben; se activa a mano desde el editor de roles. Mismo patrón idempotente
 * que las migs 184/185/186.
 */

const up = `
  INSERT INTO permissions (resource, action, description)
  SELECT 'sales', 'adjust_price', 'Corregir precios de una remisión no facturada, con observación (solo admin)'
   WHERE NOT EXISTS (
     SELECT 1 FROM permissions WHERE resource = 'sales' AND action = 'adjust_price'
   );

  INSERT INTO role_permissions (role_id, permission_id)
  SELECT r.id, p.id
    FROM roles r, permissions p
   WHERE r.name = 'super_admin'
     AND p.resource = 'sales' AND p.action = 'adjust_price'
     AND NOT EXISTS (
       SELECT 1 FROM role_permissions rp
        WHERE rp.role_id = r.id AND rp.permission_id = p.id
     );
`

const down = `
  DELETE FROM permissions WHERE resource = 'sales' AND action = 'adjust_price';
`

module.exports = { up, down }
