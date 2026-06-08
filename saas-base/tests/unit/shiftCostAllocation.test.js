'use strict'

const { allocateShiftCostByProduct } = require('../../src/modules/production/shiftCostAllocation')

// Helper: suma de totalCost de la asignación (debe igualar costGrade1).
const sumTotal = (rows) => rows.reduce((s, r) => s + r.totalCost, 0)

describe('allocateShiftCostByProduct — prorrateo de costo por medida (modelo mixto)', () => {

  test('1 solo producto → recibe TODO el costo (retrocompat con cost_per_unit del turno)', () => {
    const out = allocateShiftCostByProduct(
      [{ productId: 'A', units: 100, kg: 50, packagingCost: 0 }],
      { avgCostPerKg: 12.5, overheadCost: 2000, costGrade1: 2625 }
    )
    expect(out).toHaveLength(1)
    expect(out[0].totalCost).toBeCloseTo(2625, 4)
    expect(out[0].costPerUnit).toBeCloseTo(26.25, 6)
  })

  test('MP se reparte por PESO: medida 2× más pesada cuesta ~2× en MP', () => {
    // Sin overhead ni empaque, costGrade1 = MP total = (100+200)kg × $10 = 3000.
    const out = allocateShiftCostByProduct(
      [
        { productId: 'chico', units: 100, kg: 100, packagingCost: 0 },
        { productId: 'grande', units: 100, kg: 200, packagingCost: 0 },
      ],
      { avgCostPerKg: 10, overheadCost: 0, costGrade1: 3000 }
    )
    const chico  = out.find(o => o.productId === 'chico')
    const grande = out.find(o => o.productId === 'grande')
    expect(chico.totalCost).toBeCloseTo(1000, 4)    // 100kg × 10
    expect(grande.totalCost).toBeCloseTo(2000, 4)   // 200kg × 10
    // Mismas piezas, pero el grande pesa el doble → su costo/pza es el doble.
    expect(chico.costPerUnit).toBeCloseTo(10, 6)
    expect(grande.costPerUnit).toBeCloseTo(20, 6)
    expect(sumTotal(out)).toBeCloseTo(3000, 4)      // total conservado
  })

  test('Overhead se reparte por PIEZAS (no por peso)', () => {
    // Solo overhead (sin MP ni empaque): kg no influye, piezas sí.
    const out = allocateShiftCostByProduct(
      [
        { productId: 'A', units: 300, kg: 10,  packagingCost: 0 },
        { productId: 'B', units: 100, kg: 500, packagingCost: 0 },
      ],
      { avgCostPerKg: 0, overheadCost: 800, costGrade1: 800 }
    )
    const a = out.find(o => o.productId === 'A')
    const b = out.find(o => o.productId === 'B')
    // 300 vs 100 piezas → 3:1 aunque B pese muchísimo más.
    expect(a.totalCost).toBeCloseTo(600, 4)
    expect(b.totalCost).toBeCloseTo(200, 4)
    expect(sumTotal(out)).toBeCloseTo(800, 4)
  })

  test('Empaque se reparte por RECETA (per-producto), no por piezas', () => {
    // Solo empaque: cada medida carga su propio packagingCost.
    const out = allocateShiftCostByProduct(
      [
        { productId: 'A', units: 100, kg: 0, packagingCost: 30 },
        { productId: 'B', units: 100, kg: 0, packagingCost: 70 },
      ],
      { avgCostPerKg: 0, overheadCost: 0, costGrade1: 100 }
    )
    expect(out.find(o => o.productId === 'A').totalCost).toBeCloseTo(30, 4)
    expect(out.find(o => o.productId === 'B').totalCost).toBeCloseTo(70, 4)
  })

  test('Modelo mixto combinado: MP por peso + overhead por piezas + empaque por receta, total exacto', () => {
    // chico: 100 pza, 100 kg, empaque 50 ; grande: 100 pza, 300 kg, empaque 50
    // MP = (100+300)×10 = 4000 ; overhead 1000 ; empaque 100 ; total = 5100.
    const out = allocateShiftCostByProduct(
      [
        { productId: 'chico',  units: 100, kg: 100, packagingCost: 50 },
        { productId: 'grande', units: 100, kg: 300, packagingCost: 50 },
      ],
      { avgCostPerKg: 10, overheadCost: 1000, costGrade1: 5100 }
    )
    const chico  = out.find(o => o.productId === 'chico')
    const grande = out.find(o => o.productId === 'grande')
    // chico: MP 1000 + ovh 500 + pkg 50 = 1550 ; grande: MP 3000 + ovh 500 + pkg 50 = 3550
    expect(chico.totalCost).toBeCloseTo(1550, 4)
    expect(grande.totalCost).toBeCloseTo(3550, 4)
    expect(chico.mpCost).toBeCloseTo(1000, 4)
    expect(grande.mpCost).toBeCloseTo(3000, 4)
    expect(chico.overheadCost).toBeCloseTo(500, 4)
    expect(grande.overheadCost).toBeCloseTo(500, 4)
    expect(sumTotal(out)).toBeCloseTo(5100, 4)
  })

  test('El factor de escala reconcilia el total cuando costGrade1 ≠ suma cruda (merma/NRV)', () => {
    // Suma cruda = MP (100+200)×10 = 3000 ; pero costGrade1 = 2700 (p.ej. NRV de 2da).
    // Cada medida se escala ×0.9 preservando la proporción y el total exacto.
    const out = allocateShiftCostByProduct(
      [
        { productId: 'A', units: 100, kg: 100, packagingCost: 0 },
        { productId: 'B', units: 100, kg: 200, packagingCost: 0 },
      ],
      { avgCostPerKg: 10, overheadCost: 0, costGrade1: 2700 }
    )
    expect(out.find(o => o.productId === 'A').totalCost).toBeCloseTo(900, 4)
    expect(out.find(o => o.productId === 'B').totalCost).toBeCloseTo(1800, 4)
    expect(sumTotal(out)).toBeCloseTo(2700, 4)
  })

  test('Sin drivers (sin peso/overhead/empaque) → reparte por piezas (fallback)', () => {
    const out = allocateShiftCostByProduct(
      [
        { productId: 'A', units: 150, kg: 0, packagingCost: 0 },
        { productId: 'B', units: 50,  kg: 0, packagingCost: 0 },
      ],
      { avgCostPerKg: 0, overheadCost: 0, costGrade1: 400 }
    )
    expect(out.find(o => o.productId === 'A').totalCost).toBeCloseTo(300, 4)  // 150/200
    expect(out.find(o => o.productId === 'B').totalCost).toBeCloseTo(100, 4)  // 50/200
    expect(sumTotal(out)).toBeCloseTo(400, 4)
  })

  test('Grupo con 0 piezas no rompe (costPerUnit = 0, sin división por cero)', () => {
    const out = allocateShiftCostByProduct(
      [{ productId: 'A', units: 0, kg: 0, packagingCost: 0 }],
      { avgCostPerKg: 10, overheadCost: 100, costGrade1: 100 }
    )
    expect(out[0].costPerUnit).toBe(0)
  })

  test('Lista vacía → arreglo vacío', () => {
    expect(allocateShiftCostByProduct([], { costGrade1: 100 })).toEqual([])
  })
})
