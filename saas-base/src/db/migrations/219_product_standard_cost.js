'use strict'

/**
 * Mig 219 — costo estándar/estimado de referencia por producto.
 *
 * El costo REAL de inventario vive en inventory_stock.avg_cost (promedio
 * ponderado por almacén, alimentado por las entradas del kardex). Pero cuando
 * una entrada de un PRODUCTO llega en $0 —producción con turno mal costeado o
 * mercancía de un maquilador a la que se le da entrada sin costo— el artículo
 * queda valuado en $0 (o "pegado" a un promedio viejo por el endurecimiento del
 * costo). Esta columna guarda un costo estimado a nivel producto que se usa como
 * PARACAÍDAS: si una entrada de producto trae costo $0/sin costo y el producto
 * tiene standard_cost > 0, updateStock inyecta el estándar en lugar de $0.
 *
 * El costo real SIEMPRE gana: si la entrada trae un costo > 0 (compra/recepción),
 * ese costo alimenta el promedio ponderado y el estándar no interviene. Opcional
 * (NULL/0 = comportamiento previo, sin cambios). Expresado en la moneda operativa
 * del inventario (MXN), igual que avg_cost.
 */

const up = `
  ALTER TABLE products
    ADD COLUMN standard_cost DECIMAL(14,6);

  COMMENT ON COLUMN products.standard_cost
    IS 'Costo estimado/estándar de referencia (MXN). Paracaídas de valuación cuando una entrada de producto llega en $0. NULL/0 = sin fallback (comportamiento previo). El costo real del kardex siempre tiene prioridad.';
`

const down = `
  ALTER TABLE products DROP COLUMN IF EXISTS standard_cost;
`

module.exports = { up, down }
