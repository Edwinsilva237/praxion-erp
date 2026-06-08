'use strict'

/**
 * SaaS v2 — Prorrateo del costo de un turno entre sus PRODUCTOS (medidas) cal-1.
 *
 * Problema: un turno puede fabricar varias medidas (productos distintos). Antes el
 * motor calculaba UN solo cost_per_unit (costo_total / piezas_totales) y se lo
 * asignaba a TODAS las medidas por igual → la medida más pesada quedaba
 * sub-costeada y la más ligera sobre-costeada al cargarse a inventario.
 *
 * Modelo MIXTO (acordado con el usuario):
 *   - Materia prima: por PESO (kg producidos de cada medida × $/kg). Driver
 *     natural — una medida que pesa el doble consume el doble de resina.
 *   - Empaque: por la RECETA de cada producto (ya viene calculado per-producto).
 *   - Overhead (gastos indirectos): por PIEZAS (cada medida carga según su
 *     proporción de piezas del turno).
 *
 * Un único factor de escala reconcilia la suma EXACTA a `costGrade1` (el costo que
 * hoy se reparte a cal-1, neto de NRV de 2da calidad). Ese factor absorbe la merma
 * cargada al producto y el ajuste NRV sin distorsionar el reparto relativo: en el
 * caso común (sin 2da, sin merma cargada) el factor es 1 y cada medida sale
 * exactamente con mp_por_peso + overhead_por_pieza + empaque_por_receta.
 *
 * Garantías:
 *   - Σ(totalCost) === costGrade1  (el total del turno se conserva exacto).
 *   - 1 solo producto → recibe todo el costo (idéntico al comportamiento previo).
 *   - Sin drivers (sin peso/overhead/empaque) → reparte por piezas (fallback).
 *
 * @param {Array<{productId, units, kg, packagingCost}>} groups  grupos cal-1 del turno
 * @param {object} pools
 * @param {number} pools.avgCostPerKg   costo promedio $/kg de la MP del turno
 * @param {number} pools.overheadCost   overhead estimado total del turno
 * @param {number} pools.costGrade1     costo total a repartir entre cal-1 (= total − NRV)
 * @returns {Array<{productId, units, totalKg, mpCost, overheadCost, packagingCost, totalCost, costPerUnit}>}
 */
function allocateShiftCostByProduct(groups, { avgCostPerKg = 0, overheadCost = 0, costGrade1 = 0 } = {}) {
  const list = (groups || []).map(g => ({
    productId:     g.productId,
    units:         parseFloat(g.units) || 0,
    kg:            parseFloat(g.kg) || 0,
    packagingCost: parseFloat(g.packagingCost) || 0,
  }))

  const totalUnits = list.reduce((s, g) => s + g.units, 0)
  const cpk    = parseFloat(avgCostPerKg) || 0
  const ovh    = parseFloat(overheadCost) || 0
  const target = parseFloat(costGrade1) || 0

  // Costo "crudo" por grupo según los drivers mixtos.
  const raw = list.map(g => {
    const mp  = g.kg * cpk
    const ohG = totalUnits > 0 ? ovh * (g.units / totalUnits) : 0
    const pkg = g.packagingCost
    return { ...g, mp, ohG, pkg, rawCost: mp + ohG + pkg }
  })
  const sumRaw = raw.reduce((s, g) => s + g.rawCost, 0)
  const hasRaw = sumRaw > 1e-9
  const scale  = hasRaw ? (target / sumRaw) : 0

  return raw.map(g => {
    let mpCost, overheadCostOut, packagingCost, totalCost
    if (hasRaw) {
      mpCost          = g.mp  * scale
      overheadCostOut = g.ohG * scale
      packagingCost   = g.pkg * scale
      totalCost       = g.rawCost * scale
    } else {
      // Sin drivers (sin peso/overhead/empaque): reparte el costo por piezas.
      mpCost = 0; overheadCostOut = 0; packagingCost = 0
      totalCost = totalUnits > 0 ? target * (g.units / totalUnits) : 0
    }
    return {
      productId:     g.productId,
      units:         g.units,
      totalKg:       g.kg,
      mpCost,
      overheadCost:  overheadCostOut,
      packagingCost,
      totalCost,
      costPerUnit:   g.units > 0 ? totalCost / g.units : 0,
    }
  })
}

module.exports = { allocateShiftCostByProduct }
