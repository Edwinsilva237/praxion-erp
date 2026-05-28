'use strict'

/**
 * Mig 164 — backfill de almacenes default por tenant.
 *
 * Contexto (sesión 2026-05-29):
 *  Auditando tenant `paopops` (palomitas) descubrí que tenía 4 almacenes pero
 *  NO el de tipo `wip` (Producción en proceso). `recordProductionValidation`
 *  necesita WIP para mover MP y PT cuando `pt_goes_to_wip_first=true`; sin él
 *  hacía `console.warn` silencioso y retornaba sin generar movimientos. Por
 *  eso paopops tenía 0 filas en `inventory_movements` después de capturar y
 *  validar turnos.
 *
 *  La mig 124 sembró `tenant_warehouse_types` con el catálogo de 5 tipos
 *  (materia_prima, embalaje, producto_terminado, merma, wip) pero NO crea los
 *  almacenes físicos correspondientes — eso depende del flujo de provisioning,
 *  que históricamente solo creaba MP + PT + merma y dejaba WIP como opcional.
 *
 *  Esta migración crea automáticamente un almacén por cada tipo del catálogo
 *  que el tenant no tenga ya. Para tenants vivos, esto SOLO agrega los que
 *  faltan — no toca los existentes.
 *
 *  El nombre default del almacén nuevo es el nombre del tipo (ej. "Producción
 *  en proceso") con prefijo del tenant. El admin lo renombra desde la pantalla
 *  Configuración → Almacenes si quiere.
 *
 *  Acompañado de:
 *   - tenantService.provisionTenant llama ensureDefaultWarehouses(tenantId)
 *     después de crear el tenant para que esto no vuelva a pasar en tenants
 *     nuevos.
 *   - inventoryService.recordProductionValidation: warn silencioso pasa a
 *     error visible cuando falta WIP y pt_goes_to_wip_first=true.
 */

const up = `
  INSERT INTO warehouses
    (tenant_id, warehouse_type_id, name, type, is_active)
  SELECT t.id, twt.id,
         twt.name,
         (CASE twt.system_role
           WHEN 'input'  THEN CASE twt.code WHEN 'embalaje' THEN 'packaging' ELSE 'raw_material' END
           WHEN 'output' THEN 'finished_product'
           WHEN 'wip'    THEN 'wip'
         END)::warehouse_type,
         true
    FROM tenants t
    CROSS JOIN tenant_warehouse_types twt
   WHERE twt.tenant_id = t.id
     AND twt.is_active = true
     AND twt.system_role IN ('input','output','wip')
     AND NOT EXISTS (
       SELECT 1 FROM warehouses w
        WHERE w.tenant_id = t.id
          AND w.warehouse_type_id = twt.id
     );
`

const down = `
  -- No-op: revertir significaría borrar almacenes que pueden estar siendo usados.
  SELECT 1;
`

module.exports = { up, down }
