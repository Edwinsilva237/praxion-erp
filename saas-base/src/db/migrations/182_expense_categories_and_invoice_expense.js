'use strict'

/**
 * Mig 182 — Módulo de GASTOS (Fase 1).
 *
 * Gastos de proveedor que NO son mercancía ni materia prima: fletes, paquetería,
 * luz, renta, gasolina, gas, internet, casetas, honorarios, etc. Hasta hoy una
 * `supplier_invoice` asumía mercancía (se ligaba a OC/recepción) y no había dónde
 * clasificar un gasto puro.
 *
 * Esta migración agrega, SaaS-first (todo por tenant, sembrado por la función
 * seed del Process Template + auto-heal para tenants existentes):
 *
 *  1. `tenant_expense_categories` — catálogo configurable por tenant (CRUD).
 *     Patrón idéntico a tenant_scrap_types (mig 122). Set inicial NEUTRO universal
 *     (sirve a cualquier vertical); cada tenant lo edita.
 *  2. `supplier_invoices.is_expense` + `expense_category_id` — marca una factura
 *     de proveedor como "gasto" (sin recepción) y le asigna categoría. NULL/false
 *     para las facturas de mercancía normales → cero impacto en el flujo actual.
 *  3. Flag `expenses_enabled` en tenant_process_config — el micro pyme no carga
 *     complejidad; el avanzado lo prende.
 *  4. Permiso `expenses:read` / `expenses:create` (+ amarre a super_admin y a los
 *     roles con purchases:* como proxy de "gestiona compras").
 *
 * El IVA de estos gastos YA entra al dashboard (financialSnapshot suma tax de
 * toda supplier_invoice con uuid_sat) — no hace falta tocar reportes.
 */

const up = `
  -- ─── 1. Catálogo de categorías de gasto (por tenant) ──────────────────
  CREATE TABLE tenant_expense_categories (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id           UUID         NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    code                VARCHAR(40)  NOT NULL,
    name                VARCHAR(120) NOT NULL,
    -- 'true' = el gasto puede prorratearse al costo del producto (flete de
    -- mercancía). Hoy es solo informativo; lo consumirá el futuro "landed cost".
    affects_cost        BOOLEAN      NOT NULL DEFAULT false,
    sort_order          INTEGER      NOT NULL DEFAULT 0,
    is_active           BOOLEAN      NOT NULL DEFAULT true,
    created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    created_by_user_id  UUID         NULL REFERENCES users(id) ON DELETE SET NULL,
    updated_by_user_id  UUID         NULL REFERENCES users(id) ON DELETE SET NULL,

    CONSTRAINT tec_code_per_tenant UNIQUE (tenant_id, code)
  );

  CREATE INDEX tec_tenant_active ON tenant_expense_categories (tenant_id, is_active);

  COMMENT ON TABLE tenant_expense_categories IS
    'SaaS v2: catálogo configurable por tenant de categorías de gasto (renta, energía, fletes, combustible, etc.). Cada tenant crea/edita las suyas; el seed es solo punto de partida.';
  COMMENT ON COLUMN tenant_expense_categories.affects_cost IS
    'true: gasto prorrateable al costo del producto (ej. flete de mercancía). Hoy informativo; lo usará el futuro landed cost.';

  -- ─── 2. Marcar facturas de proveedor como "gasto" ─────────────────────
  ALTER TABLE supplier_invoices
    ADD COLUMN is_expense          BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN expense_category_id UUID NULL REFERENCES tenant_expense_categories(id) ON DELETE SET NULL;

  CREATE INDEX si_tenant_expense ON supplier_invoices (tenant_id, is_expense);

  COMMENT ON COLUMN supplier_invoices.is_expense IS
    'true: factura de GASTO puro (servicio/flete/etc., sin recepción de mercancía). false (default): factura de mercancía/MP normal.';

  -- ─── 3. Flag de tenant ────────────────────────────────────────────────
  ALTER TABLE tenant_process_config
    ADD COLUMN expenses_enabled BOOLEAN NOT NULL DEFAULT false;

  COMMENT ON COLUMN tenant_process_config.expenses_enabled IS
    'true: habilita el módulo de Gastos (facturas de gasto + categorías). false (default): el tenant no ve Gastos (micro pyme).';

  -- ─── 4. Permisos ──────────────────────────────────────────────────────
  INSERT INTO permissions (resource, action, description) VALUES
    ('expenses', 'read',   'Ver gastos de proveedor (fletes, servicios, luz, renta, etc.)'),
    ('expenses', 'create', 'Registrar/editar gastos de proveedor y su factura')
  ON CONFLICT (resource, action) DO NOTHING;

  -- super_admin global
  INSERT INTO role_permissions (role_id, permission_id)
  SELECT r.id, p.id
    FROM roles r CROSS JOIN permissions p
   WHERE r.name = 'super_admin' AND p.resource = 'expenses'
     AND NOT EXISTS (SELECT 1 FROM role_permissions rp WHERE rp.role_id = r.id AND rp.permission_id = p.id);

  -- Roles que ya gestionan compras (purchases:create) → también gastos
  INSERT INTO role_permissions (role_id, permission_id)
  SELECT DISTINCT r.id, p.id
    FROM roles r
    JOIN role_permissions rpx ON rpx.role_id = r.id
    JOIN permissions px ON px.id = rpx.permission_id AND px.resource = 'purchases' AND px.action = 'create'
    CROSS JOIN permissions p
   WHERE p.resource = 'expenses'
     AND NOT EXISTS (SELECT 1 FROM role_permissions rp WHERE rp.role_id = r.id AND rp.permission_id = p.id);

  -- ─── 5. Extender la función seed del Process Template ─────────────────
  -- (siembra categorías default a tenants NUEVOS vía trigger + auto-heal a los
  --  existentes. Set NEUTRO universal — cada tenant luego lo edita.)
  CREATE OR REPLACE FUNCTION seed_tenant_expense_categories(p_tenant_id UUID)
  RETURNS VOID
  LANGUAGE plpgsql
  AS $$
  BEGIN
    INSERT INTO tenant_expense_categories (tenant_id, code, name, affects_cost, sort_order)
    SELECT p_tenant_id, c.code, c.name, c.affects_cost, c.sort_order
    FROM (VALUES
      ('renta',        'Renta / Arrendamiento',  false, 10),
      ('energia',      'Energía eléctrica',      false, 20),
      ('agua',         'Agua',                   false, 30),
      ('internet',     'Internet / Telefonía',   false, 40),
      ('combustible',  'Combustible',            false, 50),
      ('flete',        'Fletes y paquetería',    true,  60),
      ('mantenimiento','Mantenimiento',          false, 70),
      ('papeleria',    'Papelería',              false, 80),
      ('honorarios',   'Honorarios / Servicios', false, 90),
      ('otros',        'Otros gastos',           false, 100)
    ) AS c(code, name, affects_cost, sort_order)
    WHERE NOT EXISTS (
      SELECT 1 FROM tenant_expense_categories tec
       WHERE tec.tenant_id = p_tenant_id AND tec.code = c.code
    );
  END;
  $$;

  COMMENT ON FUNCTION seed_tenant_expense_categories(UUID) IS
    'SaaS v2: siembra las categorías de gasto default (set neutro) para un tenant. Idempotente.';

  -- Encadenar a la función maestra del Process Template (la llama el trigger
  -- AFTER INSERT en tenants + el auto-heal).
  --
  -- ⚠️ IMPORTANTE: esta función fue extendida acumulativamente por las migs
  -- 120-131 (units, conversions, warehouse_types, scrap_types, quality_grades,
  -- shift_roles, allergens). NO redefinir con un cuerpo parcial — eso BORRA los
  -- seeds de los demás catálogos y deja a los tenants "config rota". Aquí
  -- reproducimos el cuerpo COMPLETO de la mig 131 + la línea nueva al final.
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

    -- tenant_quality_grades (3)
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

    -- tenant_shift_roles (5)
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

    -- NUEVO (mig 182): categorías de gasto default
    PERFORM seed_tenant_expense_categories(p_tenant_id);
  END;
  $$;

  -- Auto-heal: sembrar categorías de gasto a todos los tenants existentes.
  DO $$
  DECLARE t_id UUID;
  BEGIN
    FOR t_id IN SELECT id FROM tenants LOOP
      PERFORM seed_tenant_expense_categories(t_id);
    END LOOP;
  END $$;
`

const down = `
  ALTER TABLE supplier_invoices
    DROP COLUMN IF EXISTS is_expense,
    DROP COLUMN IF EXISTS expense_category_id;
  ALTER TABLE tenant_process_config DROP COLUMN IF EXISTS expenses_enabled;
  DROP TABLE IF EXISTS tenant_expense_categories CASCADE;
  DROP FUNCTION IF EXISTS seed_tenant_expense_categories(UUID);
  DELETE FROM permissions WHERE resource = 'expenses';
`

module.exports = { up, down }
