'use strict'

const up = `
  -- 1. Agregar prioridad y sort_order a production_orders
  DO $$ BEGIN
    CREATE TYPE order_priority AS ENUM ('urgente','alta','normal','baja');
  EXCEPTION WHEN duplicate_object THEN null; END $$;

  ALTER TABLE production_orders
    ADD COLUMN IF NOT EXISTS priority    order_priority NOT NULL DEFAULT 'normal',
    ADD COLUMN IF NOT EXISTS sort_order  INTEGER        NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS line_id     INTEGER        NOT NULL DEFAULT 1,
    ADD COLUMN IF NOT EXISTS delivery_date DATE;

  CREATE INDEX IF NOT EXISTS idx_po_priority ON production_orders (tenant_id, priority, sort_order);

  COMMENT ON COLUMN production_orders.priority     IS 'Prioridad visual: urgente | alta | normal | baja';
  COMMENT ON COLUMN production_orders.sort_order   IS 'Posición en la cola — menor número = mayor prioridad';
  COMMENT ON COLUMN production_orders.delivery_date IS 'Fecha compromiso de entrega al cliente';

  -- 2. Agregar production_order_id a shift_progress
  --    (el paquete ahora sabe a qué orden pertenece)
  ALTER TABLE shift_progress
    ADD COLUMN IF NOT EXISTS production_order_id UUID REFERENCES production_orders(id);

  CREATE INDEX IF NOT EXISTS idx_sp_order_id ON shift_progress (production_order_id);

  COMMENT ON COLUMN shift_progress.production_order_id IS
    'Orden activa al momento de capturar el paquete. Permite múltiples órdenes por turno.';

  -- 3. Hacer production_order_id opcional en production_shifts
  --    (el turno ya no pertenece a una sola orden)
  ALTER TABLE production_shifts
    ALTER COLUMN production_order_id DROP NOT NULL;

  -- El unique constraint original (production_order_id, shift_number, shift_date)
  -- ya no aplica porque un turno puede tener varias órdenes.
  -- Lo reemplazamos por un unique sobre (tenant_id, line_id, shift_number, shift_date)
  ALTER TABLE production_shifts
    DROP CONSTRAINT IF EXISTS ps_unique_shift;

  ALTER TABLE production_shifts
    ADD COLUMN IF NOT EXISTS line_id INTEGER NOT NULL DEFAULT 1,
    ADD COLUMN IF NOT EXISTS cost_per_unit DECIMAL(12,6);

  ALTER TABLE production_shifts
    ADD CONSTRAINT ps_unique_line_shift UNIQUE (tenant_id, line_id, shift_number, shift_date);

  CREATE INDEX IF NOT EXISTS idx_ps_line ON production_shifts (tenant_id, line_id, status);

  -- 4. También actualizar scheduled_shifts para quitar la dependencia de orden específica
  ALTER TABLE scheduled_shifts
    ALTER COLUMN production_order_id DROP NOT NULL;

  ALTER TABLE scheduled_shifts
    DROP CONSTRAINT IF EXISTS ss_unique_slot;

  ALTER TABLE scheduled_shifts
    ADD COLUMN IF NOT EXISTS line_id INTEGER NOT NULL DEFAULT 1;

  ALTER TABLE scheduled_shifts
    ADD CONSTRAINT ss_unique_slot UNIQUE (tenant_id, line_id, shift_number, scheduled_date);
`

const down = `
  ALTER TABLE shift_progress     DROP COLUMN IF EXISTS production_order_id;
  ALTER TABLE production_orders  DROP COLUMN IF EXISTS priority;
  ALTER TABLE production_orders  DROP COLUMN IF EXISTS sort_order;
  ALTER TABLE production_orders  DROP COLUMN IF EXISTS line_id;
  ALTER TABLE production_orders  DROP COLUMN IF EXISTS delivery_date;
  ALTER TABLE production_shifts  DROP COLUMN IF EXISTS line_id;
  ALTER TABLE production_shifts  DROP COLUMN IF EXISTS cost_per_unit;
  ALTER TABLE production_shifts  DROP CONSTRAINT IF EXISTS ps_unique_line_shift;
  ALTER TABLE scheduled_shifts   DROP COLUMN IF EXISTS line_id;
  DROP TYPE IF EXISTS order_priority CASCADE;
`

module.exports = { up, down }
