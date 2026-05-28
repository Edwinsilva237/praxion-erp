'use strict'

/**
 * Mig 165 — products.image_attachment_id + backfill desde attachments.
 *
 * Contexto (sesión 2026-05-29):
 *  El frontend ProductImageUploader leía `product.image_attachment_id` para
 *  mostrar la imagen, pero esa columna nunca existió en la tabla `products`
 *  (solo había `coa_attachment_id`). El service tampoco la tocaba. Síntoma:
 *  "subo la imagen, no da error, no aparece nada".
 *
 *  Esta migración:
 *   1. Crea la columna image_attachment_id (FK a attachments).
 *   2. Hace backfill desde attachments existentes — para cada producto con un
 *      attachment categoría 'image', toma el más reciente y lo amarra.
 *
 *  Acompañado del fix en attachmentService.saveAttachment / deleteAttachment
 *  que mantiene el campo actualizado en INSERT y DELETE.
 */

const up = `
  ALTER TABLE products
    ADD COLUMN image_attachment_id UUID NULL
      REFERENCES attachments(id) ON DELETE SET NULL;

  -- Backfill: amarrar la imagen más reciente que ya tenga cada producto.
  UPDATE products p
     SET image_attachment_id = a.id
    FROM (
      SELECT DISTINCT ON (entity_id, tenant_id)
             id, entity_id, tenant_id
        FROM attachments
       WHERE entity_type = 'product'
         AND category    = 'image'
       ORDER BY entity_id, tenant_id, created_at DESC
    ) a
   WHERE p.id = a.entity_id
     AND p.tenant_id = a.tenant_id
     AND p.image_attachment_id IS NULL;

  COMMENT ON COLUMN products.image_attachment_id IS
    'FK a la imagen principal del producto en attachments. Único por producto (la mig denormaliza para que el front la encuentre sin escanear). Mantenido por attachmentService.saveAttachment cuando entity_type=product y category=image.';
`

const down = `
  ALTER TABLE products DROP COLUMN IF EXISTS image_attachment_id;
`

module.exports = { up, down }
