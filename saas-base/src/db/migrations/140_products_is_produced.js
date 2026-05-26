'use strict'

/**
 * SaaS v2 — Migration 140: products.is_produced.
 *
 * Reemplaza el discriminador legacy `products.type` (ENUM corner_protector|resale)
 * por un boolean flexible que indica si el producto se fabrica internamente
 * (necesita receta, aparece en órdenes de producción) o solo se compra para
 * reventa.
 *
 * Backfill: los productos existentes con type='corner_protector' quedan como
 * is_produced=true; el resto queda en false.
 *
 * La columna `type` se mantiene como dato legacy (no se usa en lógica nueva).
 * Las queries que antes filtraban por type='corner_protector' ahora deben
 * filtrar por is_produced=true.
 *
 * Referencia: simplificación del modelo de productos para soportar tenants
 * sin acoplamiento a esquineros plásticos.
 */

const up = `
  ALTER TABLE products
    ADD COLUMN IF NOT EXISTS is_produced BOOLEAN NOT NULL DEFAULT false;

  -- Backfill: productos legacy con type='corner_protector' son producidos.
  UPDATE products
     SET is_produced = true
   WHERE type = 'corner_protector'
     AND is_produced = false;

  CREATE INDEX IF NOT EXISTS idx_products_is_produced
    ON products (tenant_id, is_produced)
    WHERE is_produced = true;

  COMMENT ON COLUMN products.is_produced IS
    'SaaS v2 §140: true = se fabrica internamente (genera órdenes de producción, requiere receta). false = solo se compra para reventa. Reemplaza el uso lógico de products.type, que queda como dato legacy.';
`

const down = `
  DROP INDEX IF EXISTS idx_products_is_produced;
  ALTER TABLE products DROP COLUMN IF EXISTS is_produced;
`

module.exports = { up, down }
