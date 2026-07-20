'use strict'

/**
 * Mig 233 — Módulo "Comunicados" (avisos a clientes/proveedores por correo).
 *
 * Generaliza la distribución fiscal (migs 231-232): en vez de 2 PDF fijos a solo
 * clientes, es un aviso con texto + N adjuntos LIBRES a una audiencia configurable
 * (clientes, proveedores y/o correos manuales). Estas tablas son la BITÁCORA de
 * cada envío. Los adjuntos se guardan en la tabla `attachments`
 * (entity_type='communication', categoría 'communication').
 *
 *   communication_sends            → una fila por acción de envío (batch).
 *   communication_send_recipients  → una fila por (destinatario, correo) con estado.
 *
 * Permisos: communications:read (ver historial) + communications:send (componer y
 * enviar). Se otorgan a los roles que administran el tenant (owner/admin) +
 * super_admin. ⚠️ RE-LOGIN del owner para verlos.
 *
 * Módulo toggle-able: `tenants.modules.communications` (negativo: ausente/true=ON).
 */

const up = `
  -- Categoría de adjunto para los archivos de un comunicado (patrón mig 231).
  ALTER TYPE attachment_category ADD VALUE IF NOT EXISTS 'communication';

  -- ─── Batch de envío ───────────────────────────────────────────────────────
  CREATE TABLE communication_sends (
    id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id        UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    subject          VARCHAR(300) NOT NULL,
    message          TEXT,
    category         VARCHAR(60),
    attachment_count INTEGER NOT NULL DEFAULT 0,
    client_count     INTEGER NOT NULL DEFAULT 0,
    supplier_count   INTEGER NOT NULL DEFAULT 0,
    manual_count     INTEGER NOT NULL DEFAULT 0,
    recipient_count  INTEGER NOT NULL DEFAULT 0,
    -- queued: encolados; completed: sin fallos síncronos; partial: hubo fallos.
    status           VARCHAR(20) NOT NULL DEFAULT 'queued',
    sent_by          UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT comm_send_status_check CHECK (status IN ('queued','completed','partial'))
  );
  CREATE INDEX idx_commsend_tenant ON communication_sends (tenant_id, created_at DESC);

  -- ─── Destinatarios (socio + correo) ───────────────────────────────────────
  CREATE TABLE communication_send_recipients (
    id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    send_id      UUID NOT NULL REFERENCES communication_sends(id) ON DELETE CASCADE,
    tenant_id    UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    partner_id   UUID REFERENCES business_partners(id) ON DELETE SET NULL,
    partner_name VARCHAR(255),
    -- 'customer' | 'supplier' | 'manual'
    partner_type VARCHAR(20),
    email        VARCHAR(255) NOT NULL,
    status       VARCHAR(20) NOT NULL DEFAULT 'queued',
    error        TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT comm_recipient_status_check CHECK (status IN ('queued','sent','failed'))
  );
  CREATE INDEX idx_commrecip_send   ON communication_send_recipients (send_id);
  CREATE INDEX idx_commrecip_tenant ON communication_send_recipients (tenant_id);

  -- ─── Permisos communications:read / communications:send ───────────────────
  INSERT INTO permissions (resource, action, description) VALUES
    ('communications', 'read', 'Ver el historial de comunicados enviados'),
    ('communications', 'send', 'Componer y enviar comunicados a clientes/proveedores')
  ON CONFLICT (resource, action) DO NOTHING;

  -- Otorgar a los roles que administran el tenant (los que tienen users:create =
  -- owner/admin), sin nombrarlos (mismo patrón que migs 227/232).
  INSERT INTO role_permissions (role_id, permission_id)
  SELECT DISTINCT rp.role_id, pnew.id
    FROM role_permissions rp
    JOIN permissions padmin ON padmin.id = rp.permission_id
                           AND padmin.resource = 'users' AND padmin.action = 'create'
    CROSS JOIN permissions pnew
   WHERE pnew.resource = 'communications' AND pnew.action IN ('read','send')
     AND NOT EXISTS (
       SELECT 1 FROM role_permissions rp2
        WHERE rp2.role_id = rp.role_id AND rp2.permission_id = pnew.id
     );

  -- Asegurar el super_admin global.
  INSERT INTO role_permissions (role_id, permission_id)
  SELECT r.id, p.id
    FROM roles r CROSS JOIN permissions p
   WHERE r.name = 'super_admin' AND p.resource = 'communications' AND p.action IN ('read','send')
     AND NOT EXISTS (
       SELECT 1 FROM role_permissions rp WHERE rp.role_id = r.id AND rp.permission_id = p.id
     );
`

const down = `
  DROP TABLE IF EXISTS communication_send_recipients;
  DROP TABLE IF EXISTS communication_sends;
  DELETE FROM role_permissions
   WHERE permission_id IN (SELECT id FROM permissions WHERE resource = 'communications');
  DELETE FROM permissions WHERE resource = 'communications';
  -- El valor de enum 'communication' no se elimina (ALTER TYPE ... DROP VALUE no
  -- existe en Postgres); es inofensivo dejarlo.
`

module.exports = { up, down }
