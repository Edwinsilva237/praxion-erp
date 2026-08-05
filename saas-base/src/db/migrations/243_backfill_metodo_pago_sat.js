'use strict'

/**
 * Mig 243 — backfill de supplier_invoices.metodo_pago_sat desde el XML guardado.
 *
 * La columna nació en la mig 235 y solo se llena al REGISTRAR la factura desde
 * entonces: todo lo anterior (y lo importado en lote) quedó NULL, y sin el
 * 'PPD' el semáforo REP de Pagos emitidos clasifica esos pagos como «no
 * requiere» («—») y no ofrece solicitar el REP al proveedor.
 *
 * El atributo viene en texto plano en el XML (`MetodoPago="PPD"` en el nodo
 * cfdi:Comprobante), así que se extrae con regex — sin parser. Solo llena
 * NULLs (idempotente, nunca pisa un valor ya extraído); las facturas sin
 * xml_content (gasto manual, o XML solo en storage) quedan NULL y se
 * recuperan una a una con «Volver a leer del XML».
 */

const up = `
  UPDATE supplier_invoices
     SET metodo_pago_sat = substring(xml_content FROM 'MetodoPago\\s*=\\s*.(PPD|PUE)')
   WHERE metodo_pago_sat IS NULL
     AND xml_content IS NOT NULL
     AND xml_content ~ 'MetodoPago\\s*=\\s*.(PPD|PUE)';
`

// Backfill de datos: no hay reversa razonable (no sabríamos cuáles filas
// estaban NULL antes). No-op.
const down = `SELECT 1;`

module.exports = { up, down }
