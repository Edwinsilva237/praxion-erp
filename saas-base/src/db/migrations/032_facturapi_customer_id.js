'use strict'

const up = `
  ALTER TABLE business_partners
    ADD COLUMN IF NOT EXISTS facturapi_id VARCHAR(50);

  COMMENT ON COLUMN business_partners.facturapi_id IS 'ID del cliente en Facturapi para timbrado CFDI';
`

const down = `
  ALTER TABLE business_partners DROP COLUMN IF EXISTS facturapi_id;
`

module.exports = { up, down }
