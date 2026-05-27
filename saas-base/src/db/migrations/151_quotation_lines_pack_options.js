'use strict'

/**
 * Agrega pack_options a `quotation_lines` para paridad con `sales_order_lines`,
 * `delivery_note_lines` e `invoice_lines` (que ya las traen desde la mig 074).
 *
 * Motivación de negocio: el cliente normalmente quiere ver la cotización en la
 * presentación con la que va a comprar (ej. "10 rollos"), no en la unidad base
 * del almacén ("30 millares"). El service de cotizaciones quedó intencionalmente
 * sin esta lógica esperando "resolverlo al convertir a pedido", pero eso obliga
 * a re-cotizar al captar el pedido y rompe la UX.
 *
 * Columnas (mismo contrato que las 3 tablas hermanas):
 *   - pack_option_id  FK opcional a product_pack_options
 *   - pack_factor     snapshot del base_per_pack al capturar (NOT NULL DEFAULT 1)
 *   - quantity_base   quantity * pack_factor, en unidad base del producto
 *
 * Backfill: quantity_base = quantity para todas las líneas históricas
 * (todavía no había pack_factor; era 1 implícito).
 *
 * NOTA sobre convertToOrder: el service `convertToOrder` debe copiar los 3
 * nuevos campos al INSERT de sales_order_lines para que el pedido herede la
 * presentación elegida en la cotización. Eso se hace en el commit que sube
 * esta migración — no en otro paso.
 */

const up = `
  ALTER TABLE quotation_lines
    ADD COLUMN IF NOT EXISTS pack_option_id UUID REFERENCES product_pack_options(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS pack_factor    DECIMAL(14,4) NOT NULL DEFAULT 1,
    ADD COLUMN IF NOT EXISTS quantity_base  DECIMAL(14,4);

  UPDATE quotation_lines
     SET quantity_base = quantity
   WHERE quantity_base IS NULL;

  COMMENT ON COLUMN quotation_lines.pack_option_id IS
    'Presentación elegida (rollo, millar, caja…). NULL = el producto no usa pack_options o se capturó antes de la mig 151.';
  COMMENT ON COLUMN quotation_lines.pack_factor IS
    'Snapshot del base_per_pack al capturar. Permite que cambios futuros en product_pack_options no afecten cotizaciones cerradas.';
  COMMENT ON COLUMN quotation_lines.quantity_base IS
    'quantity * pack_factor en unidad base del producto. Útil para previsualización de impacto en inventario al convertir a pedido.';
`

const down = `
  ALTER TABLE quotation_lines
    DROP COLUMN IF EXISTS quantity_base,
    DROP COLUMN IF EXISTS pack_factor,
    DROP COLUMN IF EXISTS pack_option_id;
`

module.exports = { up, down }
