'use strict'

/**
 * Mig 221 — producto de 2ª calidad por defecto (por artículo).
 *
 * Hoy el capturista, al marcar "Segunda calidad", elige el SKU destino de un
 * dropdown de TODOS los productos (~200) → propenso a error. Esta columna guarda,
 * por producto de 1ª, cuál es su SKU de 2ª calidad ("Comercial"). En captura se
 * autoselecciona ese destino en vez de mostrar la lista completa.
 *
 * FK a products (auto-referencia). ON DELETE SET NULL: si se borra el SKU de 2ª,
 * el de 1ª simplemente pierde el default (sin romper). NULL = sin default (cae al
 * comportamiento actual: el capturista elige). No obligatorio.
 */

const up = `
  ALTER TABLE products
    ADD COLUMN second_quality_product_id UUID REFERENCES products(id) ON DELETE SET NULL;

  COMMENT ON COLUMN products.second_quality_product_id
    IS 'SKU de 2ª calidad por defecto de este producto (variante "Comercial"). Se autoselecciona en captura al marcar 2ª. NULL = sin default.';
`

const down = `
  ALTER TABLE products DROP COLUMN IF EXISTS second_quality_product_id;
`

module.exports = { up, down }
