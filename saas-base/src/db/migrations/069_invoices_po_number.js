'use strict'

/**
 * Agrega `po_number` a invoices.
 *
 * Hasta ahora la OC del cliente solo vivía en `sales_orders.po_number` y
 * `delivery_notes.po_number`. Las facturas no la replicaban, así que en el
 * CFDI o en cualquier reporte basado en `invoices` no se podía consultar
 * la OC referenciada.
 *
 * Caso de uso: a veces el cliente entrega su OC después de generar el
 * pedido y la remisión, justo al pedir la factura. Tener el campo en
 * invoices permite capturarla en ese momento (manual o heredada del
 * documento origen).
 */

const up = `
  ALTER TABLE invoices
    ADD COLUMN IF NOT EXISTS po_number VARCHAR(100);

  COMMENT ON COLUMN invoices.po_number IS 'Número de OC del cliente al que se factura. Heredado del pedido/remisión origen o capturado en el momento de facturar.';
`

const down = `
  ALTER TABLE invoices DROP COLUMN IF EXISTS po_number;
`

module.exports = { up, down }
