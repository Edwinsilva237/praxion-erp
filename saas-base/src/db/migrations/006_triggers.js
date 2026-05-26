'use strict'

const up = `
  CREATE OR REPLACE FUNCTION trigger_set_updated_at()
  RETURNS TRIGGER AS $$
  BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
  END;
  $$ LANGUAGE plpgsql;

  CREATE TRIGGER set_updated_at_tenants
    BEFORE UPDATE ON tenants
    FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

  CREATE TRIGGER set_updated_at_users
    BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

  CREATE TRIGGER set_updated_at_user_credentials
    BEFORE UPDATE ON user_credentials
    FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();
`

const down = `
  DROP TRIGGER IF EXISTS set_updated_at_tenants          ON tenants;
  DROP TRIGGER IF EXISTS set_updated_at_users            ON users;
  DROP TRIGGER IF EXISTS set_updated_at_user_credentials ON user_credentials;
  DROP FUNCTION IF EXISTS trigger_set_updated_at();
`

module.exports = { up, down }
