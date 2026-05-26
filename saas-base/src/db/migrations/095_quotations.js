'use strict'

/**
 * Cotizaciones (`quotations` + `quotation_lines`).
 *
 * Entidad SEPARADA de sales_orders (decisión sesión 7, 2026-05-14):
 *   - Ciclo propio: draft → sent → accepted → converted / rejected / expired / cancelled.
 *   - Al aceptar y convertir, se crea un sales_order y se guarda en
 *     `quotations.converted_order_id`. Permite trazabilidad y métricas
 *     (tasa de conversión, monto cotizado vs vendido).
 *   - Sin IVA en la cotización (igual que pedidos y remisiones). El IVA aparece
 *     hasta el CFDI (`invoiceService`). Se conservan campos tax_mxn/total_mxn
 *     para compatibilidad — en cotización tax_mxn = 0 y total_mxn = subtotal_mxn.
 *   - `valid_until` — fecha de vigencia. Si pasa sin aceptación, una rutina
 *     diaria mueve el estatus a 'expired'.
 *
 * NO usa sales_orders con un estado previo `quotation` — entidad separada para
 * mantener lifecycle limpio y no ensuciar el conteo de pedidos.
 */

const up = `
  CREATE TYPE quotation_status AS ENUM (
    'draft',
    'sent',
    'accepted',
    'converted',
    'rejected',
    'expired',
    'cancelled'
  );

  CREATE TABLE quotations (
    id                   UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id            UUID              NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    quotation_number     VARCHAR(20)       NOT NULL,
    partner_id           UUID              NOT NULL REFERENCES business_partners(id),
    currency             document_currency NOT NULL DEFAULT 'MXN',
    exchange_rate_id     UUID              REFERENCES exchange_rates(id),
    exchange_rate_value  DECIMAL(12,6),
    subtotal_mxn         DECIMAL(14,2)     NOT NULL DEFAULT 0,
    tax_mxn              DECIMAL(14,2)     NOT NULL DEFAULT 0,
    total_mxn            DECIMAL(14,2)     NOT NULL DEFAULT 0,
    status               quotation_status  NOT NULL DEFAULT 'draft',
    valid_until          DATE,
    notes                TEXT,
    -- Trazabilidad de email enviado al cliente
    sent_at              TIMESTAMPTZ,
    sent_by              UUID              REFERENCES users(id) ON DELETE SET NULL,
    -- Conversión a pedido
    converted_order_id   UUID              REFERENCES sales_orders(id) ON DELETE SET NULL,
    converted_at         TIMESTAMPTZ,
    converted_by         UUID              REFERENCES users(id) ON DELETE SET NULL,
    -- Rechazo / cancelación / expiración
    rejected_at          TIMESTAMPTZ,
    rejected_reason      TEXT,
    cancelled_at         TIMESTAMPTZ,
    expired_at           TIMESTAMPTZ,
    created_by           UUID              REFERENCES users(id) ON DELETE SET NULL,
    created_at           TIMESTAMPTZ       NOT NULL DEFAULT NOW(),
    updated_at           TIMESTAMPTZ       NOT NULL DEFAULT NOW(),

    CONSTRAINT q_number_tenant UNIQUE (tenant_id, quotation_number)
  );

  CREATE INDEX idx_q_tenant_id  ON quotations (tenant_id);
  CREATE INDEX idx_q_partner_id ON quotations (tenant_id, partner_id);
  CREATE INDEX idx_q_status     ON quotations (tenant_id, status);
  CREATE INDEX idx_q_valid      ON quotations (tenant_id, valid_until) WHERE status IN ('draft', 'sent');

  CREATE TRIGGER set_updated_at_quotations
    BEFORE UPDATE ON quotations
    FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

  CREATE TABLE quotation_lines (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    quotation_id    UUID          NOT NULL REFERENCES quotations(id) ON DELETE CASCADE,
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

    CONSTRAINT ql_quantity_positive CHECK (quantity > 0),
    CONSTRAINT ql_price_positive    CHECK (unit_price > 0)
  );

  CREATE INDEX idx_ql_quotation_id ON quotation_lines (quotation_id);

  COMMENT ON COLUMN quotations.valid_until        IS 'Vigencia de la cotización. Pasa a expired automáticamente al amanecer del día siguiente.';
  COMMENT ON COLUMN quotations.converted_order_id IS 'Pedido generado al aceptar la cotización (nullable hasta entonces).';
  COMMENT ON COLUMN quotation_lines.subtotal      IS 'Calculado: qty × precio × (1 - descuento%). NO incluye IVA.';
`

const down = `
  DROP TRIGGER IF EXISTS set_updated_at_quotations ON quotations;
  DROP TABLE IF EXISTS quotation_lines CASCADE;
  DROP TABLE IF EXISTS quotations      CASCADE;
  DROP TYPE  IF EXISTS quotation_status CASCADE;
`

module.exports = { up, down }
