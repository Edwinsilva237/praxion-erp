'use strict'

/**
 * Mig 225 — TABLA DE DÍAS DE VACACIONES POR ANTIGÜEDAD (configurable por tenant).
 *
 * Cada renglón es un RANGO de años de servicio → días que corresponden.
 * `years_to = NULL` = rango abierto (ese tope en adelante).
 *
 * NO se siembran renglones por tenant aquí. El motor (`vacationService`) usa una
 * tabla LFT 2023 por DEFAULT en código cuando el tenant no tiene renglones
 * propios; en cuanto el tenant guarda su tabla, sus renglones mandan. Así:
 *   - Tenants existentes y nuevos arrancan con LFT 2023 sin tocar el provisioning.
 *   - Un tenant que da MÁS que la ley personaliza y sus renglones sustituyen al default.
 *
 * Referencia LFT (reforma 2023, art. 76, vigente 01-ene-2023):
 *   año 1→12, 2→14, 3→16, 4→18, 5→20, 6-10→22, 11-15→24, 16-20→26,
 *   21-25→28, 26-30→30, 31-35→32 (y +2 por cada bloque de 5 años adicional).
 *
 * RLS: policy estándar de la mig 099.
 */

const up = `
  CREATE TABLE vacation_entitlement_rules (
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id     UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    years_from    SMALLINT    NOT NULL,
    years_to      SMALLINT,
    days_entitled SMALLINT    NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT ver_years_from_positive CHECK (years_from >= 1),
    CONSTRAINT ver_years_to_order      CHECK (years_to IS NULL OR years_to >= years_from),
    CONSTRAINT ver_days_nonneg         CHECK (days_entitled >= 0),
    CONSTRAINT ver_from_unique         UNIQUE (tenant_id, years_from)
  );

  CREATE INDEX idx_ver_tenant ON vacation_entitlement_rules (tenant_id, years_from);

  CREATE TRIGGER set_updated_at_vacation_entitlement_rules
    BEFORE UPDATE ON vacation_entitlement_rules
    FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

  ALTER TABLE vacation_entitlement_rules ENABLE ROW LEVEL SECURITY;
  ALTER TABLE vacation_entitlement_rules FORCE  ROW LEVEL SECURITY;
  CREATE POLICY rls_tenant ON vacation_entitlement_rules
    AS PERMISSIVE FOR ALL
    USING (NOT rls_enforce() OR tenant_id = current_tenant_id())
    WITH CHECK (NOT rls_enforce() OR tenant_id = current_tenant_id());

  COMMENT ON TABLE vacation_entitlement_rules IS
    'Días de vacaciones por rango de antigüedad, por tenant. Sin renglones = usa la tabla LFT 2023 por default (vacationService).';
`

const down = `
  DROP POLICY IF EXISTS rls_tenant ON vacation_entitlement_rules;
  DROP TRIGGER IF EXISTS set_updated_at_vacation_entitlement_rules ON vacation_entitlement_rules;
  DROP TABLE IF EXISTS vacation_entitlement_rules CASCADE;
`

module.exports = { up, down }
