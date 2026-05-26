'use strict'

const up = `
  CREATE TYPE resin_type AS ENUM ('PP', 'PE');
  CREATE TYPE warehouse_type AS ENUM (
    'raw_material',
    'regrind',
    'wip',
    'finished_product',
    'resale'
  );
  CREATE TYPE material_type AS ENUM ('virgin', 'regrind');

  CREATE TABLE warehouses (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id   UUID         NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name        VARCHAR(100) NOT NULL,
    type        warehouse_type NOT NULL,
    resin_type  resin_type,
    description TEXT,
    is_active   BOOLEAN NOT NULL DEFAULT true,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT warehouses_name_tenant_unique UNIQUE (tenant_id, name)
  );

  CREATE INDEX idx_warehouses_tenant_id ON warehouses (tenant_id);
  CREATE INDEX idx_warehouses_type      ON warehouses (tenant_id, type);

  COMMENT ON TABLE  warehouses            IS 'Almacenes físicos o lógicos por tenant';
  COMMENT ON COLUMN warehouses.resin_type IS 'Solo aplica para almacenes de MP y regrind';

  CREATE TRIGGER set_updated_at_warehouses
    BEFORE UPDATE ON warehouses
    FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

  -- Materias primas
  CREATE TABLE raw_materials (
    id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id        UUID         NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name             VARCHAR(150) NOT NULL,
    resin_type       resin_type   NOT NULL,
    material_type    material_type NOT NULL DEFAULT 'virgin',
    unit             VARCHAR(10)  NOT NULL DEFAULT 'kg',
    max_regrind_pct  DECIMAL(5,2) DEFAULT 30.00,
    cost_per_kg      DECIMAL(12,4) DEFAULT 0,
    description      TEXT,
    is_active        BOOLEAN NOT NULL DEFAULT true,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT raw_materials_name_tenant_unique UNIQUE (tenant_id, name),
    CONSTRAINT raw_materials_max_regrind_pct CHECK (max_regrind_pct BETWEEN 0 AND 100)
  );

  CREATE INDEX idx_raw_materials_tenant_id   ON raw_materials (tenant_id);
  CREATE INDEX idx_raw_materials_resin_type  ON raw_materials (tenant_id, resin_type);

  COMMENT ON COLUMN raw_materials.max_regrind_pct IS '% máximo de regrind que se puede mezclar con esta MP';
  COMMENT ON COLUMN raw_materials.cost_per_kg     IS 'Costo actualizable — se usa para costeo de órdenes';

  CREATE TRIGGER set_updated_at_raw_materials
    BEFORE UPDATE ON raw_materials
    FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();
`

const down = `
  DROP TRIGGER IF EXISTS set_updated_at_raw_materials ON raw_materials;
  DROP TRIGGER IF EXISTS set_updated_at_warehouses    ON warehouses;
  DROP TABLE IF EXISTS raw_materials CASCADE;
  DROP TABLE IF EXISTS warehouses    CASCADE;
  DROP TYPE IF EXISTS material_type  CASCADE;
  DROP TYPE IF EXISTS warehouse_type CASCADE;
  DROP TYPE IF EXISTS resin_type     CASCADE;
`

module.exports = { up, down }
