'use strict'

/**
 * Mig 232 — Distribución de documentos fiscales (CSF + Opinión 32-D) a clientes.
 *
 * El tenant sube su CSF y su Opinión de Cumplimiento (art. 32-D) —guardadas como
 * attachments a nivel tenant, categorías fiscal_csf/fiscal_32d de la mig 231— y
 * las envía por correo a sus clientes (un correo INDIVIDUAL por cliente, a todos
 * sus contactos con email). Estas tablas son la BITÁCORA/comprobante de envío.
 *
 *   fiscal_doc_sends            → una fila por acción de envío (batch).
 *   fiscal_doc_send_recipients  → una fila por (cliente, correo) con su estado.
 *
 * NO se referencian los attachments por FK: se guarda el NOMBRE del archivo como
 * snapshot, para que la bitácora sobreviva al reemplazo del documento (los docs
 * fiscales se reemplazan cuando el tenant baja unos nuevos del SAT).
 *
 * Permiso 'fiscal:distribute' (owner/admin + super_admin). RE-LOGIN del owner.
 */

const up = `
  -- ─── Batch de envío ───────────────────────────────────────────────────────
  CREATE TABLE fiscal_doc_sends (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    -- Snapshot de qué documentos se enviaron (nombre + si iban incluidos).
    csf_filename       VARCHAR(255),
    opinion_filename   VARCHAR(255),
    included_csf       BOOLEAN NOT NULL DEFAULT false,
    included_opinion   BOOLEAN NOT NULL DEFAULT false,
    subject         VARCHAR(300),
    message         TEXT,
    client_count    INTEGER NOT NULL DEFAULT 0,
    recipient_count INTEGER NOT NULL DEFAULT 0,
    -- queued: encolados; completed: sin fallos síncronos; partial: hubo fallos.
    status          VARCHAR(20) NOT NULL DEFAULT 'queued',
    sent_by         UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT fiscal_send_status_check CHECK (status IN ('queued','completed','partial'))
  );
  CREATE INDEX idx_fiscalsend_tenant ON fiscal_doc_sends (tenant_id, created_at DESC);

  -- ─── Destinatarios (cliente + correo) ─────────────────────────────────────
  CREATE TABLE fiscal_doc_send_recipients (
    id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    send_id      UUID NOT NULL REFERENCES fiscal_doc_sends(id) ON DELETE CASCADE,
    tenant_id    UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    partner_id   UUID REFERENCES business_partners(id) ON DELETE SET NULL,
    partner_name VARCHAR(255),
    email        VARCHAR(255) NOT NULL,
    -- queued: encolado; sent: enviado (modo síncrono OK); failed: falló al encolar/enviar.
    status       VARCHAR(20) NOT NULL DEFAULT 'queued',
    error        TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT fiscal_recipient_status_check CHECK (status IN ('queued','sent','failed'))
  );
  CREATE INDEX idx_fiscalrecip_send    ON fiscal_doc_send_recipients (send_id);
  CREATE INDEX idx_fiscalrecip_tenant  ON fiscal_doc_send_recipients (tenant_id);

  -- ─── Permiso fiscal:distribute ────────────────────────────────────────────
  INSERT INTO permissions (resource, action, description) VALUES
    ('fiscal', 'distribute', 'Enviar documentos fiscales (CSF/32-D) a clientes')
  ON CONFLICT (resource, action) DO NOTHING;

  -- Otorgar a roles que administran el tenant (los que tienen users:create =
  -- owner/admin), sin nombrarlos por nombre. Mismo patrón que mig 227.
  INSERT INTO role_permissions (role_id, permission_id)
  SELECT DISTINCT rp.role_id, pnew.id
    FROM role_permissions rp
    JOIN permissions padmin ON padmin.id = rp.permission_id
                           AND padmin.resource = 'users' AND padmin.action = 'create'
    CROSS JOIN permissions pnew
   WHERE pnew.resource = 'fiscal' AND pnew.action = 'distribute'
     AND NOT EXISTS (
       SELECT 1 FROM role_permissions rp2
        WHERE rp2.role_id = rp.role_id AND rp2.permission_id = pnew.id
     );

  -- Asegurar el super_admin global.
  INSERT INTO role_permissions (role_id, permission_id)
  SELECT r.id, p.id
    FROM roles r CROSS JOIN permissions p
   WHERE r.name = 'super_admin' AND p.resource = 'fiscal' AND p.action = 'distribute'
     AND NOT EXISTS (
       SELECT 1 FROM role_permissions rp WHERE rp.role_id = r.id AND rp.permission_id = p.id
     );
`

const down = `
  DROP TABLE IF EXISTS fiscal_doc_send_recipients;
  DROP TABLE IF EXISTS fiscal_doc_sends;
  DELETE FROM role_permissions
   WHERE permission_id IN (SELECT id FROM permissions WHERE resource = 'fiscal' AND action = 'distribute');
  DELETE FROM permissions WHERE resource = 'fiscal' AND action = 'distribute';
`

module.exports = { up, down }
