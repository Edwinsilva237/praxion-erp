'use strict'

/**
 * Mig 190 — liga estructural factura↔remisión para FACTURAS CONSOLIDADAS.
 *
 * Bug (reportado 2026-06-03): una factura consolidada (varias remisiones en una
 * sola factura) dejaba `invoices.delivery_note_id` en NULL y NO guardaba
 * `delivery_note_line_id` en sus líneas. El comentario del código prometía
 * trazabilidad "vía tabla invoice_remissions"… pero esa tabla NUNCA se creó.
 * Resultado: la lista y el detalle de remisiones quedaban CIEGOS a la factura
 * consolidada → la remisión aparecía como "Listo para facturar" / "Pendiente de
 * facturar" aunque YA estaba facturada. (Las facturadas individualmente sí
 * guardan delivery_note_id + delivery_note_line_id, por eso esas sí se veían bien.)
 *
 * Esta migración crea la tabla que el código siempre debió tener y RECONSTRUYE
 * las ligas de las consolidadas ya emitidas a partir del único rastro que quedó:
 * la nota del CXC de cada remisión, "[Consolidada en factura <folio>]".
 */

const up = `
  CREATE TABLE IF NOT EXISTS invoice_remissions (
    invoice_id       UUID NOT NULL REFERENCES invoices(id)       ON DELETE CASCADE,
    delivery_note_id UUID NOT NULL REFERENCES delivery_notes(id) ON DELETE CASCADE,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (invoice_id, delivery_note_id)
  );
  CREATE INDEX IF NOT EXISTS idx_invoice_remissions_dn ON invoice_remissions(delivery_note_id);
  CREATE INDEX IF NOT EXISTS idx_invoice_remissions_inv ON invoice_remissions(invoice_id);

  -- Backfill: cada remisión consolidada tiene su CXC (document_type='remission')
  -- con la nota "[Consolidada en factura <folio>]". De ahí reconstruimos la liga.
  -- Solo consideramos facturas consolidadas (delivery_note_id IS NULL) no canceladas.
  INSERT INTO invoice_remissions (invoice_id, delivery_note_id)
  SELECT DISTINCT iv.id, ar.document_id
    FROM accounts_receivable ar
    JOIN invoices iv
      ON iv.tenant_id = ar.tenant_id
     AND iv.document_number = (regexp_match(ar.notes, 'Consolidada en factura ([A-Za-z0-9_-]+)'))[1]
     AND iv.delivery_note_id IS NULL
     AND iv.status <> 'cancelled'
   WHERE ar.document_type = 'remission'
     AND ar.document_id IS NOT NULL
     AND ar.notes ~ 'Consolidada en factura '
  ON CONFLICT DO NOTHING;
`

const down = `
  DROP TABLE IF EXISTS invoice_remissions;
`

module.exports = { up, down }
