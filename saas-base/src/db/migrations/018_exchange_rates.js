'use strict'

const up = `
  CREATE TYPE exchange_rate_source AS ENUM ('dof_auto', 'manual');

  CREATE TABLE exchange_rates (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id       UUID         NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    rate_date       DATE         NOT NULL,
    currency        VARCHAR(3)   NOT NULL DEFAULT 'USD',
    rate_mxn        DECIMAL(12,6) NOT NULL,
    source          exchange_rate_source NOT NULL DEFAULT 'dof_auto',
    override_by     UUID         REFERENCES users(id) ON DELETE SET NULL,
    override_reason TEXT,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

    CONSTRAINT er_unique_date_currency UNIQUE (tenant_id, rate_date, currency),
    CONSTRAINT er_rate_positive CHECK (rate_mxn > 0)
  );

  CREATE INDEX idx_er_tenant_date ON exchange_rates (tenant_id, rate_date DESC);
  CREATE INDEX idx_er_currency    ON exchange_rates (tenant_id, currency, rate_date DESC);

  COMMENT ON TABLE  exchange_rates              IS 'Histórico de tipos de cambio DOF por tenant — consultado al facturar en USD';
  COMMENT ON COLUMN exchange_rates.source       IS 'dof_auto = consultado automáticamente de Banxico, manual = sobrescrito por usuario';
  COMMENT ON COLUMN exchange_rates.override_by  IS 'Solo se llena cuando source = manual — auditoría de quién sobrescribió';

  -- Función para obtener el TC vigente más reciente para una fecha dada
  CREATE OR REPLACE FUNCTION get_exchange_rate(p_tenant_id UUID, p_date DATE, p_currency VARCHAR DEFAULT 'USD')
  RETURNS DECIMAL AS $$
    SELECT rate_mxn FROM exchange_rates
    WHERE tenant_id = p_tenant_id
      AND currency  = p_currency
      AND rate_date <= p_date
    ORDER BY rate_date DESC
    LIMIT 1;
  $$ LANGUAGE SQL STABLE;

  COMMENT ON FUNCTION get_exchange_rate IS 'Retorna el TC más reciente disponible para la fecha dada — usar al timbrar CFDI';
`

const down = `
  DROP FUNCTION IF EXISTS get_exchange_rate CASCADE;
  DROP TABLE IF EXISTS exchange_rates CASCADE;
  DROP TYPE  IF EXISTS exchange_rate_source CASCADE;
`

module.exports = { up, down }
