'use strict'

// ─────────────────────────────────────────────────────────────────────────────
// Diagnóstico SOLO-LECTURA de WIP de PRODUCTO varado ("En proceso" que no drenó).
//
// Corre DENTRO de Render (Shell del servicio praxion-api) → usa la base INTERNA
// vía src/db/index.js, sin abrir IPs ni External URL.
//
// Qué reporta, por cada producto con stock en estado 'wip':
//   • qty en WIP y su costo.
//   • WIP LEGÍTIMO = piezas capturadas por turnos AÚN activos / pendientes de
//     validar (ese WIP es correcto, está en proceso).
//   • EXCEDENTE (varado) = qty − legítimo. Esto es lo que sobra de turnos ya
//     validados que no se drenaron.
//   • De los turnos ya validados que tocaron ese producto: si existe (o no) su
//     movimiento 'production_pt_entry' → distingue la causa:
//        - SIN pt_entry  → el PT nunca se creó (flag pt_goes_to_wip_first cambió
//          entre captura y validación) → hay que MOVER el WIP a terminado.
//        - CON pt_entry  → el PT ya existe (mismatch 2da calidad / doble) → hay
//          que PONER EN CERO el WIP para no duplicar.
//
// NO escribe nada. Uso:  node src/db/_diag-wip.js   (dentro de saas-base/)
// ─────────────────────────────────────────────────────────────────────────────

const { query, pool, withBypass } = require('./index')

const money = (n) => (n == null ? '—' : '$' + Number(n).toFixed(4))
const num   = (n) => Number(n || 0).toFixed(2)

;(async () => {
  await withBypass(async () => {
    // Todos los saldos de PRODUCTO en estado 'wip' con cantidad != 0.
    const { rows: wipRows } = await query(
      `SELECT st.tenant_id, t.slug AS tenant, st.warehouse_id, w.name AS warehouse,
              st.item_id, p.sku, p.name AS product,
              st.quantity::numeric AS qty, st.avg_cost::numeric AS cost,
              tpc.pt_goes_to_wip_first
         FROM inventory_stock st
         JOIN warehouses w ON w.id = st.warehouse_id
         JOIN tenants t    ON t.id = st.tenant_id
         JOIN products p   ON p.id = st.item_id
         LEFT JOIN tenant_process_config tpc ON tpc.tenant_id = st.tenant_id
        WHERE st.item_type = 'product' AND st.status = 'wip'
          AND ABS(st.quantity) > 0.0001
        ORDER BY t.slug, p.sku`
    )

    if (!wipRows.length) { console.log('✅ No hay stock de PRODUCTO en estado wip. Nada varado.'); return }

    for (const r of wipRows) {
      // WIP legítimo = piezas de turnos aún NO validados (active / pending_handover).
      const { rows: [leg] } = await query(
        `SELECT COALESCE(SUM(sp.quantity_units),0)::numeric AS units
           FROM shift_progress sp
           JOIN production_shifts ps ON ps.id = sp.shift_id
          WHERE ps.tenant_id = $1
            AND COALESCE(sp.second_quality_product_id,
                 (SELECT po.product_id FROM production_orders po WHERE po.id = sp.production_order_id)) = $2
            AND ps.status IN ('active','pending_handover')`,
        [r.tenant_id, r.item_id]
      )
      const legit    = Number(leg.units)
      const stranded = Number(r.qty) - legit

      console.log('─'.repeat(74))
      console.log(`${r.product} [${r.sku}]  ·  ${r.tenant}  ·  almacén "${r.warehouse}"`)
      console.log(`   WIP total = ${num(r.qty)} pza  @ ${money(r.cost)}   (pt_goes_to_wip_first=${r.pt_goes_to_wip_first})`)
      console.log(`   WIP legítimo (turnos activos/pendientes) = ${num(legit)} pza`)
      console.log(`   ${stranded > 0.0001 ? '🔴 VARADO' : '🟢 ok'} = ${num(stranded)} pza`)

      if (stranded > 0.0001) {
        // ¿Los turnos VALIDADOS que tocaron este producto tienen su pt_entry?
        const { rows: shifts } = await query(
          `SELECT DISTINCT ps.id, ps.shift_number, ps.status,
                  EXISTS (
                    SELECT 1 FROM inventory_movements im
                     WHERE im.tenant_id = ps.tenant_id
                       AND im.item_type = 'product' AND im.item_id = $2
                       AND im.movement_type = 'production_pt_entry'
                       AND im.reference_type = 'production_shift'
                       AND im.reference_id = ps.id
                  ) AS has_pt_entry
             FROM shift_progress sp
             JOIN production_shifts ps ON ps.id = sp.shift_id
            WHERE ps.tenant_id = $1
              AND COALESCE(sp.second_quality_product_id,
                   (SELECT po.product_id FROM production_orders po WHERE po.id = sp.production_order_id)) = $2
              AND ps.status IN ('reviewed','closed')
            ORDER BY ps.shift_number`,
          [r.tenant_id, r.item_id]
        )
        for (const s of shifts)
          console.log(`      turno #${s.shift_number} (${s.status}) → PT entry: ${s.has_pt_entry ? 'SÍ (posible duplicado → zero)' : 'NO (nunca llegó a terminado → mover a PT)'}`)
        if (!shifts.length)
          console.log('      (ningún turno validado tocó este producto — WIP huérfano puro)')
      }
    }
    console.log('─'.repeat(74))
    console.log('Pásame esta salida y armo la migración de limpieza correcta (mover a PT vs poner en 0).')
  })
})()
  .then(() => pool.end())
  .catch(async (e) => { console.error('ERROR:', e.message); try { await pool.end() } catch {}; process.exitCode = 1 })
