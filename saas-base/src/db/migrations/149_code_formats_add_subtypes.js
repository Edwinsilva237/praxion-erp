'use strict'

/**
 * Extiende los entity_type válidos en `tenant_code_formats` para incluir
 * los subtipos de raw_materials (packaging, additive). Antes solo se
 * permitían cuatro: product, raw_material, customer, supplier. Esto
 * forzaba que las MP, embalajes y aditivos compartieran la misma
 * nomenclatura, lo cual es contraintuitivo: el patrón natural es
 * MP-0001 / EMB-0001 / ADI-0001 por separado.
 *
 * Reemplaza el CHECK constraint dropping + recreating (no se puede
 * modificar in-place). No toca data existente.
 */

const up = `
  ALTER TABLE tenant_code_formats
    DROP CONSTRAINT tcf_entity_valid;

  ALTER TABLE tenant_code_formats
    ADD CONSTRAINT tcf_entity_valid CHECK (entity_type IN
      ('product', 'raw_material', 'packaging', 'additive', 'customer', 'supplier'));
`

const down = `
  ALTER TABLE tenant_code_formats
    DROP CONSTRAINT tcf_entity_valid;

  ALTER TABLE tenant_code_formats
    ADD CONSTRAINT tcf_entity_valid CHECK (entity_type IN
      ('product', 'raw_material', 'customer', 'supplier'));
`

module.exports = { up, down }
