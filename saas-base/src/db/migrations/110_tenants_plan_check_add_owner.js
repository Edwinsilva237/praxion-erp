'use strict'

/**
 * Extiende el check constraint `tenants.plan` para aceptar 'owner'.
 *
 * La migration 098 introdujo el plan 'owner' (interno, sin cobro) pero no
 * actualizó el CHECK constraint definido en 002_tenants.js, que sigue
 * permitiendo solo ('free', 'starter', 'pro', 'enterprise'). Por eso al
 * intentar crear un tenant con plan='owner' falla con:
 *   "new row for relation tenants violates check constraint tenants_plan_check"
 *
 * Esta migration corrige la omisión sin tocar el resto del schema.
 */

const up = `
  ALTER TABLE tenants
    DROP CONSTRAINT IF EXISTS tenants_plan_check;

  ALTER TABLE tenants
    ADD CONSTRAINT tenants_plan_check
    CHECK (plan IN ('free', 'starter', 'pro', 'enterprise', 'owner'));
`

const down = `
  ALTER TABLE tenants
    DROP CONSTRAINT IF EXISTS tenants_plan_check;

  ALTER TABLE tenants
    ADD CONSTRAINT tenants_plan_check
    CHECK (plan IN ('free', 'starter', 'pro', 'enterprise'));
`

module.exports = { up, down }
