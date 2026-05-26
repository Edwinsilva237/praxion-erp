'use strict'

/**
 * SaaS v2 — Migration 144: product_quality_specs.grams_per_linear_meter NULLABLE.
 *
 * El esquema original (migración 011) asumió que TODO producto producido era
 * lineal (esquineros plásticos). Con el modelo SaaS v2 multi-industria, un
 * producto puede ser:
 *   - Lineal (esquineros, tubos, perfiles): grams_per_linear_meter requerido
 *   - Por unidad (frituras, pastel, cualquier producto puntual): NO aplica
 *
 * Cambios:
 *   - Eliminar el DEFAULT 180.00 (sesgo plástico)
 *   - Quitar NOT NULL
 *   - Ajustar el CHECK para permitir NULL O > 0
 *
 * Backfill: no es necesario — datos existentes siguen siendo válidos.
 */

const up = `
  ALTER TABLE product_quality_specs
    ALTER COLUMN grams_per_linear_meter DROP DEFAULT,
    ALTER COLUMN grams_per_linear_meter DROP NOT NULL;

  -- El CHECK viejo (CHECK (grams_per_linear_meter > 0)) ya no funciona si
  -- permitimos NULL. Lo reemplazamos por uno tolerante a NULL.
  ALTER TABLE product_quality_specs DROP CONSTRAINT IF EXISTS pqs_grams_positive;

  ALTER TABLE product_quality_specs
    ADD CONSTRAINT pqs_grams_positive_or_null
      CHECK (grams_per_linear_meter IS NULL OR grams_per_linear_meter > 0);

  COMMENT ON COLUMN product_quality_specs.grams_per_linear_meter IS
    'SaaS v2 §144: peso teórico por metro lineal. NULL para productos no-lineales (frituras, pastel, etc.). Para productos lineales (esquineros, tubos): peso esperado por metro de longitud.';
`

const down = `
  ALTER TABLE product_quality_specs DROP CONSTRAINT IF EXISTS pqs_grams_positive_or_null;

  -- Para revertir: re-llenar NULLs con 180 y restaurar NOT NULL.
  UPDATE product_quality_specs SET grams_per_linear_meter = 180.00
   WHERE grams_per_linear_meter IS NULL;

  ALTER TABLE product_quality_specs
    ALTER COLUMN grams_per_linear_meter SET DEFAULT 180.00,
    ALTER COLUMN grams_per_linear_meter SET NOT NULL,
    ADD CONSTRAINT pqs_grams_positive CHECK (grams_per_linear_meter > 0);
`

module.exports = { up, down }
