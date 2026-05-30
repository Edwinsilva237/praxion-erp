'use strict'

/**
 * Mig 177 — flag `enable_retentions` para mostrar retenciones (ISR/IVA) en
 * todas las modalidades de factura.
 *
 * Contexto (2026-05-30):
 *  Hasta hoy las retenciones solo se capturaban en la "factura ocasional".
 *  El motor (invoice_retentions, lineTax, XML, PDF, timbrado) ya las maneja de
 *  forma genérica, y el backend ahora acepta `retentions` también en factura
 *  directa y desde remisión. Pero la mayoría de tenants vende BIENES (que no
 *  llevan retención), así que mostrar el editor en todos lados ensuciaría la UI.
 *
 *  Este flag (opt-in, apagado por default) controla si el editor de retenciones
 *  aparece en las facturas directa y desde remisión. Tenants de SERVICIOS
 *  (honorarios, fletes, arrendamiento) lo prenden; los de bienes no ven nada
 *  nuevo. La factura ocasional sigue permitiendo retenciones siempre.
 */

const up = `
  ALTER TABLE tenant_process_config
    ADD COLUMN enable_retentions BOOLEAN NOT NULL DEFAULT false;

  COMMENT ON COLUMN tenant_process_config.enable_retentions IS
    'true: muestra el editor de retenciones (ISR/IVA) en factura directa y desde remision (para tenants de servicios). false (default): solo la factura ocasional permite retenciones.';
`

const down = `
  ALTER TABLE tenant_process_config DROP COLUMN IF EXISTS enable_retentions;
`

module.exports = { up, down }
