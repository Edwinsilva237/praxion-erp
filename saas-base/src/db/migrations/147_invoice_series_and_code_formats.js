'use strict'

/**
 * Series de facturación (multi-serie por perfil fiscal) + nomenclatura de
 * códigos para catálogos (productos, materias primas, clientes, proveedores).
 *
 * ─── Series de facturación ──────────────────────────────────────────────────
 *
 * Antes: `tenant_fiscal_profiles` tenía 1 sola `serie` y `folio_next` como
 * columnas. El generador `nextInvoiceNumber` IGNORABA esos campos y siempre
 * armaba `FAC-YYYYMM-NNNN`. Eso impedía:
 *   - Continuar la numeración desde otro sistema (migración de software).
 *   - Tener varias series por mismo RFC (ej: A para ventas, NC para notas).
 *   - Configurar serie distinta por tipo de CFDI (I/E/P/N/T).
 *
 * Ahora: 1 perfil fiscal → N rows en `tenant_invoice_series`. Cada serie con
 * su propio `folio_next`. Una marcada `is_default` para sugerencia al emitir
 * sin selección explícita. `cfdi_type` opcional permite default por tipo
 * (ej: serie A default para 'I', serie NC default para 'E').
 *
 * Backfill: por cada `tenant_fiscal_profiles` con `serie` ya definida (o aún
 * con default NULL), se crea un row en `tenant_invoice_series` con esa serie
 * + folio_next + is_default=true. Si no había serie, se crea con serie='A'
 * y folio_next=1.
 *
 * ─── Nomenclatura de códigos ────────────────────────────────────────────────
 *
 * Antes: `products.sku` y `business_partners.internal_code` eran texto libre,
 * capturados a mano. `raw_materials` ni siquiera tenía columna de código.
 * El capturista no sabía qué patrón usar — cada uno inventaba.
 *
 * Ahora: `tenant_code_formats` configura por catálogo un patrón con prefijo
 * + secuencial (ej: CLI-{seq}, MP-{seq}). El parser actual solo entiende
 * `{seq}` (se sustituye por next_seq con padding). En el futuro se agregan
 * variables `{año}`, `{mes}`, `{cat}` SIN tocar BD — solo el parser.
 *
 * Modos: 'manual' (sin ayuda, como hoy), 'suggested' (placeholder + botón
 * "siguiente" en form), 'auto' (sistema lo genera al guardar, campo readonly).
 *
 * No se crea ningún row por default → modo manual implícito (sin pattern).
 * Solo cuando el admin configura un patrón empieza a actuar.
 *
 * Plus: agregamos `raw_materials.code` para que las MP también tengan el
 * mismo modelo que productos. UNIQUE parcial (solo cuando code IS NOT NULL)
 * para no romper rows existentes que vinieron sin código.
 */

const up = `
  -- ─── Series de facturación ───────────────────────────────────────────────
  CREATE TABLE tenant_invoice_series (
    id                 UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id          UUID         NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    fiscal_profile_id  UUID         NOT NULL REFERENCES tenant_fiscal_profiles(id) ON DELETE CASCADE,
    serie              VARCHAR(10)  NOT NULL,
    folio_next         INTEGER      NOT NULL DEFAULT 1,
    cfdi_type          VARCHAR(1),
    is_default         BOOLEAN      NOT NULL DEFAULT FALSE,
    is_active          BOOLEAN      NOT NULL DEFAULT TRUE,
    notes              TEXT,
    created_by         UUID         REFERENCES users(id) ON DELETE SET NULL,
    created_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

    CONSTRAINT tis_serie_format    CHECK (serie ~ '^[A-Za-z0-9_-]{1,10}$'),
    CONSTRAINT tis_folio_positive  CHECK (folio_next >= 1),
    CONSTRAINT tis_cfdi_type_valid CHECK (cfdi_type IS NULL OR cfdi_type IN ('I','E','P','N','T'))
  );

  -- Una serie no puede repetirse dentro del mismo perfil fiscal
  CREATE UNIQUE INDEX idx_tis_serie_per_profile
    ON tenant_invoice_series (fiscal_profile_id, serie);

  -- Una sola default por perfil sin tipo (cuando cfdi_type IS NULL)
  CREATE UNIQUE INDEX idx_tis_one_default_per_profile
    ON tenant_invoice_series (fiscal_profile_id)
    WHERE is_default = TRUE AND cfdi_type IS NULL;

  -- Una sola default por perfil + tipo (cuando cfdi_type está definido)
  CREATE UNIQUE INDEX idx_tis_one_default_per_profile_type
    ON tenant_invoice_series (fiscal_profile_id, cfdi_type)
    WHERE is_default = TRUE AND cfdi_type IS NOT NULL;

  CREATE INDEX idx_tis_tenant_active ON tenant_invoice_series (tenant_id, is_active);

  CREATE TRIGGER set_updated_at_tenant_invoice_series
    BEFORE UPDATE ON tenant_invoice_series
    FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

  COMMENT ON TABLE tenant_invoice_series IS
    'Series de folios CFDI por perfil fiscal. 1 perfil → N series.';
  COMMENT ON COLUMN tenant_invoice_series.cfdi_type IS
    'I=Ingreso, E=Egreso, P=Pago, N=Nómina, T=Traslado. NULL = aplica a todos.';
  COMMENT ON COLUMN tenant_invoice_series.folio_next IS
    'Próximo folio a consumir. Editable libremente; el sistema avisa si baja por debajo del último usado.';

  -- Backfill: crear una serie default por cada perfil fiscal existente,
  -- preservando la serie/folio_next legacy. Si no había serie, default 'A'.
  INSERT INTO tenant_invoice_series
    (tenant_id, fiscal_profile_id, serie, folio_next, is_default, is_active, notes)
  SELECT
    fp.tenant_id,
    fp.id,
    COALESCE(NULLIF(fp.serie, ''), 'A'),
    GREATEST(COALESCE(fp.folio_next, 1), 1),
    TRUE,
    TRUE,
    'Serie creada automáticamente al migrar a multi-serie (147).'
  FROM tenant_fiscal_profiles fp;

  -- ─── Nomenclatura de códigos ─────────────────────────────────────────────
  CREATE TABLE tenant_code_formats (
    id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id    UUID         NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    entity_type  VARCHAR(50)  NOT NULL,
    pattern      VARCHAR(100) NOT NULL,
    padding      INTEGER      NOT NULL DEFAULT 4,
    next_seq     INTEGER      NOT NULL DEFAULT 1,
    mode         VARCHAR(20)  NOT NULL DEFAULT 'suggested',
    is_active    BOOLEAN      NOT NULL DEFAULT TRUE,
    notes        TEXT,
    created_by   UUID         REFERENCES users(id) ON DELETE SET NULL,
    created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

    CONSTRAINT tcf_entity_valid CHECK (entity_type IN
      ('product', 'raw_material', 'customer', 'supplier')),
    CONSTRAINT tcf_mode_valid   CHECK (mode IN ('manual', 'suggested', 'auto')),
    CONSTRAINT tcf_pattern_has_seq CHECK (pattern LIKE '%{seq}%'),
    CONSTRAINT tcf_padding_range CHECK (padding BETWEEN 1 AND 10),
    CONSTRAINT tcf_seq_positive CHECK (next_seq >= 1)
  );

  CREATE UNIQUE INDEX idx_tcf_entity_per_tenant
    ON tenant_code_formats (tenant_id, entity_type);

  CREATE TRIGGER set_updated_at_tenant_code_formats
    BEFORE UPDATE ON tenant_code_formats
    FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

  COMMENT ON TABLE tenant_code_formats IS
    'Nomenclatura de códigos por catálogo. 1 row por entity_type. Sin row → modo manual implícito.';
  COMMENT ON COLUMN tenant_code_formats.pattern IS
    'Plantilla con {seq} como placeholder de secuencial. Ej: "CLI-{seq}" → "CLI-0001".';
  COMMENT ON COLUMN tenant_code_formats.mode IS
    'manual=sin ayuda · suggested=placeholder + botón sugerir · auto=generación obligatoria';

  -- ─── Agregar columna code a raw_materials ────────────────────────────────
  ALTER TABLE raw_materials ADD COLUMN code VARCHAR(50);

  CREATE UNIQUE INDEX idx_raw_materials_code_per_tenant
    ON raw_materials (tenant_id, code) WHERE code IS NOT NULL;

  COMMENT ON COLUMN raw_materials.code IS
    'Código interno opcional (SKU). Generado o sugerido por tenant_code_formats.';
`

const down = `
  ALTER TABLE raw_materials DROP COLUMN IF EXISTS code;
  DROP TRIGGER IF EXISTS set_updated_at_tenant_code_formats ON tenant_code_formats;
  DROP TABLE IF EXISTS tenant_code_formats CASCADE;
  DROP TRIGGER IF EXISTS set_updated_at_tenant_invoice_series ON tenant_invoice_series;
  DROP TABLE IF EXISTS tenant_invoice_series CASCADE;
`

module.exports = { up, down }
