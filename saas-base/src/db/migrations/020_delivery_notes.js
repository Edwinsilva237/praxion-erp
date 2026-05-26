'use strict'

const up = `
  CREATE TYPE delivery_note_type AS ENUM ('sale', 'purchase');

  CREATE TYPE delivery_note_status AS ENUM (
    'issued',
    'sent_by_email',
    'partially_delivered',
    'delivered',
    'invoiced',
    'cancelled'
  );

  CREATE TABLE delivery_notes (
    id                   UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id            UUID                NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    type                 delivery_note_type  NOT NULL,
    document_number      VARCHAR(20)         NOT NULL,
    partner_id           UUID                NOT NULL REFERENCES business_partners(id),
    sales_order_id       UUID                REFERENCES sales_orders(id),
    delivery_address_id  UUID                REFERENCES delivery_addresses(id),
    currency             document_currency   NOT NULL DEFAULT 'MXN',
    exchange_rate_id     UUID                REFERENCES exchange_rates(id),
    exchange_rate_value  DECIMAL(12,6),
    subtotal_mxn         DECIMAL(14,2)       NOT NULL DEFAULT 0,
    tax_mxn              DECIMAL(14,2)       NOT NULL DEFAULT 0,
    total_mxn            DECIMAL(14,2)       NOT NULL DEFAULT 0,
    status               delivery_note_status NOT NULL DEFAULT 'issued',
    issue_date           DATE                NOT NULL DEFAULT CURRENT_DATE,
    credit_due_date      DATE,
    notes                TEXT,
    -- Evidencia de entrega (capturada offline por repartidor)
    receiver_name        VARCHAR(150),
    receiver_photo_path  VARCHAR(500),
    delivered_at         TIMESTAMPTZ,
    delivered_by         UUID                REFERENCES users(id) ON DELETE SET NULL,
    synced_at            TIMESTAMPTZ,
    -- Control
    created_by           UUID                REFERENCES users(id) ON DELETE SET NULL,
    created_at           TIMESTAMPTZ         NOT NULL DEFAULT NOW(),
    updated_at           TIMESTAMPTZ         NOT NULL DEFAULT NOW(),

    CONSTRAINT dn_number_tenant UNIQUE (tenant_id, document_number),
    CONSTRAINT dn_credit_from_issue CHECK (credit_due_date IS NULL OR credit_due_date >= issue_date)
  );

  CREATE INDEX idx_dn_tenant_id  ON delivery_notes (tenant_id);
  CREATE INDEX idx_dn_partner_id ON delivery_notes (tenant_id, partner_id);
  CREATE INDEX idx_dn_status     ON delivery_notes (tenant_id, status);
  CREATE INDEX idx_dn_type       ON delivery_notes (tenant_id, type);
  CREATE INDEX idx_dn_order_id   ON delivery_notes (sales_order_id);
  CREATE INDEX idx_dn_issue_date ON delivery_notes (tenant_id, issue_date DESC);
  CREATE INDEX idx_dn_unsynced   ON delivery_notes (tenant_id, synced_at)
    WHERE synced_at IS NULL AND delivered_at IS NOT NULL;

  COMMENT ON COLUMN delivery_notes.credit_due_date    IS 'Plazo de pago — calculado desde issue_date según días de crédito del cliente';
  COMMENT ON COLUMN delivery_notes.receiver_name      IS 'Nombre de quien recibe — capturado por repartidor';
  COMMENT ON COLUMN delivery_notes.receiver_photo_path IS 'Foto del documento firmado — guardada en uploads/';
  COMMENT ON COLUMN delivery_notes.synced_at          IS 'NULL = evidencia pendiente de sincronizar (capturada offline)';

  CREATE TRIGGER set_updated_at_delivery_notes
    BEFORE UPDATE ON delivery_notes
    FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

  -- Líneas de remisión
  CREATE TABLE delivery_note_lines (
    id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    delivery_note_id UUID          NOT NULL REFERENCES delivery_notes(id) ON DELETE CASCADE,
    product_id       UUID          NOT NULL REFERENCES products(id),
    quantity_ordered DECIMAL(14,4) NOT NULL,
    quantity_delivered DECIMAL(14,4) NOT NULL DEFAULT 0,
    unit             VARCHAR(20)   NOT NULL DEFAULT 'paquete',
    unit_price       DECIMAL(14,4) NOT NULL,
    currency         document_currency NOT NULL DEFAULT 'MXN',
    discount_pct     DECIMAL(5,2)  NOT NULL DEFAULT 0,
    subtotal         DECIMAL(14,2) GENERATED ALWAYS AS
                     (ROUND((quantity_delivered * unit_price * (1 - discount_pct/100))::numeric, 2)) STORED,
    line_number      INTEGER       NOT NULL,
    notes            TEXT,

    CONSTRAINT dnl_qty_positive CHECK (quantity_ordered > 0)
  );

  CREATE INDEX idx_dnl_note_id ON delivery_note_lines (delivery_note_id);

  COMMENT ON COLUMN delivery_note_lines.quantity_ordered   IS 'Cantidad solicitada en el pedido';
  COMMENT ON COLUMN delivery_note_lines.quantity_delivered IS 'Cantidad efectivamente entregada — puede ser menor (entrega parcial)';
`

const down = `
  DROP TRIGGER IF EXISTS set_updated_at_delivery_notes ON delivery_notes;
  DROP TABLE IF EXISTS delivery_note_lines CASCADE;
  DROP TABLE IF EXISTS delivery_notes      CASCADE;
  DROP TYPE  IF EXISTS delivery_note_status CASCADE;
  DROP TYPE  IF EXISTS delivery_note_type   CASCADE;
`

module.exports = { up, down }
