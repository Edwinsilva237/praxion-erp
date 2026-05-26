'use strict'

/**
 * SaaS v2 — Migration 131: tenant_allergens + raw_material_allergens +
 * product_allergens.
 *
 * Sección 4.3.4-5 del design. Cubre declaración de alérgenos para
 * compliance con NOM-051 (alimentos pre-envasados México) y NOM-251
 * (manejo de alimentos).
 *
 * Modelo:
 *  - tenant_allergens: catálogo configurable por tenant. Seed default de los
 *    8 alérgenos prioritarios NOM-051. Tenants no-alimentarios pueden
 *    desactivar todos via is_active=false.
 *  - raw_material_allergens / product_allergens: tablas de unión simples con
 *    declaration ('contains' | 'may_contain'). Sin endpoints v2 todavía;
 *    vendrán cuando se haga el service v2 de raw_materials/products.
 *
 * NO incluye en esta migration:
 *  - product_lot_allergens (vista materializada §4.9.3) — código del refactor.
 *  - Detección automática de discrepancias al cerrar lote (§4.9.2) — código
 *    del refactor.
 *
 * Referencia: §4.3.4, §4.3.5, §4.9.
 */

const up = `
  -- ═══════════════════════════════════════════════════════════════════════
  -- tenant_allergens — catálogo
  -- ═══════════════════════════════════════════════════════════════════════
  CREATE TABLE tenant_allergens (
    id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id             UUID         NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    code                  VARCHAR(30)  NOT NULL,
    name                  VARCHAR(80)  NOT NULL,
    is_priority           BOOLEAN      NOT NULL DEFAULT false,
    sort_order            INTEGER      NOT NULL DEFAULT 0,
    is_active             BOOLEAN      NOT NULL DEFAULT true,
    created_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    created_by_user_id    UUID         NULL REFERENCES users(id) ON DELETE SET NULL,
    updated_by_user_id    UUID         NULL REFERENCES users(id) ON DELETE SET NULL,

    CONSTRAINT ta_code_per_tenant UNIQUE (tenant_id, code)
  );

  CREATE INDEX ta_tenant_active ON tenant_allergens (tenant_id, is_active);
  CREATE INDEX ta_tenant_priority ON tenant_allergens (tenant_id, is_priority)
    WHERE is_priority = true;

  COMMENT ON TABLE tenant_allergens IS
    'SaaS v2 §4.3.4: catálogo de alérgenos por tenant. Seed default = 8 prioritarios NOM-051. Tenants no-alimentarios desactivan con is_active=false.';
  COMMENT ON COLUMN tenant_allergens.is_priority IS
    'true: alérgeno prioritario NOM-051 (los 8 grandes). Para destacar en UI/etiquetas.';

  CREATE TRIGGER set_updated_at_tenant_allergens
    BEFORE UPDATE ON tenant_allergens
    FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

  -- ═══════════════════════════════════════════════════════════════════════
  -- raw_material_allergens — declaración en MP
  -- ═══════════════════════════════════════════════════════════════════════
  CREATE TABLE raw_material_allergens (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    raw_material_id     UUID         NOT NULL REFERENCES raw_materials(id) ON DELETE CASCADE,
    allergen_id         UUID         NOT NULL REFERENCES tenant_allergens(id) ON DELETE RESTRICT,
    declaration         VARCHAR(20)  NOT NULL DEFAULT 'contains',
    created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    created_by_user_id  UUID         NULL REFERENCES users(id) ON DELETE SET NULL,

    CONSTRAINT rma_declaration_check CHECK (declaration IN ('contains', 'may_contain')),
    CONSTRAINT rma_unique_per_rm UNIQUE (raw_material_id, allergen_id)
  );

  CREATE INDEX rma_raw_material ON raw_material_allergens (raw_material_id);
  CREATE INDEX rma_allergen     ON raw_material_allergens (allergen_id);

  COMMENT ON TABLE raw_material_allergens IS
    'SaaS v2 §4.3.5: alérgenos declarados de una MP. declaration=contains (lo lleva) | may_contain (puede tener por contaminación cruzada).';

  -- ═══════════════════════════════════════════════════════════════════════
  -- product_allergens — declaración en PT
  -- ═══════════════════════════════════════════════════════════════════════
  CREATE TABLE product_allergens (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    product_id          UUID         NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    allergen_id         UUID         NOT NULL REFERENCES tenant_allergens(id) ON DELETE RESTRICT,
    declaration         VARCHAR(20)  NOT NULL DEFAULT 'contains',
    created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    created_by_user_id  UUID         NULL REFERENCES users(id) ON DELETE SET NULL,

    CONSTRAINT pa_declaration_check CHECK (declaration IN ('contains', 'may_contain')),
    CONSTRAINT pa_unique_per_product UNIQUE (product_id, allergen_id)
  );

  CREATE INDEX pa_product  ON product_allergens (product_id);
  CREATE INDEX pa_allergen ON product_allergens (allergen_id);

  COMMENT ON TABLE product_allergens IS
    'SaaS v2 §4.3.5: alérgenos declarados de un PT. La herencia desde MP consumidas se calcula al cerrar el lote (§4.9.2, post-MVP code).';

  -- ═══════════════════════════════════════════════════════════════════════
  -- Extender la función seed con los 8 alérgenos prioritarios NOM-051
  -- ═══════════════════════════════════════════════════════════════════════
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

    -- tenant_shift_roles (5 default: capturista, supervisor, calidad, alimentador, maquinista)
    INSERT INTO tenant_shift_roles (
      tenant_id, code, name,
      is_required, is_unique_per_shift,
      can_capture, can_validate, can_handover,
      sort_order
    )
    SELECT p_tenant_id, r.code, r.name,
           r.is_required, r.is_unique,
           r.can_capture, r.can_validate, r.can_handover,
           r.sort_order
    FROM (VALUES
      ('capturista',  'Capturista',  true,  true,  true,  false, true,  10),
      ('supervisor',  'Supervisor',  false, true,  false, true,  true,  20),
      ('calidad',     'Calidad',     false, false, false, false, false, 30),
      ('alimentador', 'Alimentador', false, false, false, false, false, 40),
      ('maquinista',  'Maquinista',  false, true,  false, false, false, 50)
    ) AS r(code, name, is_required, is_unique,
           can_capture, can_validate, can_handover, sort_order)
    WHERE NOT EXISTS (
      SELECT 1 FROM tenant_shift_roles tsr
       WHERE tsr.tenant_id = p_tenant_id AND tsr.code = r.code
    );

    -- tenant_allergens (8 prioritarios NOM-051)
    INSERT INTO tenant_allergens (tenant_id, code, name, is_priority, sort_order)
    SELECT p_tenant_id, a.code, a.name, true, a.sort_order
    FROM (VALUES
      ('gluten',    'Cereales con gluten',    10),
      ('dairy',     'Lácteos',                20),
      ('eggs',      'Huevo',                  30),
      ('fish',      'Pescado',                40),
      ('shellfish', 'Crustáceos',             50),
      ('nuts',      'Frutos secos de árbol',  60),
      ('soy',       'Soya',                   70),
      ('sesame',    'Sésamo (ajonjolí)',      80)
    ) AS a(code, name, sort_order)
    WHERE NOT EXISTS (
      SELECT 1 FROM tenant_allergens ta
       WHERE ta.tenant_id = p_tenant_id AND ta.code = a.code
    );
  END;
  $$;

  -- Aplicar seed a tenants existentes (los nuevos se sirven via trigger AFTER INSERT en tenants)
  DO $$
  DECLARE t_id UUID;
  BEGIN
    FOR t_id IN SELECT id FROM tenants LOOP
      PERFORM seed_tenant_process_template_defaults(t_id);
    END LOOP;
  END $$;
`

const down = `
  DROP TABLE IF EXISTS product_allergens;
  DROP TABLE IF EXISTS raw_material_allergens;
  DROP TRIGGER IF EXISTS set_updated_at_tenant_allergens ON tenant_allergens;
  DROP TABLE IF EXISTS tenant_allergens;
`

module.exports = { up, down }
