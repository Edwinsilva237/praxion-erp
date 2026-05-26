'use strict'

const up = `
  CREATE TABLE users (
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id     UUID         NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    email         VARCHAR(255) NOT NULL,
    full_name     VARCHAR(255) NOT NULL,
    is_active     BOOLEAN      NOT NULL DEFAULT true,
    last_login_at TIMESTAMPTZ,
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

    CONSTRAINT users_email_tenant_unique UNIQUE (tenant_id, email),
    CONSTRAINT users_email_format CHECK (email ~* '^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$')
  );

  CREATE INDEX idx_users_tenant_id ON users (tenant_id);
  CREATE INDEX idx_users_email     ON users (email);
  CREATE INDEX idx_users_is_active ON users (tenant_id, is_active) WHERE is_active = true;
`

const down = `
  DROP TABLE IF EXISTS users CASCADE;
`

module.exports = { up, down }
