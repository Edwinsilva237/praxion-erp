'use strict'

/**
 * Cambia la unicidad de folio en supplier_invoices.
 *
 * ANTES: UNIQUE (tenant_id, invoice_number)
 *   → Dos proveedores no podían tener folios iguales (A-001 entre dos
 *     proveedores chocaba). No es realista — folios bajos se repiten.
 *
 * AHORA: UNIQUE (tenant_id, partner_id, invoice_number)
 *   → Cada proveedor tiene su propio espacio de folios.
 *   → Facturas genéricas (partner_id NULL) quedan sin validación automática:
 *     PG trata NULL ≠ NULL, así que dos genéricas con mismo folio pasan.
 *     Si se necesita en el futuro, agregar un índice expresión sobre
 *     COALESCE(partner_id::text, generic_supplier).
 *
 * El UUID SAT sigue con su unique global (si_uuid_sat_unique).
 */

const up = `
  ALTER TABLE supplier_invoices DROP CONSTRAINT IF EXISTS si_number_tenant;

  ALTER TABLE supplier_invoices
    ADD CONSTRAINT si_number_partner_tenant
    UNIQUE (tenant_id, partner_id, invoice_number);
`

const down = `
  ALTER TABLE supplier_invoices DROP CONSTRAINT IF EXISTS si_number_partner_tenant;

  ALTER TABLE supplier_invoices
    ADD CONSTRAINT si_number_tenant
    UNIQUE (tenant_id, invoice_number);
`

module.exports = { up, down }
