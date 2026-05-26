'use strict'

/**
 * Catálogo de cuentas bancarias del tenant.
 *
 * Sirve para registrar a qué cuenta cayó cada cobro (ar_payments.bank_account_id).
 * Por ahora se usa solo en AR; en un futuro lo mismo aplicará a AP (egresos).
 *
 * `bank_name`     — nombre canónico del banco (BBVA, Banorte, Banamex, etc.)
 * `alias`         — nombre interno opcional ("Operativa MXN", "Nómina USD")
 * `account_number`— número de cuenta corta (legible)
 * `clabe`         — CLABE de 18 dígitos para transferencias SPEI
 * `currency`      — MXN o USD
 * `active`        — soft-delete; cuentas inactivas no aparecen en pickers
 */

const up = `
  CREATE TABLE bank_accounts (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id      UUID         NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    bank_name      VARCHAR(80)  NOT NULL,
    alias          VARCHAR(80),
    account_number VARCHAR(40),
    clabe          VARCHAR(18),
    currency       document_currency NOT NULL DEFAULT 'MXN',
    active         BOOLEAN      NOT NULL DEFAULT TRUE,
    notes          TEXT,
    created_by     UUID         REFERENCES users(id) ON DELETE SET NULL,
    created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

    CONSTRAINT ba_clabe_format CHECK (clabe IS NULL OR clabe ~ '^[0-9]{18}$')
  );

  CREATE INDEX idx_ba_tenant_id ON bank_accounts (tenant_id);
  CREATE INDEX idx_ba_active    ON bank_accounts (tenant_id, active);

  CREATE TRIGGER set_updated_at_bank_accounts
    BEFORE UPDATE ON bank_accounts
    FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

  ALTER TABLE ar_payments
    ADD COLUMN bank_account_id UUID REFERENCES bank_accounts(id) ON DELETE SET NULL;

  CREATE INDEX idx_arp_bank_account ON ar_payments (bank_account_id)
    WHERE bank_account_id IS NOT NULL;

  COMMENT ON COLUMN ar_payments.bank_account_id IS
    'Cuenta bancaria del tenant donde se recibió el pago. Opcional para preservar pagos históricos.';
`

const down = `
  ALTER TABLE ar_payments DROP COLUMN IF EXISTS bank_account_id;
  DROP TRIGGER IF EXISTS set_updated_at_bank_accounts ON bank_accounts;
  DROP TABLE IF EXISTS bank_accounts CASCADE;
`

module.exports = { up, down }
