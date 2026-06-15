'use strict'

/**
 * Mig 206 — Solicitar factura al proveedor (módulo de Gastos).
 *
 * Marca de tiempo de la última vez que se le solicitó al proveedor el CFDI de un
 * gasto registrado sin factura. Permite mostrar "Factura solicitada el …" y no
 * re-spamear. Aditiva, NULL por default → cero impacto en lo existente.
 */

const up = `
  ALTER TABLE supplier_invoices
    ADD COLUMN invoice_requested_at TIMESTAMPTZ NULL;

  COMMENT ON COLUMN supplier_invoices.invoice_requested_at IS
    'Gastos: fecha en que se solicitó por correo el CFDI al proveedor (gasto sin factura). NULL = no solicitado.';
`

const down = `
  ALTER TABLE supplier_invoices DROP COLUMN IF EXISTS invoice_requested_at;
`

module.exports = { up, down }
