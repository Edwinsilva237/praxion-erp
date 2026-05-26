'use strict'

const up = `
  CREATE TYPE supplier_receipt_status AS ENUM (
    'draft',
    'confirmed',
    'cancelled'
  );

  CREATE TABLE supplier_receipts (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id           UUID                     NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    receipt_number      VARCHAR(20)              NOT NULL,
    purchase_order_id   UUID                     REFERENCES purchase_orders(id),
    partner_id          UUID                     REFERENCES business_partners(id),
    generic_supplier    VARCHAR(150),
    warehouse_id        UUID                     NOT NULL REFERENCES warehouses(id),
    received_date       DATE                     NOT NULL DEFAULT CURRENT_DATE,
    status              supplier_receipt_status  NOT NULL DEFAULT 'draft',
    notes               TEXT,
    created_by          UUID                     REFERENCES users(id) ON DELETE SET NULL,
    confirmed_by        UUID                     REFERENCES users(id) ON DELETE SET NULL,
    confirmed_at        TIMESTAMPTZ,
    created_at          TIMESTAMPTZ              NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ              NOT NULL DEFAULT NOW(),

    CONSTRAINT sr_number_tenant UNIQUE (tenant_id, receipt_number)
  );

  CREATE INDEX idx_sr_tenant_id          ON supplier_receipts (tenant_id);
  CREATE INDEX idx_sr_purchase_order_id  ON supplier_receipts (purchase_order_id);
  CREATE INDEX idx_sr_partner_id         ON supplier_receipts (tenant_id, partner_id);
  CREATE INDEX idx_sr_status             ON supplier_receipts (tenant_id, status);
  CREATE INDEX idx_sr_received_date      ON supplier_receipts (tenant_id, received_date);

  CREATE TRIGGER set_updated_at_supplier_receipts
    BEFORE UPDATE ON supplier_receipts
    FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

  -- Líneas de recepción
  CREATE TABLE supplier_receipt_lines (
    id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    supplier_receipt_id   UUID          NOT NULL REFERENCES supplier_receipts(id) ON DELETE CASCADE,
    purchase_order_line_id UUID         REFERENCES purchase_order_lines(id),
    item_type             inventory_item_type,
    item_id               UUID,
    description           VARCHAR(300),
    quantity_received     DECIMAL(14,4) NOT NULL,
    unit                  VARCHAR(20)   NOT NULL DEFAULT 'kg',
    unit_price            DECIMAL(14,4) NOT NULL DEFAULT 0,
    subtotal              DECIMAL(14,2) GENERATED ALWAYS AS
                          (ROUND((quantity_received * unit_price)::numeric, 2)) STORED,
    warehouse_id          UUID          REFERENCES warehouses(id),
    is_generic            BOOLEAN       NOT NULL DEFAULT FALSE,
    generic_category      VARCHAR(60),
    line_number           INTEGER       NOT NULL,
    notes                 TEXT,

    CONSTRAINT srl_qty_positive CHECK (quantity_received > 0)
  );

  CREATE INDEX idx_srl_receipt_id ON supplier_receipt_lines (supplier_receipt_id);
  CREATE INDEX idx_srl_pol_id     ON supplier_receipt_lines (purchase_order_line_id);

  COMMENT ON TABLE  supplier_receipts                        IS 'Recepción física de mercancía de proveedor';
  COMMENT ON COLUMN supplier_receipts.purchase_order_id      IS 'OC de origen, NULL si recepción sin OC previa';
  COMMENT ON COLUMN supplier_receipt_lines.purchase_order_line_id IS 'Línea de OC de origen, NULL si genérica';
  COMMENT ON COLUMN supplier_receipt_lines.quantity_received IS 'Cantidad real recibida (puede diferir del estimado en OC)';
  COMMENT ON COLUMN supplier_receipt_lines.unit_price        IS 'Precio real confirmado al recepcionar';
`

const down = `
  DROP TRIGGER IF EXISTS set_updated_at_supplier_receipts ON supplier_receipts;
  DROP TABLE IF EXISTS supplier_receipt_lines CASCADE;
  DROP TABLE IF EXISTS supplier_receipts      CASCADE;
  DROP TYPE  IF EXISTS supplier_receipt_status CASCADE;
`

module.exports = { up, down }
