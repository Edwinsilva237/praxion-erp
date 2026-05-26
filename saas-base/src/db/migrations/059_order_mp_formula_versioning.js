'use strict'

/**
 * Versionado de la fórmula MP de las órdenes.
 *
 * Caso de negocio: durante la producción de una orden, puede ser necesario
 * cambiar la mezcla (por calidad de MP, contaminación, ajuste de proceso).
 * Los paquetes capturados ANTES del cambio deben costearse con la fórmula
 * original; los capturados DESPUÉS, con la nueva. La merma también se
 * distribuye según la fórmula vigente al momento de capturarla.
 *
 * Cambios:
 *   1. Agregar `valid_from` y `valid_until` a order_mp_formula
 *      - valid_from: cuándo entró en vigor esta versión de la fórmula
 *      - valid_until: cuándo fue reemplazada (NULL = vigente)
 *   2. Eliminar el constraint UNIQUE (production_order_id, raw_material_id)
 *      porque ahora puede haber múltiples filas por material (historial)
 *   3. Backfill: las filas existentes quedan con valid_from = created_at
 *      de la orden (o NOW() si la orden no tiene timestamp) y valid_until=NULL.
 *
 * Para consultar la fórmula vigente:
 *   WHERE production_order_id = $1 AND valid_until IS NULL
 *
 * Para consultar la fórmula que estaba activa en un momento histórico:
 *   WHERE production_order_id = $1
 *     AND valid_from <= $2
 *     AND (valid_until IS NULL OR valid_until > $2)
 */
const up = `
  ALTER TABLE order_mp_formula
    ADD COLUMN IF NOT EXISTS valid_from  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ADD COLUMN IF NOT EXISTS valid_until TIMESTAMPTZ;

  -- Backfill: para filas existentes, valid_from = created_at de la orden
  -- (esto deja todas las filas vigentes existentes correctamente marcadas)
  UPDATE order_mp_formula omf
  SET valid_from = po.created_at
  FROM production_orders po
  WHERE omf.production_order_id = po.id
    AND omf.valid_until IS NULL;

  -- Quitar el constraint UNIQUE que ya no aplica
  ALTER TABLE order_mp_formula
    DROP CONSTRAINT IF EXISTS ompf_unique_mp;

  -- Nuevo constraint: solo puede haber una versión vigente por (orden, material)
  -- (valid_until IS NULL es la versión actual)
  CREATE UNIQUE INDEX IF NOT EXISTS ompf_unique_active
    ON order_mp_formula (production_order_id, raw_material_id)
    WHERE valid_until IS NULL;

  -- Índice para consultas históricas
  CREATE INDEX IF NOT EXISTS idx_ompf_validity
    ON order_mp_formula (production_order_id, valid_from, valid_until);

  COMMENT ON COLUMN order_mp_formula.valid_from  IS 'Cuándo entró en vigor esta versión de la fórmula';
  COMMENT ON COLUMN order_mp_formula.valid_until IS 'Cuándo fue reemplazada (NULL = vigente actualmente)';
`

const down = `
  DROP INDEX IF EXISTS ompf_unique_active;
  DROP INDEX IF EXISTS idx_ompf_validity;

  -- Antes de re-agregar el constraint UNIQUE, eliminar filas históricas
  DELETE FROM order_mp_formula WHERE valid_until IS NOT NULL;

  ALTER TABLE order_mp_formula
    ADD CONSTRAINT ompf_unique_mp UNIQUE (production_order_id, raw_material_id);

  ALTER TABLE order_mp_formula
    DROP COLUMN IF EXISTS valid_from,
    DROP COLUMN IF EXISTS valid_until;
`

module.exports = { up, down }
