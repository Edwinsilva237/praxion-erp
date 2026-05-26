'use strict'

/**
 * Bitácora de sesiones de impersonación.
 *
 * Cuando un platform_admin entra a un tenant via "Impersonar", se crea una
 * fila aquí. Permite:
 *   - Auditar quién entró a qué tenant y cuándo (cumplimiento LFPDPPP).
 *   - Mostrar al cliente, si pregunta, el historial de accesos.
 *   - Investigar incidentes ("¿alguien impersonó cuando se perdió ese dato?").
 *
 * El propio JWT de impersonación es self-contained (lleva session_id, target
 * user, actor user). NO se valida contra esta tabla en cada request — el JWT
 * tiene TTL corto (30 min). Esta tabla es para auditoría histórica.
 */

const up = `
  CREATE TABLE impersonation_sessions (
    id                    UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),

    -- Quién hizo la impersonación (el platform admin real).
    actor_user_id         UUID         NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    actor_tenant_id       UUID         NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,

    -- A quién impersonó.
    target_user_id        UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    target_tenant_id      UUID         NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

    -- Razón opcional declarada por el actor (ej. "ticket #234 — bug de timbrado").
    reason                TEXT,

    started_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    expires_at            TIMESTAMPTZ  NOT NULL,
    ended_at              TIMESTAMPTZ,   -- NULL hasta que el actor cierra explícito o expira
    end_reason            VARCHAR(40),   -- 'user_ended' | 'expired' | 'admin_revoked'

    ip_address            INET,
    user_agent            TEXT
  );

  CREATE INDEX idx_impersonation_actor   ON impersonation_sessions (actor_user_id, started_at DESC);
  CREATE INDEX idx_impersonation_target  ON impersonation_sessions (target_tenant_id, started_at DESC);
  CREATE INDEX idx_impersonation_active  ON impersonation_sessions (id) WHERE ended_at IS NULL;
`

const down = `
  DROP TABLE IF EXISTS impersonation_sessions CASCADE;
`

module.exports = { up, down }
