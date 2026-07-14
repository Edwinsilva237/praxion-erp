'use strict'

/**
 * Mig 226 — PERIODOS VACACIONALES + LIBRO DE MOVIMIENTOS.
 *
 * `vacation_periods`: un renglón por (empleado, año-aniversario cumplido). El
 * derecho se genera POR AÑO CUMPLIDO (aniversario), no proporcional intra-año
 * (el proporcional/finiquito es de pre-nómina, fuera de alcance).
 *   - period_number  = k-ésimo año de servicio (1, 2, 3, …).
 *   - period_start   = ingreso + (k-1) años  (inicio del año de servicio ganado).
 *   - period_end     = ingreso + k años      (aniversario en que VENCEN/vestean).
 *   - days_entitled  = días de la tabla de antigüedad para el año k.
 *   - expires_at     = period_end + 18 meses (prescripción del disfrute, art. 78 LFT).
 *
 * `vacation_ledger`: movimientos que afectan el saldo de un periodo (patrón kardex).
 *   - taken      = días gozados (magnitud > 0; RESTA saldo).
 *   - paid       = días pagados sin gozar (magnitud > 0; RESTA saldo).
 *   - adjustment = ajuste manual (días con signo; SUMA saldo; +otorga, −descuenta).
 *   saldo(periodo) = days_entitled − Σ taken − Σ paid + Σ adjustment.
 *
 * RLS: policy estándar de la mig 099.
 */

const up = `
  DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'vacation_period_status') THEN
      CREATE TYPE vacation_period_status AS ENUM ('open', 'exhausted', 'expired', 'closed');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'vacation_ledger_type') THEN
      CREATE TYPE vacation_ledger_type AS ENUM ('taken', 'paid', 'adjustment');
    END IF;
  END $$;

  CREATE TABLE vacation_periods (
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id     UUID          NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    employee_id   UUID          NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    period_number SMALLINT      NOT NULL,
    period_start  DATE          NOT NULL,
    period_end    DATE          NOT NULL,
    days_entitled NUMERIC(6,2)  NOT NULL,
    expires_at    DATE          NOT NULL,
    status        vacation_period_status NOT NULL DEFAULT 'open',
    created_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

    CONSTRAINT vp_period_number_positive CHECK (period_number >= 1),
    CONSTRAINT vp_days_nonneg            CHECK (days_entitled >= 0),
    CONSTRAINT vp_period_order           CHECK (period_end > period_start),
    CONSTRAINT vp_unique_period          UNIQUE (employee_id, period_number)
  );

  CREATE INDEX idx_vp_tenant   ON vacation_periods (tenant_id);
  CREATE INDEX idx_vp_employee ON vacation_periods (employee_id, period_number);

  CREATE TRIGGER set_updated_at_vacation_periods
    BEFORE UPDATE ON vacation_periods
    FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

  ALTER TABLE vacation_periods ENABLE ROW LEVEL SECURITY;
  ALTER TABLE vacation_periods FORCE  ROW LEVEL SECURITY;
  CREATE POLICY rls_tenant ON vacation_periods
    AS PERMISSIVE FOR ALL
    USING (NOT rls_enforce() OR tenant_id = current_tenant_id())
    WITH CHECK (NOT rls_enforce() OR tenant_id = current_tenant_id());

  CREATE TABLE vacation_ledger (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id   UUID          NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    period_id   UUID          NOT NULL REFERENCES vacation_periods(id) ON DELETE CASCADE,
    employee_id UUID          NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    entry_type  vacation_ledger_type NOT NULL,
    days        NUMERIC(6,2)  NOT NULL,
    start_date  DATE,
    end_date    DATE,
    note        TEXT,
    created_by  UUID          REFERENCES users(id) ON DELETE SET NULL,
    created_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

    -- taken/paid siempre magnitud positiva; adjustment puede ser negativo pero nunca 0.
    CONSTRAINT vl_days_nonzero CHECK (days <> 0),
    CONSTRAINT vl_taken_paid_positive CHECK (entry_type = 'adjustment' OR days > 0),
    CONSTRAINT vl_date_order   CHECK (start_date IS NULL OR end_date IS NULL OR end_date >= start_date)
  );

  CREATE INDEX idx_vl_tenant   ON vacation_ledger (tenant_id);
  CREATE INDEX idx_vl_period   ON vacation_ledger (period_id);
  CREATE INDEX idx_vl_employee ON vacation_ledger (employee_id, created_at);

  ALTER TABLE vacation_ledger ENABLE ROW LEVEL SECURITY;
  ALTER TABLE vacation_ledger FORCE  ROW LEVEL SECURITY;
  CREATE POLICY rls_tenant ON vacation_ledger
    AS PERMISSIVE FOR ALL
    USING (NOT rls_enforce() OR tenant_id = current_tenant_id())
    WITH CHECK (NOT rls_enforce() OR tenant_id = current_tenant_id());

  COMMENT ON TABLE vacation_periods IS
    'Periodo vacacional por año de servicio cumplido. saldo = days_entitled − Σtaken − Σpaid + Σadjustment (vacation_ledger).';
  COMMENT ON TABLE vacation_ledger IS
    'Movimientos de un periodo vacacional. taken/paid restan; adjustment suma (con signo).';
`

const down = `
  DROP POLICY IF EXISTS rls_tenant ON vacation_ledger;
  DROP TABLE IF EXISTS vacation_ledger CASCADE;
  DROP POLICY IF EXISTS rls_tenant ON vacation_periods;
  DROP TRIGGER IF EXISTS set_updated_at_vacation_periods ON vacation_periods;
  DROP TABLE IF EXISTS vacation_periods CASCADE;
  DROP TYPE IF EXISTS vacation_ledger_type;
  DROP TYPE IF EXISTS vacation_period_status;
`

module.exports = { up, down }
