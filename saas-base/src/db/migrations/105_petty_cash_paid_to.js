'use strict'

/**
 * Caja chica — beneficiario del movimiento.
 *
 * Agrega columna `paid_to` (a quien se le entregó el dinero) en
 * petty_cash_movements. Es texto libre porque a menudo el receptor es
 * alguien externo al sistema (proveedor de la esquina, repartidor, etc.).
 *
 * Obligatoria solo en salidas (kind='out'). Para movimientos 'out' previos
 * sin dato se hace backfill con 'No registrado' para no romper el CHECK.
 */

const up = `
  ALTER TABLE petty_cash_movements
    ADD COLUMN paid_to VARCHAR(150);

  UPDATE petty_cash_movements
     SET paid_to = 'No registrado'
   WHERE kind = 'out' AND paid_to IS NULL;

  ALTER TABLE petty_cash_movements
    ADD CONSTRAINT pcm_paid_to_required_on_out
    CHECK (kind = 'in' OR (paid_to IS NOT NULL AND length(trim(paid_to)) > 0));

  COMMENT ON COLUMN petty_cash_movements.paid_to IS
    'Beneficiario: a quien se le entregó el efectivo. Requerido en salidas, opcional en entradas (quien repuso la caja).';
`

const down = `
  ALTER TABLE petty_cash_movements
    DROP CONSTRAINT IF EXISTS pcm_paid_to_required_on_out;
  ALTER TABLE petty_cash_movements
    DROP COLUMN IF EXISTS paid_to;
`

module.exports = { up, down }
