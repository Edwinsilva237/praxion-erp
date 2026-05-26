'use strict'

const up = `
  CREATE TYPE person_type AS ENUM ('moral', 'fisica');
  CREATE TYPE document_currency AS ENUM ('MXN', 'USD');

  -- Agregar campos a business_partners
  ALTER TABLE business_partners
    ADD COLUMN person_type person_type,
    ADD COLUMN internal_code VARCHAR(30);

  -- Inferir person_type desde RFC existente (12 chars = moral, 13 = fisica)
  UPDATE business_partners SET person_type =
    CASE WHEN LENGTH(COALESCE(rfc,'')) = 13 THEN 'fisica'::person_type
         ELSE 'moral'::person_type END;

  CREATE INDEX idx_bp_person_type ON business_partners (tenant_id, person_type);
  CREATE INDEX idx_bp_internal_code ON business_partners (tenant_id, internal_code);

  -- Domicilios de entrega por cliente
  CREATE TABLE delivery_addresses (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    business_partner_id UUID         NOT NULL REFERENCES business_partners(id) ON DELETE CASCADE,
    tenant_id           UUID         NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    alias               VARCHAR(100) NOT NULL,
    contact_name        VARCHAR(150),
    phone               VARCHAR(30),
    address             TEXT         NOT NULL,
    neighborhood        VARCHAR(150),
    city                VARCHAR(100) NOT NULL,
    state               VARCHAR(100) NOT NULL,
    zip_code            VARCHAR(10),
    freight_included    BOOLEAN      NOT NULL DEFAULT false,
    is_default          BOOLEAN      NOT NULL DEFAULT false,
    notes               TEXT,
    is_active           BOOLEAN      NOT NULL DEFAULT true,
    created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW()
  );

  CREATE INDEX idx_da_partner_id ON delivery_addresses (business_partner_id);
  CREATE INDEX idx_da_tenant_id  ON delivery_addresses (tenant_id);

  COMMENT ON COLUMN delivery_addresses.freight_included IS 'Si el flete está incluido en el precio de venta para este domicilio';
  COMMENT ON COLUMN delivery_addresses.alias            IS 'Nombre corto: Bodega principal, Planta Zamora, etc.';

  -- Precios negociados por cliente + producto
  CREATE TABLE customer_prices (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id           UUID         NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    business_partner_id UUID         NOT NULL REFERENCES business_partners(id) ON DELETE CASCADE,
    product_id          UUID         NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    currency            document_currency NOT NULL DEFAULT 'MXN',
    unit_price          DECIMAL(14,4) NOT NULL,
    valid_from          DATE         NOT NULL DEFAULT CURRENT_DATE,
    valid_until         DATE,
    notes               TEXT,
    created_by          UUID         REFERENCES users(id) ON DELETE SET NULL,
    created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

    CONSTRAINT cp_unique_active UNIQUE (tenant_id, business_partner_id, product_id, valid_from),
    CONSTRAINT cp_price_positive CHECK (unit_price > 0)
  );

  CREATE INDEX idx_cp_partner_product ON customer_prices (tenant_id, business_partner_id, product_id);
  CREATE INDEX idx_cp_valid_from      ON customer_prices (tenant_id, business_partner_id, valid_from DESC);

  COMMENT ON TABLE  customer_prices           IS 'Precios negociados por cliente y producto — con historial';
  COMMENT ON COLUMN customer_prices.currency  IS 'MXN o USD — aplica TC DOF al facturar en USD';
  COMMENT ON COLUMN customer_prices.valid_until IS 'NULL = vigente actualmente';

  -- Vista para obtener precio vigente por cliente + producto
  CREATE OR REPLACE VIEW current_customer_prices AS
    SELECT DISTINCT ON (tenant_id, business_partner_id, product_id)
      id, tenant_id, business_partner_id, product_id,
      currency, unit_price, valid_from, valid_until, notes
    FROM customer_prices
    WHERE valid_from <= CURRENT_DATE
      AND (valid_until IS NULL OR valid_until >= CURRENT_DATE)
    ORDER BY tenant_id, business_partner_id, product_id, valid_from DESC;

  -- Proveedores vinculados a materias primas
  CREATE TABLE supplier_materials (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id           UUID         NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    business_partner_id UUID         NOT NULL REFERENCES business_partners(id) ON DELETE CASCADE,
    raw_material_id     UUID         NOT NULL REFERENCES raw_materials(id) ON DELETE CASCADE,
    is_primary          BOOLEAN      NOT NULL DEFAULT false,
    last_price_per_kg   DECIMAL(12,4),
    currency            document_currency NOT NULL DEFAULT 'MXN',
    lead_time_days      INTEGER,
    notes               TEXT,
    created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

    CONSTRAINT sm_unique UNIQUE (tenant_id, business_partner_id, raw_material_id)
  );

  CREATE INDEX idx_sm_partner_id     ON supplier_materials (tenant_id, business_partner_id);
  CREATE INDEX idx_sm_raw_material   ON supplier_materials (tenant_id, raw_material_id);

  COMMENT ON COLUMN supplier_materials.is_primary       IS 'Proveedor principal para esta MP';
  COMMENT ON COLUMN supplier_materials.last_price_per_kg IS 'Último precio registrado — referencia para OC';
`

const down = `
  DROP VIEW  IF EXISTS current_customer_prices CASCADE;
  DROP TABLE IF EXISTS supplier_materials  CASCADE;
  DROP TABLE IF EXISTS customer_prices     CASCADE;
  DROP TABLE IF EXISTS delivery_addresses  CASCADE;
  ALTER TABLE business_partners DROP COLUMN IF EXISTS person_type;
  ALTER TABLE business_partners DROP COLUMN IF EXISTS internal_code;
  DROP TYPE  IF EXISTS document_currency CASCADE;
  DROP TYPE  IF EXISTS person_type       CASCADE;
`

module.exports = { up, down }
