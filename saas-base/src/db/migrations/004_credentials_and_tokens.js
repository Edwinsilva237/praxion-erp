'use strict'

const up = `
  CREATE TABLE user_credentials (
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    password_hash VARCHAR(255) NOT NULL,
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT user_credentials_user_unique UNIQUE (user_id)
  );

  CREATE TABLE refresh_tokens (
    id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id    UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash VARCHAR(64) NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    is_revoked BOOLEAN     NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    user_agent TEXT,
    ip_address INET,

    CONSTRAINT refresh_tokens_hash_unique UNIQUE (token_hash)
  );

  CREATE INDEX idx_refresh_tokens_user_id    ON refresh_tokens (user_id);
  CREATE INDEX idx_refresh_tokens_token_hash ON refresh_tokens (token_hash);
  CREATE INDEX idx_refresh_tokens_active     ON refresh_tokens (user_id, is_revoked, expires_at)
    WHERE is_revoked = false;
`

const down = `
  DROP TABLE IF EXISTS refresh_tokens CASCADE;
  DROP TABLE IF EXISTS user_credentials CASCADE;
`

module.exports = { up, down }
