'use strict'

/**
 * Mig 209 — Dirección de correo entrante LEGIBLE: <slug>.<código6>@inbox...
 *
 * La mig 208 usaba un token 100% aleatorio (16 hex) → la dirección parecía spam
 * y el proveedor no la reconocía. Decisión del usuario: anteponer el nombre de
 * la empresa (slug) + un código corto de 6 hex. El código corto sigue evitando
 * la ENUMERACIÓN (nadie adivina la dirección probando slugs) y deja el
 * interruptor de apagado: si se filtra, se ROTA (botón "Generar dirección nueva").
 *
 * El valor de `inbound_email_token` ES el local-part completo (`<slug>.<código>`)
 * → el ruteo por match exacto NO cambia; solo cambia cómo se genera.
 *
 * - Ensancha la columna (slug largo + '.' + 6 hex puede pasar de 32).
 * - Quita el DEFAULT aleatorio (ahora el token incorpora el slug → trigger).
 * - Trigger BEFORE INSERT: tenant nuevo obtiene <slug>.<6hex> solo (sin tocar
 *   provisionTenant, que inserta sin el token).
 * - Regenera los tokens existentes al formato legible.
 */

const up = `
  ALTER TABLE tenants ALTER COLUMN inbound_email_token TYPE VARCHAR(64);
  ALTER TABLE tenants ALTER COLUMN inbound_email_token DROP DEFAULT;

  CREATE OR REPLACE FUNCTION set_inbound_email_token() RETURNS trigger AS $fn$
  BEGIN
    IF NEW.inbound_email_token IS NULL THEN
      NEW.inbound_email_token :=
        regexp_replace(lower(NEW.slug), '[^a-z0-9_-]', '', 'g')
        || '.' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 6);
    END IF;
    RETURN NEW;
  END;
  $fn$ LANGUAGE plpgsql;

  DROP TRIGGER IF EXISTS trg_set_inbound_email_token ON tenants;
  CREATE TRIGGER trg_set_inbound_email_token
    BEFORE INSERT ON tenants
    FOR EACH ROW EXECUTE FUNCTION set_inbound_email_token();

  -- Regenerar los tokens ya existentes al nuevo formato legible <slug>.<6hex>.
  -- (Aún no se ha distribuido ninguna dirección → cambiarlas ahora es seguro.)
  UPDATE tenants
     SET inbound_email_token =
       regexp_replace(lower(slug), '[^a-z0-9_-]', '', 'g')
       || '.' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 6);

  COMMENT ON COLUMN tenants.inbound_email_token
    IS 'Dirección de correo entrante de facturas (local-part): <slug>.<código6>@inbox... El código corto evita enumeración; rotable si se filtra.';
`

const down = `
  DROP TRIGGER IF EXISTS trg_set_inbound_email_token ON tenants;
  DROP FUNCTION IF EXISTS set_inbound_email_token();
  -- Se deja VARCHAR(64) (ensanchar es inocuo; estrechar truncaría tokens largos).
  ALTER TABLE tenants
    ALTER COLUMN inbound_email_token
      SET DEFAULT substr(replace(gen_random_uuid()::text, '-', ''), 1, 16);
`

module.exports = { up, down }
