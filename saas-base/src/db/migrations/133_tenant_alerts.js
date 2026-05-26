'use strict'

/**
 * SaaS v2 — Migration 133: tabla de alertas por tenant.
 *
 * Persiste alertas operativas que el frontend debe mostrar al usuario:
 *  - lot_expiring     → un lote (MP o PT) está próximo a caducar.
 *  - lot_expired      → un lote ya caducó (status pasó a 'expired').
 *  - allergen_discrepancy → al cerrar un product_lot se detectó que su MP
 *    consumida arrastra alérgenos no declarados en el producto.
 *  - (extensible)     → más tipos en el futuro sin migration nueva.
 *
 * Severity:
 *  - info, warning, critical.
 *
 * Status:
 *  - pending (recién creada, sin reconocer),
 *  - acknowledged (alguien la vio y la marcó),
 *  - resolved (la causa raíz fue resuelta).
 *
 * `payload jsonb` lleva contexto específico del tipo: lot_id, product_id,
 * raw_material_id, allergens_missing, expiry_date, etc.
 *
 * `source_type` + `source_id` permiten linkear con la entidad origen para
 * navegación desde el frontend (ej. source_type='raw_material_lot').
 *
 * Para evitar spam, el caller debe verificar si ya existe una alerta
 * pending/acknowledged del mismo (type, source_type, source_id) antes de
 * insertar — alertService.dispatchAlert lo hace.
 *
 * Referencia: §4.9.2 del design.
 */

const up = `
  CREATE TABLE tenant_alerts (
    id                 UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id          UUID         NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    type               VARCHAR(40)  NOT NULL,
    severity           VARCHAR(20)  NOT NULL DEFAULT 'warning',
    status             VARCHAR(20)  NOT NULL DEFAULT 'pending',
    title              TEXT         NOT NULL,
    body               TEXT         NULL,
    payload            JSONB        NULL,
    source_type        VARCHAR(40)  NULL,
    source_id          UUID         NULL,
    created_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    acknowledged_at    TIMESTAMPTZ  NULL,
    acknowledged_by    UUID         NULL REFERENCES users(id) ON DELETE SET NULL,
    resolved_at        TIMESTAMPTZ  NULL,
    resolved_by        UUID         NULL REFERENCES users(id) ON DELETE SET NULL,

    CONSTRAINT ta_severity_check CHECK (severity IN ('info','warning','critical')),
    CONSTRAINT ta_status_check   CHECK (status IN ('pending','acknowledged','resolved')),
    CONSTRAINT ta_payload_is_object CHECK (payload IS NULL OR jsonb_typeof(payload) = 'object'),
    CONSTRAINT ta_ack_consistency CHECK (
      (status = 'pending' AND acknowledged_at IS NULL AND acknowledged_by IS NULL)
      OR status IN ('acknowledged','resolved')
    ),
    CONSTRAINT ta_resolved_consistency CHECK (
      (status != 'resolved' AND resolved_at IS NULL AND resolved_by IS NULL)
      OR (status = 'resolved' AND resolved_at IS NOT NULL)
    )
  );

  CREATE INDEX idx_ta_tenant_status   ON tenant_alerts (tenant_id, status, created_at DESC);
  CREATE INDEX idx_ta_tenant_type     ON tenant_alerts (tenant_id, type);
  CREATE INDEX idx_ta_source          ON tenant_alerts (source_type, source_id)
    WHERE source_type IS NOT NULL AND source_id IS NOT NULL;
  CREATE INDEX idx_ta_pending_dedupe  ON tenant_alerts (tenant_id, type, source_type, source_id)
    WHERE status IN ('pending','acknowledged');

  COMMENT ON TABLE tenant_alerts IS
    'SaaS v2 §4.9.2: alertas operativas (expiración de lotes, discrepancias de alérgenos, etc.). Persistidas para que el frontend pueda mostrar pendientes.';
  COMMENT ON COLUMN tenant_alerts.type IS
    'lot_expiring | lot_expired | allergen_discrepancy | (extensible — el caller pasa el string)';
  COMMENT ON COLUMN tenant_alerts.payload IS
    'Contexto específico del tipo: lot_id, expiry_date, allergens_missing, etc. Objeto JSONB.';

  -- Permisos: leer alertas / reconocer
  INSERT INTO permissions (resource, action, description)
  VALUES
    ('alerts', 'read',        'Ver alertas pendientes del tenant'),
    ('alerts', 'acknowledge', 'Reconocer / resolver alertas')
  ON CONFLICT (resource, action) DO NOTHING;

  -- Asignar a roles globales y per-tenant principales
  INSERT INTO role_permissions (role_id, permission_id)
  SELECT r.id, p.id
  FROM roles r
  CROSS JOIN permissions p
  WHERE p.resource = 'alerts' AND p.action IN ('read','acknowledge')
    AND r.name IN ('super_admin','owner','admin','supervisor')
  ON CONFLICT DO NOTHING;
`

const down = `
  DELETE FROM role_permissions
  WHERE permission_id IN (SELECT id FROM permissions WHERE resource = 'alerts');
  DELETE FROM permissions WHERE resource = 'alerts';
  DROP TABLE IF EXISTS tenant_alerts;
`

module.exports = { up, down }
