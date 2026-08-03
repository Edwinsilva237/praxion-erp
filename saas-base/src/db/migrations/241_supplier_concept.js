'use strict'

/**
 * Mig 241 — Concepto del proveedor por ítem + control de la ref. interna en la OC.
 *
 * `supplier_description` = el NOMBRE/CONCEPTO con el que el proveedor conoce el
 * producto (complementa a `supplier_sku`, que es su clave corta). Cuando existe,
 * el PDF de la OC lo imprime como descripción PRINCIPAL — el proveedor lee su
 * propio idioma — y nuestra descripción baja a "Ref. interna" en gris.
 *
 * `show_internal_ref` = si la OC impresa muestra esa ref. interna. Caso de
 * negocio: el tenant puede vender como producto "superior" algo que el proveedor
 * le surte con otro calibre/grado; ocultar la ref. interna evita revelarle su
 * posicionamiento. Solo aplica al PDF — las pantallas internas siempre muestran
 * nuestro concepto.
 *
 * Mismo patrón que supplier_sku (migs 188/207): la fuente persistente vive en
 * `supplier_prices` (por proveedor+ítem, con auto-aprendizaje al crear la OC) y
 * la línea de OC guarda un SNAPSHOT editable por línea.
 */

const up = `
  ALTER TABLE supplier_prices
    ADD COLUMN IF NOT EXISTS supplier_description TEXT,
    ADD COLUMN IF NOT EXISTS show_internal_ref BOOLEAN NOT NULL DEFAULT true;

  COMMENT ON COLUMN supplier_prices.supplier_description
    IS 'Concepto/nombre con el que el PROVEEDOR conoce el ítem (se imprime como descripción principal de la OC).';
  COMMENT ON COLUMN supplier_prices.show_internal_ref
    IS 'Si el PDF de la OC muestra la ref. interna (clave+descripción nuestras) debajo del concepto del proveedor.';

  ALTER TABLE purchase_order_lines
    ADD COLUMN IF NOT EXISTS supplier_description TEXT,
    ADD COLUMN IF NOT EXISTS show_internal_ref BOOLEAN NOT NULL DEFAULT true;

  COMMENT ON COLUMN purchase_order_lines.supplier_description
    IS 'Snapshot del concepto del proveedor impreso en ESTA OC.';
  COMMENT ON COLUMN purchase_order_lines.show_internal_ref
    IS 'Snapshot por línea: si el PDF de ESTA OC muestra la ref. interna.';

  -- La vista se recrea para exponer las columnas nuevas (agregadas al final,
  -- requisito de CREATE OR REPLACE VIEW).
  CREATE OR REPLACE VIEW current_supplier_prices AS
    SELECT DISTINCT ON (tenant_id, business_partner_id, item_type, item_id)
           id, tenant_id, business_partner_id, item_type, item_id,
           currency, unit_price, supplier_sku, min_order_qty, lead_time_days,
           valid_from, valid_until, source, notes,
           supplier_description, show_internal_ref
      FROM supplier_prices
     WHERE valid_from <= CURRENT_DATE
       AND (valid_until IS NULL OR valid_until >= CURRENT_DATE)
     ORDER BY tenant_id, business_partner_id, item_type, item_id,
              (source = 'manual') DESC, valid_from DESC, created_at DESC;
`

const down = `
  DROP VIEW IF EXISTS current_supplier_prices;
  CREATE VIEW current_supplier_prices AS
    SELECT DISTINCT ON (tenant_id, business_partner_id, item_type, item_id)
           id, tenant_id, business_partner_id, item_type, item_id,
           currency, unit_price, supplier_sku, min_order_qty, lead_time_days,
           valid_from, valid_until, source, notes
      FROM supplier_prices
     WHERE valid_from <= CURRENT_DATE
       AND (valid_until IS NULL OR valid_until >= CURRENT_DATE)
     ORDER BY tenant_id, business_partner_id, item_type, item_id,
              (source = 'manual') DESC, valid_from DESC, created_at DESC;

  ALTER TABLE purchase_order_lines
    DROP COLUMN IF EXISTS supplier_description,
    DROP COLUMN IF EXISTS show_internal_ref;

  ALTER TABLE supplier_prices
    DROP COLUMN IF EXISTS supplier_description,
    DROP COLUMN IF EXISTS show_internal_ref;
`

module.exports = { up, down }
