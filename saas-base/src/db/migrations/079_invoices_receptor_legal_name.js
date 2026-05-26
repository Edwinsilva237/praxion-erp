'use strict'

/**
 * Agrega `receptor_legal_name` a invoices.
 *
 * Override opcional de la razón social del receptor a nivel factura. Permite
 * editar la razón social desde el panel del borrador sin tocar el catálogo
 * de clientes (`business_partners.tax_name`). Útil cuando un cliente pide
 * una variación menor de su razón social para una factura específica, o
 * cuando el `tax_name` global está pendiente de corregir.
 *
 * Al timbrar y al renderizar el PDF se usa:
 *   COALESCE(invoices.receptor_legal_name, business_partners.tax_name,
 *            business_partners.name)
 */

const up = `
  ALTER TABLE invoices
    ADD COLUMN IF NOT EXISTS receptor_legal_name VARCHAR(300);

  COMMENT ON COLUMN invoices.receptor_legal_name IS
    'Override de razón social a nivel factura. NULL => usa business_partners.tax_name.';
`

const down = `
  ALTER TABLE invoices DROP COLUMN IF EXISTS receptor_legal_name;
`

module.exports = { up, down }
