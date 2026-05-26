'use strict'

/**
 * SaaS v2 — Migration 123: tenant_quality_grades + shift_progress.quality_grade_id
 *
 * Reemplaza el flag binario `shift_progress.is_second_quality` con un sistema
 * de N calidades configurables (rango 1-5, default 3).
 *
 * Decisiones:
 *  - grade_number = 1 es siempre la "mejor" (apta/primera).
 *  - counts_for_order_fulfillment: default true para grade=1, false para los
 *    demás. Override por orden vía production_orders.accept_second_quality_for_fulfillment.
 *  - goes_to_warehouse_type_id: dónde se almacena el PT de esta calidad
 *    (típicamente producto_terminado para grade=1, blocked para grade>1).
 *
 * Seed default: 3 calidades (primera/segunda/tercera) por tenant.
 * Backfill: shift_progress.is_second_quality=false → grade 1; true → grade 2.
 *
 * Referencia: §2.2.6 + §2.6.4.
 */

const up = `
  -- ─── Tabla principal ─────────────────────────────────────────────────
  CREATE TABLE tenant_quality_grades (
    id                              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id                       UUID         NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    grade_number                    SMALLINT     NOT NULL
      CHECK (grade_number BETWEEN 1 AND 5),
    code                            VARCHAR(30)  NOT NULL,
    name                            VARCHAR(80)  NOT NULL,
    counts_for_order_fulfillment    BOOLEAN      NOT NULL DEFAULT false,
    goes_to_warehouse_type_id       UUID         NULL REFERENCES tenant_warehouse_types(id) ON DELETE SET NULL,
    default_color                   VARCHAR(7)   NULL,
    sort_order                      INTEGER      NOT NULL DEFAULT 0,
    is_active                       BOOLEAN      NOT NULL DEFAULT true,
    created_at                      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at                      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    created_by_user_id              UUID         NULL REFERENCES users(id) ON DELETE SET NULL,
    updated_by_user_id              UUID         NULL REFERENCES users(id) ON DELETE SET NULL,

    CONSTRAINT tqg_grade_per_tenant UNIQUE (tenant_id, grade_number),
    CONSTRAINT tqg_code_per_tenant  UNIQUE (tenant_id, code)
  );

  CREATE INDEX tqg_tenant_active ON tenant_quality_grades (tenant_id, is_active);

  COMMENT ON TABLE tenant_quality_grades IS
    'SaaS v2: catálogo de calidades de PT por tenant. Reemplaza el flag boolean is_second_quality con N grados (1-5).';
  COMMENT ON COLUMN tenant_quality_grades.grade_number IS
    '1 = mejor calidad (apta/primera). 5 = peor (post-MVP).';
  COMMENT ON COLUMN tenant_quality_grades.counts_for_order_fulfillment IS
    'true: las unidades de esta calidad cuentan al cumplimiento de la orden. Default true para grade=1, false para los demás. Override por orden vía production_orders.accept_second_quality_for_fulfillment.';

  CREATE TRIGGER set_updated_at_tenant_quality_grades
    BEFORE UPDATE ON tenant_quality_grades
    FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

  -- ─── Extensión aditiva a shift_progress ──────────────────────────────
  ALTER TABLE shift_progress
    ADD COLUMN IF NOT EXISTS quality_grade_id UUID NULL
      REFERENCES tenant_quality_grades(id) ON DELETE SET NULL;

  CREATE INDEX IF NOT EXISTS shift_progress_quality_grade_id ON shift_progress (quality_grade_id);

  COMMENT ON COLUMN shift_progress.quality_grade_id IS
    'SaaS v2: FK al catálogo tenant_quality_grades. Reemplaza is_second_quality. Se mantiene el boolean por backward compat hasta cleanup migrations.';

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

    -- tenant_units (15)
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
      SELECT 1 FROM tenant_units tu WHERE tu.tenant_id = p_tenant_id AND tu.code = u.code
    );

    -- tenant_unit_conversions
    INSERT INTO tenant_unit_conversions (tenant_id, from_unit_id, to_unit_id, factor)
    SELECT p_tenant_id, f.id, t.id, pair.factor
    FROM (VALUES
      ('kg','g',1000),('ton','kg',1000),('L','mL',1000),('docena','pza',12),
      ('m','cm',100),('m','mm',1000),('cm','mm',10),('h','min',60)
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

    -- tenant_scrap_types (4)
    INSERT INTO tenant_scrap_types (tenant_id, code, name, default_destination, default_recovery_value_pct, is_normal, sort_order)
    SELECT p_tenant_id, s.code, s.name, s.dest, s.recovery, s.is_normal, s.sort_order
    FROM (VALUES
      ('arranque',     'Arranque',     'discard',   0,  true, 10),
      ('operacion',    'Operación',    'reprocess', 30, true, 20),
      ('contaminada',  'Contaminada',  'discard',   0,  true, 30),
      ('desecho',      'Desecho',      'discard',   0,  true, 40)
    ) AS s(code, name, dest, recovery, is_normal, sort_order)
    WHERE NOT EXISTS (
      SELECT 1 FROM tenant_scrap_types tst
       WHERE tst.tenant_id = p_tenant_id AND tst.code = s.code
    );

    -- tenant_quality_grades (3 default: primera, segunda, tercera)
    INSERT INTO tenant_quality_grades (
      tenant_id, grade_number, code, name,
      counts_for_order_fulfillment, goes_to_warehouse_type_id, sort_order
    )
    SELECT p_tenant_id,
           q.grade_number, q.code, q.name,
           q.counts_fulfillment,
           (SELECT id FROM tenant_warehouse_types
            WHERE tenant_id = p_tenant_id AND code = q.target_warehouse),
           q.sort_order
    FROM (VALUES
      (1, 'primera', 'Primera (apta)', true,  'producto_terminado', 10),
      (2, 'segunda', 'Segunda',        false, 'producto_terminado', 20),
      (3, 'tercera', 'Tercera',        false, 'producto_terminado', 30)
    ) AS q(grade_number, code, name, counts_fulfillment, target_warehouse, sort_order)
    WHERE NOT EXISTS (
      SELECT 1 FROM tenant_quality_grades tqg
       WHERE tqg.tenant_id = p_tenant_id AND tqg.grade_number = q.grade_number
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

  -- ─── Backfill shift_progress.quality_grade_id desde is_second_quality
  UPDATE shift_progress sp
  SET quality_grade_id = tqg.id
  FROM tenant_quality_grades tqg, production_shifts ps
  WHERE sp.shift_id = ps.id
    AND tqg.tenant_id = ps.tenant_id
    AND sp.quality_grade_id IS NULL
    AND (
      (sp.is_second_quality = false AND tqg.grade_number = 1) OR
      (sp.is_second_quality = true  AND tqg.grade_number = 2)
    );
`

const down = `
  ALTER TABLE shift_progress DROP COLUMN IF EXISTS quality_grade_id;

  DROP TRIGGER IF EXISTS set_updated_at_tenant_quality_grades ON tenant_quality_grades;
  DROP TABLE IF EXISTS tenant_quality_grades;
`

module.exports = { up, down }
