'use strict'

const up = `
  CREATE TYPE invoice_type   AS ENUM ('issued', 'received');
  CREATE TYPE invoice_status AS ENUM ('draft', 'stamped', 'cancelled');
  CREATE TYPE cfdi_type      AS ENUM ('I', 'E', 'P', 'N', 'T');

  CREATE TABLE invoices (
    id                   UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id            UUID           NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    type                 invoice_type   NOT NULL,
    cfdi_type            cfdi_type      NOT NULL DEFAULT 'I',
    series               VARCHAR(10),
    folio                VARCHAR(20),
    document_number      VARCHAR(30)    NOT NULL,
    cfdi_uuid            UUID,
    partner_id           UUID           NOT NULL REFERENCES business_partners(id),
    delivery_note_id     UUID           REFERENCES delivery_notes(id),
    currency             document_currency NOT NULL DEFAULT 'MXN',
    exchange_rate_id     UUID           REFERENCES exchange_rates(id),
    exchange_rate_value  DECIMAL(12,6),
    subtotal             DECIMAL(14,2)  NOT NULL DEFAULT 0,
    tax_transferred      DECIMAL(14,2)  NOT NULL DEFAULT 0,
    tax_withheld         DECIMAL(14,2)  NOT NULL DEFAULT 0,
    total                DECIMAL(14,2)  NOT NULL DEFAULT 0,
    total_mxn            DECIMAL(14,2)  NOT NULL DEFAULT 0,
    payment_method       VARCHAR(3)     DEFAULT 'PUE',
    payment_form         VARCHAR(3),
    use_cfdi             VARCHAR(3)     DEFAULT 'G01',
    status               invoice_status NOT NULL DEFAULT 'draft',
    issue_date           DATE           NOT NULL DEFAULT CURRENT_DATE,
    stamp_date           TIMESTAMPTZ,
    cancellation_date    TIMESTAMPTZ,
    cancellation_reason  TEXT,
    xml_path             VARCHAR(500),
    pdf_path             VARCHAR(500),
    notes                TEXT,
    created_by           UUID           REFERENCES users(id) ON DELETE SET NULL,
    created_at           TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
    updated_at           TIMESTAMPTZ    NOT NULL DEFAULT NOW(),

    CONSTRAINT inv_number_tenant UNIQUE (tenant_id, document_number),
    CONSTRAINT inv_uuid_unique   UNIQUE (cfdi_uuid)
  );

  CREATE INDEX idx_inv_tenant_id    ON invoices (tenant_id);
  CREATE INDEX idx_inv_partner_id   ON invoices (tenant_id, partner_id);
  CREATE INDEX idx_inv_status       ON invoices (tenant_id, status);
  CREATE INDEX idx_inv_type         ON invoices (tenant_id, type);
  CREATE INDEX idx_inv_issue_date   ON invoices (tenant_id, issue_date DESC);
  CREATE INDEX idx_inv_cfdi_uuid    ON invoices (cfdi_uuid) WHERE cfdi_uuid IS NOT NULL;
  CREATE INDEX idx_inv_delivery     ON invoices (delivery_note_id);

  COMMENT ON COLUMN invoices.cfdi_type      IS 'I=Ingreso, E=Egreso, P=Pago, N=Nómina, T=Traslado';
  COMMENT ON COLUMN invoices.payment_method IS 'PUE=Pago en una sola exhibición, PPD=Pago en parcialidades';
  COMMENT ON COLUMN invoices.use_cfdi       IS 'Uso del CFDI según catálogo SAT — G01=Adquisición de mercancias';
  COMMENT ON COLUMN invoices.total_mxn      IS 'Total convertido a MXN al TC del día de emisión';
  COMMENT ON COLUMN invoices.xml_path       IS 'Ruta del XML timbrado en uploads/';

  CREATE TRIGGER set_updated_at_invoices
    BEFORE UPDATE ON invoices
    FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

  -- Líneas de factura
  CREATE TABLE invoice_lines (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    invoice_id  UUID          NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
    product_id  UUID          REFERENCES products(id),
    description VARCHAR(500)  NOT NULL,
    quantity    DECIMAL(14,4) NOT NULL,
    unit        VARCHAR(20)   NOT NULL DEFAULT 'paquete',
    unit_price  DECIMAL(14,4) NOT NULL,
    discount_pct DECIMAL(5,2) NOT NULL DEFAULT 0,
    subtotal    DECIMAL(14,2) GENERATED ALWAYS AS
                (ROUND((quantity * unit_price * (1 - discount_pct/100))::numeric, 2)) STORED,
    tax_rate    DECIMAL(5,2)  NOT NULL DEFAULT 16.00,
    tax_amount  DECIMAL(14,2) GENERATED ALWAYS AS
                (ROUND((quantity * unit_price * (1 - discount_pct/100) * tax_rate/100)::numeric, 2)) STORED,
    sat_product_code VARCHAR(8),
    sat_unit_code    VARCHAR(5)  DEFAULT 'H87',
    line_number INTEGER NOT NULL,

    CONSTRAINT il_qty_positive   CHECK (quantity > 0),
    CONSTRAINT il_price_positive CHECK (unit_price > 0)
  );

  CREATE INDEX idx_il_invoice_id ON invoice_lines (invoice_id);

  COMMENT ON COLUMN invoice_lines.sat_product_code IS 'Clave de producto SAT (catálogo c_ClaveProdServ)';
  COMMENT ON COLUMN invoice_lines.sat_unit_code    IS 'Clave de unidad SAT — H87=pieza, KGM=kilogramo';
`

const down = `
  DROP TRIGGER IF EXISTS set_updated_at_invoices ON invoices;
  DROP TABLE IF EXISTS invoice_lines CASCADE;
  DROP TABLE IF EXISTS invoices      CASCADE;
  DROP TYPE  IF EXISTS cfdi_type     CASCADE;
  DROP TYPE  IF EXISTS invoice_status CASCADE;
  DROP TYPE  IF EXISTS invoice_type   CASCADE;
`

module.exports = { up, down }
