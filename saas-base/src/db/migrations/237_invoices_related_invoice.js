'use strict'

/**
 * Mig 237 — vínculo explícito nota de crédito → factura origen.
 *
 * Contexto (2026-07-28): las notas de crédito (invoices con cfdi_type='E') solo
 * se ligaban a su factura por CONVENCIÓN de folio: document_number LIKE
 * 'NC-{folio_factura}%'. Al darles su propia serie fiscal (p. ej. "NC-0001")
 * esa convención se rompe y el detalle de la factura dejaría de listar sus NC.
 *
 *  - `related_invoice_id` = la factura a la que la NC aplica (misma relación
 *    que el CFDI declara en related_documents tipo '01').
 *
 * Backfill en 2 pasos:
 *  1. NCs emitidas desde una devolución de venta → sales_returns ya guarda
 *     ambos lados (credit_note_invoice_id + source_invoice_id).
 *  2. NCs legacy con folio 'NC-{factura}' o 'NC-{factura}-NN' → se resuelve la
 *     factura por document_number dentro del mismo tenant.
 */

const up = `
  ALTER TABLE invoices
    ADD COLUMN IF NOT EXISTS related_invoice_id UUID REFERENCES invoices(id) ON DELETE SET NULL;

  COMMENT ON COLUMN invoices.related_invoice_id IS 'Solo NC (cfdi_type=E): factura a la que aplica esta nota de crédito (relación SAT 01).';

  CREATE INDEX IF NOT EXISTS idx_invoices_related_invoice
    ON invoices (tenant_id, related_invoice_id) WHERE related_invoice_id IS NOT NULL;

  -- Backfill 1: NCs emitidas desde devoluciones de venta.
  UPDATE invoices cn
     SET related_invoice_id = sr.source_invoice_id
    FROM sales_returns sr
   WHERE sr.credit_note_invoice_id = cn.id
     AND sr.tenant_id = cn.tenant_id
     AND cn.related_invoice_id IS NULL
     AND sr.source_invoice_id IS NOT NULL;

  -- Backfill 2: NCs legacy por convención de folio NC-{factura}[-NN].
  UPDATE invoices cn
     SET related_invoice_id = o.id
    FROM invoices o
   WHERE cn.cfdi_type = 'E'
     AND cn.related_invoice_id IS NULL
     AND o.tenant_id = cn.tenant_id
     AND o.cfdi_type <> 'E'
     AND cn.document_number LIKE 'NC-%'
     AND (
           cn.document_number = 'NC-' || o.document_number
        OR cn.document_number ~ ('^NC-' || o.document_number || '-[0-9]+$')
     );
`

const down = `
  ALTER TABLE invoices DROP COLUMN IF EXISTS related_invoice_id;
`

module.exports = { up, down }
