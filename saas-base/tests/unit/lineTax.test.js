'use strict'

const { normalizeLineTax, buildFacturapiTaxes, lineCausesTax } = require('../../src/modules/invoicing/lineTax')

describe('lineTax — tratamiento fiscal por línea (CFDI 4.0)', () => {
  describe('normalizeLineTax', () => {
    test('sin datos → IVA Tasa 16% (compat con comportamiento previo)', () => {
      expect(normalizeLineTax({})).toEqual({ objetoImp: '02', factor: 'Tasa', ratePct: 16 })
    })

    test('respeta tasa 8 (frontera) y 0 (tasa cero)', () => {
      expect(normalizeLineTax({ tax_rate: 8 }).ratePct).toBe(8)
      expect(normalizeLineTax({ tax_rate: 0 }).ratePct).toBe(0)
    })

    test('Exento ignora la tasa', () => {
      expect(normalizeLineTax({ tax_factor: 'Exento', tax_rate: 16 }))
        .toEqual({ objetoImp: '02', factor: 'Exento', ratePct: 0 })
    })

    test('factor inválido cae a Tasa', () => {
      expect(normalizeLineTax({ tax_factor: 'Basura' }).factor).toBe('Tasa')
    })

    test('objeto de impuesto se conserva', () => {
      expect(normalizeLineTax({ objeto_imp: '01' }).objetoImp).toBe('01')
    })
  })

  describe('buildFacturapiTaxes', () => {
    test('Tasa 16% → IVA Tasa 0.16', () => {
      expect(buildFacturapiTaxes({ objeto_imp: '02', tax_factor: 'Tasa', tax_rate: 16 }))
        .toEqual([{ type: 'IVA', factor: 'Tasa', rate: 0.16 }])
    })

    test('Tasa 0% (aguacate / caña / agro) → IVA Tasa 0', () => {
      expect(buildFacturapiTaxes({ objeto_imp: '02', tax_factor: 'Tasa', tax_rate: 0 }))
        .toEqual([{ type: 'IVA', factor: 'Tasa', rate: 0 }])
    })

    test('Exento → IVA factor Exento sin tasa', () => {
      expect(buildFacturapiTaxes({ objeto_imp: '02', tax_factor: 'Exento' }))
        .toEqual([{ type: 'IVA', factor: 'Exento' }])
    })

    test('No objeto de impuesto (01) → sin impuestos', () => {
      expect(buildFacturapiTaxes({ objeto_imp: '01' })).toEqual([])
    })

    test('Sí objeto sin desglose (03) → sin impuestos', () => {
      expect(buildFacturapiTaxes({ objeto_imp: '03' })).toEqual([])
    })
  })

  describe('lineCausesTax', () => {
    test('16% y 8% causan IVA trasladado', () => {
      expect(lineCausesTax({ objeto_imp: '02', tax_factor: 'Tasa', tax_rate: 16 })).toBe(true)
      expect(lineCausesTax({ objeto_imp: '02', tax_factor: 'Tasa', tax_rate: 8 })).toBe(true)
    })

    test('tasa cero, exento y no objeto NO causan IVA trasladado', () => {
      expect(lineCausesTax({ objeto_imp: '02', tax_factor: 'Tasa', tax_rate: 0 })).toBe(false)
      expect(lineCausesTax({ objeto_imp: '02', tax_factor: 'Exento' })).toBe(false)
      expect(lineCausesTax({ objeto_imp: '01' })).toBe(false)
    })
  })
})
