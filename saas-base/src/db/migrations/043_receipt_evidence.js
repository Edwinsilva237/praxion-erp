'use strict'

const up = `
  -- Evidencia adjunta a la recepción (foto o PDF del documento del proveedor)
  ALTER TABLE supplier_receipts
    ADD COLUMN IF NOT EXISTS evidence_path     VARCHAR(300),
    ADD COLUMN IF NOT EXISTS evidence_filename VARCHAR(200),
    ADD COLUMN IF NOT EXISTS evidence_mimetype VARCHAR(100);
`

const down = `
  ALTER TABLE supplier_receipts
    DROP COLUMN IF EXISTS evidence_path,
    DROP COLUMN IF EXISTS evidence_filename,
    DROP COLUMN IF EXISTS evidence_mimetype;
`

module.exports = { up, down }
