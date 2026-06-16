'use strict'

/**
 * Mig 208 — Token de correo entrante por tenant (Fase 4 de Gastos, paso 1).
 *
 * Cada tenant recibe un token ALEATORIO (no el slug — para que la dirección no
 * sea adivinable) que rutea el correo de facturas al tenant correcto:
 *   <inbound_email_token>@inbox.praxionops.com
 *
 * El DEFAULT lo genera la BD → un tenant NUEVO obtiene su token solo, sin tocar
 * provisionTenant. Backfill a los existentes. UNIQUE para el lookup de ruteo.
 * Rotable (regenerar el token si la dirección recibe spam).
 */

const up = `
  ALTER TABLE tenants ADD COLUMN IF NOT EXISTS inbound_email_token VARCHAR(32);

  -- Backfill de los tenants ya existentes (16 hex = 64 bits aleatorios).
  UPDATE tenants
     SET inbound_email_token = substr(replace(gen_random_uuid()::text, '-', ''), 1, 16)
   WHERE inbound_email_token IS NULL;

  ALTER TABLE tenants
    ALTER COLUMN inbound_email_token
      SET DEFAULT substr(replace(gen_random_uuid()::text, '-', ''), 1, 16);
  ALTER TABLE tenants ALTER COLUMN inbound_email_token SET NOT NULL;

  CREATE UNIQUE INDEX IF NOT EXISTS tenants_inbound_token_uq
    ON tenants (inbound_email_token);

  COMMENT ON COLUMN tenants.inbound_email_token
    IS 'Token aleatorio para la dirección de correo entrante de facturas (<token>@inbox...). Rutea el CFDI recibido al tenant. Rotable.';
`

const down = `
  DROP INDEX IF EXISTS tenants_inbound_token_uq;
  ALTER TABLE tenants ALTER COLUMN inbound_email_token DROP DEFAULT;
  ALTER TABLE tenants DROP COLUMN IF EXISTS inbound_email_token;
`

module.exports = { up, down }
