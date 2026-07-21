'use strict'

/**
 * Mig 234 — Comunicados Fase 2 (escala + comodidad).
 *
 * (a) ENVÍO EN SEGUNDO PLANO (sin Redis, vía pg-boss):
 *     - `communication_sends.status` gana el estado 'sending' (en curso).
 *     - `communication_sends.sent_count` — progreso (numerador; el denominador
 *       es recipient_count). El worker lo va actualizando → barra de progreso.
 *     Los destinatarios se PRE-INSERTAN en estado 'queued' y el worker los marca
 *     'sent'/'failed' uno por uno, así el envío es REANUDABLE: si el proceso se
 *     reinicia a medias, al reintentar solo procesa los que siguen en 'queued'.
 *
 * (b) PLANTILLAS / BORRADORES reutilizables por tenant (asunto+mensaje+categoría).
 *
 * (c) CATEGORÍAS configurables por tenant (antes: 4 fijas en el frontend). El
 *     campo `category` de un envío sigue siendo texto libre — estas filas solo
 *     alimentan el selector y permiten gestionarlas; no rompen datos existentes.
 *
 * Aditiva. No agrega permisos: reusa communications:read (listar) y
 * communications:send (componer/gestionar).
 */

const up = `
  -- (a) Progreso + estado 'sending' en el batch de envío.
  ALTER TABLE communication_sends DROP CONSTRAINT IF EXISTS comm_send_status_check;
  ALTER TABLE communication_sends
    ADD CONSTRAINT comm_send_status_check
    CHECK (status IN ('queued','sending','completed','partial'));
  ALTER TABLE communication_sends
    ADD COLUMN IF NOT EXISTS sent_count INTEGER NOT NULL DEFAULT 0;

  -- (b) Plantillas / borradores reutilizables.
  CREATE TABLE communication_templates (
    id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id  UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name       VARCHAR(120) NOT NULL,
    subject    VARCHAR(300),
    message    TEXT,
    category   VARCHAR(60),
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX idx_commtpl_tenant ON communication_templates (tenant_id, name);

  -- (c) Categorías configurables por tenant.
  CREATE TABLE communication_categories (
    id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id  UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name       VARCHAR(60) NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    is_active  BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  -- Sin duplicados por tenant (case-insensitive).
  CREATE UNIQUE INDEX uq_commcat_tenant_name ON communication_categories (tenant_id, lower(name));
`

const down = `
  DROP TABLE IF EXISTS communication_categories;
  DROP TABLE IF EXISTS communication_templates;
  ALTER TABLE communication_sends DROP COLUMN IF EXISTS sent_count;
  ALTER TABLE communication_sends DROP CONSTRAINT IF EXISTS comm_send_status_check;
  ALTER TABLE communication_sends
    ADD CONSTRAINT comm_send_status_check
    CHECK (status IN ('queued','completed','partial'));
`

module.exports = { up, down }
