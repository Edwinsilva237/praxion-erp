'use strict'

/**
 * Almacén por línea en remisiones.
 *
 * Hasta ahora delivery_notes no tenía vínculo con almacén — al entregar la
 * remisión no había forma de saber de qué almacén descontar. Esta migración
 * agrega `warehouse_id` por línea (no por remisión) para soportar el caso
 * donde una misma remisión despacha de varios almacenes.
 *
 * NULL significa "usar almacén default del tenant" (para retrocompat con
 * líneas previas y para casos donde solo hay un almacén).
 */

const up = `
  ALTER TABLE delivery_note_lines
    ADD COLUMN IF NOT EXISTS warehouse_id UUID REFERENCES warehouses(id) ON DELETE RESTRICT;

  CREATE INDEX IF NOT EXISTS idx_dnl_warehouse ON delivery_note_lines (warehouse_id)
    WHERE warehouse_id IS NOT NULL;

  COMMENT ON COLUMN delivery_note_lines.warehouse_id
    IS 'Almacén origen de esta línea al entregar. NULL = default del tenant.';
`

const down = `
  DROP INDEX IF EXISTS idx_dnl_warehouse;
  ALTER TABLE delivery_note_lines DROP COLUMN IF EXISTS warehouse_id;
`

module.exports = { up, down }
