'use strict'

/**
 * SaaS v2 — Migration 130: motor de lotes (raw_material_lots + product_lots +
 * lot_consumption + extensiones a shift_progress, shift_mp_loads, inventory_movements).
 *
 * Implementa la INFRAESTRUCTURA del Sección 4 del design (motor de lotes,
 * trazabilidad, FEFO/FIFO). La LÓGICA funcional (generación de lot_number,
 * selección FEFO, cron de expiración, vistas de trazabilidad backward/forward)
 * viene durante el refactor de productionService.js — el design dice
 * explícitamente que estas tablas deben estar antes que la lógica.
 *
 * Aditivo: shift_mp_loads.kg, raw_materials.unit, etc. se mantienen. Las
 * tablas viejas funcionan igual. uses_lots=false en tenant_process_config
 * mantiene todo el flujo viejo intacto.
 *
 * NO incluye en esta migration (deferidos a futuras):
 *  - tenant_allergens + tablas de unión (§4.3.4-5) — post-MVP
 *  - Triggers de generación de lot_number — código del refactor
 *  - Cron de expiración + ajuste automático — código del refactor
 *  - Vista materializada de trazabilidad — código del refactor
 *
 * Referencia: §4.3.1, §4.3.2, §4.3.3, §4.4.1.
 */

const up = `
  -- ═══════════════════════════════════════════════════════════════════════
  -- raw_material_lots — lotes de MP, embalaje y aditivos
  -- ═══════════════════════════════════════════════════════════════════════
  CREATE TABLE raw_material_lots (
    id                        UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id                 UUID         NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    raw_material_id           UUID         NOT NULL REFERENCES raw_materials(id) ON DELETE RESTRICT,
    lot_number                VARCHAR(60)  NOT NULL,
    manufacturer_lot          VARCHAR(120) NULL,
    manufacture_date          DATE         NULL,
    expiry_date               DATE         NULL,
    best_before_date          DATE         NULL,
    received_at               TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    supplier_id               UUID         NULL REFERENCES business_partners(id) ON DELETE SET NULL,
    supplier_receipt_id       UUID         NULL REFERENCES supplier_receipts(id) ON DELETE SET NULL,
    supplier_receipt_line_id  UUID         NULL REFERENCES supplier_receipt_lines(id) ON DELETE SET NULL,
    warehouse_id              UUID         NOT NULL REFERENCES warehouses(id) ON DELETE RESTRICT,
    quantity_received         NUMERIC(18,6) NOT NULL,
    quantity_remaining        NUMERIC(18,6) NOT NULL,
    unit_cost                 NUMERIC(18,6) NULL,
    total_cost                NUMERIC(18,2) NULL,
    status                    VARCHAR(20)  NOT NULL DEFAULT 'active',
    quarantine_reason         TEXT         NULL,
    coa_attachment_id         UUID         NULL REFERENCES attachments(id) ON DELETE SET NULL,
    notes                     TEXT         NULL,
    created_at                TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    created_by_user_id        UUID         NULL REFERENCES users(id) ON DELETE SET NULL,

    CONSTRAINT rml_status_check CHECK (status IN ('active','quarantined','expired','recalled','depleted')),
    CONSTRAINT rml_quantity_received_positive CHECK (quantity_received > 0),
    CONSTRAINT rml_quantity_remaining_nonneg  CHECK (quantity_remaining >= 0),
    CONSTRAINT rml_remaining_lte_received     CHECK (quantity_remaining <= quantity_received),
    CONSTRAINT rml_unit_cost_nonneg           CHECK (unit_cost IS NULL OR unit_cost >= 0),
    CONSTRAINT rml_total_cost_nonneg          CHECK (total_cost IS NULL OR total_cost >= 0),
    CONSTRAINT rml_expiry_after_manufacture   CHECK (expiry_date IS NULL OR manufacture_date IS NULL OR expiry_date >= manufacture_date),
    CONSTRAINT rml_lot_number_unique_per_rm   UNIQUE (raw_material_id, lot_number)
  );

  CREATE INDEX idx_rml_tenant_rm        ON raw_material_lots (tenant_id, raw_material_id);
  CREATE INDEX idx_rml_warehouse        ON raw_material_lots (warehouse_id);
  CREATE INDEX idx_rml_status_active    ON raw_material_lots (tenant_id, raw_material_id, status)
    WHERE status = 'active';
  CREATE INDEX idx_rml_fefo             ON raw_material_lots (raw_material_id, expiry_date, received_at)
    WHERE status = 'active' AND quantity_remaining > 0;
  CREATE INDEX idx_rml_supplier_receipt ON raw_material_lots (supplier_receipt_id);

  COMMENT ON TABLE raw_material_lots IS
    'SaaS v2 §4.3.1: lotes de MP/embalaje/aditivos. Soporta trazabilidad backward y FIFO/FEFO. Solo se popula si tenant_process_config.uses_lots=true.';
  COMMENT ON COLUMN raw_material_lots.status IS
    'active (disponible) | quarantined (bloqueado) | expired (caducado) | recalled (retirado) | depleted (consumido)';
  COMMENT ON COLUMN raw_material_lots.quantity_remaining IS
    'Saldo del lote. Lo actualizan los consumos. Cuando llega a 0, status→depleted (lógica en código).';
  COMMENT ON INDEX idx_rml_fefo IS
    'Selector FEFO: lotes activos con saldo, ordenados por expiry → received_at.';

  -- ═══════════════════════════════════════════════════════════════════════
  -- product_lots — lotes de PT (producidos o recibidos para reventa)
  -- ═══════════════════════════════════════════════════════════════════════
  CREATE TABLE product_lots (
    id                        UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id                 UUID         NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    product_id                UUID         NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
    lot_number                VARCHAR(60)  NOT NULL,
    origin                    VARCHAR(20)  NOT NULL,
    produced_at               TIMESTAMPTZ  NULL,
    production_date           DATE         NOT NULL,
    expiry_date               DATE         NULL,
    best_before_date          DATE         NULL,
    production_order_id       UUID         NULL REFERENCES production_orders(id) ON DELETE SET NULL,
    shift_id                  UUID         NULL REFERENCES production_shifts(id) ON DELETE SET NULL,
    quality_grade_id          UUID         NOT NULL REFERENCES tenant_quality_grades(id) ON DELETE RESTRICT,
    quantity_produced         NUMERIC(18,6) NOT NULL,
    quantity_remaining        NUMERIC(18,6) NOT NULL,
    unit_cost                 NUMERIC(18,6) NULL,
    unit_cost_recosted        NUMERIC(18,6) NULL,
    warehouse_id              UUID         NOT NULL REFERENCES warehouses(id) ON DELETE RESTRICT,
    supplier_id               UUID         NULL REFERENCES business_partners(id) ON DELETE SET NULL,
    supplier_receipt_id       UUID         NULL REFERENCES supplier_receipts(id) ON DELETE SET NULL,
    supplier_receipt_line_id  UUID         NULL REFERENCES supplier_receipt_lines(id) ON DELETE SET NULL,
    manufacturer_lot          VARCHAR(120) NULL,
    manufacture_date          DATE         NULL,
    status                    VARCHAR(20)  NOT NULL DEFAULT 'active',
    notes                     TEXT         NULL,
    created_at                TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    created_by_user_id        UUID         NULL REFERENCES users(id) ON DELETE SET NULL,

    CONSTRAINT pl_origin_check  CHECK (origin IN ('produced','received','adjusted')),
    CONSTRAINT pl_status_check  CHECK (status IN ('active','quarantined','expired','recalled','depleted')),
    CONSTRAINT pl_qty_produced_positive CHECK (quantity_produced > 0),
    CONSTRAINT pl_qty_remaining_nonneg  CHECK (quantity_remaining >= 0),
    CONSTRAINT pl_remaining_lte_produced CHECK (quantity_remaining <= quantity_produced),
    CONSTRAINT pl_unit_cost_nonneg      CHECK (unit_cost IS NULL OR unit_cost >= 0),
    CONSTRAINT pl_unit_cost_recosted_nonneg CHECK (unit_cost_recosted IS NULL OR unit_cost_recosted >= 0),
    CONSTRAINT pl_expiry_after_production CHECK (expiry_date IS NULL OR expiry_date >= production_date),
    CONSTRAINT pl_lot_number_unique_per_product UNIQUE (product_id, lot_number),

    -- origin='produced' requiere production_order_id + shift_id, NO supplier
    -- origin='received' requiere supplier_id + supplier_receipt_id, NO production
    -- origin='adjusted' es para ajustes manuales (inventario inicial, correcciones)
    CONSTRAINT pl_origin_produced_fields CHECK (
      origin != 'produced' OR (
        production_order_id IS NOT NULL
        AND shift_id IS NOT NULL
        AND supplier_id IS NULL
        AND supplier_receipt_id IS NULL
      )
    ),
    CONSTRAINT pl_origin_received_fields CHECK (
      origin != 'received' OR (
        supplier_id IS NOT NULL
        AND supplier_receipt_id IS NOT NULL
        AND production_order_id IS NULL
        AND shift_id IS NULL
        AND produced_at IS NULL
      )
    )
  );

  CREATE INDEX idx_pl_tenant_product     ON product_lots (tenant_id, product_id);
  CREATE INDEX idx_pl_warehouse          ON product_lots (warehouse_id);
  CREATE INDEX idx_pl_quality_grade      ON product_lots (quality_grade_id);
  CREATE INDEX idx_pl_status_active      ON product_lots (tenant_id, product_id, status)
    WHERE status = 'active';
  CREATE INDEX idx_pl_fefo               ON product_lots (product_id, expiry_date, production_date)
    WHERE status = 'active' AND quantity_remaining > 0;
  CREATE INDEX idx_pl_production_order   ON product_lots (production_order_id);
  CREATE INDEX idx_pl_shift              ON product_lots (shift_id);
  CREATE INDEX idx_pl_supplier_receipt   ON product_lots (supplier_receipt_id);

  COMMENT ON TABLE product_lots IS
    'SaaS v2 §4.3.2: lotes de PT producidos (origin=produced) o recibidos para reventa (origin=received) o ajustes (origin=adjusted). Un lote pertenece a una sola calidad.';
  COMMENT ON COLUMN product_lots.origin IS
    'produced: hecho internamente vía orden+turno. received: comprado a proveedor. adjusted: ajuste manual (inv inicial, correcciones).';
  COMMENT ON COLUMN product_lots.unit_cost_recosted IS
    'Costo después de recosteo mensual (cierre de mes). NULL si aún no se ha recosteado.';

  -- ═══════════════════════════════════════════════════════════════════════
  -- lot_consumption — qué MP entró en qué PT (columna vertebral de trazabilidad)
  -- ═══════════════════════════════════════════════════════════════════════
  CREATE TABLE lot_consumption (
    id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id             UUID          NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    product_lot_id        UUID          NOT NULL REFERENCES product_lots(id) ON DELETE CASCADE,
    raw_material_lot_id   UUID          NOT NULL REFERENCES raw_material_lots(id) ON DELETE RESTRICT,
    quantity_consumed     NUMERIC(18,6) NOT NULL,
    unit_id               UUID          NOT NULL REFERENCES tenant_units(id) ON DELETE RESTRICT,
    shift_id              UUID          NOT NULL REFERENCES production_shifts(id) ON DELETE RESTRICT,
    shift_progress_id     UUID          NULL REFERENCES shift_progress(id) ON DELETE SET NULL,
    shift_mp_load_id      UUID          NULL REFERENCES shift_mp_loads(id) ON DELETE SET NULL,
    consumed_at           TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    created_at            TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

    CONSTRAINT lc_quantity_positive CHECK (quantity_consumed > 0)
  );

  CREATE INDEX idx_lc_product_lot          ON lot_consumption (product_lot_id);
  CREATE INDEX idx_lc_raw_material_lot     ON lot_consumption (raw_material_lot_id);
  CREATE INDEX idx_lc_shift                ON lot_consumption (shift_id);
  CREATE INDEX idx_lc_tenant_consumed_at   ON lot_consumption (tenant_id, consumed_at);

  COMMENT ON TABLE lot_consumption IS
    'SaaS v2 §4.3.3: qué raw_material_lots entraron en qué product_lots. Backbone de trazabilidad backward (qué MP usó este PT) y forward (qué PT usó esta MP, para recall).';

  -- ═══════════════════════════════════════════════════════════════════════
  -- Extensión: shift_progress.lot_id → FK a product_lots
  -- ═══════════════════════════════════════════════════════════════════════
  ALTER TABLE shift_progress
    ADD COLUMN IF NOT EXISTS lot_id            UUID NULL REFERENCES product_lots(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS dynamic_attributes JSONB NULL;

  ALTER TABLE shift_progress
    ADD CONSTRAINT shift_progress_dynamic_attributes_is_object
      CHECK (dynamic_attributes IS NULL OR jsonb_typeof(dynamic_attributes) = 'object');

  CREATE INDEX IF NOT EXISTS idx_shift_progress_lot_id ON shift_progress (lot_id);

  COMMENT ON COLUMN shift_progress.lot_id IS
    'SaaS v2 §2.3.6: FK al product_lot generado por esta captura. NULL si tenant_process_config.uses_lots=false.';
  COMMENT ON COLUMN shift_progress.dynamic_attributes IS
    'SaaS v2 §2.3.6: valores capturados según capture_schema del product_kind. Objeto JSONB.';

  -- ═══════════════════════════════════════════════════════════════════════
  -- Extensión: shift_mp_loads.lot_id, unit_id, quantity
  -- ═══════════════════════════════════════════════════════════════════════
  ALTER TABLE shift_mp_loads
    ADD COLUMN IF NOT EXISTS lot_id   UUID NULL REFERENCES raw_material_lots(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS unit_id  UUID NULL REFERENCES tenant_units(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS quantity NUMERIC(18,6) NULL;

  ALTER TABLE shift_mp_loads
    ADD CONSTRAINT sml_quantity_positive_v2
      CHECK (quantity IS NULL OR quantity > 0);

  CREATE INDEX IF NOT EXISTS idx_shift_mp_loads_lot_id ON shift_mp_loads (lot_id);

  COMMENT ON COLUMN shift_mp_loads.lot_id IS
    'SaaS v2 §2.3.8: FK al raw_material_lot consumido. NULL si tenant no usa lotes.';
  COMMENT ON COLUMN shift_mp_loads.unit_id IS
    'SaaS v2: si load viene en unidad distinta a kg (que está en la columna kg vieja).';

  -- ═══════════════════════════════════════════════════════════════════════
  -- Extensión: inventory_movements lleva FK al lote (MP o PT)
  -- ═══════════════════════════════════════════════════════════════════════
  ALTER TABLE inventory_movements
    ADD COLUMN IF NOT EXISTS raw_material_lot_id UUID NULL REFERENCES raw_material_lots(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS product_lot_id      UUID NULL REFERENCES product_lots(id)      ON DELETE SET NULL;

  -- XOR: a lo sumo uno de los dos puede estar set (no ambos).
  -- Permitir ambos NULL para movimientos de tenants sin lotes (compat con flujo viejo).
  ALTER TABLE inventory_movements
    ADD CONSTRAINT im_lot_xor
      CHECK (NOT (raw_material_lot_id IS NOT NULL AND product_lot_id IS NOT NULL));

  CREATE INDEX IF NOT EXISTS idx_im_raw_material_lot ON inventory_movements (raw_material_lot_id);
  CREATE INDEX IF NOT EXISTS idx_im_product_lot      ON inventory_movements (product_lot_id);

  COMMENT ON COLUMN inventory_movements.raw_material_lot_id IS
    'SaaS v2 §4.4.1: FK al raw_material_lot para movimientos de MP. XOR con product_lot_id.';
  COMMENT ON COLUMN inventory_movements.product_lot_id IS
    'SaaS v2 §4.4.1: FK al product_lot para movimientos de PT. XOR con raw_material_lot_id.';
`

const down = `
  ALTER TABLE inventory_movements
    DROP CONSTRAINT IF EXISTS im_lot_xor;
  DROP INDEX IF EXISTS idx_im_product_lot;
  DROP INDEX IF EXISTS idx_im_raw_material_lot;
  ALTER TABLE inventory_movements
    DROP COLUMN IF EXISTS product_lot_id,
    DROP COLUMN IF EXISTS raw_material_lot_id;

  ALTER TABLE shift_mp_loads
    DROP CONSTRAINT IF EXISTS sml_quantity_positive_v2;
  DROP INDEX IF EXISTS idx_shift_mp_loads_lot_id;
  ALTER TABLE shift_mp_loads
    DROP COLUMN IF EXISTS quantity,
    DROP COLUMN IF EXISTS unit_id,
    DROP COLUMN IF EXISTS lot_id;

  ALTER TABLE shift_progress
    DROP CONSTRAINT IF EXISTS shift_progress_dynamic_attributes_is_object;
  DROP INDEX IF EXISTS idx_shift_progress_lot_id;
  ALTER TABLE shift_progress
    DROP COLUMN IF EXISTS dynamic_attributes,
    DROP COLUMN IF EXISTS lot_id;

  DROP TABLE IF EXISTS lot_consumption;
  DROP TABLE IF EXISTS product_lots;
  DROP TABLE IF EXISTS raw_material_lots;
`

module.exports = { up, down }
