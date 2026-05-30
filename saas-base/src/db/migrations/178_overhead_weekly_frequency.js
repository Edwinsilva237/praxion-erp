'use strict'

/**
 * Mig 178 — agrega 'weekly' (Semanal) a las frecuencias de captura de gastos
 * indirectos.
 *
 * Contexto (2026-05-30):
 *  El catálogo de gastos indirectos (tenant_overhead_items) tenía como
 *  frecuencias de captura: monthly, biweekly, annual, event. Faltaba SEMANAL,
 *  un hueco real: la "raya semanal" (nómina cada 7 días) es comunísima en PyMEs
 *  mexicanas de manufactura/alimentos/agro. Sin semanal, un tenant con nómina
 *  semanal tenía que forzarla a quincenal (cadencia equivocada) o mensual.
 *
 *  `capture_frequency` es un recordatorio de cadencia de captura, no un divisor
 *  de cálculo (la imputación a turnos no lo usa), así que ampliarlo es seguro.
 *  Deliberadamente NO se agrega 'daily': el gasto diario chico vive mejor en
 *  Caja chica, y todo se agrega al período mensual de costeo de todos modos.
 */

const up = `
  ALTER TABLE tenant_overhead_items DROP CONSTRAINT IF EXISTS toi_capture_frequency_check;
  ALTER TABLE tenant_overhead_items ADD CONSTRAINT toi_capture_frequency_check
    CHECK (capture_frequency IN ('monthly','biweekly','weekly','annual','event'));
`

const down = `
  ALTER TABLE tenant_overhead_items DROP CONSTRAINT IF EXISTS toi_capture_frequency_check;
  ALTER TABLE tenant_overhead_items ADD CONSTRAINT toi_capture_frequency_check
    CHECK (capture_frequency IN ('monthly','biweekly','annual','event'));
`

module.exports = { up, down }
