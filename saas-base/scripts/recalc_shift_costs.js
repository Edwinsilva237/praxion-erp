#!/usr/bin/env node
'use strict'

/**
 * Recalcula `cost_per_unit` y refresca el snapshot de costos fijos para
 * turnos en estado 'reviewed' que se hayan cerrado con el bug de la columna
 * `omf.order_id` (cuando el blended_cost_per_kg quedó en 0 por culpa del
 * try/catch silencioso).
 *
 * NO toca movimientos de inventario históricos. Sólo actualiza el costo
 * unitario calculado a partir de los datos actuales de la orden y los costos
 * fijos vigentes al momento de correr el script.
 *
 * USO (desde la raíz del backend `saas-base/`):
 *   node scripts/recalc_shift_costs.js                     # dry-run, lista turnos afectados
 *   node scripts/recalc_shift_costs.js --apply             # aplica cambios
 *   node scripts/recalc_shift_costs.js --apply --shift=ID  # solo un turno
 *   node scripts/recalc_shift_costs.js --tenant=UUID       # filtrar por tenant
 *
 * RECOMENDADO: respaldar la BD antes de correr con --apply.
 */

const { query, withTransaction } = require('../src/db')

const args = process.argv.slice(2)
const APPLY     = args.includes('--apply')
const SHIFT_ID  = (args.find(a => a.startsWith('--shift='))  || '').split('=')[1]  || null
const TENANT_ID = (args.find(a => a.startsWith('--tenant=')) || '').split('=')[1] || null

async function main() {
  console.log(APPLY ? '🔧 MODO APPLY — se aplicarán cambios' : '🔍 MODO DRY-RUN — solo lectura')
  console.log('---')

  const params = []
  const filters = [`ps.status = 'reviewed'`]
  if (SHIFT_ID)  { params.push(SHIFT_ID);  filters.push(`ps.id        = $${params.length}`) }
  if (TENANT_ID) { params.push(TENANT_ID); filters.push(`ps.tenant_id = $${params.length}`) }

  const { rows: shifts } = await query(
    `SELECT ps.id, ps.tenant_id, ps.shift_number, ps.shift_date,
            ps.pt_units_produced, ps.cost_per_unit
     FROM production_shifts ps
     WHERE ${filters.join(' AND ')}
     ORDER BY ps.shift_date, ps.shift_number`,
    params
  )

  if (!shifts.length) {
    console.log('No hay turnos para procesar.')
    process.exit(0)
  }

  console.log(`Encontrados ${shifts.length} turnos validados para revisar.`)
  console.log('---')

  let updated = 0
  let skipped = 0

  for (const shift of shifts) {
    // 1) Sumar peso producido del turno
    const { rows: wtRows } = await query(
      `SELECT
         COALESCE(SUM(real_weight_kg) FILTER (WHERE is_second_quality = false), 0) AS good_kg,
         COALESCE(SUM(real_weight_kg) FILTER (WHERE is_second_quality = true),  0) AS second_kg,
         COALESCE(SUM(quantity_units) FILTER (WHERE is_second_quality = false), 0) AS good_units
       FROM shift_progress WHERE shift_id = $1`,
      [shift.id]
    )
    const goodKg     = parseFloat(wtRows[0].good_kg)
    const secondKg   = parseFloat(wtRows[0].second_kg)
    const goodUnits  = parseInt(wtRows[0].good_units || 0)
    const totalKg    = goodKg + secondKg

    // 2) Costo promedio por kg (cargas reales > fórmula > promedio materiales)
    const { rows: avgRows } = await query(
      `SELECT COALESCE(
         (SELECT SUM(sml.kg * r.cost_per_kg) / NULLIF(SUM(sml.kg), 0)
          FROM shift_mp_loads sml
          JOIN raw_materials r ON r.id = sml.raw_material_id
          WHERE sml.shift_id = $1),
         (SELECT po.blended_cost_per_kg
          FROM shift_progress sp
          JOIN production_orders po ON po.id = sp.production_order_id
          WHERE sp.shift_id = $1 AND po.blended_cost_per_kg IS NOT NULL
          ORDER BY sp.microlot_number DESC LIMIT 1),
         (SELECT AVG(r.cost_per_kg)
          FROM shift_progress sp
          JOIN production_orders po ON po.id = sp.production_order_id
          JOIN order_mp_formula ompf ON ompf.production_order_id = po.id
          JOIN raw_materials r ON r.id = ompf.raw_material_id
          WHERE sp.shift_id = $1),
         0
       )::numeric AS avg_cost_per_kg`,
      [shift.id]
    )
    const avgCostPerKg = parseFloat(avgRows[0].avg_cost_per_kg)

    // 3) Factor de merma del tenant
    const { rows: factorRows } = await query(
      `SELECT amount FROM production_cost_items
       WHERE tenant_id = $1 AND name = '__scrap_factor__' AND is_active = true LIMIT 1`,
      [shift.tenant_id]
    )
    const scrapFactor = factorRows[0] ? parseFloat(factorRows[0].amount) / 100 : 0.20
    const estimatedMpKg = totalKg * (1 + scrapFactor)
    const mpCost        = estimatedMpKg * avgCostPerKg

    // 4) Costos fijos del snapshot (los conservados en validación)
    const { rows: snapshotRows } = await query(
      `SELECT COALESCE(SUM(amount), 0) AS fixed_total
       FROM shift_cost_snapshot
       WHERE shift_id = $1 AND name <> '__scrap_factor__'`,
      [shift.id]
    )
    const fixedTotal = parseFloat(snapshotRows[0].fixed_total)

    const totalCost      = mpCost + fixedTotal
    const newCostPerUnit = goodUnits > 0 ? (totalCost / goodUnits) : 0
    const oldCostPerUnit = parseFloat(shift.cost_per_unit || 0)
    const diff           = Math.abs(newCostPerUnit - oldCostPerUnit)

    // Si la diferencia es trivial, lo saltamos
    if (diff < 0.0001) {
      skipped++
      continue
    }

    console.log(
      `Turno ${shift.shift_number} (${shift.shift_date}, ${goodUnits} pzas): ` +
      `costo/pza  ${oldCostPerUnit.toFixed(4)} → ${newCostPerUnit.toFixed(4)} ` +
      `(MP: ${mpCost.toFixed(2)} + fijos: ${fixedTotal.toFixed(2)} = ${totalCost.toFixed(2)})`
    )

    if (APPLY) {
      await query(
        `UPDATE production_shifts SET cost_per_unit = $1 WHERE id = $2`,
        [newCostPerUnit.toFixed(6), shift.id]
      )
      updated++
    }
  }

  console.log('---')
  if (APPLY) {
    console.log(`✓ ${updated} turnos actualizados, ${skipped} sin cambios.`)
  } else {
    console.log(`Turnos que cambiarían: ${shifts.length - skipped}, sin cambios: ${skipped}.`)
    console.log('Para aplicar los cambios, vuelve a correr con --apply.')
  }

  process.exit(0)
}

main().catch((err) => {
  console.error('Error:', err)
  process.exit(1)
})
