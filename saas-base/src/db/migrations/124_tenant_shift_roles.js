'use strict'

/**
 * SaaS v2 — Migration 124: tenant_shift_roles + production_shift_members
 *
 * Reemplaza los campos rígidos production_shifts.operator_id/supervisor_id con
 * un sistema configurable de roles del turno (capturista obligatorio + N
 * opcionales: supervisor, calidad, alimentador, maquinista) y una tabla de
 * miembros que soporta sustituciones a media corrida (joined_at/left_at).
 *
 * Esta migration es **aditiva pura**:
 *  - production_shifts.operator_id/supervisor_id se mantienen NOT NULL.
 *  - production_shift_members se crea pero NO se sincroniza con shifts todavía.
 *  - El trigger de sincronización (design §2.4.1) se introduce junto con el
 *    refactor de productionService, una vez que los golden masters den red de
 *    seguridad. Hasta entonces, el code path viejo sigue funcionando intacto.
 *
 * Seed default de roles (5):
 *  - capturista   (required, unique, can_capture, can_handover)
 *  - supervisor   (unique, can_validate, can_handover)
 *  - calidad
 *  - alimentador  (puede haber 2+ por turno → is_unique_per_shift=false)
 *  - maquinista   (unique)
 *
 * Referencia: §2.2.7 + §2.4.1.
 */

const up = `
  -- ─── Catálogo: tenant_shift_roles ────────────────────────────────────
  CREATE TABLE tenant_shift_roles (
    id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id             UUID         NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    code                  VARCHAR(30)  NOT NULL,
    name                  VARCHAR(80)  NOT NULL,
    is_required           BOOLEAN      NOT NULL DEFAULT false,
    is_unique_per_shift   BOOLEAN      NOT NULL DEFAULT false,
    can_capture           BOOLEAN      NOT NULL DEFAULT false,
    can_validate          BOOLEAN      NOT NULL DEFAULT false,
    can_handover          BOOLEAN      NOT NULL DEFAULT false,
    sort_order            INTEGER      NOT NULL DEFAULT 0,
    is_active             BOOLEAN      NOT NULL DEFAULT true,
    created_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    created_by_user_id    UUID         NULL REFERENCES users(id) ON DELETE SET NULL,
    updated_by_user_id    UUID         NULL REFERENCES users(id) ON DELETE SET NULL,

    CONSTRAINT tsr_code_per_tenant UNIQUE (tenant_id, code)
  );

  CREATE INDEX tsr_tenant_active ON tenant_shift_roles (tenant_id, is_active);

  COMMENT ON TABLE tenant_shift_roles IS
    'SaaS v2: catálogo de roles configurables del turno por tenant. Reemplaza los campos rígidos operator/supervisor con N roles.';
  COMMENT ON COLUMN tenant_shift_roles.is_required IS
    'true: cada turno debe tener al menos un miembro con este rol (típicamente capturista).';
  COMMENT ON COLUMN tenant_shift_roles.is_unique_per_shift IS
    'true: máximo 1 miembro activo con este rol por turno (capturista, supervisor, maquinista). false: puede haber varios (alimentadores).';
  COMMENT ON COLUMN tenant_shift_roles.can_capture IS
    'true: miembros con este rol pueden capturar paquetes/progreso.';
  COMMENT ON COLUMN tenant_shift_roles.can_validate IS
    'true: miembros con este rol pueden liberar/validar el turno (típicamente supervisor).';
  COMMENT ON COLUMN tenant_shift_roles.can_handover IS
    'true: miembros con este rol participan en handovers entre turnos.';

  CREATE TRIGGER set_updated_at_tenant_shift_roles
    BEFORE UPDATE ON tenant_shift_roles
    FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

  -- ─── Runtime: production_shift_members ───────────────────────────────
  CREATE TABLE production_shift_members (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    shift_id    UUID         NOT NULL REFERENCES production_shifts(id) ON DELETE CASCADE,
    user_id     UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role_id     UUID         NOT NULL REFERENCES tenant_shift_roles(id) ON DELETE RESTRICT,
    joined_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    left_at     TIMESTAMPTZ  NULL,
    notes       TEXT         NULL,
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

    CONSTRAINT psm_left_after_joined CHECK (left_at IS NULL OR left_at >= joined_at)
  );

  CREATE INDEX psm_shift_active   ON production_shift_members (shift_id) WHERE left_at IS NULL;
  CREATE INDEX psm_shift_role     ON production_shift_members (shift_id, role_id);
  CREATE INDEX psm_user           ON production_shift_members (user_id);

  COMMENT ON TABLE production_shift_members IS
    'SaaS v2: miembros asignados a un turno con su rol. Soporta sustituciones via joined_at/left_at. Reemplaza operator_id/supervisor_id de production_shifts (que se mantienen por backward compat).';

  -- ─── Extender la función seed ────────────────────────────────────────
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
`

const down = `
  DROP TABLE IF EXISTS production_shift_members;

  DROP TRIGGER IF EXISTS set_updated_at_tenant_shift_roles ON tenant_shift_roles;
  DROP TABLE IF EXISTS tenant_shift_roles;
`

module.exports = { up, down }
