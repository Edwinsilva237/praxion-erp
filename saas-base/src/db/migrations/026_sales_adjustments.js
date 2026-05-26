'use strict'

const up = `
  -- Agregar campos faltantes a delivery_notes
  ALTER TABLE delivery_notes
    ADD COLUMN driver_id       UUID REFERENCES users(id) ON DELETE SET NULL,
    ADD COLUMN scheduled_date  DATE,
    ADD COLUMN po_number       VARCHAR(100);

  CREATE INDEX idx_dn_driver_id      ON delivery_notes (tenant_id, driver_id);
  CREATE INDEX idx_dn_scheduled_date ON delivery_notes (tenant_id, scheduled_date);

  COMMENT ON COLUMN delivery_notes.driver_id      IS 'Repartidor asignado a esta entrega';
  COMMENT ON COLUMN delivery_notes.scheduled_date IS 'Fecha programada de entrega — para hoja de ruta diaria';
  COMMENT ON COLUMN delivery_notes.po_number      IS 'Número de OC del cliente referenciado en el documento';

  -- Agregar scheduled_date y po_number a sales_orders
  ALTER TABLE sales_orders
    ADD COLUMN scheduled_date DATE,
    ADD COLUMN driver_id      UUID REFERENCES users(id) ON DELETE SET NULL,
    ADD COLUMN po_number      VARCHAR(100),
    ADD COLUMN direct_invoice BOOLEAN NOT NULL DEFAULT false;

  CREATE INDEX idx_so_scheduled_date ON sales_orders (tenant_id, scheduled_date);
  CREATE INDEX idx_so_driver_id      ON sales_orders (tenant_id, driver_id);

  COMMENT ON COLUMN sales_orders.scheduled_date IS 'Fecha programada de entrega — para planificación logística';
  COMMENT ON COLUMN sales_orders.direct_invoice IS 'Si es true, se factura directo sin generar remisión';
  COMMENT ON COLUMN sales_orders.po_number      IS 'Número de OC del cliente';

  -- Preferencias de envío automático en business_partners
  ALTER TABLE business_partners
    ADD COLUMN auto_send_invoice    BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN auto_send_remission  BOOLEAN NOT NULL DEFAULT false;

  COMMENT ON COLUMN business_partners.auto_send_invoice   IS 'Envía PDF+XML automáticamente al timbrar — si false muestra alerta';
  COMMENT ON COLUMN business_partners.auto_send_remission IS 'Envía PDF automáticamente al emitir remisión';

  -- Correos de facturación por cliente (pueden ser varios)
  CREATE TABLE business_partner_invoice_emails (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    business_partner_id UUID         NOT NULL REFERENCES business_partners(id) ON DELETE CASCADE,
    tenant_id           UUID         NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    email               VARCHAR(255) NOT NULL,
    name                VARCHAR(150),
    is_active           BOOLEAN      NOT NULL DEFAULT true,
    created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

    CONSTRAINT bpie_email_unique UNIQUE (business_partner_id, email)
  );

  CREATE INDEX idx_bpie_partner_id ON business_partner_invoice_emails (business_partner_id);
  CREATE INDEX idx_bpie_tenant_id  ON business_partner_invoice_emails (tenant_id);

  COMMENT ON TABLE  business_partner_invoice_emails      IS 'Correos de facturación por cliente — todos reciben XML+PDF al timbrar';
  COMMENT ON COLUMN business_partner_invoice_emails.name IS 'Nombre del contacto o área: Cuentas por pagar, Contabilidad, etc.';
`

const down = `
  DROP TABLE IF EXISTS business_partner_invoice_emails CASCADE;
  ALTER TABLE business_partners
    DROP COLUMN IF EXISTS auto_send_invoice,
    DROP COLUMN IF EXISTS auto_send_remission;
  ALTER TABLE sales_orders
    DROP COLUMN IF EXISTS scheduled_date,
    DROP COLUMN IF EXISTS driver_id,
    DROP COLUMN IF EXISTS po_number,
    DROP COLUMN IF EXISTS direct_invoice;
  ALTER TABLE delivery_notes
    DROP COLUMN IF EXISTS driver_id,
    DROP COLUMN IF EXISTS scheduled_date,
    DROP COLUMN IF EXISTS po_number;
`

module.exports = { up, down }
