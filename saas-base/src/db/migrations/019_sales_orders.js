'use strict'

const up = `
  CREATE TYPE sales_order_status AS ENUM (
    'draft',
    'confirmed',
    'in_delivery',
    'delivered',
    'cancelled'
  );

  CREATE TABLE sales_orders (
    id                   UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id            UUID              NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    order_number         VARCHAR(20)       NOT NULL,
    partner_id           UUID              NOT NULL REFERENCES business_partners(id),
    delivery_address_id  UUID              REFERENCES delivery_addresses(id),
    currency             document_currency NOT NULL DEFAULT 'MXN',
    exchange_rate_id     UUID              REFERENCES exchange_rates(id),
    exchange_rate_value  DECIMAL(12,6),
    subtotal_mxn         DECIMAL(14,2)     NOT NULL DEFAULT 0,
    tax_mxn              DECIMAL(14,2)     NOT NULL DEFAULT 0,
    total_mxn            DECIMAL(14,2)     NOT NULL DEFAULT 0,
    status               sales_order_status NOT NULL DEFAULT 'draft',
    notes                TEXT,
    created_by           UUID              REFERENCES users(id) ON DELETE SET NULL,
    confirmed_by         UUID              REFERENCES users(id) ON DELETE SET NULL,
    confirmed_at         TIMESTAMPTZ,
    created_at           TIMESTAMPTZ       NOT NULL DEFAULT NOW(),
    updated_at           TIMESTAMPTZ       NOT NULL DEFAULT NOW(),

    CONSTRAINT so_number_tenant UNIQUE (tenant_id, order_number)
  );

  CREATE INDEX idx_so_tenant_id  ON sales_orders (tenant_id);
  CREATE INDEX idx_so_partner_id ON sales_orders (tenant_id, partner_id);
  CREATE INDEX idx_so_status     ON sales_orders (tenant_id, status);

  CREATE TRIGGER set_updated_at_sales_orders
    BEFORE UPDATE ON sales_orders
    FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

  -- Líneas del pedido
  CREATE TABLE sales_order_lines (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    sales_order_id  UUID          NOT NULL REFERENCES sales_orders(id) ON DELETE CASCADE,
    product_id      UUID          NOT NULL REFERENCES products(id),
    quantity        DECIMAL(14,4) NOT NULL,
    unit            VARCHAR(20)   NOT NULL DEFAULT 'paquete',
    unit_price      DECIMAL(14,4) NOT NULL,
    currency        document_currency NOT NULL DEFAULT 'MXN',
    discount_pct    DECIMAL(5,2)  NOT NULL DEFAULT 0,
    subtotal        DECIMAL(14,2) GENERATED ALWAYS AS
                    (ROUND((quantity * unit_price * (1 - discount_pct/100))::numeric, 2)) STORED,
    notes           TEXT,
    line_number     INTEGER       NOT NULL,

    CONSTRAINT sol_quantity_positive CHECK (quantity > 0),
    CONSTRAINT sol_price_positive    CHECK (unit_price > 0)
  );

  CREATE INDEX idx_sol_order_id ON sales_order_lines (sales_order_id);

  COMMENT ON COLUMN sales_order_lines.unit_price IS 'Precio al momento del pedido — puede ser del catálogo o negociado';
  COMMENT ON COLUMN sales_order_lines.subtotal   IS 'Calculado: qty × precio × (1 - descuento%)';
`

const down = `
  DROP TRIGGER IF EXISTS set_updated_at_sales_orders ON sales_orders;
  DROP TABLE IF EXISTS sales_order_lines CASCADE;
  DROP TABLE IF EXISTS sales_orders      CASCADE;
  DROP TYPE  IF EXISTS sales_order_status CASCADE;
`

module.exports = { up, down }
