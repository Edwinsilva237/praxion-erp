'use strict'

/**
 * Asocia `gh-insumos-sandbox` a la MISMA organization de Facturapi que tiene
 * `gh-insumos-prod`, en lugar de crear una organization separada con el mismo
 * RFC (lo cual sería redundante).
 *
 * Por qué:
 *   - El mismo emisor real (Edwin Silva persona física) opera ambos tenants.
 *   - Sandbox es solo para pruebas operativas del ERP, no requiere una
 *     organization aislada en Facturapi.
 *   - Como `gh-insumos-sandbox.is_sandbox = true`, el código de
 *     `facturapiClient.js:69` resuelve automáticamente la `_test` key sin
 *     importar si la `_live` está configurada — aislamiento garantizado
 *     a nivel de modo TEST vs LIVE de la misma org.
 *
 * Operación:
 *   1. Si gh-insumos-prod no tiene profile activo con orgId → no-op.
 *   2. Si gh-insumos-sandbox ya tiene profile activo apuntando al mismo
 *      orgId → no-op (idempotente).
 *   3. Cualquier otro profile activo del sandbox se desactiva (queda como
 *      histórico para auditoría).
 *   4. Inserta un profile nuevo en sandbox replicando los datos del prod:
 *      rfc, tax_name, tax_regime, zip_code, facturapi_organization_id y
 *      facturapi_api_key_test. La live key queda NULL en sandbox.
 *   5. Crea la serie default 'A' para invoice del nuevo profile.
 *
 * Bajada (down): desactiva el profile que esta mig insertó. Los datos de
 * la organization Facturapi no se borran de la BD, solo se "olvidan" en
 * el sandbox.
 */

const up = `
  DO $$
  DECLARE
    sandbox_tenant_id UUID;
    new_profile_id    UUID;
    prod_org_id       VARCHAR;
    prod_api_key_test TEXT;
    prod_rfc          VARCHAR;
    prod_tax_name     VARCHAR;
    prod_tax_regime   VARCHAR;
    prod_zip_code     VARCHAR;
  BEGIN
    SELECT id INTO sandbox_tenant_id
      FROM tenants
     WHERE slug = 'gh-insumos-sandbox';

    IF sandbox_tenant_id IS NULL THEN
      RAISE NOTICE 'gh-insumos-sandbox no existe — skip mig 154';
      RETURN;
    END IF;

    SELECT tfp.facturapi_organization_id, tfp.facturapi_api_key_test,
           tfp.rfc, tfp.tax_name, tfp.tax_regime, tfp.zip_code
      INTO prod_org_id, prod_api_key_test,
           prod_rfc, prod_tax_name, prod_tax_regime, prod_zip_code
      FROM tenants t
      JOIN tenant_fiscal_profiles tfp ON tfp.tenant_id = t.id
     WHERE t.slug = 'gh-insumos-prod'
       AND tfp.is_active = TRUE
       AND tfp.facturapi_organization_id IS NOT NULL
     LIMIT 1;

    IF prod_org_id IS NULL THEN
      RAISE NOTICE 'gh-insumos-prod sin profile activo con orgId — skip mig 154';
      RETURN;
    END IF;

    -- Idempotencia: si sandbox ya tiene profile activo apuntando al mismo
    -- orgId, no hace nada.
    IF EXISTS (
      SELECT 1 FROM tenant_fiscal_profiles
       WHERE tenant_id = sandbox_tenant_id
         AND facturapi_organization_id = prod_org_id
         AND is_active = TRUE
    ) THEN
      RAISE NOTICE 'gh-insumos-sandbox ya comparte orgId — skip mig 154';
      RETURN;
    END IF;

    -- Desactiva cualquier profile activo previo del sandbox (queda como
    -- histórico, las facturas demo viejas que lo referencien siguen
    -- resolviendo datos legales).
    UPDATE tenant_fiscal_profiles
       SET is_active = FALSE,
           notes = COALESCE(notes, '') ||
             CASE WHEN notes IS NULL OR notes = '' THEN '' ELSE E'\\n' END ||
             '[' || to_char(NOW(), 'YYYY-MM-DD') || '] Desactivado por mig 154 — sandbox ahora comparte org con prod.'
     WHERE tenant_id = sandbox_tenant_id
       AND is_active = TRUE;

    -- Inserta profile nuevo replicando los datos del prod.
    INSERT INTO tenant_fiscal_profiles (
      tenant_id, rfc, tax_name, tax_regime, zip_code,
      facturapi_organization_id, facturapi_api_key_test,
      is_active, notes
    ) VALUES (
      sandbox_tenant_id, prod_rfc, prod_tax_name, prod_tax_regime, prod_zip_code,
      prod_org_id, prod_api_key_test,
      TRUE,
      'Comparte la organization en Facturapi con gh-insumos-prod. Como is_sandbox=TRUE, el ERP usa la TEST key automáticamente. Auto-creado por mig 154.'
    )
    RETURNING id INTO new_profile_id;

    -- Serie default 'A' para invoices (espejo del flow de createProfile).
    INSERT INTO tenant_document_series (
      tenant_id, entity_type, fiscal_profile_id, serie, folio_next,
      is_default, is_active, notes
    ) VALUES (
      sandbox_tenant_id, 'invoice', new_profile_id, 'A', 1,
      TRUE, TRUE, 'Serie creada automáticamente por mig 154.'
    )
    ON CONFLICT DO NOTHING;
  END $$;
`

const down = `
  UPDATE tenant_fiscal_profiles tfp
     SET is_active = FALSE
   WHERE tfp.tenant_id = (SELECT id FROM tenants WHERE slug = 'gh-insumos-sandbox')
     AND tfp.notes LIKE '%Auto-creado por mig 154%';
`

module.exports = { up, down }
