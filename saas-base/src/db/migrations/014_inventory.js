'use strict'

const up = `
  CREATE TYPE inventory_item_type AS ENUM ('raw_material', 'product');
  CREATE TYPE inventory_status    AS ENUM ('available', 'reserved', 'wip', 'blocked');
  CREATE TYPE movement_type AS ENUM (
    'purchase_entry',
    'production_mp_reserve',
    'production_mp_consumption',
    'production_mp_return',
    'production_wip_entry',
    'production_pt_entry',
    'production_wip_to_pt',
    'sale_exit',
    'adjustment_in',
    'adjustment_out',
    'scrap_entry',
    'scrap_disposal',
    'scrap_to_regrind',
    'transfer_in',
    'transfer_out'
  );

  -- Stock actual por almacén, producto/MP y estado
  CREATE TABLE inventory_stock (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id   UUID              NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    warehouse_id UUID             NOT NULL REFERENCES warehouses(id),
    item_type   inventory_item_type NOT NULL,
    item_id     UUID              NOT NULL,
    status      inventory_status  NOT NULL DEFAULT 'available',
    quantity    DECIMAL(14,4)     NOT NULL DEFAULT 0,
    unit        VARCHAR(10)       NOT NULL DEFAULT 'kg',
    avg_cost    DECIMAL(14,6)     NOT NULL DEFAULT 0,
    last_movement_at TIMESTAMPTZ,
    updated_at  TIMESTAMPTZ       NOT NULL DEFAULT NOW(),

    CONSTRAINT stock_unique UNIQUE (tenant_id, warehouse_id, item_type, item_id, status),
    CONSTRAINT stock_quantity_positive CHECK (quantity >= 0)
  );

  CREATE INDEX idx_stock_tenant_id    ON inventory_stock (tenant_id);
  CREATE INDEX idx_stock_warehouse    ON inventory_stock (tenant_id, warehouse_id);
  CREATE INDEX idx_stock_item         ON inventory_stock (tenant_id, item_type, item_id);
  CREATE INDEX idx_stock_status       ON inventory_stock (tenant_id, status);

  COMMENT ON TABLE  inventory_stock      IS 'Saldo actual de inventario — siempre consultar este, nunca calcular de movimientos';
  COMMENT ON COLUMN inventory_stock.avg_cost IS 'Costo promedio ponderado — se actualiza con cada entrada';
  COMMENT ON COLUMN inventory_stock.status   IS 'available=disponible, reserved=reservado para orden, wip=en proceso, blocked=pendiente gerencia';

  CREATE TRIGGER set_updated_at_inventory_stock
    BEFORE UPDATE ON inventory_stock
    FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

  -- Kardex — registro inmutable de todos los movimientos
  CREATE TABLE inventory_movements (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id       UUID              NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    warehouse_id    UUID              NOT NULL REFERENCES warehouses(id),
    item_type       inventory_item_type NOT NULL,
    item_id         UUID              NOT NULL,
    movement_type   movement_type     NOT NULL,
    quantity        DECIMAL(14,4)     NOT NULL,
    unit            VARCHAR(10)       NOT NULL DEFAULT 'kg',
    unit_cost       DECIMAL(14,6)     NOT NULL DEFAULT 0,
    total_cost      DECIMAL(14,2)     GENERATED ALWAYS AS (quantity * unit_cost) STORED,
    balance_after   DECIMAL(14,4),
    status_from     inventory_status,
    status_to       inventory_status,
    reference_type  VARCHAR(50),
    reference_id    UUID,
    notes           TEXT,
    created_by      UUID              REFERENCES users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ       NOT NULL DEFAULT NOW()
  );

  CREATE INDEX idx_movements_tenant_id    ON inventory_movements (tenant_id);
  CREATE INDEX idx_movements_item         ON inventory_movements (tenant_id, item_type, item_id);
  CREATE INDEX idx_movements_warehouse    ON inventory_movements (tenant_id, warehouse_id);
  CREATE INDEX idx_movements_type         ON inventory_movements (tenant_id, movement_type);
  CREATE INDEX idx_movements_reference    ON inventory_movements (tenant_id, reference_type, reference_id);
  CREATE INDEX idx_movements_created_at   ON inventory_movements (tenant_id, created_at DESC);

  COMMENT ON TABLE  inventory_movements          IS 'Kardex inmutable — nunca se modifica ni elimina un registro';
  COMMENT ON COLUMN inventory_movements.total_cost IS 'Calculado automáticamente: quantity × unit_cost';
  COMMENT ON COLUMN inventory_movements.reference_type IS 'Entidad origen: production_order, purchase, sale, etc.';
  COMMENT ON COLUMN inventory_movements.balance_after  IS 'Saldo después del movimiento — para kardex imprimible';
`

const down = `
  DROP TRIGGER IF EXISTS set_updated_at_inventory_stock ON inventory_stock;
  DROP TABLE IF EXISTS inventory_movements CASCADE;
  DROP TABLE IF EXISTS inventory_stock     CASCADE;
  DROP TYPE  IF EXISTS movement_type       CASCADE;
  DROP TYPE  IF EXISTS inventory_status    CASCADE;
  DROP TYPE  IF EXISTS inventory_item_type CASCADE;
`

module.exports = { up, down }
