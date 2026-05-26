'use strict'

const up = `
  CREATE TABLE delivery_records (
    id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id         UUID          NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    delivery_note_id  UUID          NOT NULL REFERENCES delivery_notes(id) ON DELETE CASCADE,
    record_number     INTEGER       NOT NULL,
    delivery_date     DATE          NOT NULL DEFAULT CURRENT_DATE,
    driver_id         UUID          REFERENCES users(id) ON DELETE SET NULL,
    receiver_name     VARCHAR(150)  NOT NULL,
    photo_path        VARCHAR(500),
    notes             TEXT,
    is_complete       BOOLEAN       NOT NULL DEFAULT false,
    synced_at         TIMESTAMPTZ,
    created_by        UUID          REFERENCES users(id) ON DELETE SET NULL,
    created_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

    CONSTRAINT dr_record_number_unique UNIQUE (delivery_note_id, record_number)
  );

  CREATE INDEX idx_dr_delivery_note_id ON delivery_records (delivery_note_id);
  CREATE INDEX idx_dr_tenant_id        ON delivery_records (tenant_id);
  CREATE INDEX idx_dr_driver_id        ON delivery_records (tenant_id, driver_id);
  CREATE INDEX idx_dr_delivery_date    ON delivery_records (tenant_id, delivery_date);
  CREATE INDEX idx_dr_unsynced         ON delivery_records (tenant_id, synced_at)
    WHERE synced_at IS NULL AND photo_path IS NOT NULL;

  -- Líneas de cada entrega parcial — qué productos y cuántos se entregaron
  CREATE TABLE delivery_record_lines (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    delivery_record_id  UUID          NOT NULL REFERENCES delivery_records(id) ON DELETE CASCADE,
    delivery_note_line_id UUID        NOT NULL REFERENCES delivery_note_lines(id),
    quantity_delivered  DECIMAL(14,4) NOT NULL,
    notes               TEXT,

    CONSTRAINT drl_qty_positive CHECK (quantity_delivered > 0)
  );

  CREATE INDEX idx_drl_record_id ON delivery_record_lines (delivery_record_id);
  CREATE INDEX idx_drl_note_line ON delivery_record_lines (delivery_note_line_id);

  COMMENT ON TABLE  delivery_records              IS 'Cada entrega física contra una remisión — puede haber varias por remisión';
  COMMENT ON COLUMN delivery_records.record_number IS 'Número secuencial de entrega dentro de la remisión: 1, 2, 3...';
  COMMENT ON COLUMN delivery_records.is_complete   IS 'True = esta entrega completa el total de la remisión';
  COMMENT ON COLUMN delivery_records.synced_at     IS 'NULL = capturado offline, pendiente de sincronizar';

  -- Función para calcular cantidad pendiente de entrega por línea de remisión
  CREATE OR REPLACE FUNCTION get_pending_quantity(p_note_line_id UUID)
  RETURNS DECIMAL AS $$
    SELECT COALESCE(dnl.quantity_ordered, 0) -
           COALESCE((
             SELECT SUM(drl.quantity_delivered)
             FROM delivery_record_lines drl
             JOIN delivery_records dr ON dr.id = drl.delivery_record_id
             WHERE drl.delivery_note_line_id = p_note_line_id
           ), 0)
    FROM delivery_note_lines dnl
    WHERE dnl.id = p_note_line_id;
  $$ LANGUAGE SQL STABLE;

  COMMENT ON FUNCTION get_pending_quantity IS 'Cantidad pendiente de entregar en una línea de remisión';
`

const down = `
  DROP FUNCTION IF EXISTS get_pending_quantity CASCADE;
  DROP TABLE IF EXISTS delivery_record_lines CASCADE;
  DROP TABLE IF EXISTS delivery_records      CASCADE;
`

module.exports = { up, down }
