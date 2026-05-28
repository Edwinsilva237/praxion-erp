'use strict'

/**
 * Mig 160 — permisos de visibilidad de la fórmula de materias primas en órdenes
 * de producción, separados del permiso genérico de leer órdenes.
 *
 * Contexto (sesión 2026-05-29):
 *  La pantalla de Órdenes de producción muestra la fórmula MP (ingredientes,
 *  porcentajes, costos $/kg, costo mezclado total). En SaaS multi-tenant esa
 *  información es sensible: tipicamente el operador que prepara la mezcla
 *  necesita verla, pero el capturista de pedido o el empacador no. Y los costos
 *  son aún más sensibles que los ingredientes.
 *
 *  Hasta hoy todo se controlaba con `production:read`, lo cual exponía la
 *  receta completa a cualquier rol con acceso al módulo.
 *
 * Esta migración crea dos permisos nuevos:
 *  - production:read_recipe        → ver ingredientes + kg + porcentajes
 *  - production:read_recipe_costs  → ver además $/kg por material y costo mezclado total
 *
 * Sin backfill silencioso: por ser información sensible, NO heredamos de
 * `production:read` ni de `production:update`. El admin de cada tenant debe
 * asignar manualmente estos permisos a los roles que correspondan. Los roles
 * preinstalados en super_admin global sí los reciben (línea de defensa).
 *
 * Los frontend ROLE_TEMPLATES de `produccion_supervisor` y `admin/owner` se
 * actualizan en el mismo cambio para que **roles nuevos** los marquen por
 * default. Tenants vivos tendrán que ir a Configuración → Roles → editar y
 * marcar las casillas tras el redeploy.
 */

const up = `
  -- 1. Permisos faltantes
  INSERT INTO permissions (resource, action, description) VALUES
    ('production', 'read_recipe',
     'Ver fórmula de materias primas en órdenes (ingredientes y cantidades en kg)'),
    ('production', 'read_recipe_costs',
     'Ver costos por kg y costo mezclado total en la fórmula de la orden')
  ON CONFLICT (resource, action) DO NOTHING;

  -- 2. Amarrar a super_admin global
  INSERT INTO role_permissions (role_id, permission_id)
  SELECT r.id, p.id
    FROM roles r
    CROSS JOIN permissions p
   WHERE r.name = 'super_admin'
     AND r.tenant_id IS NULL
     AND p.resource = 'production'
     AND p.action IN ('read_recipe', 'read_recipe_costs')
   ON CONFLICT (role_id, permission_id) DO NOTHING;
`

const down = `
  -- Quitamos el amarre y los permisos; idempotente por orden de FK.
  DELETE FROM role_permissions
   WHERE permission_id IN (
     SELECT id FROM permissions
      WHERE resource = 'production'
        AND action IN ('read_recipe', 'read_recipe_costs')
   );
  DELETE FROM permissions
   WHERE resource = 'production'
     AND action IN ('read_recipe', 'read_recipe_costs');
`

module.exports = { up, down }
