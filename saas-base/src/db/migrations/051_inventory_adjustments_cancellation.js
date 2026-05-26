'use strict'

/**
 * Soporte de cancelación para documentos de ajuste.
 *
 * Estrategia:
 *   - Agregamos `status` ('active' | 'cancelled') a la cabecera.
 *   - Al cancelar, generamos movimientos contrarios en `inventory_movements`
 *     con reference_type='inventory_adjustment_reversal' y reference_id
 *     apuntando al ajuste original. NO se borra ni se modifica el original.
 *   - Esto da trazabilidad total: en el kardex se ven los movimientos
 *     originales y los de reversión, ambos vinculados al mismo documento.
 */
const up = `
  ALTER TABLE inventory_adjustments
    ADD COLUMN status              VARCHAR(20)  NOT NULL DEFAULT 'active',
    ADD COLUMN cancelled_at        TIMESTAMPTZ,
    ADD COLUMN cancelled_by        UUID REFERENCES users(id) ON DELETE SET NULL,
    ADD COLUMN cancellation_reason TEXT,
    ADD CONSTRAINT ia_status_valid CHECK (status IN ('active','cancelled'));

  CREATE INDEX idx_ia_status ON inventory_adjustments (tenant_id, status);

  COMMENT ON COLUMN inventory_adjustments.status
    IS 'active = aplicado al inventario, cancelled = anulado con reversión automática.';
  COMMENT ON COLUMN inventory_adjustments.cancellation_reason
    IS 'Razón de la cancelación, capturada por el supervisor que la efectuó.';
`

const down = `
  ALTER TABLE inventory_adjustments
    DROP CONSTRAINT IF EXISTS ia_status_valid;
  DROP INDEX IF EXISTS idx_ia_status;
  ALTER TABLE inventory_adjustments
    DROP COLUMN IF EXISTS status,
    DROP COLUMN IF EXISTS cancelled_at,
    DROP COLUMN IF EXISTS cancelled_by,
    DROP COLUMN IF EXISTS cancellation_reason;
`

module.exports = { up, down }
