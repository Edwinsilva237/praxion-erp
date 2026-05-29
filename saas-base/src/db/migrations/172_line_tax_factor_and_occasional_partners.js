'use strict'

/**
 * Mig 172 — Tratamiento de IVA por línea + clientes ocasionales.
 *
 * Contexto (sesión 2026-05-29):
 *   Hasta ahora el timbrado FORZABA IVA Tasa 16% en cada línea, ignorando el
 *   `objeto_imp` del producto. Esto rompía dos casos reales:
 *     - Productos del campo (aguacate, caña, alimentos básicos) → IVA tasa 0%.
 *     - Conceptos exentos o no objeto de impuesto.
 *
 *   Además se habilita la "facturación ocasional": capturar el cliente directo
 *   en la factura sin darlo de alta a mano. Por integridad (cobranza,
 *   complementos de pago, cancelación se amarran al cliente) el sistema crea/
 *   reusa un business_partner por debajo, marcado `is_occasional` para no
 *   ensuciar el catálogo principal.
 *
 *   Esta migración agrega:
 *     1. products.tax_factor / tax_rate     → tratamiento fiscal por producto.
 *     2. invoice_lines.tax_factor           → factor por línea (tax_rate ya existía).
 *     3. business_partners.is_occasional    → marca de cliente ocasional.
 *
 *   `objeto_imp` ya existe en products e invoice_lines (mig 031). El factor
 *   default 'Tasa' + tasa 16 preserva exactamente el comportamiento actual:
 *   las columnas nuevas no cambian nada para los productos existentes.
 */

const up = `
  -- 1. Tratamiento fiscal por producto.
  ALTER TABLE products
    ADD COLUMN IF NOT EXISTS tax_factor VARCHAR(10) NOT NULL DEFAULT 'Tasa',
    ADD COLUMN IF NOT EXISTS tax_rate   DECIMAL(5,2) NOT NULL DEFAULT 16.00;

  ALTER TABLE products
    DROP CONSTRAINT IF EXISTS products_tax_factor_chk;
  ALTER TABLE products
    ADD CONSTRAINT products_tax_factor_chk
      CHECK (tax_factor IN ('Tasa', 'Cuota', 'Exento'));

  COMMENT ON COLUMN products.tax_factor IS
    'Tipo de factor SAT del IVA: Tasa | Cuota | Exento. Con Exento no se manda tasa.';
  COMMENT ON COLUMN products.tax_rate IS
    'Tasa de IVA en porcentaje (16, 8, 0). Combinada con objeto_imp y tax_factor define el tratamiento fiscal de la línea.';

  -- 2. Factor por línea de factura. La columna tax_rate ya existe (mig 021).
  ALTER TABLE invoice_lines
    ADD COLUMN IF NOT EXISTS tax_factor VARCHAR(10) NOT NULL DEFAULT 'Tasa';

  ALTER TABLE invoice_lines
    DROP CONSTRAINT IF EXISTS invoice_lines_tax_factor_chk;
  ALTER TABLE invoice_lines
    ADD CONSTRAINT invoice_lines_tax_factor_chk
      CHECK (tax_factor IN ('Tasa', 'Cuota', 'Exento'));

  COMMENT ON COLUMN invoice_lines.tax_factor IS
    'Tipo de factor SAT del IVA de esta línea: Tasa | Cuota | Exento.';

  -- 3. Cliente ocasional (facturación directa sin alta manual).
  ALTER TABLE business_partners
    ADD COLUMN IF NOT EXISTS is_occasional BOOLEAN NOT NULL DEFAULT false;

  COMMENT ON COLUMN business_partners.is_occasional IS
    'true = cliente creado al vuelo desde una factura ocasional. Se filtra del catálogo principal pero sostiene cobranza/complementos/cancelación.';
`

const down = `
  ALTER TABLE business_partners DROP COLUMN IF EXISTS is_occasional;
  ALTER TABLE invoice_lines DROP CONSTRAINT IF EXISTS invoice_lines_tax_factor_chk;
  ALTER TABLE invoice_lines DROP COLUMN IF EXISTS tax_factor;
  ALTER TABLE products DROP CONSTRAINT IF EXISTS products_tax_factor_chk;
  ALTER TABLE products DROP COLUMN IF EXISTS tax_factor;
  ALTER TABLE products DROP COLUMN IF EXISTS tax_rate;
`

module.exports = { up, down }
