'use strict'

/**
 * Mig 247 — firma en pantalla (opcional) del receptor en vales de salida.
 *
 * El receptor puede firmar en el dispositivo al momento de la entrega; la firma
 * se guarda como PNG en storage (R2/disco) y aquí solo vive la ruta. El PDF del
 * vale la incrusta sobre la línea de "Recibió".
 */

const up = `
  ALTER TABLE consumption_vouchers
    ADD COLUMN receiver_signature_path TEXT;

  COMMENT ON COLUMN consumption_vouchers.receiver_signature_path
    IS 'PNG de la firma en pantalla del receptor (opcional) en object storage.';
`

const down = `
  ALTER TABLE consumption_vouchers DROP COLUMN IF EXISTS receiver_signature_path;
`

module.exports = { up, down }
