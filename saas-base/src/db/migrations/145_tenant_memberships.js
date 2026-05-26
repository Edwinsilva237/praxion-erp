'use strict'

/**
 * tenant_memberships: un usuario puede pertenecer a múltiples tenants.
 *
 * Antes: la pertenencia se modelaba con `users.tenant_id` (un user vive en
 * UN tenant). Patrón de cuentas espejo: para tener "el mismo usuario" en N
 * tenants había que crear N rows en `users` con el mismo email.
 *
 * Después: el row en `users` representa la IDENTIDAD del usuario (perfil,
 * credenciales, etc.). La pertenencia a empresas vive en esta tabla. El
 * `users.tenant_id` se mantiene como "home tenant" — el tenant donde se
 * creó originalmente el user — y siempre debe existir una membresía
 * correspondiente con role='owner'. Esto preserva compatibilidad con
 * todas las queries existentes que filtran por `users.tenant_id`.
 *
 * Backfill: cada user existente recibe automáticamente una membresía
 * 'owner' en su home tenant. Nadie pierde acceso.
 */

const up = `
  CREATE TABLE tenant_memberships (
    id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id    UUID         NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
    tenant_id  UUID         NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    role       VARCHAR(50)  NOT NULL DEFAULT 'member',
    invited_by UUID                  REFERENCES users(id)   ON DELETE SET NULL,
    created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

    CONSTRAINT tenant_memberships_role_check
      CHECK (role IN ('owner', 'admin', 'member')),
    CONSTRAINT tenant_memberships_user_tenant_unique
      UNIQUE (user_id, tenant_id)
  );

  CREATE INDEX idx_memberships_user_id   ON tenant_memberships (user_id);
  CREATE INDEX idx_memberships_tenant_id ON tenant_memberships (tenant_id);

  CREATE TRIGGER set_updated_at_tenant_memberships
    BEFORE UPDATE ON tenant_memberships
    FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

  -- RLS: la tabla tiene tenant_id, así que aplicamos la misma policy que la
  -- migración 099 puso a todas las tablas tenant-scoped. Los endpoints que
  -- necesiten leer cross-tenant (listar memberships del user activo) usan
  -- withBypass(), siguiendo el patrón de requirePlatformAdmin.
  ALTER TABLE tenant_memberships ENABLE ROW LEVEL SECURITY;
  ALTER TABLE tenant_memberships FORCE  ROW LEVEL SECURITY;
  CREATE POLICY rls_tenant ON tenant_memberships
    AS PERMISSIVE
    FOR ALL
    USING      (NOT rls_enforce() OR tenant_id = current_tenant_id())
    WITH CHECK (NOT rls_enforce() OR tenant_id = current_tenant_id());

  -- Backfill: cada user existente es 'owner' en su home tenant.
  INSERT INTO tenant_memberships (user_id, tenant_id, role)
  SELECT id, tenant_id, 'owner'
  FROM users
  ON CONFLICT (user_id, tenant_id) DO NOTHING;
`

const down = `
  DROP TABLE IF EXISTS tenant_memberships CASCADE;
`

module.exports = { up, down }
