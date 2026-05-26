'use strict'

/**
 * SaaS v2 — Migration 120: auto-seed de catálogos al crear un tenant
 *
 * Las migraciones 116 (tenant_process_config) y 118 (tenant_units) sembraron
 * registros para los tenants EXISTENTES al momento de aplicarse. Pero los
 * tenants creados DESPUÉS (vía /api/tenants/provision) no reciben el seed.
 *
 * Esta migration agrega un trigger AFTER INSERT en `tenants` que invoca una
 * función PL/pgSQL que siembra los defaults del Process Template para el
 * nuevo tenant.
 *
 * A medida que aparezcan más catálogos (warehouse_types, scrap_types,
 * quality_grades, shift_roles, product_kinds), se extenderá la función
 * `seed_tenant_process_template_defaults` en migrations futuras (vía
 * CREATE OR REPLACE FUNCTION).
 *
 * También aplica retroactivamente a cualquier tenant que por alguna razón
 * NO tenga su config o sus unidades sembradas (auto-heal idempotente).
 */

const up = `
  -- ─── Función seed ─────────────────────────────────────────────────────
  CREATE OR REPLACE FUNCTION seed_tenant_process_template_defaults(p_tenant_id UUID)
  RETURNS VOID
  LANGUAGE plpgsql
  AS $$
  BEGIN
    -- tenant_process_config: una fila con defaults
    INSERT INTO tenant_process_config (tenant_id)
    VALUES (p_tenant_id)
    ON CONFLICT (tenant_id) DO NOTHING;

    -- tenant_units: 15 unidades base + comunes
    INSERT INTO tenant_units (tenant_id, code, name, symbol, unit_type, is_base, decimals, sort_order)
    SELECT p_tenant_id, u.code, u.name, u.symbol, u.unit_type, u.is_base, u.decimals, u.sort_order
    FROM (VALUES
      ('kg',     'Kilogramo',      'kg',  'weight', true,  3, 10),
      ('g',      'Gramo',          'g',   'weight', false, 2, 20),
      ('ton',    'Tonelada',       't',   'weight', false, 4, 30),
      ('L',      'Litro',          'L',   'volume', true,  3, 10),
      ('mL',     'Mililitro',      'mL',  'volume', false, 2, 20),
      ('pza',    'Pieza',          'pz',  'count',  true,  0, 10),
      ('docena', 'Docena',         'doc', 'count',  false, 0, 20),
      ('caja',   'Caja',           'cj',  'count',  false, 0, 30),
      ('tarima', 'Tarima',         'tar', 'count',  false, 0, 40),
      ('m',      'Metro',          'm',   'length', true,  3, 10),
      ('cm',     'Centímetro',     'cm',  'length', false, 1, 20),
      ('mm',     'Milímetro',      'mm',  'length', false, 1, 30),
      ('m2',     'Metro cuadrado', 'm²',  'area',   true,  3, 10),
      ('h',      'Hora',           'h',   'time',   true,  2, 10),
      ('min',    'Minuto',         'min', 'time',   false, 0, 20)
    ) AS u(code, name, symbol, unit_type, is_base, decimals, sort_order)
    WHERE NOT EXISTS (
      SELECT 1 FROM tenant_units tu
       WHERE tu.tenant_id = p_tenant_id AND tu.code = u.code
    );

    -- tenant_unit_conversions: 8 conversiones default
    INSERT INTO tenant_unit_conversions (tenant_id, from_unit_id, to_unit_id, factor)
    SELECT
      p_tenant_id,
      f.id   AS from_unit_id,
      t.id   AS to_unit_id,
      pair.factor
    FROM (VALUES
      ('kg',     'g',    1000),
      ('ton',    'kg',   1000),
      ('L',      'mL',   1000),
      ('docena', 'pza',  12),
      ('m',      'cm',   100),
      ('m',      'mm',   1000),
      ('cm',     'mm',   10),
      ('h',      'min',  60)
    ) AS pair(from_code, to_code, factor)
    JOIN tenant_units f ON f.tenant_id = p_tenant_id AND f.code = pair.from_code
    JOIN tenant_units t ON t.tenant_id = p_tenant_id AND t.code = pair.to_code
    WHERE NOT EXISTS (
      SELECT 1 FROM tenant_unit_conversions tuc
       WHERE tuc.tenant_id    = p_tenant_id
         AND tuc.from_unit_id = f.id
         AND tuc.to_unit_id   = t.id
    );
  END;
  $$;

  COMMENT ON FUNCTION seed_tenant_process_template_defaults(UUID) IS
    'SaaS v2: siembra los catálogos default del Process Template para un tenant. Idempotente — usar en triggers AFTER INSERT y para auto-heal.';

  -- ─── Trigger AFTER INSERT en tenants ──────────────────────────────────
  CREATE OR REPLACE FUNCTION trigger_seed_tenant_defaults()
  RETURNS TRIGGER
  LANGUAGE plpgsql
  AS $$
  BEGIN
    PERFORM seed_tenant_process_template_defaults(NEW.id);
    RETURN NEW;
  END;
  $$;

  DROP TRIGGER IF EXISTS tenants_seed_process_template_defaults ON tenants;
  CREATE TRIGGER tenants_seed_process_template_defaults
    AFTER INSERT ON tenants
    FOR EACH ROW EXECUTE FUNCTION trigger_seed_tenant_defaults();

  -- ─── Auto-heal de tenants existentes que falten algo ──────────────────
  -- (Caso típico: tenants viejos sin tenant_process_config, o test tenants
  -- que se quedaron sin seed por timing.)
  DO $$
  DECLARE t_id UUID;
  BEGIN
    FOR t_id IN SELECT id FROM tenants LOOP
      PERFORM seed_tenant_process_template_defaults(t_id);
    END LOOP;
  END $$;
`

const down = `
  DROP TRIGGER IF EXISTS tenants_seed_process_template_defaults ON tenants;
  DROP FUNCTION IF EXISTS trigger_seed_tenant_defaults();
  DROP FUNCTION IF EXISTS seed_tenant_process_template_defaults(UUID);
`

module.exports = { up, down }
