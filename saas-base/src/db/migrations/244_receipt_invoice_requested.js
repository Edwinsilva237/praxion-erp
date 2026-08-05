'use strict'

/**
 * Mig 244 — "Solicitar factura" desde Recepciones.
 *
 * Espejo del flujo de Gastos (supplier_invoices.invoice_requested_at): una
 * recepción confirmada sin CFDI puede pedirle la factura al proveedor por
 * correo. Aquí solo persistimos la marca de cuándo se solicitó, para mostrar
 * "Factura solicitada el ..." y permitir re-solicitar.
 *
 * SIN permiso nuevo (reusa purchases:create, el mismo del botón de CXP
 * sin factura) → SIN re-login.
 */

const up = `
  ALTER TABLE supplier_receipts
    ADD COLUMN IF NOT EXISTS invoice_requested_at TIMESTAMPTZ;

  COMMENT ON COLUMN supplier_receipts.invoice_requested_at IS
    'Última vez que se pidió por correo al proveedor la factura de esta recepción';
`

const down = `
  ALTER TABLE supplier_receipts
    DROP COLUMN IF EXISTS invoice_requested_at;
`

module.exports = { up, down }
