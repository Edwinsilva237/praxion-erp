'use strict'

/**
 * Paquetes de productos en cotizaciones (extiende mig 203 a quotation_lines).
 *
 * Mismo modelo que sales_order_lines: una línea de cotización puede pertenecer
 * a una instancia de paquete (bundle_group_id). Al convertir la cotización en
 * pedido, estos campos se copian fielmente a sales_order_lines, así el pedido
 * resultante conserva el agrupamiento y el precio prorrateado.
 *
 * Aditiva, sin backfill (las cotizaciones existentes no tienen paquetes).
 */

const up = `
  ALTER TABLE quotation_lines
    ADD COLUMN IF NOT EXISTS bundle_id       UUID REFERENCES product_bundles(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS bundle_group_id UUID,
    ADD COLUMN IF NOT EXISTS bundle_name     VARCHAR(200),
    ADD COLUMN IF NOT EXISTS bundle_quantity DECIMAL(14,4);

  CREATE INDEX IF NOT EXISTS idx_ql_bundle_group
    ON quotation_lines (bundle_group_id)
    WHERE bundle_group_id IS NOT NULL;

  COMMENT ON COLUMN quotation_lines.bundle_group_id IS
    'Agrupa las líneas de UNA instancia de paquete dentro de la cotización. Se copia al pedido al convertir.';
  COMMENT ON COLUMN quotation_lines.bundle_name IS
    'Snapshot del nombre del paquete al capturar (sobrevive si el paquete se borra del catálogo).';
`

const down = `
  ALTER TABLE quotation_lines
    DROP COLUMN IF EXISTS bundle_quantity,
    DROP COLUMN IF EXISTS bundle_name,
    DROP COLUMN IF EXISTS bundle_group_id,
    DROP COLUMN IF EXISTS bundle_id;
`

module.exports = { up, down }
