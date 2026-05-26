'use strict'

/**
 * Soporte para múltiples almacenes del mismo tipo con marca de "default".
 *
 * Antes: getWarehouseId hacía LIMIT 1 — funcionaba con 1 almacén por tipo,
 * pero al tener varios el resultado era indefinido.
 *
 * Ahora: cada tipo tiene un almacén marcado como default. Los hooks
 * automáticos (producción → MP→WIP, WIP→PT) usan el default por defecto.
 *
 * Backfill: marca como default el primer almacén activo de cada tipo
 * (en orden por created_at) — preserva el comportamiento existente.
 */
const up = `
  ALTER TABLE warehouses
    ADD COLUMN is_default BOOLEAN NOT NULL DEFAULT false;

  -- Backfill: marca como default el almacén más antiguo activo de cada tipo,
  -- por tenant. Esto preserva el comportamiento que hoy tienen los hooks.
  UPDATE warehouses w
  SET    is_default = true
  WHERE  w.id = (
    SELECT w2.id
    FROM   warehouses w2
    WHERE  w2.tenant_id = w.tenant_id
      AND  w2.type      = w.type
      AND  w2.is_active = true
    ORDER  BY w2.created_at ASC, w2.id ASC
    LIMIT  1
  );

  -- Constraint: solo puede haber UN default por (tenant, tipo) cuando esté activo.
  CREATE UNIQUE INDEX uq_warehouse_default_per_type
    ON warehouses (tenant_id, type)
    WHERE is_default = true AND is_active = true;

  COMMENT ON COLUMN warehouses.is_default
    IS 'true = almacén que recibe automáticos del proceso (uno por tipo). Editable solo por inventario:manage.';
`

const down = `
  DROP INDEX IF EXISTS uq_warehouse_default_per_type;
  ALTER TABLE warehouses DROP COLUMN IF EXISTS is_default;
`

module.exports = { up, down }
