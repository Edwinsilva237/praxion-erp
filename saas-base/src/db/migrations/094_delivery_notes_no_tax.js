'use strict'

/**
 * Remisiones (delivery_notes) NO llevan IVA.
 *
 * Misma decisión de producto que la migración 093 (pedidos sin IVA).
 *
 * Las remisiones son documentos pre-fiscales — entrega física de mercancía.
 * El IVA se agrega cuando se emite el CFDI (`invoiceService.createFromRemissions`
 * recalcula tax = subtotal * 0.16 desde las líneas, no depende de delivery_notes.tax_mxn).
 *
 * Convención B2B asumida: "precio + IVA" — el cliente paga el IVA al recibir
 * el CFDI, no al recibir la remisión. Si la empresa cobra contra remisión
 * antes de facturar, necesita cobrar adicionalmente el IVA al emitir el CFDI.
 *
 * Esta migración:
 *   - Reescribe tax_mxn = 0 y total_mxn = subtotal_mxn en remisiones existentes.
 *   - Recalcula el AR-remisión (accounts_receivable type='remission') al
 *     subtotal, salvo aquellas que ya estén pagadas (no las tocamos para no
 *     romper el balance histórico).
 */

const up = `
  -- Pasar remisiones a sin IVA
  UPDATE delivery_notes
     SET tax_mxn   = 0,
         total_mxn = subtotal_mxn;

  -- Ajustar AR-remisión donde aún no se haya pagado nada.
  -- Las AR-remisión ya parcial/totalmente pagadas se respetan: rebalancearlas
  -- automáticamente puede generar diferencias contables. Si hace falta
  -- ajustarlas manualmente, hacerlo desde el panel de CXC.
  UPDATE accounts_receivable ar
     SET amount_total = dn.subtotal_mxn
    FROM delivery_notes dn
   WHERE ar.document_type = 'remission'
     AND ar.document_id   = dn.id
     AND COALESCE(ar.amount_paid, 0) = 0;
`

const down = `
  UPDATE delivery_notes
     SET tax_mxn   = subtotal_mxn * 0.16,
         total_mxn = subtotal_mxn * 1.16;

  UPDATE accounts_receivable ar
     SET amount_total = dn.total_mxn
    FROM delivery_notes dn
   WHERE ar.document_type = 'remission'
     AND ar.document_id   = dn.id
     AND COALESCE(ar.amount_paid, 0) = 0;
`

module.exports = { up, down }
