'use strict'

/**
 * Mensajes del sistema: banners + ventanas de mantenimiento.
 *
 * Una sola tabla cubre dos casos:
 *   - kind='announcement': mensaje libre con ventana de visibilidad (banner)
 *   - kind='maintenance':  ventana de mantenimiento programado con fecha + duración
 *
 * Sin tenant_id: estos mensajes son cross-tenant. El super-admin los crea
 * desde el panel de plataforma y se muestran a TODOS los tenants.
 */

const up = `
  CREATE TABLE system_messages (
    id                  UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
    kind                VARCHAR(20)  NOT NULL CHECK (kind IN ('maintenance','announcement')),
    title               VARCHAR(200) NOT NULL,
    message             TEXT         NOT NULL,
    severity            VARCHAR(20)  NOT NULL DEFAULT 'info'
                                     CHECK (severity IN ('info','success','warning','critical')),

    -- Ventana de visibilidad del banner
    starts_at           TIMESTAMPTZ  NOT NULL,
    ends_at             TIMESTAMPTZ  NOT NULL,

    -- Solo para kind='maintenance'
    maintenance_at      TIMESTAMPTZ,
    duration_minutes    INTEGER,

    -- Notificación por email a tenants
    notify_email        BOOLEAN      NOT NULL DEFAULT FALSE,
    notified_at         TIMESTAMPTZ,             -- email inicial enviado
    reminder_sent_at    TIMESTAMPTZ,             -- recordatorio T-1d enviado
    admin_reminded_at   TIMESTAMPTZ,             -- recordatorio al admin enviado

    cancelled_at        TIMESTAMPTZ,
    cancelled_reason    TEXT,

    created_by          UUID         REFERENCES users(id) ON DELETE SET NULL,
    created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

    -- Coherencia temporal
    CONSTRAINT sm_visibility_window CHECK (ends_at > starts_at),

    -- Si es mantenimiento, los campos de fecha/duración son obligatorios
    CONSTRAINT sm_maintenance_fields CHECK (
      (kind = 'maintenance' AND maintenance_at IS NOT NULL AND duration_minutes IS NOT NULL AND duration_minutes > 0)
      OR
      (kind = 'announcement')
    )
  );

  -- Para el query del banner (mensajes activos): filtrar por ventana de visibilidad
  -- y excluir los cancelados.
  CREATE INDEX idx_system_messages_active
    ON system_messages (starts_at, ends_at)
    WHERE cancelled_at IS NULL;

  -- Para los jobs de notificación que buscan no notificados / no recordados.
  CREATE INDEX idx_system_messages_notify_pending
    ON system_messages (notify_email, notified_at)
    WHERE cancelled_at IS NULL AND notify_email = TRUE AND notified_at IS NULL;

  CREATE INDEX idx_system_messages_reminder_pending
    ON system_messages (maintenance_at, reminder_sent_at)
    WHERE cancelled_at IS NULL AND kind = 'maintenance' AND reminder_sent_at IS NULL;

  CREATE TRIGGER set_updated_at_system_messages BEFORE UPDATE ON system_messages
    FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();
`

const down = `
  DROP TRIGGER IF EXISTS set_updated_at_system_messages ON system_messages;
  DROP TABLE IF EXISTS system_messages CASCADE;
`

module.exports = { up, down }
