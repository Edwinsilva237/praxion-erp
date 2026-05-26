'use strict'

const up = `
  ALTER TABLE business_partners
    -- Preferencias CFDI
    ADD COLUMN cfdi_use          VARCHAR(3)   DEFAULT 'G01',
    ADD COLUMN payment_method    VARCHAR(3)   DEFAULT 'PUE',
    ADD COLUMN payment_form      VARCHAR(3)   DEFAULT '99',
    ADD COLUMN sat_product_code  VARCHAR(8),
    ADD COLUMN sat_unit_code     VARCHAR(5)   DEFAULT 'H87',

    -- Preferencias comerciales
    ADD COLUMN preferred_currency  VARCHAR(3)  DEFAULT 'MXN',
    ADD COLUMN requires_po         BOOLEAN     NOT NULL DEFAULT false,
    ADD COLUMN requires_quotation  BOOLEAN     NOT NULL DEFAULT false,
    ADD COLUMN accepts_partial     BOOLEAN     NOT NULL DEFAULT true,
    ADD COLUMN default_address_id  UUID        REFERENCES delivery_addresses(id) ON DELETE SET NULL,
    ADD COLUMN billing_contact_id  UUID        REFERENCES business_partner_contacts(id) ON DELETE SET NULL,

    -- Notas internas para quien factura
    ADD COLUMN billing_notes       TEXT;

  COMMENT ON COLUMN business_partners.cfdi_use         IS 'Uso de CFDI según catálogo SAT — G01=Adquisición, G03=Gastos en general, etc.';
  COMMENT ON COLUMN business_partners.payment_method   IS 'PUE=Pago en una sola exhibición, PPD=Pago en parcialidades';
  COMMENT ON COLUMN business_partners.payment_form     IS 'Forma de pago SAT: 01=Efectivo, 03=Transferencia, 04=Cheque, 99=Por definir';
  COMMENT ON COLUMN business_partners.sat_product_code IS 'Clave de producto/servicio SAT default para este cliente';
  COMMENT ON COLUMN business_partners.sat_unit_code    IS 'Clave de unidad SAT default: H87=Pieza, KGM=Kilogramo, XBX=Caja';
  COMMENT ON COLUMN business_partners.requires_po      IS 'El cliente exige número de OC en la factura/remisión';
  COMMENT ON COLUMN business_partners.requires_quotation IS 'El cliente requiere cotización previa antes de facturar';
  COMMENT ON COLUMN business_partners.accepts_partial  IS 'El cliente acepta entregas parciales';
  COMMENT ON COLUMN business_partners.billing_notes    IS 'Notas internas visibles al facturar — instrucciones especiales del cliente';
`

const down = `
  ALTER TABLE business_partners
    DROP COLUMN IF EXISTS cfdi_use,
    DROP COLUMN IF EXISTS payment_method,
    DROP COLUMN IF EXISTS payment_form,
    DROP COLUMN IF EXISTS sat_product_code,
    DROP COLUMN IF EXISTS sat_unit_code,
    DROP COLUMN IF EXISTS preferred_currency,
    DROP COLUMN IF EXISTS requires_po,
    DROP COLUMN IF EXISTS requires_quotation,
    DROP COLUMN IF EXISTS accepts_partial,
    DROP COLUMN IF EXISTS default_address_id,
    DROP COLUMN IF EXISTS billing_contact_id,
    DROP COLUMN IF EXISTS billing_notes;
`

module.exports = { up, down }
