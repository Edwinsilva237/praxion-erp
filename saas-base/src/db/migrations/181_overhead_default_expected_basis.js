'use strict'

/**
 * Mig 181 — `default_expected_basis_divisor` en tenant_overhead_items.
 *
 * Contexto: el overhead estimado intra-mes se reparte como
 *   shift_amount = (period.estimated_amount / expected_basis_divisor) * basis_value
 * Si `expected_basis_divisor` es NULL, cada turno carga el MONTO COMPLETO del
 * período (estimado altísimo a mitad de mes; el cierre lo corrige). La UI nunca
 * dejaba fijar ese divisor, así que el estimado intra-mes salía inflado.
 *
 * Este campo guarda, POR ÍTEM y de forma persistente ("se configura una vez"),
 * cuántos turnos/horas/unidades/kg se esperan al mes según su allocation_base.
 * `ensurePeriodsForMonth` lo copia al `expected_basis_divisor` de cada período
 * generado, de modo que el estimado por turno ya salga repartido y realista.
 *
 * NULL = comportamiento previo (monto completo por turno hasta el recosteo).
 */

const up = `
  ALTER TABLE tenant_overhead_items
    ADD COLUMN default_expected_basis_divisor NUMERIC(14,4) NULL
      CHECK (default_expected_basis_divisor IS NULL OR default_expected_basis_divisor > 0);

  COMMENT ON COLUMN tenant_overhead_items.default_expected_basis_divisor IS
    'Turnos/horas/unidades/kg esperados al mes (según allocation_base). Se copia a expected_basis_divisor al generar los períodos para repartir el estimado intra-mes. NULL = monto completo por turno.';
`

const down = `
  ALTER TABLE tenant_overhead_items DROP COLUMN IF EXISTS default_expected_basis_divisor;
`

module.exports = { up, down }
