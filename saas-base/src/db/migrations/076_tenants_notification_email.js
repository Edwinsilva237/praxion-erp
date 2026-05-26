'use strict'

/**
 * Agrega `notification_email` a tenants.
 *
 * Es el correo institucional que recibe copia (BCC) de los envíos
 * automáticos y manuales de remisiones/facturas. Permite desacoplar la
 * "copia interna" del correo del usuario logueado: cualquier operador
 * que envíe documentos genera la copia para este único correo.
 *
 * Si está NULL, los servicios caen al `users.email` del usuario que
 * dispara el envío como fallback (comportamiento heredado).
 */

const up = `
  ALTER TABLE tenants
    ADD COLUMN IF NOT EXISTS notification_email VARCHAR(255);

  COMMENT ON COLUMN tenants.notification_email IS
    'Correo institucional que recibe copia de remisiones/facturas enviadas. Si NULL, fallback al email del usuario logueado.';
`

const down = `
  ALTER TABLE tenants DROP COLUMN IF EXISTS notification_email;
`

module.exports = { up, down }
