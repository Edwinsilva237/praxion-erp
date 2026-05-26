'use strict'

const up = `
  CREATE TYPE ar_document_type AS ENUM ('invoice', 'remission', 'credit_note', 'advance');
  CREATE TYPE ar_status        AS ENUM ('pending', 'partial', 'paid', 'overdue', 'cancelled');
  CREATE TYPE payment_method   AS ENUM ('cash', 'transfer', 'check', 'advance_application', 'credit_note');
  CREATE TYPE credit_note_reason AS ENUM ('return', 'discount', 'correction');

  -- ─── CXC — Cuentas por cobrar ───────────────────────────────────────────
  CREATE TABLE accounts_receivable (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id       UUID             NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    partner_id      UUID             NOT NULL REFERENCES business_partners(id),
    document_type   ar_document_type NOT NULL,
    document_id     UUID             NOT NULL,
    document_number VARCHAR(30)      NOT NULL,
    currency        document_currency NOT NULL DEFAULT 'MXN',
    exchange_rate   DECIMAL(12,6)    NOT NULL DEFAULT 1,
    amount_total    DECIMAL(14,2)    NOT NULL,
    amount_paid     DECIMAL(14,2)    NOT NULL DEFAULT 0,
    amount_pending  DECIMAL(14,2)    GENERATED ALWAYS AS (amount_total - amount_paid) STORED,
    issue_date      DATE             NOT NULL,
    due_date        DATE,
    status          ar_status        NOT NULL DEFAULT 'pending',
    notes           TEXT,
    created_by      UUID             REFERENCES users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ      NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ      NOT NULL DEFAULT NOW(),

    CONSTRAINT ar_amount_positive  CHECK (amount_total > 0),
    CONSTRAINT ar_paid_not_exceed  CHECK (amount_paid <= amount_total),
    CONSTRAINT ar_doc_unique       UNIQUE (tenant_id, document_type, document_id)
  );

  CREATE INDEX idx_ar_tenant_id    ON accounts_receivable (tenant_id);
  CREATE INDEX idx_ar_partner_id   ON accounts_receivable (tenant_id, partner_id);
  CREATE INDEX idx_ar_status       ON accounts_receivable (tenant_id, status);
  CREATE INDEX idx_ar_due_date     ON accounts_receivable (tenant_id, due_date) WHERE status IN ('pending','partial');
  CREATE INDEX idx_ar_document     ON accounts_receivable (tenant_id, document_type, document_id);

  COMMENT ON COLUMN accounts_receivable.amount_pending IS 'Calculado: total - pagado — saldo por cobrar';
  COMMENT ON COLUMN accounts_receivable.due_date       IS 'Calculado desde issue_date + días de crédito del cliente';

  CREATE TRIGGER set_updated_at_accounts_receivable
    BEFORE UPDATE ON accounts_receivable
    FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

  -- Abonos a CXC
  CREATE TABLE ar_payments (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id       UUID           NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    ar_id           UUID           NOT NULL REFERENCES accounts_receivable(id),
    amount          DECIMAL(14,2)  NOT NULL,
    payment_method  payment_method NOT NULL,
    reference       VARCHAR(100),
    payment_date    DATE           NOT NULL DEFAULT CURRENT_DATE,
    advance_id      UUID,
    notes           TEXT,
    created_by      UUID           REFERENCES users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ    NOT NULL DEFAULT NOW(),

    CONSTRAINT arp_amount_positive CHECK (amount > 0),
    CONSTRAINT arp_reference_required CHECK (
      payment_method NOT IN ('transfer','check') OR reference IS NOT NULL
    )
  );

  CREATE INDEX idx_arp_ar_id      ON ar_payments (ar_id);
  CREATE INDEX idx_arp_tenant_id  ON ar_payments (tenant_id);
  CREATE INDEX idx_arp_date       ON ar_payments (tenant_id, payment_date DESC);

  COMMENT ON COLUMN ar_payments.reference IS 'Número de transferencia, cheque, etc — obligatorio para transfer y check';

  -- Anticipos de clientes
  CREATE TABLE ar_advances (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id       UUID          NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    partner_id      UUID          NOT NULL REFERENCES business_partners(id),
    amount          DECIMAL(14,2) NOT NULL,
    amount_applied  DECIMAL(14,2) NOT NULL DEFAULT 0,
    amount_available DECIMAL(14,2) GENERATED ALWAYS AS (amount - amount_applied) STORED,
    payment_method  payment_method NOT NULL,
    reference       VARCHAR(100),
    receipt_date    DATE          NOT NULL DEFAULT CURRENT_DATE,
    notes           TEXT,
    created_by      UUID          REFERENCES users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

    CONSTRAINT ara_amount_positive   CHECK (amount > 0),
    CONSTRAINT ara_applied_not_exceed CHECK (amount_applied <= amount)
  );

  CREATE INDEX idx_ara_tenant_id  ON ar_advances (tenant_id);
  CREATE INDEX idx_ara_partner_id ON ar_advances (tenant_id, partner_id);
  CREATE INDEX idx_ara_available  ON ar_advances (tenant_id, partner_id, amount_available)
    WHERE amount_applied < amount;

  CREATE TRIGGER set_updated_at_ar_advances
    BEFORE UPDATE ON ar_advances
    FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

  COMMENT ON COLUMN ar_advances.amount_available IS 'Calculado: total - aplicado — disponible para aplicar a facturas';

  -- Notas de crédito
  CREATE TABLE credit_notes (
    id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id        UUID               NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    type             invoice_type       NOT NULL,
    document_number  VARCHAR(30)        NOT NULL,
    cfdi_uuid        UUID,
    partner_id       UUID               NOT NULL REFERENCES business_partners(id),
    original_doc_id  UUID,
    original_doc_type VARCHAR(20),
    reason           credit_note_reason NOT NULL,
    amount           DECIMAL(14,2)      NOT NULL,
    tax_amount       DECIMAL(14,2)      NOT NULL DEFAULT 0,
    total            DECIMAL(14,2)      NOT NULL,
    issue_date       DATE               NOT NULL DEFAULT CURRENT_DATE,
    status           invoice_status     NOT NULL DEFAULT 'draft',
    notes            TEXT,
    created_by       UUID               REFERENCES users(id) ON DELETE SET NULL,
    created_at       TIMESTAMPTZ        NOT NULL DEFAULT NOW(),

    CONSTRAINT cn_number_tenant UNIQUE (tenant_id, document_number),
    CONSTRAINT cn_amount_positive CHECK (amount > 0)
  );

  CREATE INDEX idx_cn_tenant_id  ON credit_notes (tenant_id);
  CREATE INDEX idx_cn_partner_id ON credit_notes (tenant_id, partner_id);
  CREATE INDEX idx_cn_type       ON credit_notes (tenant_id, type);

  -- ─── CXP — Cuentas por pagar (espejo de CXC) ────────────────────────────
  CREATE TABLE accounts_payable (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id       UUID             NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    partner_id      UUID             NOT NULL REFERENCES business_partners(id),
    document_type   ar_document_type NOT NULL,
    document_id     UUID             NOT NULL,
    document_number VARCHAR(30)      NOT NULL,
    currency        document_currency NOT NULL DEFAULT 'MXN',
    exchange_rate   DECIMAL(12,6)    NOT NULL DEFAULT 1,
    amount_total    DECIMAL(14,2)    NOT NULL,
    amount_paid     DECIMAL(14,2)    NOT NULL DEFAULT 0,
    amount_pending  DECIMAL(14,2)    GENERATED ALWAYS AS (amount_total - amount_paid) STORED,
    issue_date      DATE             NOT NULL,
    due_date        DATE,
    status          ar_status        NOT NULL DEFAULT 'pending',
    notes           TEXT,
    created_by      UUID             REFERENCES users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ      NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ      NOT NULL DEFAULT NOW(),

    CONSTRAINT ap_amount_positive CHECK (amount_total > 0),
    CONSTRAINT ap_paid_not_exceed CHECK (amount_paid <= amount_total),
    CONSTRAINT ap_doc_unique      UNIQUE (tenant_id, document_type, document_id)
  );

  CREATE INDEX idx_ap_tenant_id  ON accounts_payable (tenant_id);
  CREATE INDEX idx_ap_partner_id ON accounts_payable (tenant_id, partner_id);
  CREATE INDEX idx_ap_status     ON accounts_payable (tenant_id, status);
  CREATE INDEX idx_ap_due_date   ON accounts_payable (tenant_id, due_date) WHERE status IN ('pending','partial');

  CREATE TRIGGER set_updated_at_accounts_payable
    BEFORE UPDATE ON accounts_payable
    FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

  -- Pagos a proveedores
  CREATE TABLE ap_payments (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id       UUID           NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    ap_id           UUID           NOT NULL REFERENCES accounts_payable(id),
    amount          DECIMAL(14,2)  NOT NULL,
    payment_method  payment_method NOT NULL,
    reference       VARCHAR(100),
    payment_date    DATE           NOT NULL DEFAULT CURRENT_DATE,
    notes           TEXT,
    created_by      UUID           REFERENCES users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ    NOT NULL DEFAULT NOW(),

    CONSTRAINT app_amount_positive CHECK (amount > 0),
    CONSTRAINT app_reference_required CHECK (
      payment_method NOT IN ('transfer','check') OR reference IS NOT NULL
    )
  );

  CREATE INDEX idx_app_ap_id     ON ap_payments (ap_id);
  CREATE INDEX idx_app_tenant_id ON ap_payments (tenant_id);
  CREATE INDEX idx_app_date      ON ap_payments (tenant_id, payment_date DESC);
`

const down = `
  DROP TRIGGER IF EXISTS set_updated_at_accounts_payable    ON accounts_payable;
  DROP TRIGGER IF EXISTS set_updated_at_ar_advances         ON ar_advances;
  DROP TRIGGER IF EXISTS set_updated_at_accounts_receivable ON accounts_receivable;
  DROP TABLE IF EXISTS ap_payments          CASCADE;
  DROP TABLE IF EXISTS accounts_payable     CASCADE;
  DROP TABLE IF EXISTS credit_notes         CASCADE;
  DROP TABLE IF EXISTS ar_advances          CASCADE;
  DROP TABLE IF EXISTS ar_payments          CASCADE;
  DROP TABLE IF EXISTS accounts_receivable  CASCADE;
  DROP TYPE  IF EXISTS credit_note_reason   CASCADE;
  DROP TYPE  IF EXISTS payment_method       CASCADE;
  DROP TYPE  IF EXISTS ar_status            CASCADE;
  DROP TYPE  IF EXISTS ar_document_type     CASCADE;
`

module.exports = { up, down }
