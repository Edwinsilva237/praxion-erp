'use strict'

/**
 * Motivo de la suspensión de un tenant.
 *
 *   - 'payment'  → suspendido por cobro vencido. El webhook de Stripe lo
 *                  reactiva automáticamente cuando la suscripción vuelve a
 *                  'active'.
 *   - 'manual'   → suspendido por decisión del platform admin (fraude,
 *                  contrato, etc.). Solo se reactiva manualmente desde el
 *                  panel.
 *   - NULL       → no suspendido (is_active = true).
 *
 * El check garantiza coherencia: si is_active = true, reason debe ser NULL;
 * si is_active = false, reason debe ser uno de los valores válidos.
 */

const up = `
  ALTER TABLE tenants
    ADD COLUMN IF NOT EXISTS suspended_reason VARCHAR(20),
    ADD COLUMN IF NOT EXISTS suspended_at     TIMESTAMPTZ;

  ALTER TABLE tenants
    DROP CONSTRAINT IF EXISTS tenants_suspended_reason_valid;
  ALTER TABLE tenants
    ADD CONSTRAINT tenants_suspended_reason_valid
    CHECK (
      (is_active = TRUE  AND suspended_reason IS NULL)
      OR
      (is_active = FALSE AND suspended_reason IN ('payment', 'manual'))
    );
`

const down = `
  ALTER TABLE tenants
    DROP CONSTRAINT IF EXISTS tenants_suspended_reason_valid;
  ALTER TABLE tenants
    DROP COLUMN IF EXISTS suspended_reason,
    DROP COLUMN IF EXISTS suspended_at;
`

module.exports = { up, down }
