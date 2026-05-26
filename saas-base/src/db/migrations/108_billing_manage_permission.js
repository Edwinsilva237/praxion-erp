'use strict'

/**
 * Permiso billing:manage para acciones de suscripción.
 *
 * Mi suscripción y Planes y precios son pantallas que tocan Stripe:
 * cambiar plan, abrir portal de pagos, cancelar. Acciones del dueño,
 * no del operador. Antes caían bajo settings:read genérico — cualquier
 * usuario con acceso de configuración las veía.
 *
 * Con billing:manage el admin decide explícitamente qué roles pueden
 * tocar la facturación de la plataforma.
 */

const up = `
  INSERT INTO permissions (resource, action, description) VALUES
    ('billing', 'manage', 'Gestionar suscripción y plan (Stripe)')
  ON CONFLICT (resource, action) DO NOTHING;

  -- Asignar al super_admin global
  INSERT INTO role_permissions (role_id, permission_id)
  SELECT r.id, p.id
    FROM roles r
    CROSS JOIN permissions p
   WHERE r.name = 'super_admin'
     AND p.resource = 'billing'
     AND p.action   = 'manage'
     AND NOT EXISTS (
       SELECT 1 FROM role_permissions rp
        WHERE rp.role_id = r.id AND rp.permission_id = p.id
     );
`

const down = `
  DELETE FROM permissions WHERE resource = 'billing' AND action = 'manage';
`

module.exports = { up, down }
