'use strict'

/**
 * SaaS v2 — Migration 136: aplicación de overhead a turnos.
 *
 * Registra cuánto overhead estimado (y real, tras re-costeo) se imputa
 * a cada turno por cada ítem de overhead del período activo.
 *
 * basis_value: la cantidad de la base de imputación que aporta este turno
 *   (p. ej. 1 si allocation_base='shifts', horas si='hours', kg si='weight').
 *
 * estimated_amount: overhead estimado = (period.estimated_amount / expected_basis_divisor) × basis_value.
 * real_amount:      overhead real =     (period.real_amount      / actual_basis_divisor)   × basis_value.
 *                   Calculado al finalizar el período (re-costeo).
 *
 * is_recosted: true cuando el real_amount fue calculado y actualizado.
 *
 * Referencia: docs/saas-v2/04-fase2-progress.md §Fase3.
 */

const up = `
  CREATE TABLE shift_overhead_application (
    id               UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
    shift_id         UUID          NOT NULL REFERENCES production_shifts(id) ON DELETE CASCADE,
    overhead_item_id UUID          NOT NULL REFERENCES tenant_overhead_items(id) ON DELETE CASCADE,
    period_id        UUID          NOT NULL REFERENCES tenant_overhead_periods(id) ON DELETE CASCADE,
    basis_value      NUMERIC(18,4) NOT NULL DEFAULT 0,
    estimated_amount NUMERIC(18,2) NULL,
    real_amount      NUMERIC(18,2) NULL,
    is_recosted      BOOLEAN       NOT NULL DEFAULT false,
    created_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

    UNIQUE (shift_id, overhead_item_id)
  );

  CREATE INDEX idx_soa_shift   ON shift_overhead_application (shift_id);
  CREATE INDEX idx_soa_period  ON shift_overhead_application (period_id);

  CREATE TRIGGER set_updated_at_shift_overhead_application
    BEFORE UPDATE ON shift_overhead_application
    FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

  COMMENT ON TABLE shift_overhead_application IS
    'SaaS v2 §Fase3: distribución de overhead a turnos de producción. Una fila por (turno, ítem). Contiene importe estimado al cierre y real tras re-costeo mensual.';
`

const down = `
  DROP TABLE IF EXISTS shift_overhead_application;
`

module.exports = { up, down }
