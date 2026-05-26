'use strict'

/**
 * Agrega 'image' al enum attachment_category para soportar fotos de
 * producto (categoría usada por ProductImageUploader del frontend).
 *
 * Sin esta migración el INSERT falla con:
 *   "la sintaxis de entrada no es válida para el enum attachment_category: «image»"
 */

const up = `
  ALTER TYPE attachment_category ADD VALUE IF NOT EXISTS 'image';
`

// Postgres no permite quitar valores de un ENUM sin recrearlo. El down
// queda como no-op intencional: una vez aplicado, conservar 'image'
// es seguro porque solo añade una opción válida.
const down = `
  -- No-op: Postgres no soporta DROP VALUE en enums. Para revertir hay que
  -- recrear el tipo y migrar las columnas, lo cual no se justifica para
  -- esta adición.
  SELECT 1;
`

module.exports = { up, down }
