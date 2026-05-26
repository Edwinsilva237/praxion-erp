'use strict'

const up = `
  ALTER TABLE supplier_receipts
    ADD COLUMN IF NOT EXISTS document_type   VARCHAR(50),
    ADD COLUMN IF NOT EXISTS document_number VARCHAR(100);
`

const down = `
  ALTER TABLE supplier_receipts
    DROP COLUMN IF EXISTS document_type,
    DROP COLUMN IF EXISTS document_number;
`

module.exports = { up, down }
