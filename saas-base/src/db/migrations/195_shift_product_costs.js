'use strict'

/**
 * SaaS v2 — Migration 195: costo prorrateado por PRODUCTO (medida) de cada turno.
 *
 * Un turno puede fabricar varias medidas (productos distintos). Antes el inventario
 * PT se valuaba con UN solo cost_per_unit del turno (costo_total / piezas_totales),
 * idéntico para todas las medidas → la medida más pesada quedaba sub-costeada.
 *
 * Esta tabla guarda el costo prorrateado por SKU cal-1 con el modelo mixto:
 *   - MP por peso, overhead por piezas, empaque por receta (ver shiftCostAllocation.js).
 *
 * Una fila por (turno, producto). Solo cal-1 (la 2da calidad conserva el promedio
 * del turno / NRV). La consume inventoryService.recordProductionValidation para
 * valuar cada entrada PT con el costo real de su medida.
 */

const up = `
  CREATE TABLE shift_product_costs (
    id             UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id      UUID          NOT NULL,
    shift_id       UUID          NOT NULL REFERENCES production_shifts(id) ON DELETE CASCADE,
    product_id     UUID          NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    units          NUMERIC(18,4) NOT NULL DEFAULT 0,
    total_kg       NUMERIC(18,4) NOT NULL DEFAULT 0,
    mp_cost        NUMERIC(18,4) NOT NULL DEFAULT 0,
    overhead_cost  NUMERIC(18,4) NOT NULL DEFAULT 0,
    packaging_cost NUMERIC(18,4) NOT NULL DEFAULT 0,
    total_cost     NUMERIC(18,4) NOT NULL DEFAULT 0,
    cost_per_unit  NUMERIC(18,6) NOT NULL DEFAULT 0,
    created_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    updated_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

    UNIQUE (shift_id, product_id)
  );

  CREATE INDEX idx_spc_shift ON shift_product_costs (shift_id);

  CREATE TRIGGER set_updated_at_shift_product_costs
    BEFORE UPDATE ON shift_product_costs
    FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

  COMMENT ON TABLE shift_product_costs IS
    'SaaS v2: costo prorrateado por PRODUCTO (medida) cal-1 de cada turno. Modelo mixto: MP por peso, overhead por piezas, empaque por receta. Lo consume recordProductionValidation para valuar el inventario PT por SKU.';
`

const down = `
  DROP TABLE IF EXISTS shift_product_costs;
`

module.exports = { up, down }
