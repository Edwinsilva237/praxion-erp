'use strict'

/**
 * SaaS v2 — Migration 132: granularidad de product_lots por tenant.
 *
 * Agrega tenant_process_config.product_lot_granularity para que cada tenant
 * decida el nivel al que se generan product_lots desde capturePackage:
 *
 *   - 'per_shift' (default): un product_lot por (shift × product × quality).
 *     El primer paquete del turno crea el lote; los siguientes lo aumentan.
 *     Alineado con realidad operativa de alimentos / commodities.
 *
 *   - 'per_package': un product_lot por captura. Granularidad máxima.
 *     Útil para farma / pharma donde cada paquete debe tener trazabilidad
 *     única.
 *
 *   - 'per_attribute_set' (reservado): un product_lot cada vez que cambian
 *     los custom_attributes marcados como lot-critical en
 *     tenant_product_kinds.capture_schema. Requiere infraestructura aún no
 *     implementada — el service lo rechaza con 501 hasta que se construya.
 *
 * Una sola columna en tenant_process_config; el override per-producto
 * (products.lot_granularity_override) se deja para futuro si surge la
 * necesidad real.
 *
 * Referencia: §4.3.2, §4.5 del design.
 */

const up = `
  ALTER TABLE tenant_process_config
    ADD COLUMN product_lot_granularity VARCHAR(20) NOT NULL DEFAULT 'per_shift'
      CHECK (product_lot_granularity IN ('per_shift','per_package','per_attribute_set'));

  COMMENT ON COLUMN tenant_process_config.product_lot_granularity IS
    'SaaS v2 §4.3.2: granularidad de product_lots generados al capturar paquete. per_shift (default) = 1 lote por shift×product×quality. per_package = 1 lote por captura. per_attribute_set = reservado, requiere lot-critical attributes (501 hasta implementarlo).';
`

const down = `
  ALTER TABLE tenant_process_config
    DROP COLUMN IF EXISTS product_lot_granularity;
`

module.exports = { up, down }
