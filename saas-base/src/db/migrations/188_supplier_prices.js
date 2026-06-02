'use strict'

/**
 * Mig 188 — Precios por proveedor (para crear OC rápido).
 *
 * Espejo de `customer_prices` (ventas) pero para COMPRAS:
 *   - El ítem es polimórfico: item_type IN ('raw_material','product') + item_id
 *     (las OC compran ambos).
 *   - Modelo de historial con `valid_from`/`valid_until` + vista
 *     `current_supplier_prices` que toma el precio vigente (igual que
 *     current_customer_prices).
 *   - `source` distingue precio NEGOCIADO a mano ('manual') del AUTO-APRENDIDO
 *     al crear la OC ('po') o al recibir la mercancía ('receipt').
 *   - Extras del alcance "Completo": `supplier_sku` (clave del proveedor por
 *     ítem, para que la OC lleve su código), `min_order_qty`, `lead_time_days`.
 *
 * Prioridad al sugerir (la maneja la vista + el servicio):
 *   manual > aprendido (po/receipt) > costo estándar del ítem > nulo.
 * El precio manual es "pegajoso": gana sobre el aprendido aunque sea más viejo,
 * así un precio negociado no lo pisa una OC de una sola vez.
 */

const up = `
  CREATE TABLE IF NOT EXISTS supplier_prices (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    business_partner_id UUID NOT NULL REFERENCES business_partners(id) ON DELETE CASCADE,
    item_type           TEXT NOT NULL CHECK (item_type IN ('raw_material','product')),
    item_id             UUID NOT NULL,
    currency            document_currency NOT NULL DEFAULT 'MXN',
    unit_price          NUMERIC(14,4) NOT NULL CHECK (unit_price >= 0),
    supplier_sku        TEXT,
    min_order_qty       NUMERIC(14,4),
    lead_time_days      INTEGER,
    valid_from          DATE NOT NULL DEFAULT CURRENT_DATE,
    valid_until         DATE,
    source              TEXT NOT NULL DEFAULT 'manual'
                          CHECK (source IN ('manual','po','receipt')),
    notes               TEXT,
    created_by          UUID REFERENCES users(id),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE INDEX IF NOT EXISTS supplier_prices_lookup_idx
    ON supplier_prices (tenant_id, business_partner_id, item_type, item_id);

  -- Dedup del auto-aprendizaje: máx 1 fila por proveedor+ítem+día+fuente.
  -- Permite que un precio 'manual' y uno aprendido convivan el mismo día
  -- (distinta fuente) y que varias OC del mismo día hagan UPSERT en vez de spamear.
  CREATE UNIQUE INDEX IF NOT EXISTS supplier_prices_daily_uq
    ON supplier_prices (tenant_id, business_partner_id, item_type, item_id, valid_from, source);

  -- Precio vigente por proveedor+ítem. manual gana sobre aprendido (pegajoso);
  -- entre los del mismo rango, el de valid_from más reciente.
  CREATE OR REPLACE VIEW current_supplier_prices AS
    SELECT DISTINCT ON (tenant_id, business_partner_id, item_type, item_id)
           id, tenant_id, business_partner_id, item_type, item_id,
           currency, unit_price, supplier_sku, min_order_qty, lead_time_days,
           valid_from, valid_until, source, notes
      FROM supplier_prices
     WHERE valid_from <= CURRENT_DATE
       AND (valid_until IS NULL OR valid_until >= CURRENT_DATE)
     ORDER BY tenant_id, business_partner_id, item_type, item_id,
              (source = 'manual') DESC, valid_from DESC, created_at DESC;
`

const down = `
  DROP VIEW IF EXISTS current_supplier_prices;
  DROP TABLE IF EXISTS supplier_prices;
`

module.exports = { up, down }
