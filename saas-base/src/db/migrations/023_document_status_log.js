'use strict'

const up = `
  CREATE TABLE document_status_log (
    id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id    UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    entity_type  VARCHAR(50) NOT NULL,
    entity_id    UUID        NOT NULL,
    from_status  VARCHAR(50),
    to_status    VARCHAR(50) NOT NULL,
    changed_by   UUID        REFERENCES users(id) ON DELETE SET NULL,
    notes        TEXT,
    metadata     JSONB       DEFAULT '{}',
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE INDEX idx_dsl_tenant_id  ON document_status_log (tenant_id);
  CREATE INDEX idx_dsl_entity     ON document_status_log (tenant_id, entity_type, entity_id);
  CREATE INDEX idx_dsl_created_at ON document_status_log (tenant_id, created_at DESC);

  COMMENT ON TABLE  document_status_log          IS 'Log inmutable de cambios de estatus en todos los documentos';
  COMMENT ON COLUMN document_status_log.metadata IS 'Datos adicionales según el tipo de cambio (ej: foto_path al entregar)';
`

const down = `
  DROP TABLE IF EXISTS document_status_log CASCADE;
`

module.exports = { up, down }
