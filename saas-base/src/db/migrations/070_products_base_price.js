'use strict'

const up = `
  ALTER TABLE products
    ADD COLUMN IF NOT EXISTS base_price    DECIMAL(14,4),
    ADD COLUMN IF NOT EXISTS base_currency document_currency NOT NULL DEFAULT 'MXN';

  COMMENT ON COLUMN products.base_price    IS 'Precio base de lista. NULL = no definido. Los precios por cliente en customer_prices tienen prioridad cuando existen.';
  COMMENT ON COLUMN products.base_currency IS 'Moneda del precio base — MXN por default.';
`

const down = `
  ALTER TABLE products
    DROP COLUMN IF EXISTS base_price,
    DROP COLUMN IF EXISTS base_currency;
`

module.exports = { up, down }
