'use strict'

/**
 * SaaS v2 — Migration 143: delivery_note_lines.product_lot_id.
 *
 * Vincula cada línea de remisión a un lote específico de producto terminado
 * (`product_lots`) cuando el tenant tiene `uses_lots=true`.
 *
 * Trazabilidad forward: con esto podemos contestar "este lote producido el día
 * X terminó entregado al cliente Y en la remisión Z". Combinado con
 * `lot_consumption` (MP→PT), cubre la cadena completa MP → cliente.
 *
 * NULL es legítimo para tenants con uses_lots=false (esquineros, recicladora):
 * estos siguen despachando sin lotes y la columna queda vacía.
 *
 * No hay backfill: las remisiones existentes quedan en NULL. Trazabilidad
 * histórica solo empieza desde que se active el flag uses_lots por tenant.
 */

const up = `
  ALTER TABLE delivery_note_lines
    ADD COLUMN IF NOT EXISTS product_lot_id UUID NULL
      REFERENCES product_lots(id) ON DELETE SET NULL;

  CREATE INDEX IF NOT EXISTS idx_delivery_note_lines_product_lot
    ON delivery_note_lines (product_lot_id)
    WHERE product_lot_id IS NOT NULL;

  COMMENT ON COLUMN delivery_note_lines.product_lot_id IS
    'SaaS v2 §143: lote de PT despachado al cliente. Solo se popula cuando tenant_process_config.uses_lots=true. Permite trazabilidad forward (lote → cliente).';
`

const down = `
  DROP INDEX IF EXISTS idx_delivery_note_lines_product_lot;
  ALTER TABLE delivery_note_lines DROP COLUMN IF EXISTS product_lot_id;
`

module.exports = { up, down }
