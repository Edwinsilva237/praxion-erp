'use strict'

const up = `
  -- Datos fiscales del emisor (empresa) para CFDI 4.0
  CREATE TABLE tenant_fiscal_info (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id       UUID         NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    rfc             VARCHAR(13)  NOT NULL,
    razon_social    VARCHAR(300) NOT NULL,
    tax_regime      VARCHAR(3)   NOT NULL,
    zip_code        VARCHAR(5)   NOT NULL,
    serie_default   VARCHAR(10),
    folio_next      INTEGER      NOT NULL DEFAULT 1,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

    CONSTRAINT tfi_tenant_unique UNIQUE (tenant_id)
  );

  CREATE TRIGGER set_updated_at_tenant_fiscal_info
    BEFORE UPDATE ON tenant_fiscal_info
    FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

  COMMENT ON TABLE  tenant_fiscal_info           IS 'Datos fiscales del emisor para generación de CFDI 4.0';
  COMMENT ON COLUMN tenant_fiscal_info.tax_regime IS 'Régimen fiscal SAT: 601=General Ley, 603=Personas Morales, etc.';
  COMMENT ON COLUMN tenant_fiscal_info.zip_code   IS 'Código postal fiscal del lugar de expedición';
  COMMENT ON COLUMN tenant_fiscal_info.folio_next IS 'Folio autoincremental por tenant';

  -- Campos faltantes en products para CFDI 4.0
  ALTER TABLE products
    ADD COLUMN IF NOT EXISTS sat_product_code VARCHAR(8)  NOT NULL DEFAULT '10111402',
    ADD COLUMN IF NOT EXISTS sat_unit_code    VARCHAR(5)  NOT NULL DEFAULT 'H87',
    ADD COLUMN IF NOT EXISTS objeto_imp       VARCHAR(2)  NOT NULL DEFAULT '02';

  COMMENT ON COLUMN products.sat_product_code IS 'Clave producto/servicio SAT (c_ClaveProdServ)';
  COMMENT ON COLUMN products.sat_unit_code    IS 'Clave unidad SAT (c_ClaveUnidad): H87=Pieza, KGM=Kilogramo';
  COMMENT ON COLUMN products.objeto_imp       IS '01=No objeto de impuesto, 02=Sí objeto de impuesto';

  -- Campos faltantes en invoices para CFDI 4.0
  ALTER TABLE invoices
    ADD COLUMN IF NOT EXISTS exportacion      VARCHAR(2)  NOT NULL DEFAULT '01',
    ADD COLUMN IF NOT EXISTS lugar_expedicion VARCHAR(5),
    ADD COLUMN IF NOT EXISTS receptor_tax_regime VARCHAR(3),
    ADD COLUMN IF NOT EXISTS receptor_zip_code   VARCHAR(5);

  COMMENT ON COLUMN invoices.exportacion          IS '01=No aplica, 02=Definitiva, 03=Temporal';
  COMMENT ON COLUMN invoices.lugar_expedicion      IS 'CP del lugar de expedición — obligatorio CFDI 4.0';
  COMMENT ON COLUMN invoices.receptor_tax_regime   IS 'Régimen fiscal del receptor — obligatorio CFDI 4.0';
  COMMENT ON COLUMN invoices.receptor_zip_code     IS 'CP fiscal del receptor — obligatorio CFDI 4.0';

  -- Campos faltantes en invoice_lines para CFDI 4.0
  ALTER TABLE invoice_lines
    ADD COLUMN IF NOT EXISTS objeto_imp VARCHAR(2) NOT NULL DEFAULT '02';

  COMMENT ON COLUMN invoice_lines.objeto_imp IS '01=No objeto de impuesto, 02=Sí objeto de impuesto';

  -- tax_regime del receptor en business_partners si no existe
  ALTER TABLE business_partners
    ADD COLUMN IF NOT EXISTS tax_regime_code VARCHAR(3);

  COMMENT ON COLUMN business_partners.tax_regime_code IS 'Clave de régimen fiscal SAT: 601, 612, 626, etc.';
`

const down = `
  ALTER TABLE business_partners  DROP COLUMN IF EXISTS tax_regime_code;
  ALTER TABLE invoice_lines      DROP COLUMN IF EXISTS objeto_imp;
  ALTER TABLE invoices           DROP COLUMN IF EXISTS exportacion,
                                 DROP COLUMN IF EXISTS lugar_expedicion,
                                 DROP COLUMN IF EXISTS receptor_tax_regime,
                                 DROP COLUMN IF EXISTS receptor_zip_code;
  ALTER TABLE products           DROP COLUMN IF EXISTS sat_product_code,
                                 DROP COLUMN IF EXISTS sat_unit_code,
                                 DROP COLUMN IF EXISTS objeto_imp;
  DROP TRIGGER IF EXISTS set_updated_at_tenant_fiscal_info ON tenant_fiscal_info;
  DROP TABLE IF EXISTS tenant_fiscal_info CASCADE;
`

module.exports = { up, down }
