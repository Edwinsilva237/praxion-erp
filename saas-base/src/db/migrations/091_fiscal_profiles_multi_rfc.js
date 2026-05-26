'use strict'

/**
 * Soporte multi-RFC por tenant.
 *
 * ANTES: `tenant_fiscal_info` es 1-a-1 con tenant. Un tenant solo puede tener
 * un emisor fiscal (RFC). Esto no cubre casos reales:
 *   - Empresa con varias razones sociales (PFAE + S.A. de C.V.)
 *   - Grupo empresarial con varios RFCs operando bajo el mismo software
 *
 * AHORA: cada tenant puede tener N `fiscal_profiles`. Cada profile:
 *   - Tiene su propio RFC, razón social, régimen, CP, serie de folios.
 *   - Está vinculado a una `organization` en Facturapi (cada organization
 *     tiene su propia API key live/test y CSD subido).
 *   - Uno está marcado como `is_default` para sugerirlo al emitir factura.
 *
 * Las facturas nuevas guardan `fiscal_profile_id` para saber desde qué RFC
 * se emitieron. Las viejas (legacy, sin profile) siguen funcionando contra
 * el fallback de `tenant_fiscal_info` o el default profile.
 *
 * NO migramos los datos de `tenant_fiscal_info` automáticamente — el usuario
 * decidió que las facturas existentes son de prueba.
 */

const up = `
  CREATE TABLE tenant_fiscal_profiles (
    id                          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id                   UUID         NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    -- Datos fiscales del emisor
    rfc                         VARCHAR(13)  NOT NULL,
    tax_name                    VARCHAR(300) NOT NULL,    -- Razón social (CFDI)
    tax_regime                  VARCHAR(3)   NOT NULL,    -- 601, 612, 626, etc.
    zip_code                    VARCHAR(5)   NOT NULL,    -- Lugar de expedición
    -- Serie y folios
    serie                       VARCHAR(10),              -- "A", "B", "FAC", etc.
    folio_next                  INTEGER      NOT NULL DEFAULT 1,
    -- Integración Facturapi
    facturapi_organization_id   VARCHAR(50),              -- id de la org en Facturapi
    facturapi_api_key_live      VARCHAR(120),             -- sk_user_xxx (producción)
    facturapi_api_key_test      VARCHAR(120),             -- sk_test_xxx (pruebas)
    facturapi_certificate_status VARCHAR(20),             -- 'none' | 'uploaded' | 'verified' | 'expired'
    facturapi_certificate_expires_at DATE,                -- Fecha de expiración del CSD
    -- Metadatos
    is_default                  BOOLEAN      NOT NULL DEFAULT FALSE,
    is_active                   BOOLEAN      NOT NULL DEFAULT TRUE,
    notes                       TEXT,
    created_by                  UUID         REFERENCES users(id) ON DELETE SET NULL,
    created_at                  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at                  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

    CONSTRAINT tfp_rfc_format CHECK (rfc ~ '^[A-Z&Ñ]{3,4}[0-9]{6}[A-Z0-9]{3}$'),
    CONSTRAINT tfp_zip_format CHECK (zip_code ~ '^[0-9]{5}$')
  );

  -- Solo un default por tenant
  CREATE UNIQUE INDEX idx_tfp_one_default ON tenant_fiscal_profiles (tenant_id)
    WHERE is_default = TRUE;
  CREATE UNIQUE INDEX idx_tfp_rfc_per_tenant ON tenant_fiscal_profiles (tenant_id, rfc);
  CREATE INDEX idx_tfp_tenant_active ON tenant_fiscal_profiles (tenant_id, is_active);

  CREATE TRIGGER set_updated_at_tenant_fiscal_profiles
    BEFORE UPDATE ON tenant_fiscal_profiles
    FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

  COMMENT ON TABLE  tenant_fiscal_profiles IS
    'Emisores fiscales (RFCs) de un tenant. Multi-RFC: 1 tenant → N profiles.';
  COMMENT ON COLUMN tenant_fiscal_profiles.facturapi_api_key_live IS
    'Key de Facturapi para producción. Se usa cuando is_sandbox=false del tenant.';
  COMMENT ON COLUMN tenant_fiscal_profiles.facturapi_api_key_test IS
    'Key de Facturapi para pruebas. Se usa cuando is_sandbox=true del tenant.';

  -- FK opcional en invoices (NULL = factura legacy contra tenant_fiscal_info)
  ALTER TABLE invoices
    ADD COLUMN fiscal_profile_id UUID
    REFERENCES tenant_fiscal_profiles(id) ON DELETE SET NULL;

  CREATE INDEX idx_inv_fiscal_profile ON invoices (fiscal_profile_id)
    WHERE fiscal_profile_id IS NOT NULL;
`

const down = `
  ALTER TABLE invoices DROP COLUMN IF EXISTS fiscal_profile_id;
  DROP TRIGGER IF EXISTS set_updated_at_tenant_fiscal_profiles ON tenant_fiscal_profiles;
  DROP TABLE IF EXISTS tenant_fiscal_profiles CASCADE;
`

module.exports = { up, down }
