'use strict'

const up = `
  -- 1. Longitud en órdenes de producción (medida del esquinero)
  ALTER TABLE production_orders
    ADD COLUMN IF NOT EXISTS length_mm       DECIMAL(8,2),
    ADD COLUMN IF NOT EXISTS line_id         INTEGER NOT NULL DEFAULT 1,
    ADD COLUMN IF NOT EXISTS cost_per_unit   DECIMAL(12,6),
    ADD COLUMN IF NOT EXISTS total_cost      DECIMAL(14,4);

  COMMENT ON COLUMN production_orders.length_mm     IS 'Largo del esquinero en mm para esta orden';
  COMMENT ON COLUMN production_orders.line_id       IS 'Línea de producción (1,2,3...) para multi-línea';
  COMMENT ON COLUMN production_orders.cost_per_unit IS 'Costo unitario calculado al cerrar el turno';
  COMMENT ON COLUMN production_orders.total_cost    IS 'Costo total del lote';

  -- 2. Segunda calidad y largo en captura de paquetes
  ALTER TABLE shift_progress
    ADD COLUMN IF NOT EXISTS is_second_quality BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS length_mm         DECIMAL(8,2);

  COMMENT ON COLUMN shift_progress.is_second_quality IS 'Paquete marcado como segunda calidad por el operador';

  -- 3. Catálogo de costos fijos por turno
  CREATE TABLE IF NOT EXISTS production_cost_items (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id   UUID          NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name        VARCHAR(100)  NOT NULL,
    amount      DECIMAL(12,4) NOT NULL DEFAULT 0,
    unit        VARCHAR(20)   NOT NULL DEFAULT 'por_turno',
    is_active   BOOLEAN       NOT NULL DEFAULT true,
    sort_order  INTEGER       NOT NULL DEFAULT 0,
    notes       TEXT,
    created_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

    CONSTRAINT pci_name_tenant UNIQUE (tenant_id, name),
    CONSTRAINT pci_amount_positive CHECK (amount >= 0)
  );

  CREATE INDEX idx_pci_tenant ON production_cost_items (tenant_id, is_active);

  COMMENT ON TABLE production_cost_items IS 'Catálogo de costos fijos que se aplican automáticamente a cada turno cerrado';

  CREATE TRIGGER set_updated_at_pci
    BEFORE UPDATE ON production_cost_items
    FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

  -- 4. Tipos de merma
  DO $$ BEGIN
    CREATE TYPE scrap_type AS ENUM ('arranque','operacion','contaminada','desecho');
  EXCEPTION WHEN duplicate_object THEN null; END $$;

  DO $$ BEGIN
    CREATE TYPE scrap_destination AS ENUM ('regrind','mezcla','venta','desecho');
  EXCEPTION WHEN duplicate_object THEN null; END $$;

  -- 5. Registro de merma por turno
  CREATE TABLE IF NOT EXISTS shift_scrap (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    shift_id    UUID               NOT NULL REFERENCES production_shifts(id) ON DELETE CASCADE,
    scrap_type  scrap_type         NOT NULL,
    destination scrap_destination,
    kg          DECIMAL(10,4)      NOT NULL DEFAULT 0,
    notes       TEXT,
    captured_at TIMESTAMPTZ        NOT NULL DEFAULT NOW(),

    CONSTRAINT ss_kg_positive CHECK (kg >= 0)
  );

  CREATE INDEX idx_ss_shift_id ON shift_scrap (shift_id);

  COMMENT ON TABLE shift_scrap IS 'Merma registrada por tipo durante el turno. El kg total se cruza con la diferencia MP-PT al validar.';

  -- 6. Incidencias del turno
  DO $$ BEGIN
    CREATE TYPE incident_category AS ENUM ('paro_maquina','problema_mp','cambio_orden','calidad','otro');
  EXCEPTION WHEN duplicate_object THEN null; END $$;

  CREATE TABLE IF NOT EXISTS shift_incidents (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    shift_id    UUID               NOT NULL REFERENCES production_shifts(id) ON DELETE CASCADE,
    category    incident_category  NOT NULL,
    description TEXT               NOT NULL,
    duration_min INTEGER,
    reported_by UUID               REFERENCES users(id) ON DELETE SET NULL,
    created_at  TIMESTAMPTZ        NOT NULL DEFAULT NOW()
  );

  CREATE INDEX idx_si_shift_id ON shift_incidents (shift_id);

  -- 7. MP cargada por turno (puede haber múltiples cargas incluyendo reposiciones)
  CREATE TABLE IF NOT EXISTS shift_mp_loads (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    shift_id        UUID          NOT NULL REFERENCES production_shifts(id) ON DELETE CASCADE,
    raw_material_id UUID          NOT NULL REFERENCES raw_materials(id),
    kg              DECIMAL(10,4) NOT NULL,
    is_replacement  BOOLEAN       NOT NULL DEFAULT false,
    notes           TEXT,
    loaded_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

    CONSTRAINT sml_kg_positive CHECK (kg > 0)
  );

  CREATE INDEX idx_sml_shift_id ON shift_mp_loads (shift_id);

  COMMENT ON TABLE shift_mp_loads IS 'Cargas de MP por turno. La carga inicial + reposiciones = MP total consumida.';

  -- 8. Costos aplicados al cerrar un turno (snapshot del catálogo en ese momento)
  CREATE TABLE IF NOT EXISTS shift_cost_snapshot (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    shift_id        UUID          NOT NULL REFERENCES production_shifts(id) ON DELETE CASCADE,
    cost_item_id    UUID          REFERENCES production_cost_items(id) ON DELETE SET NULL,
    name            VARCHAR(100)  NOT NULL,
    amount          DECIMAL(12,4) NOT NULL,
    created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
  );

  CREATE INDEX idx_scs_shift_id ON shift_cost_snapshot (shift_id);

  COMMENT ON TABLE shift_cost_snapshot IS 'Snapshot de costos aplicados al turno. Preserva los montos aunque cambie el catálogo después.';
`

const down = `
  DROP TABLE IF EXISTS shift_cost_snapshot  CASCADE;
  DROP TABLE IF EXISTS shift_mp_loads       CASCADE;
  DROP TABLE IF EXISTS shift_incidents      CASCADE;
  DROP TABLE IF EXISTS shift_scrap          CASCADE;
  DROP TABLE IF EXISTS production_cost_items CASCADE;
  DROP TYPE  IF EXISTS incident_category    CASCADE;
  DROP TYPE  IF EXISTS scrap_destination    CASCADE;
  DROP TYPE  IF EXISTS scrap_type           CASCADE;
  ALTER TABLE shift_progress    DROP COLUMN IF EXISTS is_second_quality;
  ALTER TABLE shift_progress    DROP COLUMN IF EXISTS length_mm;
  ALTER TABLE production_orders DROP COLUMN IF EXISTS length_mm;
  ALTER TABLE production_orders DROP COLUMN IF EXISTS line_id;
  ALTER TABLE production_orders DROP COLUMN IF EXISTS cost_per_unit;
  ALTER TABLE production_orders DROP COLUMN IF EXISTS total_cost;
`

module.exports = { up, down }
