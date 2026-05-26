'use strict'

const up = `
  CREATE TYPE scrap_cause AS ENUM (
    'startup',
    'equipment_failure',
    'out_of_tolerance',
    'material_change',
    'other'
  );

  CREATE TYPE scrap_lot_status AS ENUM (
    'in_quarantine',
    'processing',
    'decided'
  );

  CREATE TYPE scrap_decision AS ENUM (
    'regrind',
    'disposal',
    'sale',
    'controlled_mix'
  );

  CREATE TABLE scrap_lots (
    id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id         UUID            NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    shift_id          UUID            REFERENCES production_shifts(id) ON DELETE SET NULL,
    resin_type        resin_type      NOT NULL,
    cause             scrap_cause     NOT NULL,
    estimated_weight_kg DECIMAL(10,4) NOT NULL,
    real_weight_kg    DECIMAL(10,4),
    status            scrap_lot_status NOT NULL DEFAULT 'in_quarantine',
    notes             TEXT,
    declared_by       UUID            REFERENCES users(id) ON DELETE SET NULL,
    processed_at      TIMESTAMPTZ,
    processed_by      UUID            REFERENCES users(id) ON DELETE SET NULL,
    created_at        TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ     NOT NULL DEFAULT NOW(),

    CONSTRAINT sl_weight_positive CHECK (estimated_weight_kg > 0)
  );

  CREATE INDEX idx_sl_tenant_id   ON scrap_lots (tenant_id);
  CREATE INDEX idx_sl_shift_id    ON scrap_lots (shift_id);
  CREATE INDEX idx_sl_resin_type  ON scrap_lots (tenant_id, resin_type);
  CREATE INDEX idx_sl_status      ON scrap_lots (tenant_id, status);

  CREATE TRIGGER set_updated_at_scrap_lots
    BEFORE UPDATE ON scrap_lots
    FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

  CREATE TABLE scrap_decisions (
    id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    scrap_lot_id      UUID           NOT NULL REFERENCES scrap_lots(id) ON DELETE CASCADE UNIQUE,
    decision          scrap_decision NOT NULL,
    contaminated      BOOLEAN        NOT NULL DEFAULT false,
    blend_pct         DECIMAL(5,2),
    target_lot_id     UUID           REFERENCES production_orders(id) ON DELETE SET NULL,
    authorized_by     UUID           REFERENCES users(id) ON DELETE SET NULL,
    authorized_at     TIMESTAMPTZ,
    notes             TEXT,
    decided_by        UUID           REFERENCES users(id) ON DELETE SET NULL,
    decided_at        TIMESTAMPTZ    NOT NULL DEFAULT NOW(),

    CONSTRAINT sd_controlled_mix_requires_auth CHECK (
      decision != 'controlled_mix' OR authorized_by IS NOT NULL
    ),
    CONSTRAINT sd_blend_pct_range CHECK (
      blend_pct IS NULL OR blend_pct BETWEEN 0 AND 100
    )
  );

  CREATE INDEX idx_sd_scrap_lot_id ON scrap_decisions (scrap_lot_id);
  CREATE INDEX idx_sd_decision     ON scrap_decisions (decision);

  COMMENT ON COLUMN scrap_decisions.authorized_by IS 'Solo gerente puede autorizar controlled_mix — validado por constraint';
  COMMENT ON COLUMN scrap_decisions.target_lot_id IS 'Orden de producción destino cuando decision = controlled_mix';
`

const down = `
  DROP TRIGGER IF EXISTS set_updated_at_scrap_lots ON scrap_lots;
  DROP TABLE IF EXISTS scrap_decisions  CASCADE;
  DROP TABLE IF EXISTS scrap_lots       CASCADE;
  DROP TYPE  IF EXISTS scrap_decision   CASCADE;
  DROP TYPE  IF EXISTS scrap_lot_status CASCADE;
  DROP TYPE  IF EXISTS scrap_cause      CASCADE;
`

module.exports = { up, down }
