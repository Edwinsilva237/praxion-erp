'use strict'

/**
 * Agrega la columna `no_invoice` a delivery_notes.
 *
 * Permite marcar remisiones que NO se van a facturar (ventas de mostrador,
 * cliente sin RFC, etc.). Esas remisiones desaparecen del listado del modal
 * de "Nueva factura" para no inflar la elección del usuario.
 *
 * Default: false (toda remisión se asume facturable hasta que se diga lo
 * contrario). El usuario puede marcar/desmarcar desde el panel de la remisión.
 */

const up = `
  ALTER TABLE delivery_notes
    ADD COLUMN no_invoice BOOLEAN NOT NULL DEFAULT false;

  COMMENT ON COLUMN delivery_notes.no_invoice IS
    'true = esta remisión queda final y no se va a facturar. Se excluye del modal de nueva factura.';

  -- Índice parcial para acelerar el filtro "facturables" en el modal de factura
  CREATE INDEX idx_dn_invoiceable ON delivery_notes (tenant_id, status)
    WHERE status = 'delivered' AND no_invoice = false;
`

const down = `
  DROP INDEX IF EXISTS idx_dn_invoiceable;
  ALTER TABLE delivery_notes DROP COLUMN IF EXISTS no_invoice;
`

module.exports = { up, down }
