'use strict'

/**
 * Mig 191 — Tokens de dispositivo para notificaciones push (FCM).
 *
 * Cada fila asocia un token de Firebase Cloud Messaging con el (user, tenant)
 * que está logueado en ese dispositivo. La app registra su token al iniciar
 * sesión (POST /api/push/register) y lo borra al cerrar (POST /api/push/unregister).
 *
 * ⚠️ `UNIQUE (token)` a propósito (NO por user/tenant): el token de FCM es
 * GLOBAL por instalación de la app, no por usuario. Si el usuario A cierra
 * sesión y el usuario B entra en el MISMO teléfono, FCM reusa el mismo token.
 * Por eso `registerToken` hace UPSERT por `token` sobrescribiendo
 * user_id/tenant_id → el token siempre apunta al usuario logueado AHORA. Así,
 * aunque se pierda el unregister de A (app matada, sin red), el siguiente login
 * de B lo reclama y nunca hay entrega cruzada.
 *
 * `platform` distingue android / ios / web (web reservado para futuro web-push).
 * `device_info` es texto libre opcional (modelo / SO) para depurar.
 */

const up = `
  CREATE TABLE IF NOT EXISTS device_tokens (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    user_id      UUID NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
    token        TEXT NOT NULL,
    platform     TEXT NOT NULL CHECK (platform IN ('android','ios','web')),
    device_info  TEXT,
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  -- El token es global por dispositivo: clave única para el UPSERT de reclamo.
  CREATE UNIQUE INDEX IF NOT EXISTS device_tokens_token_uq ON device_tokens (token);
  -- Lectura caliente: "todos los tokens de estos usuarios en este tenant".
  CREATE INDEX IF NOT EXISTS device_tokens_user_idx ON device_tokens (tenant_id, user_id);

  COMMENT ON TABLE device_tokens IS
    'Tokens FCM por dispositivo. UNIQUE(token) porque el token es global por instalación; el upsert lo reclama para el usuario logueado actual.';

  -- Permiso para mandar anuncios push manuales (broadcast) a todo el tenant.
  INSERT INTO permissions (resource, action, description)
  VALUES ('push', 'broadcast', 'Enviar notificaciones push (anuncios) a la empresa')
  ON CONFLICT (resource, action) DO NOTHING;

  INSERT INTO role_permissions (role_id, permission_id)
  SELECT r.id, p.id
  FROM roles r
  CROSS JOIN permissions p
  WHERE p.resource = 'push' AND p.action = 'broadcast'
    AND r.name IN ('super_admin','owner','admin')
  ON CONFLICT DO NOTHING;
`

const down = `
  DELETE FROM role_permissions
  WHERE permission_id IN (SELECT id FROM permissions WHERE resource = 'push');
  DELETE FROM permissions WHERE resource = 'push';
  DROP TABLE IF EXISTS device_tokens;
`

module.exports = { up, down }
