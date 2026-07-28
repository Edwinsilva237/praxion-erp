'use strict'

/**
 * Mig 238 — devoluciones de venta: mercancía dañada / no apta para reventa.
 *
 * Contexto (2026-07-28, revisión NIF C-4): todo reingreso por devolución
 * entraba al almacén como 'available', incluyendo mercancía dañada que no se
 * puede revender. Ahora cada línea de devolución puede marcarse como dañada:
 * reingresa con status 'blocked' (el mismo estado de 2ª calidad, con su flujo
 * existente de "Liberar" o dar de baja) en lugar de disponible.
 */

const up = `
  ALTER TABLE sales_return_lines
    ADD COLUMN IF NOT EXISTS is_damaged BOOLEAN NOT NULL DEFAULT FALSE;

  COMMENT ON COLUMN sales_return_lines.is_damaged IS 'Mercancía dañada / no apta para reventa: reingresa al almacén como Bloqueado en vez de Disponible.';
`

const down = `
  ALTER TABLE sales_return_lines DROP COLUMN IF EXISTS is_damaged;
`

module.exports = { up, down }
