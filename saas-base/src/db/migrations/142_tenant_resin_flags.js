'use strict'

/**
 * SaaS v2 — Migration 142: tenant_process_config flags para atributos
 * específicos de plástico.
 *
 * `resin_type` (PP / PE) y `material_type` (virgin / regrind) son atributos
 * útiles solo para tenants de industria plástica (esquineros, recicladora,
 * extrusión). Para frituras, panadería, pellet alimentario, etc. son ruido.
 *
 * Agregamos dos flags por tenant:
 *   - uses_resin_types         → muestra/oculta "Tipo de resina" en UI
 *   - tracks_material_origin   → muestra/oculta "Virgen / Regrind" en UI
 *
 * Backfill: TRUE para tenants que YA tienen raw_materials con esos atributos
 * capturados (los 4 pilotos plásticos). FALSE para tenants nuevos.
 *
 * Las columnas `raw_materials.resin_type` y `raw_materials.material_type`
 * NO se eliminan — los datos existentes siguen guardándose. Los flags solo
 * controlan la visibilidad en UI.
 */

const up = `
  ALTER TABLE tenant_process_config
    ADD COLUMN IF NOT EXISTS uses_resin_types        BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS tracks_material_origin  BOOLEAN NOT NULL DEFAULT false;

  -- Backfill: prender ambos flags para tenants que ya usan estos atributos.
  UPDATE tenant_process_config tpc
     SET uses_resin_types = true
   WHERE EXISTS (
     SELECT 1 FROM raw_materials rm
      WHERE rm.tenant_id = tpc.tenant_id
        AND rm.resin_type IS NOT NULL
   );

  UPDATE tenant_process_config tpc
     SET tracks_material_origin = true
   WHERE EXISTS (
     SELECT 1 FROM raw_materials rm
      WHERE rm.tenant_id = tpc.tenant_id
        AND rm.material_type IS NOT NULL
   );

  COMMENT ON COLUMN tenant_process_config.uses_resin_types IS
    'SaaS v2 §142: si TRUE, la UI muestra el campo "Tipo de resina" (PP/PE) en MP y almacenes. Útil para tenants de plástico.';
  COMMENT ON COLUMN tenant_process_config.tracks_material_origin IS
    'SaaS v2 §142: si TRUE, la UI muestra el campo "Virgen / Regrind" en MP. Útil para industrias con reciclado interno (plástico, papel).';
`

const down = `
  ALTER TABLE tenant_process_config
    DROP COLUMN IF EXISTS uses_resin_types,
    DROP COLUMN IF EXISTS tracks_material_origin;
`

module.exports = { up, down }
