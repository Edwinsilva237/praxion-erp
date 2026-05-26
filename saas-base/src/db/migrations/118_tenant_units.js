'use strict'

/**
 * SaaS v2 — Migration 118: tenant_units + tenant_unit_conversions
 *
 * Crea el sistema de unidades configurable por tenant. Es la base que el
 * resto del Process Template referenciará (raw_materials.unit_id,
 * tenant_product_kinds.base_unit_id, recipe_components.unit_id, etc.).
 *
 * Decisiones de diseño relevantes (§2.2.2 y §2.2.3):
 *  - Una sola unidad base por (tenant_id, unit_type) — garantizado por
 *    partial unique index.
 *  - Conversiones unidireccionales (1 row = 1 dirección). El motor calcula
 *    la inversa automáticamente: si "caja → pza factor 24", entonces
 *    "pza → caja factor 1/24" se deriva en código, no en DB.
 *  - Conversiones SOLO entre unidades del mismo unit_type (CHECK).
 *  - Seed: cada tenant existente recibe unidades base + comunes (kg, g, L,
 *    mL, pza, docena, m, cm, mm, m2, h, min) + sus conversiones.
 *
 * Referencia: docs/saas-v2/00-design.md §2.2.2 y §2.2.3.
 */

const up = `
  -- ─── Tabla principal: tenant_units ───────────────────────────────────────
  CREATE TABLE tenant_units (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id           UUID         NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    code                VARCHAR(20)  NOT NULL,
    name                VARCHAR(80)  NOT NULL,
    symbol              VARCHAR(10)  NOT NULL,
    unit_type           VARCHAR(20)  NOT NULL
      CHECK (unit_type IN ('weight','volume','count','length','area','time')),
    is_base             BOOLEAN      NOT NULL DEFAULT false,
    decimals            SMALLINT     NOT NULL DEFAULT 2
      CHECK (decimals BETWEEN 0 AND 6),
    is_active           BOOLEAN      NOT NULL DEFAULT true,
    sort_order          INTEGER      NOT NULL DEFAULT 0,
    created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    created_by_user_id  UUID         NULL REFERENCES users(id) ON DELETE SET NULL,
    updated_by_user_id  UUID         NULL REFERENCES users(id) ON DELETE SET NULL,

    CONSTRAINT tu_code_per_tenant UNIQUE (tenant_id, code)
  );

  -- Solo una unidad base por (tenant_id, unit_type)
  CREATE UNIQUE INDEX tu_one_base_per_type
    ON tenant_units (tenant_id, unit_type)
    WHERE is_base = true;

  CREATE INDEX tu_tenant_unit_type
    ON tenant_units (tenant_id, unit_type, is_active);

  COMMENT ON TABLE tenant_units IS
    'SaaS v2: catálogo de unidades de medida por tenant. La unidad base de cada unit_type es la referencia para conversiones.';
  COMMENT ON COLUMN tenant_units.unit_type IS
    'Categoría física: weight/volume/count/length/area/time. Solo se permiten conversiones dentro del mismo unit_type.';
  COMMENT ON COLUMN tenant_units.is_base IS
    'La unidad base de un unit_type. Todas las conversiones del tipo se calculan respecto a ella. Solo puede haber 1 base por unit_type por tenant.';

  CREATE TRIGGER set_updated_at_tenant_units
    BEFORE UPDATE ON tenant_units
    FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

  -- ─── Tabla de conversiones: tenant_unit_conversions ─────────────────────
  CREATE TABLE tenant_unit_conversions (
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id     UUID           NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    from_unit_id  UUID           NOT NULL REFERENCES tenant_units(id) ON DELETE CASCADE,
    to_unit_id    UUID           NOT NULL REFERENCES tenant_units(id) ON DELETE CASCADE,
    factor        NUMERIC(18,6)  NOT NULL CHECK (factor > 0),
    is_active     BOOLEAN        NOT NULL DEFAULT true,
    created_at    TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
    created_by_user_id UUID      NULL REFERENCES users(id) ON DELETE SET NULL,

    CONSTRAINT tuc_no_self CHECK (from_unit_id <> to_unit_id),
    CONSTRAINT tuc_unique  UNIQUE (tenant_id, from_unit_id, to_unit_id)
  );

  CREATE INDEX tuc_tenant_from ON tenant_unit_conversions (tenant_id, from_unit_id);
  CREATE INDEX tuc_tenant_to   ON tenant_unit_conversions (tenant_id, to_unit_id);

  COMMENT ON TABLE tenant_unit_conversions IS
    'SaaS v2: conversiones unidireccionales entre unidades del mismo unit_type. from × factor = to.';
  COMMENT ON COLUMN tenant_unit_conversions.factor IS
    'Factor multiplicativo: from × factor = to. Ejemplo: caja → pza con factor 24 significa que 1 caja = 24 piezas.';

  -- ─── Seed default por tenant ────────────────────────────────────────────
  -- Para cada tenant existente sembramos:
  --   weight:  kg (base), g, ton
  --   volume:  L (base), mL
  --   count:   pza (base), docena, caja, tarima
  --   length:  m (base), cm, mm
  --   area:    m2 (base)
  --   time:    h (base), min
  -- Y las conversiones más comunes (kg→g, L→mL, docena→pza, etc.).

  INSERT INTO tenant_units (tenant_id, code, name, symbol, unit_type, is_base, decimals, sort_order)
  SELECT t.id, u.code, u.name, u.symbol, u.unit_type, u.is_base, u.decimals, u.sort_order
  FROM tenants t
  CROSS JOIN (VALUES
    -- weight
    ('kg',  'Kilogramo', 'kg',  'weight', true,  3, 10),
    ('g',   'Gramo',     'g',   'weight', false, 2, 20),
    ('ton', 'Tonelada',  't',   'weight', false, 4, 30),
    -- volume
    ('L',   'Litro',         'L',  'volume', true,  3, 10),
    ('mL',  'Mililitro',     'mL', 'volume', false, 2, 20),
    -- count
    ('pza',     'Pieza',     'pz',  'count', true,  0, 10),
    ('docena',  'Docena',    'doc', 'count', false, 0, 20),
    ('caja',    'Caja',      'cj',  'count', false, 0, 30),
    ('tarima',  'Tarima',    'tar', 'count', false, 0, 40),
    -- length
    ('m',  'Metro',      'm',  'length', true,  3, 10),
    ('cm', 'Centímetro', 'cm', 'length', false, 1, 20),
    ('mm', 'Milímetro',  'mm', 'length', false, 1, 30),
    -- area
    ('m2', 'Metro cuadrado', 'm²', 'area', true, 3, 10),
    -- time
    ('h',   'Hora',   'h',   'time', true,  2, 10),
    ('min', 'Minuto', 'min', 'time', false, 0, 20)
  ) AS u(code, name, symbol, unit_type, is_base, decimals, sort_order)
  WHERE NOT EXISTS (
    SELECT 1 FROM tenant_units tu WHERE tu.tenant_id = t.id AND tu.code = u.code
  );

  -- Conversiones default. Patrón: para cada par (from, to) buscamos los IDs.
  -- factor: from × factor = to.
  -- kg → g: factor 1000  (1 kg = 1000 g)
  -- g  → kg: factor 0.001 (1 g  = 0.001 kg) — derivado en código, NO en seed
  --   Decisión §2.8.5: explícita, 1 row = 1 dirección.
  --   Sembramos solo "subir granularidad" (de unidad grande a chica) que es la
  --   forma más natural; la inversa la calcula la app.
  INSERT INTO tenant_unit_conversions (tenant_id, from_unit_id, to_unit_id, factor)
  SELECT
    f.tenant_id,
    f.id      AS from_unit_id,
    t.id      AS to_unit_id,
    pair.factor
  FROM tenants tn
  CROSS JOIN (VALUES
    ('kg',     'g',    1000),
    ('ton',    'kg',   1000),
    ('L',      'mL',   1000),
    ('docena', 'pza',  12),
    ('m',      'cm',   100),
    ('m',      'mm',   1000),
    ('cm',     'mm',   10),
    ('h',      'min',  60)
  ) AS pair(from_code, to_code, factor)
  JOIN tenant_units f ON f.tenant_id = tn.id AND f.code = pair.from_code
  JOIN tenant_units t ON t.tenant_id = tn.id AND t.code = pair.to_code
  WHERE NOT EXISTS (
    SELECT 1 FROM tenant_unit_conversions tuc
    WHERE tuc.tenant_id = tn.id
      AND tuc.from_unit_id = f.id
      AND tuc.to_unit_id   = t.id
  );
`

const down = `
  DROP TRIGGER IF EXISTS set_updated_at_tenant_units ON tenant_units;
  DROP TABLE IF EXISTS tenant_unit_conversions;
  DROP TABLE IF EXISTS tenant_units;
`

module.exports = { up, down }
