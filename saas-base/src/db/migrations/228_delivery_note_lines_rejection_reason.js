'use strict'

/**
 * Mig 228 — motivo de rechazo por línea de remisión (entrega parcial por rechazo).
 *
 * Contexto (2026-07-15):
 *  Al registrar la ENTREGA de una remisión, el cliente puede rechazar/no recibir
 *  parte de un producto (calidad o error). El modelo ya distingue
 *  `quantity_ordered` (lo que la remisión iba a entregar) de `quantity_delivered`
 *  (lo efectivamente entregado); esta columna documenta el PORQUÉ del faltante.
 *
 *  Flujo (retrocompatible): si el usuario NO indica rechazo, la entrega sigue
 *  siendo 100% como hasta ahora. Si indica que se rechazó algún ítem, se baja el
 *  `quantity_delivered` de esa línea (inventario y CXC solo por lo entregado), se
 *  guarda aquí el motivo, y la diferencia queda pendiente en el pedido para una
 *  remisión nueva. La cantidad rechazada es derivable: quantity_ordered - quantity_delivered.
 */

const up = `
  ALTER TABLE delivery_note_lines
    ADD COLUMN IF NOT EXISTS rejection_reason TEXT;

  COMMENT ON COLUMN delivery_note_lines.rejection_reason IS
    'Motivo por el que se recibió menos de lo remisionado (calidad/error). NULL = entregada completa. La cantidad rechazada = quantity_ordered - quantity_delivered.';
`

const down = `
  ALTER TABLE delivery_note_lines DROP COLUMN IF EXISTS rejection_reason;
`

module.exports = { up, down }
