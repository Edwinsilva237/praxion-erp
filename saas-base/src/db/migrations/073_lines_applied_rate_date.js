'use strict'

/**
 * Fecha del TC usado para convertir el precio (junto a applied_exchange_rate).
 *
 * Importante en fines de semana y feriados: Banxico solo publica en días
 * hábiles, así que un pedido capturado un sábado usa el TC del viernes.
 * Esta columna deja claro QUÉ FECHA tiene el TC aplicado para que el usuario
 * sepa si es del día o arrastrado del último día hábil anterior.
 */

const up = `
  ALTER TABLE sales_order_lines
    ADD COLUMN IF NOT EXISTS applied_exchange_rate_date DATE;

  ALTER TABLE delivery_note_lines
    ADD COLUMN IF NOT EXISTS applied_exchange_rate_date DATE;

  ALTER TABLE invoice_lines
    ADD COLUMN IF NOT EXISTS applied_exchange_rate_date DATE;
`

const down = `
  ALTER TABLE sales_order_lines   DROP COLUMN IF EXISTS applied_exchange_rate_date;
  ALTER TABLE delivery_note_lines DROP COLUMN IF EXISTS applied_exchange_rate_date;
  ALTER TABLE invoice_lines       DROP COLUMN IF EXISTS applied_exchange_rate_date;
`

module.exports = { up, down }
