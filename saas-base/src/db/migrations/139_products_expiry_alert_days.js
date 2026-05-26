'use strict'

/**
 * SaaS v2 — Migration 139: expiry_alert_days por producto.
 *
 * Agrega products.expiry_alert_days (INTEGER NULL) para que tenants con
 * vida útil muy corta (pastelería: 2-3 días) puedan configurar umbrales de
 * alerta granulares sin afectar el umbral global del tenant.
 *
 * Lógica de prioridad en getExpiringLots:
 *   1. Si products.expiry_alert_days IS NOT NULL → usar ese valor.
 *   2. Si NULL → usar tenant_process_config.expiry_alert_days.
 *   3. Si tampoco → 30 días default.
 *
 * Referencia: §7.7 (Fase 5 Pastelería).
 */

const up = `
  ALTER TABLE products
    ADD COLUMN IF NOT EXISTS expiry_alert_days INTEGER NULL
    CONSTRAINT products_expiry_alert_days_positive
      CHECK (expiry_alert_days IS NULL OR expiry_alert_days > 0);

  COMMENT ON COLUMN products.expiry_alert_days IS
    'SaaS v2 §4.9: umbral de alerta de caducidad en días, específico por producto. Override del valor global tenant_process_config.expiry_alert_days. NULL = hereda global.';
`

const down = `
  ALTER TABLE products
    DROP CONSTRAINT IF EXISTS products_expiry_alert_days_positive,
    DROP COLUMN IF EXISTS expiry_alert_days;
`

module.exports = { up, down }
