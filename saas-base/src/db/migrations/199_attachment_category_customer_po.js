'use strict'

/**
 * Mig 199 — agrega 'customer_po' al enum attachment_category.
 *
 * Permite adjuntar el DOCUMENTO de la orden de compra del cliente (PDF o foto)
 * a un pedido de venta (entity_type='sales_order'). El cliente a veces exige su
 * propia OC impresa para recibir la mercancía, así que el documento se sube en el
 * pedido y se puede descargar/imprimir desde el pedido Y desde la remisión ligada.
 *
 * El número de OC ya se capturaba (`sales_orders.po_number`); esto agrega el
 * documento. Categoría aditiva (varios archivos por pedido), MIME imágenes + PDF.
 *
 * En PostgreSQL 12+ `ALTER TYPE ... ADD VALUE` corre dentro de la transacción
 * (solo se agrega, no se USA en esta misma migración). IF NOT EXISTS lo hace
 * idempotente. Migración dedicada (mismo patrón que mig 084 / 196).
 */

const up = `
  ALTER TYPE attachment_category ADD VALUE IF NOT EXISTS 'customer_po';
`

// Postgres no permite quitar valores de un enum; el down es no-op.
const down = `
  -- irreversible: Postgres no soporta DROP VALUE en un enum.
`

module.exports = { up, down }
