'use strict'

/**
 * SaaS v2 — la restricción `rm_resin_material_required_for_raw_material`
 * (introducida en mig 150) asume el modelo plástico: si `item_kind='raw_material'`,
 * `resin_type` y `material_type` deben ser NOT NULL. Eso impide que verticales
 * sin resinas (palomitas, pastelería, frituras, recicladora de no-plástico)
 * registren materias primas principales — el INSERT truena en BD aunque la
 * config del tenant tenga `uses_resin_types=false`.
 *
 * La lógica correcta vive en la capa de aplicación, donde sí tenemos contexto
 * del tenant: `routes.js` (POST /api/raw-materials) ahora condiciona la
 * exigencia de resinType a `tenant_process_config.uses_resin_types`. Un CHECK
 * estático en Postgres no puede cruzar a otra tabla sin trigger, así que la
 * defensa correcta es relajar la BD y dejar el guard en la app.
 *
 * Decisión §46 (sesión 2026-05-27, post-cierre): bajamos el contrato de BD
 * para que tolere los 4 verticales del SaaS. Las garantías de "MP plástica
 * tiene resina" pasan al backend + frontend, donde tienen conocimiento del
 * flag uses_resin_types del tenant.
 */

const up = `
  ALTER TABLE raw_materials
    DROP CONSTRAINT IF EXISTS rm_resin_material_required_for_raw_material;
`

const down = `
  -- Restaurar el CHECK rompe los rows que se crearon entre la app de mig 155
  -- y el rollback. Backfill con dummies para que el rollback no truene; el
  -- usuario que haga rollback acepta perder la semántica multi-vertical.
  UPDATE raw_materials SET resin_type    = 'PE'     WHERE item_kind = 'raw_material' AND resin_type    IS NULL;
  UPDATE raw_materials SET material_type = 'virgin' WHERE item_kind = 'raw_material' AND material_type IS NULL;

  ALTER TABLE raw_materials
    ADD CONSTRAINT rm_resin_material_required_for_raw_material CHECK (
      item_kind <> 'raw_material'
      OR (resin_type IS NOT NULL AND material_type IS NOT NULL)
    );
`

module.exports = { up, down }
