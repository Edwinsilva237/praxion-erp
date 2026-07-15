'use strict'

/**
 * Mig 229 — Devoluciones de VENTA (cliente devuelve mercancía ya entregada).
 *
 * Espejo del lado de compras (mig 197 supplier_returns). Cubre el caso que HOY
 * quedaba a medias: una remisión YA entregada (con o sin factura) de la que el
 * cliente regresa producto — total o PARCIAL.
 *
 *   - sales_returns / sales_return_lines: encabezado + líneas de la devolución.
 *   - Reusa `tenant_return_reasons` (catálogo genérico creado en mig 197).
 *   - El reingreso de inventario se hace con movement_type='adjustment_in'
 *     (referenceType='sales_return'), igual que la reversa de cancelDelivery —
 *     evita tocar el enum movement_type.
 *   - Diferencia con el RECHAZO EN ENTREGA (mig 228): la devolución post-entrega
 *     NO reabre el pedido (el pedido se cumplió; el cliente regresó después).
 *   - Resolución fiscal:
 *       · SIN factura → se reduce la CXC de la remisión (amount_credited).
 *       · CON factura → se emite/vincula una nota de crédito (CFDI E, reusa
 *         creditNoteService) que reduce la CXC de la factura; el inventario se
 *         reingresa igual (hueco que la NC sola no cubría).
 *   - Permiso 'sales:return' (aislado; super_admin + roles con sales:update).
 */

const up = `
  DO $$ BEGIN
    CREATE TYPE sales_return_status AS ENUM ('draft','confirmed','cancelled');
  EXCEPTION WHEN duplicate_object THEN null; END $$;

  -- ─── Encabezado ───────────────────────────────────────────────────────
  CREATE TABLE sales_returns (
    id                     UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id              UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    return_number          VARCHAR(20) NOT NULL,
    partner_id             UUID NOT NULL REFERENCES business_partners(id),
    reason_id              UUID REFERENCES tenant_return_reasons(id),
    source_delivery_note_id UUID NOT NULL REFERENCES delivery_notes(id),
    source_invoice_id      UUID REFERENCES invoices(id),
    status                 sales_return_status NOT NULL DEFAULT 'draft',
    return_date            DATE NOT NULL DEFAULT CURRENT_DATE,
    notes                  TEXT,
    total_mxn              NUMERIC(14,2) NOT NULL DEFAULT 0,

    -- Resolución fiscal / de saldo:
    --   credit_status: pending (con factura, NC por emitir) | resolved | not_applicable (sin factura)
    credit_status          VARCHAR(20) NOT NULL DEFAULT 'not_applicable',
    credit_note_invoice_id UUID REFERENCES invoices(id),  -- la NC (CFDI E) cuando con factura
    ar_credited            BOOLEAN NOT NULL DEFAULT false, -- sin factura: si ya bajó la CXC de la remisión

    confirmed_at           TIMESTAMPTZ,
    created_by             UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT sales_ret_number_tenant UNIQUE (tenant_id, return_number),
    CONSTRAINT sales_ret_credit_status_check CHECK (credit_status IN ('pending','resolved','not_applicable'))
  );
  CREATE INDEX idx_salesret_tenant_status ON sales_returns (tenant_id, status);
  CREATE INDEX idx_salesret_partner        ON sales_returns (tenant_id, partner_id);
  CREATE INDEX idx_salesret_dn             ON sales_returns (source_delivery_note_id);
  CREATE TRIGGER set_updated_at_sales_returns
    BEFORE UPDATE ON sales_returns
    FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

  -- ─── Líneas ───────────────────────────────────────────────────────────
  CREATE TABLE sales_return_lines (
    id                          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    return_id                   UUID NOT NULL REFERENCES sales_returns(id) ON DELETE CASCADE,
    tenant_id                   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    product_id                  UUID NOT NULL REFERENCES products(id),
    warehouse_id                UUID NOT NULL REFERENCES warehouses(id),
    product_lot_id              UUID REFERENCES product_lots(id),
    quantity                    NUMERIC(14,4) NOT NULL,
    unit                        VARCHAR(20) NOT NULL DEFAULT 'pieza',
    unit_price                  NUMERIC(14,4) NOT NULL DEFAULT 0,
    discount_pct                NUMERIC(5,2)  NOT NULL DEFAULT 0,
    subtotal                    NUMERIC(14,2) GENERATED ALWAYS AS
                                  (ROUND((quantity * unit_price * (1 - discount_pct/100))::numeric, 2)) STORED,
    pack_factor                 NUMERIC(14,4) NOT NULL DEFAULT 1,
    quantity_base               NUMERIC(14,4) NOT NULL,
    source_delivery_note_line_id UUID REFERENCES delivery_note_lines(id),
    created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT salesretl_qty_positive CHECK (quantity > 0)
  );
  CREATE INDEX idx_salesretl_return ON sales_return_lines (return_id);
  CREATE INDEX idx_salesretl_dnl    ON sales_return_lines (source_delivery_note_line_id);

  -- ─── Permiso sales:return ─────────────────────────────────────────────
  INSERT INTO permissions (resource, action, description) VALUES
    ('sales', 'return', 'Registrar devoluciones de venta')
  ON CONFLICT (resource, action) DO NOTHING;

  INSERT INTO role_permissions (role_id, permission_id)
  SELECT r.id, p.id
    FROM roles r CROSS JOIN permissions p
   WHERE r.name = 'super_admin' AND r.tenant_id IS NULL
     AND p.resource = 'sales' AND p.action = 'return'
   ON CONFLICT (role_id, permission_id) DO NOTHING;

  -- Preservar acceso: todo rol que hoy puede editar ventas (sales:update)
  -- también puede devolver.
  INSERT INTO role_permissions (role_id, permission_id)
  SELECT DISTINCT rp.role_id, np.id
    FROM role_permissions rp
    JOIN permissions up ON up.id = rp.permission_id
                       AND up.resource = 'sales' AND up.action = 'update'
    JOIN permissions np ON np.resource = 'sales' AND np.action = 'return'
   ON CONFLICT (role_id, permission_id) DO NOTHING;
`

const down = `
  DROP TABLE IF EXISTS sales_return_lines;
  DROP TABLE IF EXISTS sales_returns;
  DROP TYPE IF EXISTS sales_return_status;

  DELETE FROM role_permissions WHERE permission_id IN (
    SELECT id FROM permissions WHERE resource = 'sales' AND action = 'return'
  );
  DELETE FROM permissions WHERE resource = 'sales' AND action = 'return';
`

module.exports = { up, down }
