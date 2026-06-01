'use strict'

/**
 * Mig 183 — Forma de pago en facturas/gastos de proveedor.
 *
 * El módulo de GASTOS (mig 182) registra el gasto pero no guardaba con qué se
 * paga (efectivo / transferencia / cheque). Esa "forma de pago" es útil tanto
 * para flujo de caja como para deducibilidad SAT (gastos > $2,000 deben pagarse
 * por medio bancarizado para ser deducibles).
 *
 * Reusamos el enum `ap_payment_method` (mig 030: transfer/cash/check) que ya
 * maneja el módulo de pagos a proveedor, para que el vocabulario sea el mismo en
 * toda la cadena de CXP. La columna es NULL por default → cero impacto en las
 * facturas de mercancía existentes; la usa el formulario de gasto.
 *
 * Cuando el usuario marca "ya lo pagué" al registrar el gasto, la ruta
 * /purchases/expenses encadena registerPayment con esta misma forma de pago, de
 * modo que el gasto queda liquidado (no como "Por pagar").
 */

const up = `
  ALTER TABLE supplier_invoices
    ADD COLUMN IF NOT EXISTS payment_method ap_payment_method NULL;

  COMMENT ON COLUMN supplier_invoices.payment_method IS
    'Forma de pago del gasto (efectivo/transferencia/cheque). NULL para mercancía.';
`

const down = `
  ALTER TABLE supplier_invoices DROP COLUMN IF EXISTS payment_method;
`

module.exports = { up, down }
