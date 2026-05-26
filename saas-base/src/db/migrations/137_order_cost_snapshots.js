'use strict'

/**
 * SaaS v2 — Migration 137: snapshots de costo por orden de producción.
 *
 * Guarda dos versiones del costo de cada orden:
 *   estimated  → calculado al cierre del último turno de la orden.
 *   recosted   → recalculado tras la finalización del período de overhead.
 *
 * Los campos de costo siguen la estructura del cálculo de costeo:
 *   mp_cost                 → costo de materia prima.
 *   packaging_cost          → costo de empaque/embalaje.
 *   overhead_cost           → overhead total imputado a la orden.
 *   scrap_recovery_value    → valor de recuperación de merma (reduce costo neto).
 *   nrv_value_lower_grades  → NRV de calidades inferiores (reduce costo de cal-1).
 *   total_cost_to_grade_1   → costo neto final asignado a calidad 1.
 *   units_grade_1           → unidades de calidad 1 producidas.
 *   unit_cost_grade_1       → costo unitario calidad 1 = total_cost / units.
 *
 * Referencia: docs/saas-v2/04-fase2-progress.md §Fase3.
 */

const up = `
  CREATE TABLE order_cost_snapshots (
    id                    UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
    order_id              UUID          NOT NULL REFERENCES production_orders(id) ON DELETE CASCADE,
    snapshot_type         VARCHAR(20)   NOT NULL,
    mp_cost               NUMERIC(18,2) NOT NULL DEFAULT 0,
    packaging_cost        NUMERIC(18,2) NOT NULL DEFAULT 0,
    overhead_cost         NUMERIC(18,2) NOT NULL DEFAULT 0,
    scrap_recovery_value  NUMERIC(18,2) NOT NULL DEFAULT 0,
    nrv_value_lower_grades NUMERIC(18,2) NOT NULL DEFAULT 0,
    total_cost_to_grade_1 NUMERIC(18,2) NOT NULL DEFAULT 0,
    units_grade_1         NUMERIC(18,6) NOT NULL DEFAULT 0,
    unit_cost_grade_1     NUMERIC(18,6) NOT NULL DEFAULT 0,
    notes                 TEXT          NULL,
    created_at            TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

    CONSTRAINT ocs_snapshot_type_check CHECK (snapshot_type IN ('estimated','recosted')),
    UNIQUE (order_id, snapshot_type)
  );

  CREATE INDEX idx_ocs_order ON order_cost_snapshots (order_id);

  COMMENT ON TABLE order_cost_snapshots IS
    'SaaS v2 §Fase3: snapshots de costo de órdenes de producción (estimated y recosted). Permite comparar costo estimado vs real tras re-costeo mensual.';
`

const down = `
  DROP TABLE IF EXISTS order_cost_snapshots;
`

module.exports = { up, down }
