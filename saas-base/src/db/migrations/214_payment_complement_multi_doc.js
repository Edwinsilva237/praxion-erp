'use strict'

/**
 * Mig 214 — Complemento de pago (CFDI tipo P) con VARIOS documentos relacionados.
 *
 * Hasta ahora un cobro que liquidaba N facturas PPD generaba N complementos de
 * pago separados (un CFDI tipo P por factura). Lo correcto ante el SAT es UN
 * solo REP por pago recibido, con un `DoctoRelacionado` por cada factura que
 * liquida. Para soportarlo conservando el modelo por-factura (las vistas y
 * cálculos de complemento se hacen `WHERE invoice_id = X`), un REP que cubre N
 * facturas inserta N filas en `payment_complements` —una por factura, con su
 * porción del pago— pero TODAS comparten el mismo `facturapi_id`/`cfdi_uuid`
 * (un solo timbre).
 *
 * Eso choca con el UNIQUE(cfdi_uuid) original (un UUID = una fila). Se
 * reemplaza por UNIQUE(cfdi_uuid, invoice_id): el mismo CFDI puede repetirse
 * en varias filas, pero no dos veces para la MISMA factura (anti-duplicado).
 */

const up = `
  ALTER TABLE payment_complements
    DROP CONSTRAINT IF EXISTS pc_uuid_unique;

  ALTER TABLE payment_complements
    ADD CONSTRAINT pc_uuid_invoice_unique UNIQUE (cfdi_uuid, invoice_id);

  CREATE INDEX IF NOT EXISTS idx_pc_facturapi_id
    ON payment_complements (tenant_id, facturapi_id);
`

const down = `
  DROP INDEX IF EXISTS idx_pc_facturapi_id;

  ALTER TABLE payment_complements
    DROP CONSTRAINT IF EXISTS pc_uuid_invoice_unique;

  ALTER TABLE payment_complements
    ADD CONSTRAINT pc_uuid_unique UNIQUE (cfdi_uuid);
`

module.exports = { up, down }
