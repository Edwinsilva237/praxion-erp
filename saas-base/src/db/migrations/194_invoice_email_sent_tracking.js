'use strict'

/**
 * Mig 194 — rastreo de envío por correo de la factura.
 *
 * Contexto (2026-06-04): el envío automático de la factura al timbrar
 * (auto_send_invoice del cliente → Facturapi sendByEmail) solo dejaba un audit
 * log; no había forma de ver en el listado de facturas cuáles ya se enviaron.
 *
 *  - `email_sent_at`   = última vez que se envió por correo (auto o manual).
 *  - `email_sent_auto` = true si se envió AUTOMÁTICAMENTE al timbrar (sticky: un
 *    reenvío manual posterior NO lo apaga, porque sí fue auto-enviada en su
 *    momento). Permite la tag "Auto-enviada" en el listado.
 */

const up = `
  ALTER TABLE invoices
    ADD COLUMN IF NOT EXISTS email_sent_at   TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS email_sent_auto BOOLEAN NOT NULL DEFAULT false;

  COMMENT ON COLUMN invoices.email_sent_at   IS 'Última vez que la factura se envió por correo (auto al timbrar o manual). NULL = nunca enviada.';
  COMMENT ON COLUMN invoices.email_sent_auto IS 'true si la factura se envió AUTOMÁTICAMENTE al timbrar (cliente con auto_send_invoice). Sticky: un reenvío manual no lo apaga.';
`

const down = `
  ALTER TABLE invoices
    DROP COLUMN IF EXISTS email_sent_at,
    DROP COLUMN IF EXISTS email_sent_auto;
`

module.exports = { up, down }
