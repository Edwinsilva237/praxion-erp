'use strict'

/**
 * Mig 236 — facturas EMITIDAS importadas de otro sistema (migración de cartera).
 *
 * Contexto (2026-07-23): el usuario migra desde otro sistema de facturación y
 * necesita traer sus facturas vigentes (CFDI ya timbrados por otro PAC) para
 * gestionar la cobranza aquí SIN re-timbrar. Estas facturas nacen directamente
 * en status 'stamped' con su cfdi_uuid del XML, pero NO tienen facturapi_id —
 * todo lo que depende de Facturapi (PDF oficial, cancelación SAT, sync) debe
 * ramificar por `source`.
 *
 *  - `source` = 'system' (timbrada por este ERP vía Facturapi) | 'imported'.
 *  - `imported_installments` = nº de parcialidades de REP YA emitidas en el
 *    sistema anterior. El siguiente complemento que timbre este ERP usa
 *    NumParcialidad = imported_installments + REPs locales + 1 (exigencia SAT).
 *  - `imported_initial_balance` = saldo insoluto (en la MONEDA de la factura)
 *    al momento de importar. Es el ImpSaldoAnt del primer REP local; NULL en
 *    facturas del sistema (no aplica).
 */

const up = `
  ALTER TABLE invoices
    ADD COLUMN IF NOT EXISTS source                   VARCHAR(20) NOT NULL DEFAULT 'system',
    ADD COLUMN IF NOT EXISTS imported_installments    INTEGER     NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS imported_initial_balance NUMERIC(14,2);

  COMMENT ON COLUMN invoices.source                   IS 'system = timbrada por este ERP (Facturapi); imported = CFDI timbrado en otro sistema e importado para gestionar su cobranza.';
  COMMENT ON COLUMN invoices.imported_installments    IS 'Solo importadas: parcialidades de complemento de pago ya emitidas en el sistema anterior (el siguiente REP local continúa la numeración).';
  COMMENT ON COLUMN invoices.imported_initial_balance IS 'Solo importadas: saldo insoluto en la moneda de la factura al importarla (ImpSaldoAnt del primer REP local).';
`

const down = `
  ALTER TABLE invoices
    DROP COLUMN IF EXISTS source,
    DROP COLUMN IF EXISTS imported_installments,
    DROP COLUMN IF EXISTS imported_initial_balance;
`

module.exports = { up, down }
