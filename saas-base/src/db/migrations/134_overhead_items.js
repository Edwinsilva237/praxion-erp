'use strict'

/**
 * SaaS v2 — Migration 134: catálogo de ítems de overhead por tenant.
 *
 * Cada ítem representa un gasto indirecto (energía, mano de obra indirecta,
 * mantenimiento, depreciación, etc.) que debe distribuirse a los turnos de
 * producción según una base de imputación (allocation_base).
 *
 * allocation_base:
 *   shifts  → cada turno recibe 1/N del total del período.
 *   hours   → se pondera por la duración en horas del turno.
 *   units   → se pondera por unidades producidas.
 *   weight  → se pondera por kg producidos.
 *   equal   → alias de shifts (UI semántica distinta, cálculo igual).
 *
 * capture_frequency: con qué periodicidad se captura el importe real:
 *   monthly | biweekly | annual | event.
 *
 * Referencia: docs/saas-v2/04-fase2-progress.md §Fase3.
 */

const up = `
  CREATE TABLE tenant_overhead_items (
    id                        UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id                 UUID          NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    code                      VARCHAR(50)   NOT NULL,
    name                      VARCHAR(100)  NOT NULL,
    allocation_base           VARCHAR(20)   NOT NULL DEFAULT 'shifts',
    capture_frequency         VARCHAR(20)   NOT NULL DEFAULT 'monthly',
    default_estimated_amount  NUMERIC(18,2) NOT NULL DEFAULT 0,
    is_active                 BOOLEAN       NOT NULL DEFAULT true,
    sort_order                INTEGER       NOT NULL DEFAULT 0,
    notes                     TEXT          NULL,
    created_at                TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    updated_at                TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

    CONSTRAINT toi_allocation_base_check CHECK (
      allocation_base IN ('shifts','hours','units','weight','equal')
    ),
    CONSTRAINT toi_capture_frequency_check CHECK (
      capture_frequency IN ('monthly','biweekly','annual','event')
    ),
    CONSTRAINT toi_default_amount_nonneg CHECK (default_estimated_amount >= 0),
    UNIQUE (tenant_id, code)
  );

  CREATE INDEX idx_toi_tenant_active ON tenant_overhead_items (tenant_id, is_active, sort_order);

  CREATE TRIGGER set_updated_at_tenant_overhead_items
    BEFORE UPDATE ON tenant_overhead_items
    FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

  COMMENT ON TABLE tenant_overhead_items IS
    'SaaS v2 §Fase3: catálogo de ítems de overhead (costos indirectos) del tenant. Cada ítem se distribuye a los turnos según allocation_base y capture_frequency.';

  -- Permisos overhead
  INSERT INTO permissions (resource, action, description)
  VALUES
    ('overhead', 'read',   'Ver configuración y períodos de overhead'),
    ('overhead', 'update', 'Crear y modificar ítems, períodos y cerrar mes de overhead')
  ON CONFLICT (resource, action) DO NOTHING;

  INSERT INTO role_permissions (role_id, permission_id)
  SELECT r.id, p.id
  FROM roles r
  CROSS JOIN permissions p
  WHERE p.resource = 'overhead'
    AND r.name IN ('super_admin','owner','admin','supervisor')
  ON CONFLICT DO NOTHING;
`

const down = `
  DELETE FROM role_permissions
  WHERE permission_id IN (SELECT id FROM permissions WHERE resource = 'overhead');
  DELETE FROM permissions WHERE resource = 'overhead';
  DROP TABLE IF EXISTS tenant_overhead_items;
`

module.exports = { up, down }
