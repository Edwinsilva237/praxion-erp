'use strict'

/**
 * Eliminamos `products.min_stock` (creado en 035) porque quedó huérfano:
 * el modelo vigente vive en `inventory_levels.min_stock` con granularidad
 * por (producto × almacén) y acompañado de max_stock, reorder_point y
 * safety_stock. La columna legacy no se consultaba en ninguna alerta ni
 * reporte real — solo en el CRUD del catálogo de producto.
 */

const up = `
  ALTER TABLE products DROP COLUMN IF EXISTS min_stock;
`

const down = `
  ALTER TABLE products ADD COLUMN min_stock INTEGER NOT NULL DEFAULT 0;
  COMMENT ON COLUMN products.min_stock IS 'Stock mínimo para alerta de reabastecimiento. 0 = sin alerta.';
`

module.exports = { up, down }
