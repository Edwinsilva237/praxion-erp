'use strict'

const up = `
  CREATE TABLE roles (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id   UUID         REFERENCES tenants(id) ON DELETE CASCADE,
    name        VARCHAR(100) NOT NULL,
    description TEXT,
    is_system   BOOLEAN      NOT NULL DEFAULT false,
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

    CONSTRAINT roles_name_tenant_unique UNIQUE (tenant_id, name)
  );

  CREATE INDEX idx_roles_tenant_id ON roles (tenant_id);
  CREATE INDEX idx_roles_is_system ON roles (is_system) WHERE is_system = true;

  CREATE TABLE permissions (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    resource    VARCHAR(100) NOT NULL,
    action      VARCHAR(50)  NOT NULL,
    description TEXT,

    CONSTRAINT permissions_resource_action_unique UNIQUE (resource, action)
  );

  CREATE INDEX idx_permissions_resource ON permissions (resource);

  CREATE TABLE role_permissions (
    role_id       UUID NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    permission_id UUID NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
    granted_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    PRIMARY KEY (role_id, permission_id)
  );

  CREATE INDEX idx_role_permissions_role_id ON role_permissions (role_id);

  CREATE TABLE user_roles (
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role_id     UUID NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    assigned_by UUID        REFERENCES users(id) ON DELETE SET NULL,

    PRIMARY KEY (user_id, role_id)
  );

  CREATE INDEX idx_user_roles_user_id ON user_roles (user_id);
  CREATE INDEX idx_user_roles_role_id ON user_roles (role_id);
`

const down = `
  DROP TABLE IF EXISTS user_roles CASCADE;
  DROP TABLE IF EXISTS role_permissions CASCADE;
  DROP TABLE IF EXISTS permissions CASCADE;
  DROP TABLE IF EXISTS roles CASCADE;
`

module.exports = { up, down }
