'use strict'

const up = `
  CREATE TABLE payment_complements (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id       UUID         NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    invoice_id      UUID         NOT NULL REFERENCES invoices(id),
    facturapi_id    VARCHAR(50)  NOT NULL,
    cfdi_uuid       UUID         NOT NULL,
    payment_date    DATE         NOT NULL,
    payment_form    VARCHAR(3)   NOT NULL,
    amount          DECIMAL(14,2) NOT NULL,
    currency        document_currency NOT NULL DEFAULT 'MXN',
    reference       VARCHAR(100),
    status          VARCHAR(20)  NOT NULL DEFAULT 'stamped',
    created_by      UUID         REFERENCES users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

    CONSTRAINT pc_uuid_unique UNIQUE (cfdi_uuid)
  );

  CREATE INDEX idx_pc_tenant_id  ON payment_complements (tenant_id);
  CREATE INDEX idx_pc_invoice_id ON payment_complements (invoice_id);

  COMMENT ON TABLE payment_complements IS 'Complementos de pago CFDI tipo P vinculados a facturas PPD';
`

const down = `
  DROP TABLE IF EXISTS payment_complements CASCADE;
`

module.exports = { up, down }
