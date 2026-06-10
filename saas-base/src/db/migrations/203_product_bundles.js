'use strict'

/**
 * Paquetes de productos (bundles) — combos fijos de catálogo con precio especial.
 *
 * Diseño acordado (2026-06-10):
 *   - El paquete se define UNA vez en el catálogo: productos + cantidades +
 *     precio especial. Es un constructo COMERCIAL: nunca existe en inventario.
 *   - Al capturarlo en un pedido se "explota" en N líneas componente con el
 *     precio PRORRATEADO proporcional al precio de lista (= mismo % de
 *     descuento implícito en todas las líneas). De ahí en adelante todo fluye
 *     por la maquinaria existente: la remisión descuenta inventario por
 *     componente, la factura lleva las claves SAT de cada producto y el
 *     reporte de utilidad por producto funciona sin cambios.
 *   - Las líneas del pedido recuerdan a qué paquete pertenecen (snapshot del
 *     nombre + grupo por instancia) para mostrarse agrupadas y protegerse de
 *     edición individual (el paquete entra/sale como bloque).
 *
 * Tablas nuevas:
 *   product_bundles       → header del paquete (nombre, precio, moneda, activo)
 *   product_bundle_items  → componentes (producto + presentación + cantidad)
 *
 * Columnas nuevas en sales_order_lines:
 *   bundle_id        → FK al paquete del catálogo (SET NULL si se borra)
 *   bundle_group_id  → agrupa las líneas de UNA instancia de paquete en el pedido
 *   bundle_name      → snapshot del nombre (sobrevive al borrado del paquete)
 *   bundle_quantity  → cuántos paquetes representa el grupo
 *
 * delivery_note_lines NO lleva columnas: la remisión deriva el paquete vía
 * sales_order_line_id → sales_order_lines.bundle_name (solo display).
 */

const up = `
  -- 1) Header del paquete
  CREATE TABLE product_bundles (
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id     UUID              NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name          VARCHAR(200)      NOT NULL,
    description   TEXT,
    bundle_price  DECIMAL(14,4)     NOT NULL,
    currency      document_currency NOT NULL DEFAULT 'MXN',
    is_active     BOOLEAN           NOT NULL DEFAULT true,
    created_at    TIMESTAMPTZ       NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ       NOT NULL DEFAULT NOW(),

    CONSTRAINT pb_unique_name     UNIQUE (tenant_id, name),
    CONSTRAINT pb_price_positive  CHECK (bundle_price > 0)
  );

  CREATE INDEX idx_pb_tenant ON product_bundles (tenant_id);

  COMMENT ON TABLE product_bundles IS
    'Paquetes/combos comerciales: precio especial que se prorratea entre componentes al capturar el pedido. No existen en inventario.';

  CREATE TRIGGER set_updated_at_product_bundles
    BEFORE UPDATE ON product_bundles
    FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

  -- 2) Componentes del paquete
  --    product_id RESTRICT: no se puede borrar un producto que vive en un
  --    paquete (primero se quita del paquete) — evita paquetes "rotos" con
  --    precio intacto pero contenido incompleto.
  CREATE TABLE product_bundle_items (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id       UUID          NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    bundle_id       UUID          NOT NULL REFERENCES product_bundles(id) ON DELETE CASCADE,
    product_id      UUID          NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
    pack_option_id  UUID          REFERENCES product_pack_options(id) ON DELETE SET NULL,
    quantity        DECIMAL(14,4) NOT NULL,
    line_number     INT           NOT NULL DEFAULT 1,
    created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

    CONSTRAINT pbi_qty_positive   CHECK (quantity > 0),
    CONSTRAINT pbi_unique_product UNIQUE (bundle_id, product_id)
  );

  CREATE INDEX idx_pbi_bundle ON product_bundle_items (bundle_id);

  COMMENT ON COLUMN product_bundle_items.quantity IS
    'Cantidad por UN paquete, en la presentación elegida (pack_option_id; NULL = unidad base del producto).';

  -- 3) Marcador de paquete en líneas de pedido
  ALTER TABLE sales_order_lines
    ADD COLUMN IF NOT EXISTS bundle_id       UUID REFERENCES product_bundles(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS bundle_group_id UUID,
    ADD COLUMN IF NOT EXISTS bundle_name     VARCHAR(200),
    ADD COLUMN IF NOT EXISTS bundle_quantity DECIMAL(14,4);

  CREATE INDEX idx_sol_bundle_group
    ON sales_order_lines (bundle_group_id)
    WHERE bundle_group_id IS NOT NULL;

  COMMENT ON COLUMN sales_order_lines.bundle_group_id IS
    'Agrupa las líneas de UNA instancia de paquete dentro del pedido. Las líneas con grupo no se editan individualmente.';
  COMMENT ON COLUMN sales_order_lines.bundle_name IS
    'Snapshot del nombre del paquete al capturar (sobrevive si el paquete se borra del catálogo).';
`

const down = `
  ALTER TABLE sales_order_lines
    DROP COLUMN IF EXISTS bundle_quantity,
    DROP COLUMN IF EXISTS bundle_name,
    DROP COLUMN IF EXISTS bundle_group_id,
    DROP COLUMN IF EXISTS bundle_id;

  DROP TABLE IF EXISTS product_bundle_items CASCADE;
  DROP TABLE IF EXISTS product_bundles CASCADE;
`

module.exports = { up, down }
