'use strict'

const up = `
  CREATE TABLE audit_logs (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id   UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    user_id     UUID        REFERENCES users(id) ON DELETE SET NULL,
    action      VARCHAR(100) NOT NULL,
    resource    VARCHAR(100) NOT NULL,
    resource_id UUID,
    payload     JSONB        DEFAULT '{}',
    ip_address  INET,
    user_agent  TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE INDEX idx_audit_logs_tenant_id   ON audit_logs (tenant_id);
  CREATE INDEX idx_audit_logs_user_id     ON audit_logs (user_id);
  CREATE INDEX idx_audit_logs_action      ON audit_logs (action);
  CREATE INDEX idx_audit_logs_resource    ON audit_logs (resource, resource_id);
  CREATE INDEX idx_audit_logs_created_at  ON audit_logs (tenant_id, created_at DESC);

  COMMENT ON TABLE  audit_logs             IS 'Registro inmutable de acciones del sistema por tenant';
  COMMENT ON COLUMN audit_logs.action      IS 'Formato: resource.verb — ej: user.invited, role.created';
  COMMENT ON COLUMN audit_logs.payload     IS 'Datos relevantes del evento sin información sensible';
`

const down = `
  DROP TABLE IF EXISTS audit_logs CASCADE;
`

module.exports = { up, down }
