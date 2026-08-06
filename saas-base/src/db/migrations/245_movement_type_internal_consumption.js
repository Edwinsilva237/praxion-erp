'use strict'

/**
 * Mig 245 — agrega 'internal_consumption' al enum movement_type.
 *
 * Vales de salida (consumo interno): la entrega de material a un área/departamento
 * (empaque, mantenimiento, oficinas...) se registra en el kardex con
 * movement_type = 'internal_consumption', distinto de 'adjustment_out' para que
 * los reportes separen consumo real de correcciones de inventario.
 *
 * Migración dedicada (mismo patrón que migs 180/196): el valor no puede USARSE
 * en la misma transacción que lo agrega. Las tablas van en mig 246.
 */

const up = `
  ALTER TYPE movement_type ADD VALUE IF NOT EXISTS 'internal_consumption';
`

// Postgres no permite quitar valores de un enum; el down es no-op.
const down = `
  -- irreversible: Postgres no soporta DROP VALUE en un enum.
`

module.exports = { up, down }
