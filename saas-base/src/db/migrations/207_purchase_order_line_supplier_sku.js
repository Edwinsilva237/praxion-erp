'use strict'

/**
 * Mig 207 — Clave/concepto del proveedor por línea de OC.
 *
 * `supplier_sku` = el código o concepto con el que el PROVEEDOR identifica el
 * producto (no nuestra clave interna). Se captura/edita por línea de la OC y se
 * imprime en el PDF para que el proveedor reconozca de inmediato qué le pides.
 *
 * Es un SNAPSHOT en la línea (lo que se mandó en ESTA OC); la fuente persistente
 * que la precarga/recuerda vive en `supplier_prices.supplier_sku` (mig 188), que
 * el auto-aprendizaje ahora también actualiza al crear la OC.
 *
 * La nota libre por línea ya existe (`purchase_order_lines.notes`, mig 022) — esta
 * migración solo agrega la clave del proveedor.
 */

const up = `
  ALTER TABLE purchase_order_lines
    ADD COLUMN IF NOT EXISTS supplier_sku VARCHAR(120);

  COMMENT ON COLUMN purchase_order_lines.supplier_sku
    IS 'Clave/concepto del proveedor para este ítem (snapshot del que se imprime en la OC).';
`

const down = `
  ALTER TABLE purchase_order_lines
    DROP COLUMN IF EXISTS supplier_sku;
`

module.exports = { up, down }
