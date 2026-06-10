'use strict'

/**
 * Mig 202 — facturación PARCIAL de recepciones a nivel LÍNEA (producto).
 *
 * Hasta ahora una recepción se facturaba completa (1 recepción → 1 factura, o N
 * recepciones → 1 consolidada). Algunos proveedores facturan UNA recepción en
 * VARIAS facturas, una por producto/línea (línea completa). Para soportarlo
 * rastreamos qué factura cubre cada línea de la recepción:
 *
 *   supplier_receipt_lines.invoiced_by_invoice_id → supplier_invoices(id)
 *     NULL  = línea pendiente de facturar.
 *     <id>  = línea cubierta por esa factura/remisión (activa).
 *   Al CANCELAR la factura/remisión se vuelve a NULL (la línea re-abre).
 *
 * Una recepción está "totalmente facturada" (invoiced_at) cuando TODAS sus líneas
 * tienen invoiced_by_invoice_id de un documento activo. ON DELETE SET NULL para que
 * borrar una factura re-abra sus líneas sin romper la FK.
 */

const up = `
  ALTER TABLE supplier_receipt_lines
    ADD COLUMN IF NOT EXISTS invoiced_by_invoice_id UUID
      REFERENCES supplier_invoices(id) ON DELETE SET NULL;

  CREATE INDEX IF NOT EXISTS idx_srl_invoiced_by
    ON supplier_receipt_lines (invoiced_by_invoice_id);

  -- Backfill: las recepciones YA facturadas (invoiced_at) marcan todas sus líneas
  -- con la factura activa ligada (la más reciente no cancelada), para que el nuevo
  -- criterio "línea pendiente = invoiced_by IS NULL" sea consistente con el histórico.
  UPDATE supplier_receipt_lines srl
     SET invoiced_by_invoice_id = sub.si_id
    FROM (
      SELECT srl2.id AS line_id,
             (SELECT si.id
                FROM invoice_receipt_links irl
                JOIN supplier_invoices si ON si.id = irl.supplier_invoice_id
                                         AND si.status <> 'cancelled'
               WHERE irl.supplier_receipt_id = srl2.supplier_receipt_id
               ORDER BY si.created_at DESC LIMIT 1) AS si_id
        FROM supplier_receipt_lines srl2
        JOIN supplier_receipts sr ON sr.id = srl2.supplier_receipt_id
       WHERE sr.invoiced_at IS NOT NULL
    ) sub
   WHERE srl.id = sub.line_id
     AND sub.si_id IS NOT NULL
     AND srl.invoiced_by_invoice_id IS NULL;
`

const down = `
  DROP INDEX IF EXISTS idx_srl_invoiced_by;
  ALTER TABLE supplier_receipt_lines DROP COLUMN IF EXISTS invoiced_by_invoice_id;
`

module.exports = { up, down }
