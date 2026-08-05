'use strict'

/**
 * Mig 242 — Solicitar REP al proveedor desde Pagos emitidos.
 *
 * `supplier_payments.rep_requested_at`: cuándo se le pidió por correo al
 * proveedor el complemento de pago (REP) faltante o su corrección (cuando el
 * recibido no cuadra con el pago). Mismo patrón que
 * `supplier_invoices.invoice_requested_at` (solicitar factura de un gasto).
 */

const up = `
  ALTER TABLE supplier_payments
    ADD COLUMN IF NOT EXISTS rep_requested_at TIMESTAMPTZ;
`

const down = `
  ALTER TABLE supplier_payments
    DROP COLUMN IF EXISTS rep_requested_at;
`

module.exports = { up, down }
