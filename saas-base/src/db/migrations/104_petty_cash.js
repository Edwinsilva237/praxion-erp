'use strict'

/**
 * Caja chica — multi-fondos.
 *
 * - `petty_cash_funds`: una caja por sucursal/depto/responsable.
 * - `petty_cash_categories`: catálogo configurable por tenant, separado en
 *   entradas (reabastecimiento) y salidas (gastos).
 * - `petty_cash_movements`: movimientos atómicos con kind in/out, monto,
 *   categoría opcional, descripción y status. Cancelación con motivo
 *   (no hay edición — solo cancelar y volver a capturar).
 *
 * Los comprobantes (fotos de tickets) usan la tabla genérica `attachments`
 * con entity_type='petty_cash_movement'. No necesitamos columna directa.
 */

const up = `
  CREATE TYPE petty_cash_movement_kind   AS ENUM ('in', 'out');
  CREATE TYPE petty_cash_movement_status AS ENUM ('active', 'cancelled');

  -- ── Fondos (cajas) ─────────────────────────────────────────────────────
  CREATE TABLE petty_cash_funds (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id           UUID         NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name                VARCHAR(100) NOT NULL,
    location            VARCHAR(150),
    responsible_user_id UUID         REFERENCES users(id) ON DELETE SET NULL,
    initial_balance     DECIMAL(14,2) NOT NULL DEFAULT 0,
    is_active           BOOLEAN      NOT NULL DEFAULT true,
    notes               TEXT,
    created_by          UUID         REFERENCES users(id) ON DELETE SET NULL,
    created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

    CONSTRAINT pcf_name_tenant_unique UNIQUE (tenant_id, name),
    CONSTRAINT pcf_initial_non_negative CHECK (initial_balance >= 0)
  );

  CREATE INDEX idx_pcf_tenant_id ON petty_cash_funds (tenant_id);
  CREATE INDEX idx_pcf_active    ON petty_cash_funds (tenant_id, is_active);

  CREATE TRIGGER set_updated_at_petty_cash_funds
    BEFORE UPDATE ON petty_cash_funds
    FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

  COMMENT ON COLUMN petty_cash_funds.initial_balance IS
    'Saldo inicial al crear la caja. El saldo actual se calcula como initial + entradas - salidas (movimientos active).';

  -- ── Categorías (configurables por tenant) ─────────────────────────────
  CREATE TABLE petty_cash_categories (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id   UUID         NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name        VARCHAR(80)  NOT NULL,
    kind        petty_cash_movement_kind NOT NULL,
    is_active   BOOLEAN      NOT NULL DEFAULT true,
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

    CONSTRAINT pcc_name_unique UNIQUE (tenant_id, kind, name)
  );

  CREATE INDEX idx_pcc_tenant_id ON petty_cash_categories (tenant_id);
  CREATE INDEX idx_pcc_kind      ON petty_cash_categories (tenant_id, kind, is_active);

  -- ── Movimientos ────────────────────────────────────────────────────────
  CREATE TABLE petty_cash_movements (
    id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id        UUID                NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    fund_id          UUID                NOT NULL REFERENCES petty_cash_funds(id),
    kind             petty_cash_movement_kind NOT NULL,
    amount           DECIMAL(14,2)       NOT NULL,
    category_id      UUID                REFERENCES petty_cash_categories(id) ON DELETE SET NULL,
    description      TEXT,
    occurred_at      DATE                NOT NULL DEFAULT CURRENT_DATE,
    status           petty_cash_movement_status NOT NULL DEFAULT 'active',
    cancelled_reason TEXT,
    cancelled_by     UUID                REFERENCES users(id) ON DELETE SET NULL,
    cancelled_at     TIMESTAMPTZ,
    created_by       UUID                REFERENCES users(id) ON DELETE SET NULL,
    created_at       TIMESTAMPTZ         NOT NULL DEFAULT NOW(),

    CONSTRAINT pcm_amount_positive CHECK (amount > 0),
    CONSTRAINT pcm_cancelled_has_reason CHECK (
      status = 'active' OR cancelled_reason IS NOT NULL
    )
  );

  CREATE INDEX idx_pcm_tenant_id   ON petty_cash_movements (tenant_id);
  CREATE INDEX idx_pcm_fund        ON petty_cash_movements (tenant_id, fund_id);
  CREATE INDEX idx_pcm_occurred    ON petty_cash_movements (tenant_id, occurred_at DESC);
  CREATE INDEX idx_pcm_status      ON petty_cash_movements (tenant_id, status);

  COMMENT ON COLUMN petty_cash_movements.amount IS
    'Monto siempre positivo. La direccion la indica kind (in/out).';
  COMMENT ON COLUMN petty_cash_movements.status IS
    'Cancelar (no editar). Movimientos cancelled NO afectan el saldo del fondo.';

  -- Permisos del recurso 'petty_cash'
  INSERT INTO permissions (resource, action, description) VALUES
    ('petty_cash', 'read',   'Ver movimientos y saldo de caja chica'),
    ('petty_cash', 'create', 'Capturar movimientos de entrada/salida'),
    ('petty_cash', 'cancel', 'Cancelar movimientos con motivo'),
    ('petty_cash', 'manage', 'Crear/editar fondos y categorias')
  ON CONFLICT (resource, action) DO NOTHING;

  -- Asignar los permisos nuevos al rol super_admin global (si existe).
  -- Sin este paso, el super_admin se queda sin acceso a la feature recien
  -- creada hasta que un admin los marque manualmente en la pantalla de roles.
  INSERT INTO role_permissions (role_id, permission_id)
  SELECT r.id, p.id
    FROM roles r
    CROSS JOIN permissions p
   WHERE r.name = 'super_admin'
     AND p.resource = 'petty_cash'
     AND NOT EXISTS (
       SELECT 1 FROM role_permissions rp
        WHERE rp.role_id = r.id AND rp.permission_id = p.id
     );
`

const down = `
  DELETE FROM permissions WHERE resource = 'petty_cash';
  DROP TRIGGER IF EXISTS set_updated_at_petty_cash_funds ON petty_cash_funds;
  DROP TABLE IF EXISTS petty_cash_movements  CASCADE;
  DROP TABLE IF EXISTS petty_cash_categories CASCADE;
  DROP TABLE IF EXISTS petty_cash_funds      CASCADE;
  DROP TYPE  IF EXISTS petty_cash_movement_status CASCADE;
  DROP TYPE  IF EXISTS petty_cash_movement_kind   CASCADE;
`

module.exports = { up, down }
