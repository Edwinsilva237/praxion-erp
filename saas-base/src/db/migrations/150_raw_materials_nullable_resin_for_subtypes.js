'use strict'

/**
 * Bug latente descubierto al cablear nomenclatura por subtipo (149):
 *
 * `raw_materials.resin_type` y `raw_materials.material_type` se crearon en
 * la migración 010 como `NOT NULL` (resin_type sin default, material_type
 * con default 'virgin'). La migración 126 introdujo `item_kind` con valores
 * 'raw_material' / 'packaging' / 'additive' para unificar el catálogo, pero
 * NO relajó las dos columnas viejas. Resultado: INSERT de packaging/additive
 * por la API real falla con "violates not-null constraint" porque ni resina
 * ni tipo de material aplican a esos subtipos.
 *
 * El service ya envía NULL para esos campos cuando kind != 'raw_material',
 * así que el contrato semántico estaba bien — solo faltaba ajustar la BD.
 *
 * Esta migración:
 *   - DROP NOT NULL en resin_type y material_type.
 *   - Agrega CHECK condicional: si item_kind='raw_material', ambos deben
 *     seguir siendo NOT NULL (mantiene la garantía vieja para MP plástico).
 *
 * No toca data existente (todas las filas hoy tienen ambos campos por
 * construcción del constraint anterior).
 */

const up = `
  ALTER TABLE raw_materials
    ALTER COLUMN resin_type    DROP NOT NULL,
    ALTER COLUMN material_type DROP NOT NULL;

  ALTER TABLE raw_materials
    ADD CONSTRAINT rm_resin_material_required_for_raw_material CHECK (
      item_kind <> 'raw_material'
      OR (resin_type IS NOT NULL AND material_type IS NOT NULL)
    );
`

const down = `
  ALTER TABLE raw_materials
    DROP CONSTRAINT IF EXISTS rm_resin_material_required_for_raw_material;

  -- Si quedaron rows packaging/additive con NULL, no se pueden re-restaurar
  -- NOT NULL sin perder data. Backfill con defaults dummy para que el rollback
  -- no rompa, asumiendo que en ese momento ya no se usa el feature.
  UPDATE raw_materials SET resin_type = 'PE'        WHERE resin_type    IS NULL;
  UPDATE raw_materials SET material_type = 'virgin' WHERE material_type IS NULL;

  ALTER TABLE raw_materials
    ALTER COLUMN resin_type    SET NOT NULL,
    ALTER COLUMN material_type SET NOT NULL;
`

module.exports = { up, down }
