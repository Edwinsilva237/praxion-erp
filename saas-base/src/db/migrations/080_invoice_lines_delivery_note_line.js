'use strict'

/**
 * Permite que una remisión se facture parcialmente — un subset de sus líneas
 * en una factura y el resto en otra. Caso de uso: el cliente pide distintos
 * usos CFDI por producto (p.ej. G01 para "esquinero" y I04 para "fleje" que
 * salieron en la misma remisión).
 *
 * Modelo: cada línea de factura recuerda de qué línea de remisión proviene.
 * El status "facturable" de una remisión deja de ser "no tiene factura
 * activa" y pasa a "tiene al menos una línea sin facturar".
 *
 * `invoices.delivery_note_id` se mantiene apuntando a la remisión "principal"
 * (la primera) por compat con queries existentes, pero la trazabilidad fina
 * pasa por las líneas. Para una factura sólo basada en una remisión, esto
 * sigue siendo la fuente única; para una mezcla N remisiones × M facturas,
 * delegamos a las líneas.
 *
 * Backfill: para facturas histórias (status<>cancelled y con delivery_note_id
 * único) se intenta mapear `invoice_lines.delivery_note_line_id` por
 * `product_id` desde la remisión origen. No es 100% exacto si la remisión
 * tiene líneas duplicadas del mismo producto, pero cubre el caso normal.
 * Facturas consolidadas (delivery_note_id NULL) o canceladas no se backfillean.
 */

const up = `
  ALTER TABLE invoice_lines
    ADD COLUMN IF NOT EXISTS delivery_note_line_id UUID
      REFERENCES delivery_note_lines(id) ON DELETE SET NULL;

  CREATE INDEX IF NOT EXISTS idx_il_dnl_id ON invoice_lines (delivery_note_line_id);

  COMMENT ON COLUMN invoice_lines.delivery_note_line_id IS
    'Línea de remisión origen. NULL en facturas directas o consolidadas (pre-migración 080).';

  -- Backfill: facturas con una sola remisión origen → mapear línea por producto.
  -- Si la remisión tiene varias líneas del mismo producto, se toma la primera.
  WITH candidates AS (
    SELECT il.id AS invoice_line_id,
           (SELECT dnl.id
              FROM delivery_note_lines dnl
             WHERE dnl.delivery_note_id = inv.delivery_note_id
               AND dnl.product_id       = il.product_id
             ORDER BY dnl.line_number
             LIMIT 1) AS dnl_id
      FROM invoice_lines il
      JOIN invoices inv ON inv.id = il.invoice_id
     WHERE il.delivery_note_line_id IS NULL
       AND inv.delivery_note_id IS NOT NULL
       AND inv.status <> 'cancelled'
       AND il.product_id IS NOT NULL
  )
  UPDATE invoice_lines il
     SET delivery_note_line_id = c.dnl_id
    FROM candidates c
   WHERE c.invoice_line_id = il.id AND c.dnl_id IS NOT NULL;
`

const down = `
  ALTER TABLE invoice_lines DROP COLUMN IF EXISTS delivery_note_line_id;
`

module.exports = { up, down }
