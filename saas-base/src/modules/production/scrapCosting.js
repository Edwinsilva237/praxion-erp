'use strict'

/**
 * SaaS v2 — Costeo de merma por tipo.
 *
 * Decide cuánto del valor MP de cada merma del turno carga al COSTO DEL
 * PRODUCTO (good units), según la configuración por tenant que YA existe:
 *   - tenant_scrap_types.is_normal              (normal entra al costo / anormal = pérdida)
 *   - tenant_scrap_types.default_recovery_value_pct  (% recuperable → se descuenta)
 *   - shift_scrap.recovery_value_pct            (override por registro)
 *   - shift_scrap.is_abnormal                   (superó expected_scrap_pct)
 *   - tenant_process_config.treat_abnormal_scrap_as_loss (flag)
 *
 * Antes esta config solo estaba cableada al INVENTARIO (recordScrap recupera la
 * merma a la MP vinculada). El costeo tenía `mpCostScrap = 0` hardcodeado, así
 * que `is_normal` ("entra al costo") era letra muerta y los turnos con merma
 * desechada (típico alimentos) quedaban SUB-COSTEADOS. Este módulo conecta la
 * config al cálculo de costo.
 *
 * No hay doble conteo con la recuperación a inventario: esa entrada se hace a
 * unitCost 0 (no crea un activo costeado), por lo que el descuento de valor se
 * gobierna únicamente por `recovery_value_pct`.
 *
 * Reglas por registro de merma (la primera que aplica gana):
 *   1. Pérdida (NO al costo del producto, va a pérdida del período):
 *        - tipo anormal: tenant_scrap_types.is_normal = false, ó
 *        - registro anormal: shift_scrap.is_abnormal = true Y treatAbnormalAsLoss.
 *   2. Normal: carga al producto la porción no recuperable:
 *        valor × (1 - recovery%/100),  recovery% = registro ?? tipo ?? 0.
 *
 * Compat: merma sin scrap_type_id (catálogo nulo) se trata como NORMAL con
 * recovery 0 → carga su valor completo (conservador: sobre-costea en vez de
 * sub-costear ante datos incompletos).
 */

/**
 * @param {Array<object>} scrapRows  filas con:
 *   { kg, is_abnormal, record_recovery_pct, is_normal,
 *     default_recovery_value_pct, default_destination, linked_raw_material_id }
 * @param {object} opts
 * @param {number} opts.avgCostPerKg
 * @param {boolean} [opts.treatAbnormalAsLoss=true]
 * @returns {{ productCost: number, lossValue: number, chargedKg: number, lossKg: number }}
 */
function computeScrapProductCost(scrapRows, { avgCostPerKg = 0, treatAbnormalAsLoss = true } = {}) {
  const cost = parseFloat(avgCostPerKg) || 0
  let productCost = 0   // carga al costo del producto (good units)
  let lossValue   = 0   // informativo: merma a pérdida del período
  let chargedKg   = 0
  let lossKg      = 0

  for (const r of scrapRows || []) {
    const kg = parseFloat(r.kg || 0)
    if (kg <= 0 || cost <= 0) continue
    const value = kg * cost

    const isAbnormalType   = r.is_normal === false
    const isAbnormalRecord = r.is_abnormal === true
    const goesToLoss = isAbnormalType || (isAbnormalRecord && treatAbnormalAsLoss !== false)

    if (goesToLoss) {
      lossValue += value
      lossKg    += kg
      continue
    }

    // Normal → carga la porción NO recuperable
    const recoveryRaw = (r.record_recovery_pct != null)
      ? r.record_recovery_pct
      : (r.default_recovery_value_pct != null ? r.default_recovery_value_pct : 0)
    const recovery = Math.min(100, Math.max(0, parseFloat(recoveryRaw) || 0))
    productCost += value * (1 - recovery / 100)
    chargedKg   += kg
  }

  return { productCost, lossValue, chargedKg, lossKg }
}

/**
 * Trae las filas de merma del turno con la info del catálogo y computa el costo
 * que carga al producto. `queryFn` es client.query (en transacción) o el query
 * del módulo.
 */
async function fetchAndComputeScrapProductCost(queryFn, { shiftId, avgCostPerKg, treatAbnormalAsLoss }) {
  const { rows } = await queryFn(
    `SELECT ss.kg,
            ss.is_abnormal,
            ss.recovery_value_pct          AS record_recovery_pct,
            tst.is_normal,
            tst.default_recovery_value_pct,
            tst.default_destination,
            tst.linked_raw_material_id
       FROM shift_scrap ss
       LEFT JOIN tenant_scrap_types tst ON tst.id = ss.scrap_type_id
      WHERE ss.shift_id = $1`,
    [shiftId]
  )
  return computeScrapProductCost(rows, { avgCostPerKg, treatAbnormalAsLoss })
}

module.exports = { computeScrapProductCost, fetchAndComputeScrapProductCost }
