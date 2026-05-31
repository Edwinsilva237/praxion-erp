'use strict'

/**
 * Mig 180 — agrega 'production_validation_reversed' al enum movement_type.
 *
 * Bug encontrado 2026-05-30: revertValidation (mig 163) inserta movimientos de
 * inventario con movement_type = 'production_validation_reversed' para revertir
 * la validación de un turno, PERO ese valor nunca se agregó al enum. Resultado:
 * Postgres rechaza el INSERT ("entrada no válida para el enum movement_type")
 * y el endpoint /shifts/:id/revert-validation devuelve 500.
 *
 * En PostgreSQL 12+ `ALTER TYPE ... ADD VALUE` puede correr dentro de la
 * transacción del runner siempre que el nuevo valor no se USE en la misma
 * transacción (aquí solo se agrega). IF NOT EXISTS lo hace idempotente.
 *
 * down: los valores de enum no se pueden eliminar de forma sencilla en
 * Postgres; se deja como no-op (mismo criterio que migs 141, 063, etc.).
 */

const up = `
  ALTER TYPE movement_type ADD VALUE IF NOT EXISTS 'production_validation_reversed';
`

const down = `
  -- No-op: Postgres no permite quitar valores de un enum sin recrear el tipo.
`

module.exports = { up, down }
