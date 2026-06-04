'use strict'

/**
 * Mig 192 — Backfill: CXC de facturas de UNA remisión que quedaron SIN IVA.
 *
 * Bug corregido en `invoiceService.createFromRemission` (path full-coverage): al
 * facturar UNA sola remisión, el AR-remisión se migraba a tipo 'invoice' pero
 * CONSERVABA su `amount_total = subtotal` — las remisiones no llevan IVA
 * (deliveryNoteService: `tax_mxn = 0, total_mxn = subtotal`). Resultado: Cuentas
 * por cobrar / pagos recibidos mostraban el monto SIN IVA de esas ventas facturadas.
 *
 * Este backfill corrige las CXC ya existentes: para cada AR tipo 'invoice' ligado a
 * una factura de UNA remisión (`invoices.delivery_note_id IS NOT NULL`), pone
 * `amount_total = invoices.total_mxn` (el total CON IVA). Solo toca las descuadradas
 * (idempotente). NO toca `amount_paid`. NO toca facturas DIRECTAS ni CONSOLIDADAS
 * (delivery_note_id NULL), que ya nacían con IVA correcto.
 */

const up = `
  UPDATE accounts_receivable ar
     SET amount_total = inv.total_mxn
    FROM invoices inv
   WHERE ar.document_type = 'invoice'
     AND ar.document_id   = inv.id
     AND ar.tenant_id     = inv.tenant_id
     AND inv.delivery_note_id IS NOT NULL          -- factura de UNA remisión (path afectado)
     AND inv.status <> 'cancelled'
     AND ar.status  <> 'cancelled'
     AND ABS(ar.amount_total - inv.total_mxn) > 0.01;  -- solo las que no cuadran
`

// Irreversible por diseño: no guardamos el monto previo (sin IVA), y revertir
// re-introduciría el bug. El down es no-op.
const down = `
  -- no-op (ver comentario arriba)
`

module.exports = { up, down }
