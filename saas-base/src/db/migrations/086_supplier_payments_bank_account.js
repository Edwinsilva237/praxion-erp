'use strict'

/**
 * Cuenta bancaria emisora del pago a proveedor (espejo del campo equivalente
 * en ar_payments). Es opcional para preservar pagos históricos y para casos
 * sin trazabilidad bancaria (caja chica, vales, etc.).
 */

const up = `
  ALTER TABLE supplier_payments
    ADD COLUMN bank_account_id UUID REFERENCES bank_accounts(id) ON DELETE SET NULL;

  CREATE INDEX idx_sp_bank_account ON supplier_payments (bank_account_id)
    WHERE bank_account_id IS NOT NULL;

  COMMENT ON COLUMN supplier_payments.bank_account_id IS
    'Cuenta bancaria del tenant desde donde se emitió el pago. Opcional.';
`

const down = `
  DROP INDEX IF EXISTS idx_sp_bank_account;
  ALTER TABLE supplier_payments DROP COLUMN IF EXISTS bank_account_id;
`

module.exports = { up, down }
