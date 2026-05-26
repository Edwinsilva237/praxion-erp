'use strict'

/**
 * Restringe a UN solo profile fiscal por tenant.
 *
 * Decisión de producto: el ERP completo es por empresa. Cada tenant tiene
 * exactamente UN RFC. Si más adelante se necesita multi-empresa, se modela
 * como multi-TENANT (cada empresa su propio tenant), no como multi-RFC
 * dentro de un mismo tenant — porque producción, inventario, costos, etc.
 * son operación interna que NO debe mezclarse entre razones sociales.
 *
 * También removemos el concepto de `is_default` (con uno solo no aplica).
 */

const up = `
  -- Si por accidente hay >1 profile por tenant (datos de prueba),
  -- conservamos solo el primero creado.
  DELETE FROM tenant_fiscal_profiles tfp1
   USING tenant_fiscal_profiles tfp2
   WHERE tfp1.tenant_id = tfp2.tenant_id
     AND tfp1.created_at > tfp2.created_at;

  -- Constraint: solo un profile por tenant.
  DROP INDEX IF EXISTS idx_tfp_one_default;
  DROP INDEX IF EXISTS idx_tfp_rfc_per_tenant;

  ALTER TABLE tenant_fiscal_profiles
    DROP COLUMN IF EXISTS is_default;

  ALTER TABLE tenant_fiscal_profiles
    ADD CONSTRAINT tfp_one_per_tenant UNIQUE (tenant_id);
`

const down = `
  ALTER TABLE tenant_fiscal_profiles
    DROP CONSTRAINT IF EXISTS tfp_one_per_tenant;

  ALTER TABLE tenant_fiscal_profiles
    ADD COLUMN is_default BOOLEAN NOT NULL DEFAULT FALSE;

  CREATE UNIQUE INDEX idx_tfp_one_default ON tenant_fiscal_profiles (tenant_id)
    WHERE is_default = TRUE;
  CREATE UNIQUE INDEX idx_tfp_rfc_per_tenant ON tenant_fiscal_profiles (tenant_id, rfc);
`

module.exports = { up, down }
