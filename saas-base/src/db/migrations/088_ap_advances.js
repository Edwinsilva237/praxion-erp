'use strict'

/**
 * Anticipos a proveedor (espejo de ar_advances en el lado AP).
 *
 * Caso de uso: pagamos al proveedor antes de tener una factura registrada
 * (depósito, prepago, 50% al firmar OC, etc.) — o se paga de más por
 * accidente y queda saldo a favor.
 *
 * `amount`           — monto total del anticipo otorgado.
 * `amount_applied`   — cuánto se ha aplicado ya a facturas.
 * `amount_available` — generated (amount - applied). Filtra anticipos vivos.
 *
 * Se vincula con cuentas bancarias (bank_account_id) para trazabilidad.
 * Se vincula opcionalmente con supplier_payments cuando el anticipo viene de
 * un sobrante de un pago aplicado a facturas — esto permite saber de qué
 * pago físico nació el anticipo.
 */

const up = `
  CREATE TABLE ap_advances (
    id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id        UUID          NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    partner_id       UUID          NOT NULL REFERENCES business_partners(id),
    amount           DECIMAL(14,2) NOT NULL,
    amount_applied   DECIMAL(14,2) NOT NULL DEFAULT 0,
    amount_available DECIMAL(14,2) GENERATED ALWAYS AS (amount - amount_applied) STORED,
    currency         document_currency NOT NULL DEFAULT 'MXN',
    payment_method   ap_payment_method NOT NULL,
    reference        VARCHAR(100),
    bank_account_id  UUID          REFERENCES bank_accounts(id) ON DELETE SET NULL,
    payment_date     DATE          NOT NULL DEFAULT CURRENT_DATE,
    -- supplier_payment_id es opcional. Cuando el anticipo nace del sobrante
    -- de un pago aplicado a facturas, apunta a ese pago físico para trazar.
    supplier_payment_id UUID       REFERENCES supplier_payments(id) ON DELETE SET NULL,
    notes            TEXT,
    created_by       UUID          REFERENCES users(id) ON DELETE SET NULL,
    created_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

    CONSTRAINT apa_amount_positive    CHECK (amount > 0),
    CONSTRAINT apa_applied_not_exceed CHECK (amount_applied <= amount)
  );

  CREATE INDEX idx_apa_tenant_id    ON ap_advances (tenant_id);
  CREATE INDEX idx_apa_partner_id   ON ap_advances (tenant_id, partner_id);
  CREATE INDEX idx_apa_available    ON ap_advances (tenant_id, partner_id, amount_available)
    WHERE amount_applied < amount;
  CREATE INDEX idx_apa_payment      ON ap_advances (supplier_payment_id)
    WHERE supplier_payment_id IS NOT NULL;

  CREATE TRIGGER set_updated_at_ap_advances
    BEFORE UPDATE ON ap_advances
    FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

  COMMENT ON COLUMN ap_advances.amount_available IS
    'Calculado: amount - amount_applied. Filtra anticipos con saldo > 0.';
  COMMENT ON COLUMN ap_advances.supplier_payment_id IS
    'Si el anticipo nació del sobrante de un pago aplicado a facturas, apunta a ese pago físico.';

  -- supplier_payments necesita un método 'advance_application' para registrar
  -- la aplicación de un anticipo como pago (sin salida real de dinero).
  -- El enum ap_payment_method ya tiene cash/transfer/check; agregamos el nuevo valor.
  ALTER TYPE ap_payment_method ADD VALUE IF NOT EXISTS 'advance_application';
`

const down = `
  DROP TRIGGER IF EXISTS set_updated_at_ap_advances ON ap_advances;
  DROP TABLE IF EXISTS ap_advances CASCADE;
  -- Nota: PG no permite quitar valores de un enum, advance_application queda en el tipo.
`

module.exports = { up, down }
