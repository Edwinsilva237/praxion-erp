'use strict'

const up = `
  CREATE TYPE attachment_category AS ENUM (
    'technical_sheet',
    'recipe',
    'temperature_profile',
    'manual',
    'certificate',
    'other'
  );

  CREATE TABLE attachments (
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id     UUID         NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    entity_type   VARCHAR(50)  NOT NULL,
    entity_id     UUID         NOT NULL,
    category      attachment_category NOT NULL DEFAULT 'other',
    filename      VARCHAR(255) NOT NULL,
    storage_path  VARCHAR(500) NOT NULL,
    file_size_bytes BIGINT,
    mime_type     VARCHAR(100) NOT NULL DEFAULT 'application/pdf',
    description   TEXT,
    uploaded_by   UUID         REFERENCES users(id) ON DELETE SET NULL,
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
  );

  CREATE INDEX idx_attachments_tenant_id   ON attachments (tenant_id);
  CREATE INDEX idx_attachments_entity      ON attachments (tenant_id, entity_type, entity_id);
  CREATE INDEX idx_attachments_category    ON attachments (tenant_id, entity_type, category);

  COMMENT ON TABLE  attachments             IS 'Archivos adjuntos genéricos — vinculables a cualquier entidad';
  COMMENT ON COLUMN attachments.entity_type IS 'Nombre de la entidad: product, raw_material, production_order, etc.';
  COMMENT ON COLUMN attachments.entity_id   IS 'UUID del registro al que pertenece el archivo';
  COMMENT ON COLUMN attachments.storage_path IS 'Ruta local o key en S3/R2 — nunca exponer directamente al cliente';
`

const down = `
  DROP TABLE IF EXISTS attachments        CASCADE;
  DROP TYPE  IF EXISTS attachment_category CASCADE;
`

module.exports = { up, down }
