'use strict'

/**
 * Mig 213 — agrega 'cfdi' al enum attachment_category.
 *
 * Permite guardar el respaldo del CFDI recibido (XML y/o PDF) pegado a su
 * supplier_invoice/gasto (entity_type='supplier_invoice'), descargable desde el
 * detalle del gasto. Cierra el hueco del buzón de correo: hoy lee el CFDI, crea
 * el gasto y descarta el archivo — con esta categoría el archivo original queda
 * guardado y se puede consultar/descargar (y a futuro, re-parsear).
 *
 * La validación MIME (que acepta XML, único caso entre las categorías) vive en
 * attachmentService.MIME_BY_CATEGORY.cfdi → ['application/xml','text/xml','application/pdf'].
 *
 * En PostgreSQL 12+ `ALTER TYPE ... ADD VALUE` corre dentro de la transacción
 * (solo se agrega, no se USA en esta misma migración). IF NOT EXISTS lo hace
 * idempotente. Migración dedicada (mismo patrón que mig 084 / 199).
 */

const up = `
  ALTER TYPE attachment_category ADD VALUE IF NOT EXISTS 'cfdi';
`

// Postgres no permite quitar valores de un enum; el down es no-op.
const down = `
  -- irreversible: Postgres no soporta DROP VALUE en un enum.
`

module.exports = { up, down }
