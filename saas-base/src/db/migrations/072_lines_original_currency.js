'use strict'

/**
 * Trazabilidad de precio original en moneda extranjera por línea.
 *
 * Caso de uso: el producto se cotiza en USD pero se vende y factura en MXN
 * al tipo de cambio del día. Hasta ahora el pedido se forzaba a la moneda
 * del producto/precio negociado. Con estas columnas el pedido puede ir en
 * MXN llevando por debajo el precio USD original + el TC aplicado, lo que
 * permite revaluar al timbrar la factura usando el TC del día del DOF.
 *
 *   - original_unit_price    → precio en la moneda original (NULL = sin conversión)
 *   - original_currency      → moneda original ('USD' típico, 'MXN' si redundante)
 *   - applied_exchange_rate  → TC usado al convertir a la moneda del documento
 *
 * Cuando original_currency = NULL no hay conversión — el unit_price es el
 * "real" en la moneda del documento.
 */

const up = `
  ALTER TABLE sales_order_lines
    ADD COLUMN IF NOT EXISTS original_unit_price    DECIMAL(14,4),
    ADD COLUMN IF NOT EXISTS original_currency      document_currency,
    ADD COLUMN IF NOT EXISTS applied_exchange_rate  DECIMAL(12,6);

  ALTER TABLE delivery_note_lines
    ADD COLUMN IF NOT EXISTS original_unit_price    DECIMAL(14,4),
    ADD COLUMN IF NOT EXISTS original_currency      document_currency,
    ADD COLUMN IF NOT EXISTS applied_exchange_rate  DECIMAL(12,6);

  ALTER TABLE invoice_lines
    ADD COLUMN IF NOT EXISTS original_unit_price    DECIMAL(14,4),
    ADD COLUMN IF NOT EXISTS original_currency      document_currency,
    ADD COLUMN IF NOT EXISTS applied_exchange_rate  DECIMAL(12,6);

  COMMENT ON COLUMN sales_order_lines.original_unit_price
    IS 'Precio en moneda original (típicamente USD). NULL = sin conversión.';
  COMMENT ON COLUMN sales_order_lines.applied_exchange_rate
    IS 'TC aplicado al convertir el precio original a la moneda del pedido.';
`

const down = `
  ALTER TABLE sales_order_lines
    DROP COLUMN IF EXISTS original_unit_price,
    DROP COLUMN IF EXISTS original_currency,
    DROP COLUMN IF EXISTS applied_exchange_rate;

  ALTER TABLE delivery_note_lines
    DROP COLUMN IF EXISTS original_unit_price,
    DROP COLUMN IF EXISTS original_currency,
    DROP COLUMN IF EXISTS applied_exchange_rate;

  ALTER TABLE invoice_lines
    DROP COLUMN IF EXISTS original_unit_price,
    DROP COLUMN IF EXISTS original_currency,
    DROP COLUMN IF EXISTS applied_exchange_rate;
`

module.exports = { up, down }
