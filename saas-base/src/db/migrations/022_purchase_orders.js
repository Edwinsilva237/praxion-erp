'use strict'

const up = `
  CREATE TYPE purchase_order_status AS ENUM (
    'draft',
    'sent',
    'partially_received',
    'received',
    'cancelled'
  );

  CREATE TABLE purchase_orders (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id       UUID                  NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    order_number    VARCHAR(20)           NOT NULL,
    partner_id      UUID                  NOT NULL REFERENCES business_partners(id),
    currency        document_currency     NOT NULL DEFAULT 'MXN',
    exchange_rate_id UUID                 REFERENCES exchange_rates(id),
    exchange_rate_value DECIMAL(12,6),
    subtotal_mxn    DECIMAL(14,2)         NOT NULL DEFAULT 0,
    tax_mxn         DECIMAL(14,2)         NOT NULL DEFAULT 0,
    total_mxn       DECIMAL(14,2)         NOT NULL DEFAULT 0,
    expected_date   DATE,
    status          purchase_order_status NOT NULL DEFAULT 'draft',
    notes           TEXT,
    created_by      UUID                  REFERENCES users(id) ON DELETE SET NULL,
    approved_by     UUID                  REFERENCES users(id) ON DELETE SET NULL,
    approved_at     TIMESTAMPTZ,
    created_at      TIMESTAMPTZ           NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ           NOT NULL DEFAULT NOW(),

    CONSTRAINT poc_number_tenant UNIQUE (tenant_id, order_number)
  );

  CREATE INDEX idx_poc_tenant_id  ON purchase_orders (tenant_id);
  CREATE INDEX idx_poc_partner_id ON purchase_orders (tenant_id, partner_id);
  CREATE INDEX idx_poc_status     ON purchase_orders (tenant_id, status);

  CREATE TRIGGER set_updated_at_purchase_orders
    BEFORE UPDATE ON purchase_orders
    FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

  -- Líneas de OC — pueden ser MP o productos de reventa
  CREATE TABLE purchase_order_lines (
    id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    purchase_order_id UUID          NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
    item_type         inventory_item_type NOT NULL,
    item_id           UUID          NOT NULL,
    description       VARCHAR(300),
    quantity          DECIMAL(14,4) NOT NULL,
    unit              VARCHAR(20)   NOT NULL DEFAULT 'kg',
    unit_price        DECIMAL(14,4) NOT NULL,
    currency          document_currency NOT NULL DEFAULT 'MXN',
    subtotal          DECIMAL(14,2) GENERATED ALWAYS AS
                      (ROUND((quantity * unit_price)::numeric, 2)) STORED,
    warehouse_id      UUID          REFERENCES warehouses(id),
    line_number       INTEGER       NOT NULL,
    notes             TEXT,

    CONSTRAINT pol_qty_positive   CHECK (quantity > 0),
    CONSTRAINT pol_price_positive CHECK (unit_price > 0)
  );

  CREATE INDEX idx_pol_order_id ON purchase_order_lines (purchase_order_id);

  COMMENT ON COLUMN purchase_order_lines.item_type    IS 'raw_material o product (reventa)';
  COMMENT ON COLUMN purchase_order_lines.warehouse_id IS 'Almacén destino de la recepción';
`

const down = `
  DROP TRIGGER IF EXISTS set_updated_at_purchase_orders ON purchase_orders;
  DROP TABLE IF EXISTS purchase_order_lines CASCADE;
  DROP TABLE IF EXISTS purchase_orders      CASCADE;
  DROP TYPE  IF EXISTS purchase_order_status CASCADE;
`

module.exports = { up, down }
