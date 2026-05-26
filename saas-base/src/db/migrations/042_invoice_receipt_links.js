'use strict'

const up = `
  -- Tabla de relación N:N entre facturas y recepciones
  CREATE TABLE IF NOT EXISTS invoice_receipt_links (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id           UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    supplier_invoice_id UUID NOT NULL REFERENCES supplier_invoices(id) ON DELETE CASCADE,
    supplier_receipt_id UUID NOT NULL REFERENCES supplier_receipts(id) ON DELETE CASCADE,
    amount_applied      DECIMAL(14,2) NOT NULL DEFAULT 0,
    notes               TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_invoice_receipt UNIQUE (supplier_invoice_id, supplier_receipt_id)
  );

  CREATE INDEX idx_irl_invoice  ON invoice_receipt_links (supplier_invoice_id);
  CREATE INDEX idx_irl_receipt  ON invoice_receipt_links (supplier_receipt_id);
  CREATE INDEX idx_irl_tenant   ON invoice_receipt_links (tenant_id);

  -- Agregar campos de conciliación a supplier_invoices
  ALTER TABLE supplier_invoices
    ADD COLUMN IF NOT EXISTS reconciliation_status VARCHAR(20) NOT NULL DEFAULT 'pending',
    ADD COLUMN IF NOT EXISTS reconciliation_diff   DECIMAL(14,2),
    ADD COLUMN IF NOT EXISTS xml_content           TEXT,
    ADD COLUMN IF NOT EXISTS xml_uuid              VARCHAR(50);

  COMMENT ON COLUMN supplier_invoices.reconciliation_status IS 'pending | reconciled | with_diff';
  COMMENT ON COLUMN supplier_invoices.reconciliation_diff   IS 'Diferencia total_factura - suma_recepciones (MXN)';
  COMMENT ON COLUMN supplier_invoices.xml_content           IS 'XML CFDI original en texto';
  COMMENT ON COLUMN supplier_invoices.xml_uuid              IS 'UUID SAT del timbre fiscal';

  -- Agregar campo a recepciones para saber si ya están facturadas
  ALTER TABLE supplier_receipts
    ADD COLUMN IF NOT EXISTS invoiced_at TIMESTAMPTZ;
`

const down = `
  DROP TABLE IF EXISTS invoice_receipt_links;
  ALTER TABLE supplier_invoices
    DROP COLUMN IF EXISTS reconciliation_status,
    DROP COLUMN IF EXISTS reconciliation_diff,
    DROP COLUMN IF EXISTS xml_content,
    DROP COLUMN IF EXISTS xml_uuid;
  ALTER TABLE supplier_receipts
    DROP COLUMN IF EXISTS invoiced_at;
`

module.exports = { up, down }
