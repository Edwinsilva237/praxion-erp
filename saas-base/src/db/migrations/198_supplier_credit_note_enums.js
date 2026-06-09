'use strict'

/**
 * Mig 198 — Devoluciones a proveedor (Fase 2: resolución fiscal). Solo enums.
 *
 * Agrega los valores de enum que la resolución fiscal usa en runtime:
 *   - supplier_invoice_type += 'credit_note'  → la NOTA DE CRÉDITO (CFDI de egreso
 *     recibido) se guarda como un supplier_invoices con type='credit_note' (sin AP
 *     propio: NO se factura/paga, solo reduce la CXP original o genera saldo a favor).
 *   - ap_payment_method     += 'credit_note'  → el "pago" no-efectivo que aplica la
 *     nota de crédito contra la factura original se registra como supplier_payment
 *     con method='credit_note' (espejo de 'advance_application'). Se EXCLUYE del IVA
 *     acreditable al-cobro (financialSnapshot) para no doble-contar el IVA.
 *
 * Patrón idéntico a la mig 196: migración DEDICADA a enums. En PostgreSQL 12+
 * `ALTER TYPE ... ADD VALUE` corre dentro de la transacción siempre que el valor
 * nuevo NO se USE en la misma migración (aquí solo se agrega; el uso es en runtime).
 * `IF NOT EXISTS` la hace idempotente.
 *
 * NOTA: `ar_document_type` y `payment_method` (mig 024) ya incluyen 'credit_note',
 * por eso no se tocan.
 */

const up = `
  ALTER TYPE supplier_invoice_type ADD VALUE IF NOT EXISTS 'credit_note';
  ALTER TYPE ap_payment_method     ADD VALUE IF NOT EXISTS 'credit_note';
`

// Postgres no permite quitar valores de un enum; el down es no-op.
const down = `
  -- irreversible: Postgres no soporta DROP VALUE en un enum.
`

module.exports = { up, down }
