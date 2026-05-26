'use strict'

const up = `
  CREATE TYPE supplier_invoice_type AS ENUM (
    'invoice',    -- Factura con UUID SAT
    'remission'   -- Remisión sin factura (se factura después)
  );

  CREATE TYPE supplier_invoice_status AS ENUM (
    'pending',    -- Pendiente de pago
    'partial',    -- Pago parcial
    'paid',       -- Pagada
    'cancelled'   -- Cancelada
  );

  CREATE TABLE supplier_invoices (
    id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id             UUID                     NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    invoice_number        VARCHAR(30)              NOT NULL,
    type                  supplier_invoice_type    NOT NULL DEFAULT 'invoice',
    status                supplier_invoice_status  NOT NULL DEFAULT 'pending',
    partner_id            UUID                     REFERENCES business_partners(id),
    generic_supplier      VARCHAR(150),
    supplier_receipt_id   UUID                     REFERENCES supplier_receipts(id),
    purchase_order_id     UUID                     REFERENCES purchase_orders(id),

    -- Datos fiscales (solo facturas)
    uuid_sat              UUID,
    rfc_emisor            VARCHAR(13),
    serie                 VARCHAR(10),
    folio                 VARCHAR(20),

    -- Cuando una remisión recibe su factura
    replaced_by_invoice_id UUID                   REFERENCES supplier_invoices(id),

    -- Importes
    currency              document_currency        NOT NULL DEFAULT 'MXN',
    exchange_rate_id      UUID                     REFERENCES exchange_rates(id),
    exchange_rate_value   DECIMAL(12,6),
    subtotal              DECIMAL(14,2)            NOT NULL DEFAULT 0,
    tax                   DECIMAL(14,2)            NOT NULL DEFAULT 0,
    total                 DECIMAL(14,2)            NOT NULL DEFAULT 0,
    total_mxn             DECIMAL(14,2)            NOT NULL DEFAULT 0,
    balance               DECIMAL(14,2)            NOT NULL DEFAULT 0,

    -- Fechas
    invoice_date          DATE                     NOT NULL DEFAULT CURRENT_DATE,
    due_date              DATE,
    received_date         DATE                     NOT NULL DEFAULT CURRENT_DATE,

    notes                 TEXT,
    created_by            UUID                     REFERENCES users(id) ON DELETE SET NULL,
    created_at            TIMESTAMPTZ              NOT NULL DEFAULT NOW(),
    updated_at            TIMESTAMPTZ              NOT NULL DEFAULT NOW(),

    CONSTRAINT si_number_tenant   UNIQUE (tenant_id, invoice_number),
    CONSTRAINT si_uuid_sat_unique UNIQUE (uuid_sat),
    CONSTRAINT si_total_positive  CHECK (total >= 0),
    CONSTRAINT si_balance_valid   CHECK (balance >= 0 AND balance <= total_mxn)
  );

  CREATE INDEX idx_si_tenant_id           ON supplier_invoices (tenant_id);
  CREATE INDEX idx_si_partner_id          ON supplier_invoices (tenant_id, partner_id);
  CREATE INDEX idx_si_status              ON supplier_invoices (tenant_id, status);
  CREATE INDEX idx_si_due_date            ON supplier_invoices (tenant_id, due_date);
  CREATE INDEX idx_si_purchase_order_id   ON supplier_invoices (purchase_order_id);
  CREATE INDEX idx_si_supplier_receipt_id ON supplier_invoices (supplier_receipt_id);

  CREATE TRIGGER set_updated_at_supplier_invoices
    BEFORE UPDATE ON supplier_invoices
    FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

  -- Pagos a proveedores
  CREATE TYPE ap_payment_method AS ENUM (
    'transfer',
    'cash',
    'check'
  );

  CREATE TABLE supplier_payments (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id           UUID                 NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    partner_id          UUID                 REFERENCES business_partners(id),
    generic_supplier    VARCHAR(150),
    payment_date        DATE                 NOT NULL DEFAULT CURRENT_DATE,
    method              ap_payment_method    NOT NULL DEFAULT 'transfer',
    reference           VARCHAR(100),
    amount              DECIMAL(14,2)        NOT NULL,
    currency            document_currency    NOT NULL DEFAULT 'MXN',
    exchange_rate_value DECIMAL(12,6),
    amount_mxn          DECIMAL(14,2)        NOT NULL,
    notes               TEXT,
    created_by          UUID                 REFERENCES users(id) ON DELETE SET NULL,
    created_at          TIMESTAMPTZ          NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ          NOT NULL DEFAULT NOW(),

    CONSTRAINT sp_amount_positive CHECK (amount > 0)
  );

  CREATE INDEX idx_sp_tenant_id  ON supplier_payments (tenant_id);
  CREATE INDEX idx_sp_partner_id ON supplier_payments (tenant_id, partner_id);
  CREATE INDEX idx_sp_date       ON supplier_payments (tenant_id, payment_date);

  CREATE TRIGGER set_updated_at_supplier_payments
    BEFORE UPDATE ON supplier_payments
    FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

  -- Aplicación de pagos a facturas (N:M)
  CREATE TABLE supplier_payment_applications (
    id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    supplier_payment_id   UUID          NOT NULL REFERENCES supplier_payments(id) ON DELETE CASCADE,
    supplier_invoice_id   UUID          NOT NULL REFERENCES supplier_invoices(id) ON DELETE CASCADE,
    amount_applied        DECIMAL(14,2) NOT NULL,
    applied_at            TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    created_by            UUID          REFERENCES users(id) ON DELETE SET NULL,

    CONSTRAINT spa_amount_positive CHECK (amount_applied > 0),
    CONSTRAINT spa_unique UNIQUE (supplier_payment_id, supplier_invoice_id)
  );

  CREATE INDEX idx_spa_payment_id ON supplier_payment_applications (supplier_payment_id);
  CREATE INDEX idx_spa_invoice_id ON supplier_payment_applications (supplier_invoice_id);

  COMMENT ON TABLE  supplier_invoices                          IS 'Facturas y remisiones de proveedores (CXP)';
  COMMENT ON COLUMN supplier_invoices.type                     IS 'invoice=factura con UUID SAT, remission=sin factura';
  COMMENT ON COLUMN supplier_invoices.replaced_by_invoice_id   IS 'Cuando una remisión es sustituida por factura definitiva';
  COMMENT ON COLUMN supplier_invoices.balance                  IS 'Saldo pendiente en MXN, se actualiza con cada pago';
  COMMENT ON COLUMN supplier_invoices.due_date                 IS 'Fecha límite de pago según condiciones del proveedor';
  COMMENT ON TABLE  supplier_payments                          IS 'Pagos realizados a proveedores';
  COMMENT ON TABLE  supplier_payment_applications              IS 'Aplicación de pagos a facturas específicas';
`

const down = `
  DROP TRIGGER IF EXISTS set_updated_at_supplier_payments ON supplier_payments;
  DROP TRIGGER IF EXISTS set_updated_at_supplier_invoices ON supplier_invoices;
  DROP TABLE IF EXISTS supplier_payment_applications CASCADE;
  DROP TABLE IF EXISTS supplier_payments             CASCADE;
  DROP TABLE IF EXISTS supplier_invoices             CASCADE;
  DROP TYPE  IF EXISTS ap_payment_method             CASCADE;
  DROP TYPE  IF EXISTS supplier_invoice_status       CASCADE;
  DROP TYPE  IF EXISTS supplier_invoice_type         CASCADE;
`

module.exports = { up, down }
