'use strict'

/**
 * Mig 220 — limpieza de WIP de PRODUCTO varado (write-off).
 *
 * Bug: cuando un turno se CAPTURA con pt_goes_to_wip_first=true (el producto
 * entra al almacén "En proceso"/wip) pero se VALIDA después de cambiar el flag a
 * false, la rama de validación del flujo directo NO drena el WIP → el producto
 * queda atorado en estado 'wip' para siempre, sin llegar nunca a terminado.
 * (Reportado 2026-07-09 en gh-insumos: PRO-0001 100pza, PRO-0021 50pza.)
 *
 * Decisión del usuario para el histórico: ese producto NO existe físicamente / ya
 * está contado en Fábrica → WRITE-OFF (poner el WIP en cero), NO mover a terminado
 * (evita doble conteo). El código ya se corrige aparte para que no vuelva a pasar.
 *
 * Qué hace: por cada saldo de PRODUCTO en estado 'wip' cuya cantidad EXCEDE lo que
 * justifican los turnos aún activos/pendientes (WIP legítimo, en proceso ahora),
 * registra un movimiento 'adjustment_out' del excedente (kardex auditable) y baja
 * inventory_stock.quantity al nivel legítimo. Conservador: solo toca el EXCEDENTE
 * varado; el WIP de turnos activos se respeta intacto. Idempotente (una segunda
 * corrida ya no encuentra excedente).
 */

// Excedente varado = qty en wip − Σ piezas de turnos activos/pendientes del producto.
const STRANDED_CTE = `
  WITH wip AS (
    SELECT st.id, st.tenant_id, st.warehouse_id, st.item_id, st.unit,
           st.avg_cost::numeric AS cost, st.quantity::numeric AS qty,
           COALESCE((
             SELECT SUM(sp.quantity_units)
               FROM shift_progress sp
               JOIN production_shifts ps ON ps.id = sp.shift_id
              WHERE ps.tenant_id = st.tenant_id
                AND COALESCE(sp.second_quality_product_id,
                     (SELECT po.product_id FROM production_orders po WHERE po.id = sp.production_order_id)) = st.item_id
                AND ps.status IN ('active','pending_handover')
           ), 0)::numeric AS legit_qty
      FROM inventory_stock st
     WHERE st.item_type = 'product' AND st.status = 'wip' AND st.quantity > 0.0001
  ),
  stranded AS (
    SELECT *, (qty - legit_qty) AS strand_qty FROM wip WHERE (qty - legit_qty) > 0.0001
  )
`

const up = `
  ${STRANDED_CTE}
  INSERT INTO inventory_movements
    (tenant_id, warehouse_id, item_type, item_id, movement_type, quantity, unit,
     unit_cost, balance_after, status_to, reference_type, notes)
  SELECT tenant_id, warehouse_id, 'product', item_id, 'adjustment_out',
         -strand_qty, COALESCE(unit,'pza'), cost, legit_qty, 'wip', 'wip_cleanup',
         'Limpieza WIP varado (mig 220): producto capturado a "En proceso" que no dreno a terminado al validar bajo flujo directo. Write-off (no existe / ya contado).'
    FROM stranded;

  ${STRANDED_CTE}
  UPDATE inventory_stock st
     SET quantity = s.legit_qty, updated_at = NOW(), last_movement_at = NOW()
    FROM stranded s
   WHERE st.id = s.id;
`

// Write-off no es reversible (no sabemos el estado previo por almacén sin la foto).
// Los movimientos 'wip_cleanup' quedan en el kardex como rastro auditable.
const down = `SELECT 1;`

module.exports = { up, down }
