'use strict'

const up = `
  CREATE TYPE partner_type AS ENUM ('customer', 'supplier', 'both');
  CREATE TYPE credit_type  AS ENUM ('cash', 'credit');

  CREATE TABLE business_partners (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id       UUID         NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    type            partner_type NOT NULL,
    name            VARCHAR(255) NOT NULL,
    rfc             VARCHAR(13),
    tax_name        VARCHAR(255),
    tax_regime      VARCHAR(100),
    credit_type     credit_type  NOT NULL DEFAULT 'cash',
    credit_days     INTEGER      NOT NULL DEFAULT 0,
    credit_limit    DECIMAL(14,2) DEFAULT 0,
    address         TEXT,
    city            VARCHAR(100),
    state           VARCHAR(100),
    zip_code        VARCHAR(10),
    notes           TEXT,
    is_active       BOOLEAN      NOT NULL DEFAULT true,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

    CONSTRAINT bp_rfc_tenant_unique UNIQUE (tenant_id, rfc),
    CONSTRAINT bp_credit_days_check CHECK (credit_days >= 0),
    CONSTRAINT bp_credit_limit_check CHECK (credit_limit >= 0)
  );

  CREATE INDEX idx_bp_tenant_id ON business_partners (tenant_id);
  CREATE INDEX idx_bp_type      ON business_partners (tenant_id, type);
  CREATE INDEX idx_bp_rfc       ON business_partners (tenant_id, rfc);

  COMMENT ON COLUMN business_partners.rfc        IS 'RFC del cliente/proveedor para facturación CFDI 4.0';
  COMMENT ON COLUMN business_partners.tax_name   IS 'Razón social para factura';
  COMMENT ON COLUMN business_partners.tax_regime IS 'Régimen fiscal SAT';

  CREATE TRIGGER set_updated_at_business_partners
    BEFORE UPDATE ON business_partners
    FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

  -- Contactos por socio de negocio
  CREATE TABLE business_partner_contacts (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    business_partner_id UUID         NOT NULL REFERENCES business_partners(id) ON DELETE CASCADE,
    name                VARCHAR(150) NOT NULL,
    position            VARCHAR(100),
    email               VARCHAR(255),
    phone               VARCHAR(30),
    is_primary          BOOLEAN      NOT NULL DEFAULT false,
    created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW()
  );

  CREATE INDEX idx_bpc_partner_id ON business_partner_contacts (business_partner_id);
`

const down = `
  DROP TRIGGER IF EXISTS set_updated_at_business_partners ON business_partners;
  DROP TABLE IF EXISTS business_partner_contacts CASCADE;
  DROP TABLE IF EXISTS business_partners         CASCADE;
  DROP TYPE  IF EXISTS credit_type               CASCADE;
  DROP TYPE  IF EXISTS partner_type              CASCADE;
`

module.exports = { up, down }
