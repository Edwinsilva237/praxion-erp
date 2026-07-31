'use strict'

/**
 * Mig 240 — devoluciones a proveedor: REPOSICIÓN EN ESPECIE.
 *
 * Caso real (2026-07-30): el proveedor no emite nota de crédito ni cancela el
 * CFDI — repone el material defectuoso con material bueno. La devolución se
 * marca "espera reposición" y queda visible como documento pendiente; la
 * reposición se recibe en Recepciones eligiendo la DEVOLUCIÓN (en lugar de una
 * OC), lo que liga ambos documentos para trazabilidad/auditoría:
 *   recepción de reposición → devolución → lote/recepción/factura originales.
 *
 * - supplier_returns.replacement_expected: el proveedor repondrá el material.
 * - supplier_returns.replacement_completed_at: cuándo quedó cubierta.
 * - supplier_return_lines.quantity_replaced: avance de reposición por línea.
 * - supplier_receipts.replacement_return_id: la recepción ES una reposición
 *   de esa devolución (no genera CxP ni espera factura: la factura vigente es
 *   la original).
 * - Enum supplier_return_fiscal_resolution gana 'replacement' (la devolución
 *   se resuelve sin tocar la CxP). ADD VALUE no se usa en esta misma
 *   transacción (mismo patrón que mig 230).
 */

const up = `
  ALTER TYPE supplier_return_fiscal_resolution ADD VALUE IF NOT EXISTS 'replacement';

  ALTER TABLE supplier_returns
    ADD COLUMN IF NOT EXISTS replacement_expected BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS replacement_completed_at TIMESTAMPTZ;

  COMMENT ON COLUMN supplier_returns.replacement_expected IS 'El proveedor repondrá el material (reposición en especie): la devolución queda pendiente hasta recibir la reposición en Recepciones.';

  ALTER TABLE supplier_return_lines
    ADD COLUMN IF NOT EXISTS quantity_replaced NUMERIC(14,4) NOT NULL DEFAULT 0;

  ALTER TABLE supplier_receipts
    ADD COLUMN IF NOT EXISTS replacement_return_id UUID REFERENCES supplier_returns(id);

  CREATE INDEX IF NOT EXISTS idx_supplier_receipts_replacement_return
    ON supplier_receipts (replacement_return_id)
    WHERE replacement_return_id IS NOT NULL;
`

const down = `
  DROP INDEX IF EXISTS idx_supplier_receipts_replacement_return;
  ALTER TABLE supplier_receipts DROP COLUMN IF EXISTS replacement_return_id;
  ALTER TABLE supplier_return_lines DROP COLUMN IF EXISTS quantity_replaced;
  ALTER TABLE supplier_returns DROP COLUMN IF EXISTS replacement_completed_at;
  ALTER TABLE supplier_returns DROP COLUMN IF EXISTS replacement_expected;
`

module.exports = { up, down }
