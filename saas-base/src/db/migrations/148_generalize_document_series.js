'use strict'

/**
 * Generaliza `tenant_invoice_series` a `tenant_document_series` para que el
 * mismo modelo de series y folios sirva a TODOS los documentos numerados del
 * ERP: facturas, pedidos, remisiones, cotizaciones, OC, recepciones de
 * proveedor, ajustes de inventario.
 *
 * Antes: 1 tabla específica de facturas (`tenant_invoice_series`) atada a
 * `tenant_fiscal_profiles`. Los demás documentos (`sales_orders`,
 * `purchase_orders`, etc.) usaban generadores hardcoded en cada service con
 * formato `PREFIJO-YYYYMM-NNNN` y reset mensual implícito.
 *
 * Ahora: una tabla `tenant_document_series` discriminada por `entity_type`.
 * Cada (tenant, entity_type) puede tener N series, una marcada como default.
 * Para `entity_type='invoice'` se requiere fiscal_profile_id (sigue siendo
 * obligatoria la asociación con un RFC emisor). Para los demás documentos
 * es NULL.
 *
 * Backfill: copia los rows existentes de `tenant_invoice_series` con
 * `entity_type='invoice'`. Para los demás documentos NO crea nada — quedan
 * en modo legacy (cada generador hace fallback al patrón viejo si no
 * encuentra serie configurada).
 *
 * La tabla vieja `tenant_invoice_series` se mantiene como vista (alias)
 * sobre la nueva, para que cualquier query externa (reportería, scripts)
 * siga funcionando. En migración futura se puede dropear.
 */

const VALID_ENTITY_TYPES = [
  'invoice',              // CFDI emitido
  'sales_order',          // Pedido de venta (PV)
  'delivery_note',        // Remisión de venta (REM)
  'sales_return',         // Devolución de venta (REC en deliveryNoteService)
  'quotation',            // Cotización (COT)
  'purchase_order',       // Orden de compra (OC)
  'supplier_receipt',     // Recepción de mercancía de proveedor
  'inventory_adjustment', // Ajuste de inventario (AJ)
]

const up = `
  CREATE TABLE tenant_document_series (
    id                 UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id          UUID         NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    entity_type        VARCHAR(30)  NOT NULL,
    fiscal_profile_id  UUID                  REFERENCES tenant_fiscal_profiles(id) ON DELETE CASCADE,
    serie              VARCHAR(10)  NOT NULL,
    folio_next         INTEGER      NOT NULL DEFAULT 1,
    cfdi_type          VARCHAR(1),
    is_default         BOOLEAN      NOT NULL DEFAULT FALSE,
    is_active          BOOLEAN      NOT NULL DEFAULT TRUE,
    notes              TEXT,
    created_by         UUID         REFERENCES users(id) ON DELETE SET NULL,
    created_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

    CONSTRAINT tds_serie_format    CHECK (serie ~ '^[A-Za-z0-9_-]{1,10}$'),
    CONSTRAINT tds_folio_positive  CHECK (folio_next >= 1),
    CONSTRAINT tds_cfdi_type_valid CHECK (cfdi_type IS NULL OR cfdi_type IN ('I','E','P','N','T')),
    CONSTRAINT tds_entity_valid    CHECK (entity_type IN (${VALID_ENTITY_TYPES.map(t => `'${t}'`).join(', ')})),
    CONSTRAINT tds_invoice_needs_profile
      CHECK (entity_type <> 'invoice' OR fiscal_profile_id IS NOT NULL),
    CONSTRAINT tds_non_invoice_no_profile
      CHECK (entity_type = 'invoice' OR fiscal_profile_id IS NULL),
    CONSTRAINT tds_non_invoice_no_cfdi
      CHECK (entity_type = 'invoice' OR cfdi_type IS NULL)
  );

  -- Una serie no puede repetirse dentro del mismo perfil fiscal (invoices)
  CREATE UNIQUE INDEX idx_tds_invoice_serie_per_profile
    ON tenant_document_series (fiscal_profile_id, serie)
    WHERE entity_type = 'invoice';

  -- Una serie no puede repetirse dentro del mismo (tenant, entity_type) para no-facturas
  CREATE UNIQUE INDEX idx_tds_serie_per_tenant_entity
    ON tenant_document_series (tenant_id, entity_type, serie)
    WHERE entity_type <> 'invoice';

  -- Default unique (genérico, sin cfdi_type) para invoices: una por perfil
  CREATE UNIQUE INDEX idx_tds_invoice_one_default_per_profile
    ON tenant_document_series (fiscal_profile_id)
    WHERE entity_type = 'invoice' AND is_default = TRUE AND cfdi_type IS NULL;

  -- Default por (perfil, cfdi_type)
  CREATE UNIQUE INDEX idx_tds_invoice_one_default_per_profile_type
    ON tenant_document_series (fiscal_profile_id, cfdi_type)
    WHERE entity_type = 'invoice' AND is_default = TRUE AND cfdi_type IS NOT NULL;

  -- Default para no-facturas: una por (tenant, entity_type)
  CREATE UNIQUE INDEX idx_tds_non_invoice_one_default
    ON tenant_document_series (tenant_id, entity_type)
    WHERE entity_type <> 'invoice' AND is_default = TRUE;

  CREATE INDEX idx_tds_tenant_entity_active
    ON tenant_document_series (tenant_id, entity_type, is_active);

  CREATE TRIGGER set_updated_at_tenant_document_series
    BEFORE UPDATE ON tenant_document_series
    FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

  COMMENT ON TABLE tenant_document_series IS
    'Series y folios para todos los documentos numerados del ERP. Discriminado por entity_type. Para invoices requiere fiscal_profile_id.';
  COMMENT ON COLUMN tenant_document_series.entity_type IS
    'invoice|sales_order|delivery_note|sales_return|quotation|purchase_order|supplier_receipt|inventory_adjustment';

  -- ─── Backfill desde tenant_invoice_series ───────────────────────────────
  INSERT INTO tenant_document_series
    (id, tenant_id, entity_type, fiscal_profile_id, serie, folio_next,
     cfdi_type, is_default, is_active, notes, created_by, created_at, updated_at)
  SELECT id, tenant_id, 'invoice', fiscal_profile_id, serie, folio_next,
         cfdi_type, is_default, is_active, notes, created_by, created_at, updated_at
    FROM tenant_invoice_series;

  -- ─── Drop tabla vieja y recrearla como VIEW para backcompat ─────────────
  -- Para que cualquier query/script legacy que aún use 'tenant_invoice_series'
  -- siga funcionando (solo lectura). Si en el futuro se quiere drop completo,
  -- hacerlo en otra migración después de verificar que nada la lea.
  DROP TABLE tenant_invoice_series CASCADE;

  CREATE VIEW tenant_invoice_series AS
    SELECT id, tenant_id, fiscal_profile_id, serie, folio_next, cfdi_type,
           is_default, is_active, notes, created_by, created_at, updated_at
      FROM tenant_document_series
     WHERE entity_type = 'invoice';

  COMMENT ON VIEW tenant_invoice_series IS
    'DEPRECATED: vista de backcompat sobre tenant_document_series WHERE entity_type=invoice. Usar tenant_document_series directamente.';
`

const down = `
  -- No es seguro revertir limpiamente porque la tabla vieja tendría que
  -- recrearse con sus constraints y los datos no-invoice se perderían.
  -- Si necesitas revertir, restaura desde backup.
  DROP VIEW IF EXISTS tenant_invoice_series;
  DROP TRIGGER IF EXISTS set_updated_at_tenant_document_series ON tenant_document_series;
  DROP TABLE IF EXISTS tenant_document_series CASCADE;
`

module.exports = { up, down }
