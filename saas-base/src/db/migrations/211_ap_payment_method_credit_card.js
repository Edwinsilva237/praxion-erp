'use strict'

/**
 * Agrega 'credit_card' (Tarjeta de crédito) al enum `ap_payment_method`.
 *
 * Es la forma de pago a proveedor para compras de contado pagadas con tarjeta.
 * El enum (mig 030) ya tenía cash/transfer/check (+ advance_application/credit_note
 * de migs posteriores). Lo usan supplier_payments.method y supplier_invoices.payment_method.
 *
 * Patrón idéntico a la mig 088 (advance_application): ADD VALUE solo AGREGA el valor
 * (no lo usa en la misma transacción), por eso es seguro dentro del BEGIN/COMMIT del
 * runner en PG12+.
 */

const up = `
  ALTER TYPE ap_payment_method ADD VALUE IF NOT EXISTS 'credit_card';
`

const down = `
  -- PG no permite quitar valores de un enum; 'credit_card' queda en el tipo.
`

module.exports = { up, down }
