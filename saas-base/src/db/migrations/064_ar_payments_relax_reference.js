'use strict'

/**
 * Relaja el constraint de referencia obligatoria en ar_payments.
 *
 * Antes: la referencia era obligatoria para 'transfer' y 'check'.
 * Ahora: solo obligatoria para 'check' (el número de cheque es control físico
 * irrenunciable). Para transferencias (SPEI) la referencia queda opcional —
 * el usuario puede omitirla si todavía no tiene el folio de la transferencia
 * al capturar el pago.
 *
 * NOTA: en `ap_payments` (CXP) NO se aplica este cambio. Se mantendrá el
 * constraint estricto hasta que el usuario lo solicite explícitamente.
 */

const up = `
  ALTER TABLE ar_payments DROP CONSTRAINT IF EXISTS arp_reference_required;
  ALTER TABLE ar_payments
    ADD CONSTRAINT arp_reference_required CHECK (
      payment_method <> 'check' OR reference IS NOT NULL
    );
`

const down = `
  ALTER TABLE ar_payments DROP CONSTRAINT IF EXISTS arp_reference_required;
  ALTER TABLE ar_payments
    ADD CONSTRAINT arp_reference_required CHECK (
      payment_method NOT IN ('transfer','check') OR reference IS NOT NULL
    );
`

module.exports = { up, down }
