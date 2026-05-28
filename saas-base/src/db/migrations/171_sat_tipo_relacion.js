'use strict'

/**
 * Mig 171 — catalogo c_TipoRelacion del SAT.
 *
 * Usado en CFDI 4.0 cuando se emite un comprobante relacionado a otros
 * (Nota de Credito, refacturacion, devoluciones). Define el tipo de
 * relacion entre el CFDI nuevo y el original.
 *
 * Cargado desde catCFDI_V_4_*.xls hoja c_TipoRelacion.
 */

const up = `
  CREATE TABLE IF NOT EXISTS sat_tipo_relacion (
    code      TEXT PRIMARY KEY,
    name      TEXT NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT true
  );

  INSERT INTO sat_tipo_relacion (code, name) VALUES
    ('01', 'Nota de crédito de los documentos relacionados'),
    ('02', 'Nota de débito de los documentos relacionados'),
    ('03', 'Devolución de mercancía sobre facturas o traslados previos'),
    ('04', 'Sustitución de los CFDI previos'),
    ('05', 'Traslados de mercancías facturados previamente'),
    ('06', 'Factura generada por los traslados previos'),
    ('07', 'CFDI por aplicación de anticipo')
  ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name;
`

const down = `
  DROP TABLE IF EXISTS sat_tipo_relacion;
`

module.exports = { up, down }
