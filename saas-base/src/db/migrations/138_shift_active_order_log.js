'use strict'

/**
 * SaaS v2 — Migration 138: log de orden activa por turno + columnas de overhead en turnos.
 *
 * shift_active_order_log:
 *   Registra qué orden estuvo activa en cada tramo del turno. Permite al
 *   re-costeo identificar qué turnos produjeron qué órdenes, incluso cuando
 *   un turno produjo parcialmente para múltiples órdenes.
 *
 * Columnas adicionales en production_shifts:
 *   estimated_overhead_total  → suma de overhead estimado aplicado al turno (por applyOverheadToShift).
 *   real_overhead_total       → suma de overhead real tras re-costeo mensual.
 *   recosted_at               → timestamp del último re-costeo.
 *   recosted_by_user_id       → usuario que disparó el re-costeo.
 *
 * Referencia: docs/saas-v2/04-fase2-progress.md §Fase3.
 */

const up = `
  CREATE TABLE shift_active_order_log (
    id          UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    shift_id    UUID        NOT NULL REFERENCES production_shifts(id) ON DELETE CASCADE,
    order_id    UUID        NULL     REFERENCES production_orders(id) ON DELETE SET NULL,
    started_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ended_at    TIMESTAMPTZ NULL
  );

  CREATE INDEX idx_saol_shift_started ON shift_active_order_log (shift_id, started_at DESC);

  COMMENT ON TABLE shift_active_order_log IS
    'SaaS v2 §Fase3: log de la orden activa por tramo de turno. Permite re-costeo distribuido cuando un turno produce para múltiples órdenes.';

  -- Columnas overhead en production_shifts
  ALTER TABLE production_shifts
    ADD COLUMN IF NOT EXISTS estimated_overhead_total  NUMERIC(18,2) NULL,
    ADD COLUMN IF NOT EXISTS real_overhead_total       NUMERIC(18,2) NULL,
    ADD COLUMN IF NOT EXISTS recosted_at               TIMESTAMPTZ   NULL,
    ADD COLUMN IF NOT EXISTS recosted_by_user_id       UUID          NULL REFERENCES users(id) ON DELETE SET NULL;

  COMMENT ON COLUMN production_shifts.estimated_overhead_total IS
    'SaaS v2 §Fase3: suma del overhead estimado aplicado al turno al momento de su cierre.';
  COMMENT ON COLUMN production_shifts.real_overhead_total IS
    'SaaS v2 §Fase3: suma del overhead real recalculado tras el cierre del período mensual.';
  COMMENT ON COLUMN production_shifts.recosted_at IS
    'SaaS v2 §Fase3: timestamp del último re-costeo de overhead aplicado a este turno.';
`

const down = `
  ALTER TABLE production_shifts
    DROP COLUMN IF EXISTS recosted_by_user_id,
    DROP COLUMN IF EXISTS recosted_at,
    DROP COLUMN IF EXISTS real_overhead_total,
    DROP COLUMN IF EXISTS estimated_overhead_total;
  DROP TABLE IF EXISTS shift_active_order_log;
`

module.exports = { up, down }
