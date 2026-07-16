'use strict'

/**
 * Mig 230 — agrega 'delivery_evidence' al enum attachment_category.
 *
 * BUG: el uploader de "Evidencia adicional" de una remisión ya entregada
 * (RemisionEvidencia → POST /sales/delivery-notes/:id/attachments) inserta el
 * adjunto con category='delivery_evidence', pero ese valor NUNCA se agregó al
 * enum `attachment_category` (013 lo creó; 084/199/213 agregaron image/
 * customer_po/cfdi). Postgres rechazaba el INSERT con
 *   "invalid input value for enum attachment_category: delivery_evidence"
 * y el handler global lo enmascaraba como 500 "Internal server error".
 *
 * Por eso las fotos de PRODUCTO (category='image', sí existe) funcionaban y la
 * evidencia de remisión no — de hecho nunca funcionó desde que se agregó la
 * feature. Esta migración cierra el hueco. Aditiva, idempotente.
 *
 * Mismo patrón que mig 084 / 199 / 213: `ALTER TYPE ... ADD VALUE` solo agrega
 * el valor (no lo USA en esta misma migración), IF NOT EXISTS = idempotente.
 */

const up = `
  ALTER TYPE attachment_category ADD VALUE IF NOT EXISTS 'delivery_evidence';
`

// Postgres no permite quitar valores de un enum; el down es no-op.
const down = `
  -- irreversible: Postgres no soporta DROP VALUE en un enum.
`

module.exports = { up, down }
