'use strict'

/**
 * SaaS v2 — Migration 122: tenant_scrap_types + extensión a shift_scrap
 *
 * Reemplaza los enums `scrap_type` (arranque/operacion/contaminada/desecho) y
 * `scrap_destination` (regrind/mezcla/venta/desecho) con un catálogo
 * configurable por tenant. Soporta:
 *  - is_normal vs anormal (anormal → cuenta de pérdida, no costo del producto)
 *  - default_recovery_value_pct (% del costo recuperable)
 *  - linked_raw_material_id: mermas reprocesables (papas rotas → combos,
 *    regrind → MP, etc.). Cuando se registra esta merma, el sistema
 *    incrementa el stock del raw_material vinculado.
 *  - allows_reprocess_of_expired: mermas que pueden recibir lotes expirados.
 *
 * Referencia: docs/saas-v2/00-design.md §2.2.5 + ajuste #1 de §6.6.
 *
 * Backward compat:
 *  - Columnas enum (`shift_scrap.scrap_type`, `shift_scrap.destination`) se
 *    mantienen — cleanup migrations las eliminan más adelante.
 *  - Backfill mapea enum → catálogo según §2.6.4.
 */

const up = `
  -- ─── Tabla principal ─────────────────────────────────────────────────
  CREATE TABLE tenant_scrap_types (
    id                            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id                     UUID         NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    code                          VARCHAR(30)  NOT NULL,
    name                          VARCHAR(80)  NOT NULL,
    default_destination           VARCHAR(20)  NOT NULL
      CHECK (default_destination IN ('reprocess','discard','sell')),
    default_recovery_value_pct    NUMERIC(5,2) NOT NULL DEFAULT 0
      CHECK (default_recovery_value_pct >= 0 AND default_recovery_value_pct <= 100),
    is_normal                     BOOLEAN      NOT NULL DEFAULT true,
    linked_raw_material_id        UUID         NULL REFERENCES raw_materials(id) ON DELETE SET NULL,
    allows_reprocess_of_expired   BOOLEAN      NOT NULL DEFAULT false,
    sort_order                    INTEGER      NOT NULL DEFAULT 0,
    is_active                     BOOLEAN      NOT NULL DEFAULT true,
    created_at                    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at                    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    created_by_user_id            UUID         NULL REFERENCES users(id) ON DELETE SET NULL,
    updated_by_user_id            UUID         NULL REFERENCES users(id) ON DELETE SET NULL,

    CONSTRAINT tst_code_per_tenant UNIQUE (tenant_id, code)
  );

  CREATE INDEX tst_tenant_active ON tenant_scrap_types (tenant_id, is_active);

  COMMENT ON TABLE tenant_scrap_types IS
    'SaaS v2: catálogo de tipos de merma por tenant. Reemplaza el enum scrap_type.';
  COMMENT ON COLUMN tenant_scrap_types.is_normal IS
    'true = merma normal (entra al costo del producto). false = anormal (cuenta de pérdida, no infla costo unitario).';
  COMMENT ON COLUMN tenant_scrap_types.default_recovery_value_pct IS
    '% del costo original recuperable (0-100). Usado por el motor de costeo para descontar valor de la merma vendible/reprocesable.';
  COMMENT ON COLUMN tenant_scrap_types.linked_raw_material_id IS
    'Si está set, cuando se registra esta merma el sistema INCREMENTA el stock del raw_material vinculado. Permite que mermas reprocesables (papas rotas, regrind) funcionen como MP consumible.';
  COMMENT ON COLUMN tenant_scrap_types.allows_reprocess_of_expired IS
    'Si true, lotes que caduquen pueden moverse a este tipo de merma en lugar de bloquearse.';

  CREATE TRIGGER set_updated_at_tenant_scrap_types
    BEFORE UPDATE ON tenant_scrap_types
    FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

  -- ─── Extensión aditiva a shift_scrap ─────────────────────────────────
  ALTER TABLE shift_scrap
    ADD COLUMN IF NOT EXISTS scrap_type_id      UUID NULL REFERENCES tenant_scrap_types(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS recovery_value_pct NUMERIC(5,2) NULL
      CHECK (recovery_value_pct IS NULL OR (recovery_value_pct >= 0 AND recovery_value_pct <= 100)),
    ADD COLUMN IF NOT EXISTS dynamic_attributes JSONB NULL,
    ADD COLUMN IF NOT EXISTS is_abnormal        BOOLEAN NOT NULL DEFAULT false;

  CREATE INDEX IF NOT EXISTS shift_scrap_scrap_type_id ON shift_scrap (scrap_type_id);

  COMMENT ON COLUMN shift_scrap.scrap_type_id IS
    'SaaS v2: FK al catálogo tenant_scrap_types. Reemplaza la columna enum scrap_type. Se mantiene la enum por backward compat hasta cleanup migrations.';
  COMMENT ON COLUMN shift_scrap.is_abnormal IS
    'SaaS v2: true cuando esta merma supera el % esperado de la receta. Las anormales se cargan a pérdida del período en vez de inflar el costo del producto.';

  -- ─── Extender la función seed ─────────────────────────────────────────
  CREATE OR REPLACE FUNCTION seed_tenant_process_template_defaults(p_tenant_id UUID)
  RETURNS VOID
  LANGUAGE plpgsql
  AS $$
  BEGIN
    -- tenant_process_config
    INSERT INTO tenant_process_config (tenant_id)
    VALUES (p_tenant_id)
    ON CONFLICT (tenant_id) DO NOTHING;

    -- tenant_units (15 unidades)
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

    -- tenant_unit_conversions (8)
    INSERT INTO tenant_unit_conversions (tenant_id, from_unit_id, to_unit_id, factor)
    SELECT p_tenant_id, f.id, t.id, pair.factor
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
       WHERE tuc.tenant_id = p_tenant_id
         AND tuc.from_unit_id = f.id AND tuc.to_unit_id = t.id
    );

    -- tenant_warehouse_types (5)
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

    -- tenant_scrap_types (4 — matchean al enum viejo)
    INSERT INTO tenant_scrap_types (tenant_id, code, name, default_destination, default_recovery_value_pct, is_normal, sort_order)
    SELECT p_tenant_id, s.code, s.name, s.dest, s.recovery, s.is_normal, s.sort_order
    FROM (VALUES
      ('arranque',     'Arranque',               'discard',   0,  true,  10),
      ('operacion',    'Operación',              'reprocess', 30, true,  20),
      ('contaminada',  'Contaminada',            'discard',   0,  true,  30),
      ('desecho',      'Desecho',                'discard',   0,  true,  40)
    ) AS s(code, name, dest, recovery, is_normal, sort_order)
    WHERE NOT EXISTS (
      SELECT 1 FROM tenant_scrap_types tst
       WHERE tst.tenant_id = p_tenant_id AND tst.code = s.code
    );
  END;
  $$;

  -- ─── Aplicar seed a tenants existentes ───────────────────────────────
  DO $$
  DECLARE t_id UUID;
  BEGIN
    FOR t_id IN SELECT id FROM tenants LOOP
      PERFORM seed_tenant_process_template_defaults(t_id);
    END LOOP;
  END $$;

  -- ─── Backfill shift_scrap.scrap_type_id desde enum ───────────────────
  UPDATE shift_scrap ss
  SET scrap_type_id = tst.id
  FROM tenant_scrap_types tst, production_shifts ps
  WHERE ss.shift_id = ps.id
    AND tst.tenant_id = ps.tenant_id
    AND ss.scrap_type_id IS NULL
    AND tst.code = ss.scrap_type::text;
`

const down = `
  -- Restablecer función seed sin scrap_types
  -- (mantiene los demás catálogos — solo retrocede scrap_types)
  -- En la práctica el down completo requeriría re-aplicar 121; lo dejamos
  -- inocuo y los catálogos siguen sembrados.

  ALTER TABLE shift_scrap
    DROP COLUMN IF EXISTS scrap_type_id,
    DROP COLUMN IF EXISTS recovery_value_pct,
    DROP COLUMN IF EXISTS dynamic_attributes,
    DROP COLUMN IF EXISTS is_abnormal;

  DROP TRIGGER IF EXISTS set_updated_at_tenant_scrap_types ON tenant_scrap_types;
  DROP TABLE IF EXISTS tenant_scrap_types;
`

module.exports = { up, down }
