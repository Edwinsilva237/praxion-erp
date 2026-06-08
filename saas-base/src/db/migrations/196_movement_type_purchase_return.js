'use strict'

/**
 * Mig 196 — agrega 'purchase_return' al enum movement_type.
 *
 * Devoluciones a proveedor (Fase 1): la salida de inventario al devolver material
 * al proveedor se registra en el kardex con movement_type = 'purchase_return'
 * (espejo de 'purchase_entry'), para trazabilidad limpia y distinta de
 * 'adjustment_out'.
 *
 * En PostgreSQL 12+ `ALTER TYPE ... ADD VALUE` puede correr dentro de la
 * transacción (solo se agrega, no se USA en esta misma migración). IF NOT EXISTS
 * lo hace idempotente. Migración dedicada (mismo patrón que mig 180).
 */

const up = `
  ALTER TYPE movement_type ADD VALUE IF NOT EXISTS 'purchase_return';
`

// Postgres no permite quitar valores de un enum; el down es no-op.
const down = `
  -- irreversible: Postgres no soporta DROP VALUE en un enum.
`

module.exports = { up, down }
