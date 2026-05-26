'use strict'

/**
 * SaaS v2 — Migration 127: recipes + recipe_components + permisos.
 *
 * Primera migration de Fase 1. Reemplaza order_mp_formula (hardcoded a 4
 * materiales en columnas planas) por un modelo de recetas versionadas con
 * N componentes y unidades configurables.
 *
 * Modelo:
 *  - recipes: BOM por producto. Una sola vigente por producto en cualquier
 *    momento (partial unique constraint). Nueva versión cierra la anterior
 *    con valid_until=NOW. version es entero auto-asignado por el service.
 *  - recipe_components: componentes de la receta (raw_materials), con cantidad
 *    y unidad (gracias a tenant_units, no más asumir kg).
 *
 * Aditivo: order_mp_formula se mantiene; el código viejo de production sigue
 * usándola. El refactor de productionService que migre a recipe_id viene
 * después (con golden masters).
 *
 * Permisos:
 *  - recipes:read    — listar y ver recetas
 *  - recipes:update  — crear nueva versión, editar metadata
 *  Asignados a owner, admin, supervisor.
 *
 * Referencia: §2.2.9 + §2.2.10.
 */

const up = `
  -- ─── recipes ──────────────────────────────────────────────────────────
  CREATE TABLE recipes (
    id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id             UUID         NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    product_id            UUID         NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    version               INTEGER      NOT NULL,
    name                  VARCHAR(120) NOT NULL,
    yield_quantity        NUMERIC(18,6) NOT NULL,
    yield_unit_id         UUID         NOT NULL REFERENCES tenant_units(id) ON DELETE RESTRICT,
    expected_scrap_pct    NUMERIC(5,2) NULL,
    valid_from            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    valid_until           TIMESTAMPTZ  NULL,
    is_active             BOOLEAN      NOT NULL DEFAULT true,
    created_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    created_by_user_id    UUID         NULL REFERENCES users(id) ON DELETE SET NULL,

    CONSTRAINT recipes_version_per_product UNIQUE (product_id, version),
    CONSTRAINT recipes_yield_positive      CHECK (yield_quantity > 0),
    CONSTRAINT recipes_scrap_pct_range     CHECK (expected_scrap_pct IS NULL OR (expected_scrap_pct >= 0 AND expected_scrap_pct <= 100)),
    CONSTRAINT recipes_valid_until_after_from CHECK (valid_until IS NULL OR valid_until >= valid_from)
  );

  -- Partial unique: solo una receta vigente (valid_until IS NULL) por producto.
  CREATE UNIQUE INDEX recipes_one_vigente_per_product
    ON recipes (product_id) WHERE valid_until IS NULL;

  CREATE INDEX recipes_tenant_active  ON recipes (tenant_id, is_active);
  CREATE INDEX recipes_product_vigent ON recipes (product_id) WHERE valid_until IS NULL;

  COMMENT ON TABLE recipes IS
    'SaaS v2: recetas/BOM por producto. Versionadas (version 1, 2, 3...). Solo una con valid_until IS NULL por producto. Reemplaza order_mp_formula (hardcoded a 4 materiales).';
  COMMENT ON COLUMN recipes.version IS
    'Entero auto-asignado por el service como MAX(version)+1 al crear nueva versión del mismo producto.';
  COMMENT ON COLUMN recipes.valid_until IS
    'NULL: receta vigente. Se setea a NOW() cuando una nueva versión la reemplaza.';
  COMMENT ON COLUMN recipes.yield_quantity IS
    'Cuánto PT se obtiene de una corrida estándar de la receta, expresado en yield_unit_id.';
  COMMENT ON COLUMN recipes.expected_scrap_pct IS
    '% de merma normal esperado. Para distinguir merma normal (queda en costo) vs anormal (va a cuenta de pérdida).';

  -- ─── recipe_components ────────────────────────────────────────────────
  CREATE TABLE recipe_components (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    recipe_id           UUID         NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
    raw_material_id     UUID         NOT NULL REFERENCES raw_materials(id) ON DELETE RESTRICT,
    quantity            NUMERIC(18,6) NOT NULL,
    unit_id             UUID         NOT NULL REFERENCES tenant_units(id) ON DELETE RESTRICT,
    is_optional         BOOLEAN      NOT NULL DEFAULT false,
    substitute_group    VARCHAR(40)  NULL,
    notes               TEXT         NULL,
    sort_order          INTEGER      NOT NULL DEFAULT 0,
    created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

    CONSTRAINT rc_quantity_positive CHECK (quantity > 0),
    CONSTRAINT rc_unique_rm_per_recipe UNIQUE (recipe_id, raw_material_id)
  );

  CREATE INDEX rc_recipe ON recipe_components (recipe_id);
  CREATE INDEX rc_raw_material ON recipe_components (raw_material_id);
  CREATE INDEX rc_substitute_group ON recipe_components (recipe_id, substitute_group)
    WHERE substitute_group IS NOT NULL;

  COMMENT ON TABLE recipe_components IS
    'SaaS v2: ingredientes de una receta. raw_material_id puede ser MP, embalaje o aditivo (gracias a raw_materials.item_kind).';
  COMMENT ON COLUMN recipe_components.substitute_group IS
    'Componentes con el mismo substitute_group son intercambiables (ej. dos aceites alternativos).';

  -- ─── Permisos recipes:read y recipes:update ───────────────────────────
  INSERT INTO permissions (resource, action, description)
  VALUES
    ('recipes', 'read',   'Ver recetas y sus componentes'),
    ('recipes', 'update', 'Crear nuevas versiones y editar metadata de recetas')
  ON CONFLICT (resource, action) DO NOTHING;

  -- Asignar a roles globales (super_admin), owner, admin, supervisor de cada tenant.
  INSERT INTO role_permissions (role_id, permission_id)
  SELECT r.id, p.id
  FROM roles r, permissions p
  WHERE p.resource = 'recipes'
    AND p.action IN ('read', 'update')
    AND (
      (r.tenant_id IS NULL AND r.name = 'super_admin') OR
      (r.tenant_id IS NOT NULL AND r.name IN ('owner', 'admin', 'supervisor'))
    )
  ON CONFLICT DO NOTHING;
`

const down = `
  DELETE FROM role_permissions
   WHERE permission_id IN (SELECT id FROM permissions WHERE resource = 'recipes');
  DELETE FROM permissions WHERE resource = 'recipes';

  DROP TABLE IF EXISTS recipe_components;
  DROP TABLE IF EXISTS recipes;
`

module.exports = { up, down }
