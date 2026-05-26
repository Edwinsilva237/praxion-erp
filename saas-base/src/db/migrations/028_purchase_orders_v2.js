'use strict'

const up = `
  -- Agregar nuevos estatus al ENUM
  ALTER TYPE purchase_order_status ADD VALUE IF NOT EXISTS 'invoiced' AFTER 'received';
  ALTER TYPE purchase_order_status ADD VALUE IF NOT EXISTS 'closed'   AFTER 'invoiced';

  -- Soporte para líneas estimadas (ej: viaje de MP, precio a confirmar)
  ALTER TABLE purchase_order_lines
    ADD COLUMN IF NOT EXISTS is_estimated     BOOLEAN       NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS estimated_qty    DECIMAL(14,4),
    ADD COLUMN IF NOT EXISTS estimated_price  DECIMAL(14,4);

  -- Soporte para líneas genéricas (Mercado Libre, compras sin catálogo)
  ALTER TABLE purchase_order_lines
    ADD COLUMN IF NOT EXISTS is_generic       BOOLEAN       NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS generic_category VARCHAR(60);

  -- Hacer item_id opcional para líneas genéricas
  ALTER TABLE purchase_order_lines
    ALTER COLUMN item_id DROP NOT NULL;

  -- Hacer item_type opcional para líneas genéricas
  ALTER TABLE purchase_order_lines
    ALTER COLUMN item_type DROP NOT NULL;

  -- OC genérica (sin proveedor fijo del catálogo)
  ALTER TABLE purchase_orders
    ADD COLUMN IF NOT EXISTS is_generic       BOOLEAN       NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS generic_supplier VARCHAR(150);

  -- Hacer partner_id opcional para OC genéricas
  ALTER TABLE purchase_orders
    ALTER COLUMN partner_id DROP NOT NULL;

  COMMENT ON COLUMN purchase_order_lines.is_estimated    IS 'Precio/cantidad a confirmar en recepción';
  COMMENT ON COLUMN purchase_order_lines.is_generic      IS 'Línea sin item del catálogo (Mercado Libre, etc.)';
  COMMENT ON COLUMN purchase_orders.is_generic           IS 'OC sin proveedor registrado en catálogo';
  COMMENT ON COLUMN purchase_orders.generic_supplier     IS 'Nombre libre del proveedor (Mercado Libre, ferretería, etc.)';
`

const down = `
  ALTER TABLE purchase_orders      ALTER COLUMN partner_id  SET NOT NULL;
  ALTER TABLE purchase_order_lines ALTER COLUMN item_type   SET NOT NULL;
  ALTER TABLE purchase_order_lines ALTER COLUMN item_id     SET NOT NULL;
  ALTER TABLE purchase_order_lines
    DROP COLUMN IF EXISTS is_estimated,
    DROP COLUMN IF EXISTS estimated_qty,
    DROP COLUMN IF EXISTS estimated_price,
    DROP COLUMN IF EXISTS is_generic,
    DROP COLUMN IF EXISTS generic_category;
  ALTER TABLE purchase_orders
    DROP COLUMN IF EXISTS is_generic,
    DROP COLUMN IF EXISTS generic_supplier;
`

module.exports = { up, down }
