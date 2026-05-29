'use strict'

/**
 * Mig 173 — Retenciones por factura (CFDI 4.0).
 *
 * Contexto (continuación 2026-05-29):
 *   El timbrado solo manejaba impuestos TRASLADADOS (IVA que se cobra). Faltaban
 *   las RETENCIONES (impuestos que el receptor retiene al emisor): ISR e IVA
 *   retenido. Aplican sobre todo a servicios:
 *     - Honorarios (persona física → moral): ISR 10% + IVA retenido 10.6667%.
 *     - Autotransporte / fletes: IVA retenido 4%.
 *     - Arrendamiento: ISR 10% + IVA retenido.
 *
 *   Modelo (estilo Alegra): una factura puede tener varias retenciones, cada una
 *   {tipo, tasa}. Se guardan aquí; el monto se calcula sobre la base gravable
 *   (subtotal de líneas objeto de impuesto). `invoices.tax_withheld` (ya existía,
 *   mig 021) guarda el agregado y el total de la factura ya las descuenta.
 */

const up = `
  CREATE TABLE invoice_retentions (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    invoice_id  UUID          NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
    tax_type    VARCHAR(4)    NOT NULL,        -- 'ISR' | 'IVA'
    rate        DECIMAL(9,6)  NOT NULL,        -- porcentaje (10, 10.6667, 4)
    amount      DECIMAL(14,2) NOT NULL DEFAULT 0,
    created_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

    CONSTRAINT ir_tax_type_chk CHECK (tax_type IN ('ISR', 'IVA')),
    CONSTRAINT ir_rate_chk     CHECK (rate >= 0 AND rate <= 100)
  );

  CREATE INDEX idx_invoice_retentions_invoice ON invoice_retentions (invoice_id);

  COMMENT ON TABLE invoice_retentions IS
    'Retenciones (ISR/IVA) de una factura. Se suman a invoices.tax_withheld y se descuentan del total. Al timbrar se mandan a Facturapi como impuestos withholding por concepto.';
`

const down = `
  DROP TABLE IF EXISTS invoice_retentions CASCADE;
`

module.exports = { up, down }
