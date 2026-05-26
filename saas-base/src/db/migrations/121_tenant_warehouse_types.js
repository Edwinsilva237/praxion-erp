'use strict'

/**
 * SaaS v2 — Migration 121: tenant_warehouse_types + warehouses.warehouse_type_id
 *
 * Reemplaza el enum hardcoded (`raw_material`, `regrind`, `wip`,
 * `finished_product`, `resale`) con un catálogo configurable por tenant.
 * Mantiene la columna string `type` en `warehouses` para backward compat
 * — los cleanup migrations al final del proyecto la eliminarán.
 *
 * Conceptos clave:
 *  - `code`: nombre que ve el usuario (ej. "Almacén de Refrigeración").
 *  - `system_role`: rol que cumple en el motor (input/wip/output/scrap/
 *    blocked/resale). Permite que un tenant nombre sus almacenes como
 *    quiera mientras el motor sabe cómo tratarlos.
 *  - `default_scrap_destination`: solo aplica si system_role='scrap'
 *    (reprocess/discard/sell). Sirve como default; cada tenant_scrap_types
 *    puede override por tipo de merma específico.
 *
 * Seed default: 5 tipos comunes (materia_prima, embalaje, producto_terminado,
 * merma, wip). Cubren los 4 verticales sin override.
 *
 * Referencia: §2.2.4 y §2.6.4.
 */

const up = `
  -- ─── Tabla principal ─────────────────────────────────────────────────
  CREATE TABLE tenant_warehouse_types (
    id                           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id                    UUID         NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    code                         VARCHAR(30)  NOT NULL,
    name                         VARCHAR(80)  NOT NULL,
    system_role                  VARCHAR(20)  NOT NULL
      CHECK (system_role IN ('input','wip','output','scrap','blocked','resale')),
    default_scrap_destination    VARCHAR(20)  NULL
      CHECK (default_scrap_destination IS NULL
             OR default_scrap_destination IN ('reprocess','discard','sell')),
    color                        VARCHAR(7)   NULL,
    sort_order                   INTEGER      NOT NULL DEFAULT 0,
    is_active                    BOOLEAN      NOT NULL DEFAULT true,
    created_at                   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at                   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    created_by_user_id           UUID         NULL REFERENCES users(id) ON DELETE SET NULL,
    updated_by_user_id           UUID         NULL REFERENCES users(id) ON DELETE SET NULL,

    CONSTRAINT twt_code_per_tenant UNIQUE (tenant_id, code),
    -- default_scrap_destination solo tiene sentido si el rol es scrap
    CONSTRAINT twt_scrap_dest_only_for_scrap CHECK (
      (system_role = 'scrap') OR (default_scrap_destination IS NULL)
    )
  );

  CREATE INDEX twt_tenant_role ON tenant_warehouse_types (tenant_id, system_role, is_active);

  COMMENT ON TABLE tenant_warehouse_types IS
    'SaaS v2: catálogo de tipos de almacén por tenant. Reemplaza el enum warehouses.type. El motor consume system_role; el tenant ve code/name.';
  COMMENT ON COLUMN tenant_warehouse_types.system_role IS
    'Qué rol cumple el almacén en el motor de producción: input (MP/embalaje), wip (en proceso), output (PT disponible), scrap (merma), blocked (bloqueado), resale (reventa).';
  COMMENT ON COLUMN tenant_warehouse_types.default_scrap_destination IS
    'Solo aplica si system_role=scrap. Cada tenant_scrap_types puede override por tipo de merma específico.';

  CREATE TRIGGER set_updated_at_tenant_warehouse_types
    BEFORE UPDATE ON tenant_warehouse_types
    FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

  -- ─── Extensión aditiva a warehouses ──────────────────────────────────
  -- Agregamos warehouse_type_id como FK opcional. La columna 'type' (enum
  -- string) se mantiene por backward compat hasta cleanup migrations.
  ALTER TABLE warehouses
    ADD COLUMN IF NOT EXISTS warehouse_type_id UUID NULL
      REFERENCES tenant_warehouse_types(id) ON DELETE SET NULL;

  CREATE INDEX IF NOT EXISTS warehouses_warehouse_type_id
    ON warehouses (warehouse_type_id);

  COMMENT ON COLUMN warehouses.warehouse_type_id IS
    'SaaS v2: FK al catálogo tenant_warehouse_types. La columna string "type" se mantiene por backward compat hasta cleanup migrations.';

  -- ─── Extender la función seed para tenants nuevos ────────────────────
  CREATE OR REPLACE FUNCTION seed_tenant_process_template_defaults(p_tenant_id UUID)
  RETURNS VOID
  LANGUAGE plpgsql
  AS $$
  BEGIN
    -- tenant_process_config: una fila con defaults
    INSERT INTO tenant_process_config (tenant_id)
    VALUES (p_tenant_id)
    ON CONFLICT (tenant_id) DO NOTHING;

    -- tenant_units (15 unidades default)
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

    -- tenant_unit_conversions (8 conversiones default)
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

    -- tenant_warehouse_types (5 tipos default)
    INSERT INTO tenant_warehouse_types (tenant_id, code, name, system_role, default_scrap_destination, sort_order)
    SELECT p_tenant_id, w.code, w.name, w.system_role, w.dest, w.sort_order
    FROM (VALUES
      ('materia_prima',       'Materia prima',         'input',  NULL,         10),
      ('embalaje',            'Embalaje',              'input',  NULL,         20),
      ('producto_terminado',  'Producto terminado',    'output', NULL,         30),
      ('merma',               'Merma',                 'scrap',  'discard',    40),
      ('wip',                 'Producción en proceso', 'wip',    NULL,         50)
    ) AS w(code, name, system_role, dest, sort_order)
    WHERE NOT EXISTS (
      SELECT 1 FROM tenant_warehouse_types twt
       WHERE twt.tenant_id = p_tenant_id AND twt.code = w.code
    );
  END;
  $$;

  -- ─── Aplicar seed a tenants existentes (auto-heal) ───────────────────
  DO $$
  DECLARE t_id UUID;
  BEGIN
    FOR t_id IN SELECT id FROM tenants LOOP
      PERFORM seed_tenant_process_template_defaults(t_id);
    END LOOP;
  END $$;

  -- ─── Backfill: popular warehouses.warehouse_type_id desde 'type' ─────
  -- Mapeo enum→catálogo según §2.6.4:
  --   raw_material     → materia_prima
  --   regrind          → merma  (acoplado al modelo plástico; en el nuevo
  --                              esquema regrind es un tipo de scrap)
  --   wip              → wip
  --   finished_product → producto_terminado
  --   resale           → (nuevo tipo "reventa" si existe — los tenants v1 no
  --                       lo tendrán hasta que un admin lo cree)
  UPDATE warehouses w
  SET warehouse_type_id = twt.id
  FROM tenant_warehouse_types twt
  WHERE w.tenant_id = twt.tenant_id
    AND w.warehouse_type_id IS NULL
    AND (
      (w.type = 'raw_material'      AND twt.code = 'materia_prima')      OR
      (w.type = 'regrind'           AND twt.code = 'merma')              OR
      (w.type = 'wip'               AND twt.code = 'wip')                OR
      (w.type = 'finished_product'  AND twt.code = 'producto_terminado')
    );
`

const down = `
  -- Restablecer función seed sin warehouse_types (volver a la versión de migration 120)
  CREATE OR REPLACE FUNCTION seed_tenant_process_template_defaults(p_tenant_id UUID)
  RETURNS VOID
  LANGUAGE plpgsql
  AS $$
  BEGIN
    INSERT INTO tenant_process_config (tenant_id)
    VALUES (p_tenant_id)
    ON CONFLICT (tenant_id) DO NOTHING;
  END;
  $$;

  DROP INDEX IF EXISTS warehouses_warehouse_type_id;
  ALTER TABLE warehouses DROP COLUMN IF EXISTS warehouse_type_id;

  DROP TRIGGER IF EXISTS set_updated_at_tenant_warehouse_types ON tenant_warehouse_types;
  DROP TABLE IF EXISTS tenant_warehouse_types;
`

module.exports = { up, down }
