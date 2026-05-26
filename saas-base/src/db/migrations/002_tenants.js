'use strict'

const up = `
  CREATE TABLE tenants (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    slug        VARCHAR(63)  NOT NULL,
    name        VARCHAR(255) NOT NULL,
    plan        VARCHAR(50)  NOT NULL DEFAULT 'free',
    is_active   BOOLEAN      NOT NULL DEFAULT true,
    metadata    JSONB                 DEFAULT '{}',
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

    CONSTRAINT tenants_slug_unique UNIQUE (slug),
    CONSTRAINT tenants_slug_format CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$'),
    CONSTRAINT tenants_plan_check  CHECK (plan IN ('free', 'starter', 'pro', 'enterprise'))
  );

  CREATE INDEX idx_tenants_slug      ON tenants (slug);
  CREATE INDEX idx_tenants_is_active ON tenants (is_active) WHERE is_active = true;
`

const down = `
  DROP TABLE IF EXISTS tenants CASCADE;
`

module.exports = { up, down }
