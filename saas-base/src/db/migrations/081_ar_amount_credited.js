'use strict'

/**
 * Agrega `accounts_receivable.amount_credited` para trackear el monto
 * acumulado de notas de crédito aplicadas a un AR.
 *
 * Hasta ahora el código de createCreditNote modificaba `amount_total`
 * directamente, lo cual era incorrecto: el documento (factura) sigue
 * valiendo lo facturado originalmente; lo que cambia es el SALDO COBRABLE.
 *
 * Con la nueva columna:
 *   amount_total      → monto original facturado (inmutable).
 *   amount_paid       → cobros aplicados.
 *   amount_credited   → notas de crédito aplicadas (nuevo).
 *   amount_pending    → total - paid - credited.
 *   status            → 'paid' si pending ≤ 0.005, 'partial' si paid+credited > 0, 'pending' si nada.
 *
 * Backfill: si hay ARs cuyo amount_total ya fue reducido por NCs (datos
 * dañados antes de este fix), el operador debe corregirlos manualmente
 * usando la consulta documentada en el HANDOFF.
 */

// `amount_pending` es una columna GENERATED ALWAYS. Para incluir el descuento
// por notas de crédito hay que redefinirla — Postgres no permite alterar la
// expresión: drop + add con la nueva fórmula.

const up = `
  ALTER TABLE accounts_receivable
    ADD COLUMN IF NOT EXISTS amount_credited NUMERIC(14,2) NOT NULL DEFAULT 0;

  ALTER TABLE accounts_receivable DROP COLUMN IF EXISTS amount_pending;

  ALTER TABLE accounts_receivable
    ADD COLUMN amount_pending NUMERIC(14,2)
    GENERATED ALWAYS AS (amount_total - amount_paid - amount_credited) STORED;

  COMMENT ON COLUMN accounts_receivable.amount_credited IS
    'Monto acumulado de notas de crédito aplicadas. Reduce amount_pending sin tocar amount_total.';
  COMMENT ON COLUMN accounts_receivable.amount_pending IS
    'Saldo cobrable = amount_total - amount_paid - amount_credited.';
`

const down = `
  ALTER TABLE accounts_receivable DROP COLUMN IF EXISTS amount_pending;
  ALTER TABLE accounts_receivable
    ADD COLUMN amount_pending NUMERIC(14,2)
    GENERATED ALWAYS AS (amount_total - amount_paid) STORED;
  ALTER TABLE accounts_receivable DROP COLUMN IF EXISTS amount_credited;
`

module.exports = { up, down }
