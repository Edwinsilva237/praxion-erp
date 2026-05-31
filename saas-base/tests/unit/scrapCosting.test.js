'use strict'

const { computeScrapProductCost } = require('../../src/modules/production/scrapCosting')

// avgCostPerKg = 10 para que la aritmética sea trivial: valor = kg × 10.
const COST = 10

describe('computeScrapProductCost — costeo de merma por tipo', () => {
  test('merma normal sin recuperación (alimentos/discard) → carga TODO al producto', () => {
    const rows = [{ kg: 20, is_normal: true, default_recovery_value_pct: 0, record_recovery_pct: null, is_abnormal: false }]
    const r = computeScrapProductCost(rows, { avgCostPerKg: COST })
    expect(r.productCost).toBeCloseTo(200, 4)   // 20 × 10 × (1 - 0)
    expect(r.lossValue).toBeCloseTo(0, 4)
    expect(r.chargedKg).toBeCloseTo(20, 4)
  })

  test('merma normal 100% recuperable (plástico regrind) → NO carga al producto', () => {
    const rows = [{ kg: 20, is_normal: true, default_recovery_value_pct: 100, is_abnormal: false }]
    const r = computeScrapProductCost(rows, { avgCostPerKg: COST })
    expect(r.productCost).toBeCloseTo(0, 4)
  })

  test('merma normal con recuperación parcial (40%) → carga el 60% no recuperable', () => {
    const rows = [{ kg: 20, is_normal: true, default_recovery_value_pct: 40, is_abnormal: false }]
    const r = computeScrapProductCost(rows, { avgCostPerKg: COST })
    expect(r.productCost).toBeCloseTo(120, 4)   // 200 × 0.6
  })

  test('tipo anormal (is_normal=false) → pérdida del período, NO al producto', () => {
    const rows = [{ kg: 20, is_normal: false, default_recovery_value_pct: 0, is_abnormal: false }]
    const r = computeScrapProductCost(rows, { avgCostPerKg: COST })
    expect(r.productCost).toBeCloseTo(0, 4)
    expect(r.lossValue).toBeCloseTo(200, 4)
    expect(r.lossKg).toBeCloseTo(20, 4)
  })

  test('registro anormal (is_abnormal) + treatAbnormalAsLoss=true → pérdida, no producto', () => {
    const rows = [{ kg: 20, is_normal: true, default_recovery_value_pct: 0, is_abnormal: true }]
    const r = computeScrapProductCost(rows, { avgCostPerKg: COST, treatAbnormalAsLoss: true })
    expect(r.productCost).toBeCloseTo(0, 4)
    expect(r.lossValue).toBeCloseTo(200, 4)
  })

  test('registro anormal + treatAbnormalAsLoss=false → se trata como normal (carga al producto)', () => {
    const rows = [{ kg: 20, is_normal: true, default_recovery_value_pct: 0, is_abnormal: true }]
    const r = computeScrapProductCost(rows, { avgCostPerKg: COST, treatAbnormalAsLoss: false })
    expect(r.productCost).toBeCloseTo(200, 4)
    expect(r.lossValue).toBeCloseTo(0, 4)
  })

  test('recovery del registro tiene prioridad sobre el default del tipo', () => {
    const rows = [{ kg: 20, is_normal: true, default_recovery_value_pct: 0, record_recovery_pct: 50, is_abnormal: false }]
    const r = computeScrapProductCost(rows, { avgCostPerKg: COST })
    expect(r.productCost).toBeCloseTo(100, 4)   // usa 50%, no 0%
  })

  test('merma sin catálogo (scrap_type_id nulo) → normal, recovery 0 → carga completo', () => {
    const rows = [{ kg: 20, is_normal: null, default_recovery_value_pct: null, record_recovery_pct: null, is_abnormal: false }]
    const r = computeScrapProductCost(rows, { avgCostPerKg: COST })
    expect(r.productCost).toBeCloseTo(200, 4)
  })

  test('mezcla de tipos: normal + recuperable + anormal', () => {
    const rows = [
      { kg: 10, is_normal: true,  default_recovery_value_pct: 0,   is_abnormal: false }, // 100 producto
      { kg: 10, is_normal: true,  default_recovery_value_pct: 100, is_abnormal: false }, //   0 producto
      { kg: 10, is_normal: false, default_recovery_value_pct: 0,   is_abnormal: false }, // 100 pérdida
    ]
    const r = computeScrapProductCost(rows, { avgCostPerKg: COST })
    expect(r.productCost).toBeCloseTo(100, 4)
    expect(r.lossValue).toBeCloseTo(100, 4)
  })

  test('avgCostPerKg = 0 → todo en cero', () => {
    const rows = [{ kg: 20, is_normal: true, default_recovery_value_pct: 0, is_abnormal: false }]
    const r = computeScrapProductCost(rows, { avgCostPerKg: 0 })
    expect(r.productCost).toBeCloseTo(0, 4)
  })

  test('sin filas → cero', () => {
    expect(computeScrapProductCost([], { avgCostPerKg: COST }).productCost).toBe(0)
    expect(computeScrapProductCost(null, { avgCostPerKg: COST }).productCost).toBe(0)
  })

  test('recovery fuera de rango se satura a [0,100]', () => {
    const over = computeScrapProductCost([{ kg: 10, is_normal: true, default_recovery_value_pct: 150, is_abnormal: false }], { avgCostPerKg: COST })
    expect(over.productCost).toBeCloseTo(0, 4)   // satura a 100% → 0 carga
    const under = computeScrapProductCost([{ kg: 10, is_normal: true, default_recovery_value_pct: -20, is_abnormal: false }], { avgCostPerKg: COST })
    expect(under.productCost).toBeCloseTo(100, 4) // satura a 0% → carga completo
  })
})
