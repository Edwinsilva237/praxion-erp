'use strict'

/**
 * Permisos granulares de reportes + preferencias por rol.
 *
 * 1) Permisos reports:* — uno por reporte, para que el admin pueda decidir
 *    si un rol ve "Ventas" pero no "CxC", por ejemplo. Antes todos caían
 *    bajo financials:read / production:read.
 *
 * 2) roles.mobile_tabs — JSONB con array de keys de tabs que aparecen
 *    en la barra inferior del móvil (BottomNav). NULL = usar el default
 *    filtrado por permisos.
 *
 * 3) roles.home_route — ruta a la que aterriza el usuario al entrar.
 *    NULL = comportamiento por defecto del Dashboard (redirección
 *    automática para operadores, dashboard genérico para los demás).
 *
 * Backfill: no hay roles preexistentes con estos campos. Los permisos
 * nuevos se asignan al super_admin global automáticamente.
 */

const up = `
  -- ── Permisos por reporte ────────────────────────────────────────────────
  INSERT INTO permissions (resource, action, description) VALUES
    ('reports', 'sales',      'Ver reporte de Ventas'),
    ('reports', 'cxc',        'Ver reporte de Cuentas por Cobrar'),
    ('reports', 'cxp',        'Ver reporte de Cuentas por Pagar'),
    ('reports', 'production', 'Ver reporte de Producción'),
    ('reports', 'accounting', 'Ver reporte Contable y snapshot financiero')
  ON CONFLICT (resource, action) DO NOTHING;

  -- Asignar todos al super_admin global
  INSERT INTO role_permissions (role_id, permission_id)
  SELECT r.id, p.id
    FROM roles r
    CROSS JOIN permissions p
   WHERE r.name = 'super_admin'
     AND p.resource = 'reports'
     AND NOT EXISTS (
       SELECT 1 FROM role_permissions rp
        WHERE rp.role_id = r.id AND rp.permission_id = p.id
     );

  -- ── Preferencias por rol ────────────────────────────────────────────────
  ALTER TABLE roles
    ADD COLUMN mobile_tabs JSONB,
    ADD COLUMN home_route  VARCHAR(150);

  ALTER TABLE roles
    ADD CONSTRAINT roles_mobile_tabs_array
    CHECK (mobile_tabs IS NULL OR jsonb_typeof(mobile_tabs) = 'array');

  ALTER TABLE roles
    ADD CONSTRAINT roles_mobile_tabs_max5
    CHECK (mobile_tabs IS NULL OR jsonb_array_length(mobile_tabs) <= 5);

  ALTER TABLE roles
    ADD CONSTRAINT roles_home_route_format
    CHECK (home_route IS NULL OR home_route ~ '^/');

  COMMENT ON COLUMN roles.mobile_tabs IS
    'Array JSON con keys de tabs del BottomNav (ej. ["home","sales","inventory"]). NULL = filtrado dinámico por permisos. Máx 5.';
  COMMENT ON COLUMN roles.home_route IS
    'Ruta SPA a la que aterriza el usuario al entrar (ej. /produccion/captura). NULL = comportamiento por defecto del Dashboard.';
`

const down = `
  ALTER TABLE roles
    DROP CONSTRAINT IF EXISTS roles_home_route_format,
    DROP CONSTRAINT IF EXISTS roles_mobile_tabs_max5,
    DROP CONSTRAINT IF EXISTS roles_mobile_tabs_array;
  ALTER TABLE roles
    DROP COLUMN IF EXISTS home_route,
    DROP COLUMN IF EXISTS mobile_tabs;

  DELETE FROM permissions WHERE resource = 'reports';
`

module.exports = { up, down }
