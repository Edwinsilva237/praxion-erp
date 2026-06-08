'use strict'

/**
 * Mig 197 — Devoluciones a proveedor (Fase 1) + catálogo de motivos + permiso.
 *
 * - tenant_return_reasons: catálogo configurable por tenant (sembrado por plantilla).
 * - supplier_returns / supplier_return_lines: encabezado + líneas de la devolución.
 *   El encabezado ya incluye los campos de RESOLUCIÓN FISCAL (Fase 2: nota de
 *   crédito / cancelación / sustitución), default 'none' / credit_status 'pending'.
 * - permiso 'purchases:return' (aislado de update; super_admin + roles con purchases:update).
 *
 * El valor de enum 'purchase_return' (movement_type) se agrega en mig 196.
 */

const up = `
  -- ─── Enums ────────────────────────────────────────────────────────────
  DO $$ BEGIN
    CREATE TYPE supplier_return_status AS ENUM ('draft','confirmed','cancelled');
  EXCEPTION WHEN duplicate_object THEN null; END $$;

  DO $$ BEGIN
    CREATE TYPE supplier_return_fiscal_resolution AS ENUM
      ('none','credit_note','cancellation','substitution');
  EXCEPTION WHEN duplicate_object THEN null; END $$;

  -- ─── Catálogo de motivos (por tenant, sembrado por plantilla) ─────────
  CREATE TABLE tenant_return_reasons (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id   UUID         NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    code        VARCHAR(40)  NOT NULL,
    name        VARCHAR(120) NOT NULL,
    sort_order  INTEGER      NOT NULL DEFAULT 0,
    is_active   BOOLEAN      NOT NULL DEFAULT true,
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

    CONSTRAINT trr_code_per_tenant UNIQUE (tenant_id, code)
  );
  CREATE INDEX idx_trr_tenant_active ON tenant_return_reasons (tenant_id, is_active);
  CREATE TRIGGER set_updated_at_tenant_return_reasons
    BEFORE UPDATE ON tenant_return_reasons
    FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

  -- ─── Encabezado de devolución ─────────────────────────────────────────
  CREATE TABLE supplier_returns (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id           UUID         NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    return_number       VARCHAR(20)  NOT NULL,
    partner_id          UUID         NOT NULL REFERENCES business_partners(id),
    reason_id           UUID         REFERENCES tenant_return_reasons(id),
    source_receipt_id   UUID         REFERENCES supplier_receipts(id),
    supplier_invoice_id UUID         REFERENCES supplier_invoices(id),
    status              supplier_return_status NOT NULL DEFAULT 'draft',
    return_date         DATE         NOT NULL DEFAULT CURRENT_DATE,
    notes               TEXT,
    total_mxn           NUMERIC(14,2) NOT NULL DEFAULT 0,

    -- Resolución fiscal (Fase 2) — cómo el proveedor resuelve el CFDI:
    --   credit_note  = nota de crédito (CFDI de egreso recibido)
    --   cancellation = cancela la factura original
    --   substitution = cancela y emite una nueva que la sustituye
    fiscal_resolution      supplier_return_fiscal_resolution NOT NULL DEFAULT 'none',
    credit_status          VARCHAR(20) NOT NULL DEFAULT 'pending',  -- pending|resolved|not_applicable
    credit_note_invoice_id UUID REFERENCES supplier_invoices(id),
    cancelled_invoice_id   UUID REFERENCES supplier_invoices(id),
    substitute_invoice_id  UUID REFERENCES supplier_invoices(id),

    confirmed_at        TIMESTAMPTZ,
    created_by          UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

    CONSTRAINT sret_number_tenant UNIQUE (tenant_id, return_number),
    CONSTRAINT sret_credit_status_check CHECK (credit_status IN ('pending','resolved','not_applicable'))
  );
  CREATE INDEX idx_sret_tenant_status ON supplier_returns (tenant_id, status);
  CREATE INDEX idx_sret_partner       ON supplier_returns (tenant_id, partner_id);
  CREATE INDEX idx_sret_receipt       ON supplier_returns (source_receipt_id);
  CREATE TRIGGER set_updated_at_supplier_returns
    BEFORE UPDATE ON supplier_returns
    FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

  -- ─── Líneas de devolución ─────────────────────────────────────────────
  CREATE TABLE supplier_return_lines (
    id                      UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    return_id               UUID NOT NULL REFERENCES supplier_returns(id) ON DELETE CASCADE,
    tenant_id               UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    item_type               inventory_item_type NOT NULL,
    item_id                 UUID NOT NULL,
    warehouse_id            UUID NOT NULL REFERENCES warehouses(id),
    raw_material_lot_id     UUID REFERENCES raw_material_lots(id),
    quantity                NUMERIC(14,4) NOT NULL,
    unit                    VARCHAR(10)   NOT NULL DEFAULT 'kg',
    unit_cost               NUMERIC(14,6) NOT NULL DEFAULT 0,
    subtotal                NUMERIC(14,2) GENERATED ALWAYS AS
                              (ROUND((quantity * unit_cost)::numeric, 2)) STORED,
    source_receipt_line_id  UUID REFERENCES supplier_receipt_lines(id),
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT sretl_qty_positive CHECK (quantity > 0)
  );
  CREATE INDEX idx_sretl_return ON supplier_return_lines (return_id);
  CREATE INDEX idx_sretl_lot    ON supplier_return_lines (raw_material_lot_id);

  -- ─── Seed del catálogo de motivos (set neutro universal) ──────────────
  CREATE OR REPLACE FUNCTION seed_tenant_return_reasons(p_tenant_id UUID)
  RETURNS VOID LANGUAGE plpgsql AS $$
  BEGIN
    INSERT INTO tenant_return_reasons (tenant_id, code, name, sort_order)
    SELECT p_tenant_id, r.code, r.name, r.sort_order
    FROM (VALUES
      ('defectuoso',         'Producto defectuoso',   10),
      ('danado',             'Dañado en transporte',  20),
      ('excedente',          'Excedente / sobrante',  30),
      ('calidad',            'No cumple calidad',     40),
      ('producto_equivocado','Producto equivocado',   50),
      ('caducado',           'Caducado / vencido',    60),
      ('otro',               'Otro',                  100)
    ) AS r(code, name, sort_order)
    WHERE NOT EXISTS (
      SELECT 1 FROM tenant_return_reasons trr
       WHERE trr.tenant_id = p_tenant_id AND trr.code = r.code
    );
  END; $$;

  COMMENT ON FUNCTION seed_tenant_return_reasons(UUID) IS
    'SaaS v2: siembra los motivos de devolución a proveedor default (set neutro). Idempotente.';

  -- Extender el trigger AFTER INSERT en tenants (función diminuta, cuerpo COMPLETO)
  -- para que los tenants NUEVOS reciban los motivos. NO se toca la función maestra
  -- del Process Template (evita el footgun de redefinirla con cuerpo parcial).
  CREATE OR REPLACE FUNCTION trigger_seed_tenant_defaults()
  RETURNS TRIGGER LANGUAGE plpgsql AS $$
  BEGIN
    PERFORM seed_tenant_process_template_defaults(NEW.id);
    PERFORM seed_tenant_return_reasons(NEW.id);
    RETURN NEW;
  END; $$;

  -- Auto-heal: sembrar motivos a todos los tenants existentes.
  DO $$ DECLARE t_id UUID; BEGIN
    FOR t_id IN SELECT id FROM tenants LOOP
      PERFORM seed_tenant_return_reasons(t_id);
    END LOOP;
  END $$;

  -- ─── Permiso purchases:return (aislado de update) ─────────────────────
  INSERT INTO permissions (resource, action, description) VALUES
    ('purchases', 'return', 'Registrar devoluciones a proveedor')
  ON CONFLICT (resource, action) DO NOTHING;

  -- super_admin global lo tiene.
  INSERT INTO role_permissions (role_id, permission_id)
  SELECT r.id, p.id
    FROM roles r CROSS JOIN permissions p
   WHERE r.name = 'super_admin' AND r.tenant_id IS NULL
     AND p.resource = 'purchases' AND p.action = 'return'
   ON CONFLICT (role_id, permission_id) DO NOTHING;

  -- Preservar acceso: todo rol que hoy puede confirmar compras (purchases:update)
  -- también puede devolver.
  INSERT INTO role_permissions (role_id, permission_id)
  SELECT DISTINCT rp.role_id, np.id
    FROM role_permissions rp
    JOIN permissions up ON up.id = rp.permission_id
                       AND up.resource = 'purchases' AND up.action = 'update'
    JOIN permissions np ON np.resource = 'purchases' AND np.action = 'return'
   ON CONFLICT (role_id, permission_id) DO NOTHING;
`

const down = `
  DROP TABLE IF EXISTS supplier_return_lines;
  DROP TABLE IF EXISTS supplier_returns;
  DROP FUNCTION IF EXISTS seed_tenant_return_reasons(UUID);
  DROP TABLE IF EXISTS tenant_return_reasons;
  DROP TYPE IF EXISTS supplier_return_fiscal_resolution;
  DROP TYPE IF EXISTS supplier_return_status;

  -- Restaurar el trigger sin la siembra de motivos.
  CREATE OR REPLACE FUNCTION trigger_seed_tenant_defaults()
  RETURNS TRIGGER LANGUAGE plpgsql AS $$
  BEGIN
    PERFORM seed_tenant_process_template_defaults(NEW.id);
    RETURN NEW;
  END; $$;

  DELETE FROM role_permissions WHERE permission_id IN (
    SELECT id FROM permissions WHERE resource = 'purchases' AND action = 'return'
  );
  DELETE FROM permissions WHERE resource = 'purchases' AND action = 'return';
`

module.exports = { up, down }
