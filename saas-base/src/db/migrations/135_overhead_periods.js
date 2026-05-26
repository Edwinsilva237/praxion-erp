'use strict'

/**
 * SaaS v2 — Migration 135: períodos de overhead por ítem.
 *
 * Un período liga un overhead_item a un rango de fechas y almacena tanto
 * el importe estimado (al abrir el período) como el real (al cerrar el mes).
 *
 * expected_basis_divisor: divisor estimado (p. ej. turnos previstos para el mes).
 * actual_basis_divisor:   divisor real calculado al finalizar el período
 *                         (suma de basis_value de todos los turnos del período).
 *
 * is_finalized: true = el período fue cerrado con importe real y los turnos
 *   del mes fueron re-costeados.
 *
 * Referencia: docs/saas-v2/04-fase2-progress.md §Fase3.
 */

const up = `
  CREATE TABLE tenant_overhead_periods (
    id                      UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id               UUID          NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    overhead_item_id        UUID          NOT NULL REFERENCES tenant_overhead_items(id) ON DELETE CASCADE,
    period_start            DATE          NOT NULL,
    period_end              DATE          NOT NULL,
    estimated_amount        NUMERIC(18,2) NOT NULL DEFAULT 0,
    real_amount             NUMERIC(18,2) NULL,
    expected_basis_divisor  NUMERIC(18,4) NULL,
    actual_basis_divisor    NUMERIC(18,4) NULL,
    is_finalized            BOOLEAN       NOT NULL DEFAULT false,
    finalized_at            TIMESTAMPTZ   NULL,
    finalized_by_user_id    UUID          NULL REFERENCES users(id) ON DELETE SET NULL,
    notes                   TEXT          NULL,
    created_at              TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

    CONSTRAINT top_dates_check     CHECK (period_end >= period_start),
    CONSTRAINT top_estimated_nonneg CHECK (estimated_amount >= 0),
    CONSTRAINT top_real_nonneg      CHECK (real_amount IS NULL OR real_amount >= 0),
    CONSTRAINT top_finalized_consistency CHECK (
      (is_finalized = false AND finalized_at IS NULL AND finalized_by_user_id IS NULL)
      OR (is_finalized = true AND finalized_at IS NOT NULL)
    )
  );

  CREATE INDEX idx_top_tenant_period ON tenant_overhead_periods
    (tenant_id, period_start, period_end, is_finalized);
  CREATE INDEX idx_top_item ON tenant_overhead_periods (overhead_item_id);

  CREATE TRIGGER set_updated_at_tenant_overhead_periods
    BEFORE UPDATE ON tenant_overhead_periods
    FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

  COMMENT ON TABLE tenant_overhead_periods IS
    'SaaS v2 §Fase3: períodos de overhead por ítem. Almacena estimado y real para distribución y re-costeo mensual.';
`

const down = `
  DROP TABLE IF EXISTS tenant_overhead_periods;
`

module.exports = { up, down }
