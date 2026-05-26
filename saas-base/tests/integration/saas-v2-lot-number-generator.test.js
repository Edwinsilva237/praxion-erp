'use strict'

/**
 * SaaS v2 — Tests del lotNumberGenerator.
 *
 * Función pura, tests unitarios (sin BD, sin afterAll de cleanup).
 */

const { generate, supportedVariables, DEFAULT_PATTERN, MAX_LOT_NUMBER_LENGTH }
  = require('../../src/modules/production/lotNumberGenerator')

describe('SaaS v2: lotNumberGenerator — ejemplos del design §4.5.1', () => {
  test('Ejemplo 1: {YYYY}{MM}{DD}-{SKU}-{SEQ}', () => {
    expect(generate('{YYYY}{MM}{DD}-{SKU}-{SEQ}', {
      date: '2026-05-22',
      sku: 'PAL-MTQ-50G',
      seq: 1,
    })).toBe('20260522-PAL-MTQ-50G-001')
  })

  test('Ejemplo 2: LOT-{YYYY}{JJJ}-{LINE}-{SHIFT}', () => {
    expect(generate('LOT-{YYYY}{JJJ}-{LINE}-{SHIFT}', {
      date: '2026-05-22',
      line: 'L1',
      shift: 2,
    })).toBe('LOT-2026142-L1-2')
  })

  test('Ejemplo 3: {SKU}/{YYYY}{MM}/{SEQ} con seq=47', () => {
    expect(generate('{SKU}/{YYYY}{MM}/{SEQ}', {
      date: '2026-05-22',
      sku: 'PAL-MTQ-50G',
      seq: 47,
    })).toBe('PAL-MTQ-50G/202605/047')
  })
})

describe('SaaS v2: lotNumberGenerator — variables individuales', () => {
  const date = new Date('2026-05-22T15:30:00Z')

  test('YYYY = 2026', () => expect(generate('{YYYY}', { date })).toBe('2026'))
  test('YY = 26',     () => expect(generate('{YY}',   { date })).toBe('26'))
  test('MM = 05',     () => expect(generate('{MM}',   { date })).toBe('05'))
  test('DD = 22',     () => expect(generate('{DD}',   { date })).toBe('22'))
  test('JJJ = 142',   () => expect(generate('{JJJ}',  { date })).toBe('142'))
  test('SHIFT = 3',   () => expect(generate('{SHIFT}',{ date, shift: 3 })).toBe('3'))
  test('LINE = L2',   () => expect(generate('{LINE}', { date, line: 'L2' })).toBe('L2'))
  test('SKU = ABC',   () => expect(generate('{SKU}',  { date, sku: 'ABC' })).toBe('ABC'))
  test('SEQ = 042 (zero-pad default 3)', () =>
    expect(generate('{SEQ}', { date, seq: 42 })).toBe('042'))

  test('seqPadding override a 5', () =>
    expect(generate('{SEQ}', { date, seq: 7, seqPadding: 5 })).toBe('00007'))
})

describe('SaaS v2: lotNumberGenerator — Día juliano correcto en bordes', () => {
  test('1 de enero = 001', () =>
    expect(generate('{JJJ}', { date: new Date('2026-01-01T12:00:00Z') })).toBe('001'))

  test('31 de diciembre año NO-bisiesto = 365', () =>
    expect(generate('{JJJ}', { date: new Date('2026-12-31T12:00:00Z') })).toBe('365'))

  test('31 de diciembre año bisiesto (2024) = 366', () =>
    expect(generate('{JJJ}', { date: new Date('2024-12-31T12:00:00Z') })).toBe('366'))

  test('29 de febrero bisiesto = 060', () =>
    expect(generate('{JJJ}', { date: new Date('2024-02-29T12:00:00Z') })).toBe('060'))
})

describe('SaaS v2: lotNumberGenerator — comportamiento de variables faltantes', () => {
  test('Variable no provista en ctx queda vacía', () => {
    expect(generate('LOT-{SKU}-{SEQ}', { date: '2026-05-22' })).toBe('LOT--')
  })

  test('Variable desconocida queda vacía', () => {
    expect(generate('LOT-{BANANA}', { date: '2026-05-22' })).toBe('LOT-')
  })

  test('Patrón sin placeholders pasa tal cual', () => {
    expect(generate('STATIC-PREFIX', {})).toBe('STATIC-PREFIX')
  })

  test('Date default = hoy (NO falla)', () => {
    const result = generate('{YYYY}', {})
    expect(result).toMatch(/^\d{4}$/)
  })
})

describe('SaaS v2: lotNumberGenerator — validaciones', () => {
  test('Pattern vacío → throws', () => {
    expect(() => generate('', { date: '2026-05-22' })).toThrow(/pattern/i)
    expect(() => generate('   ', { date: '2026-05-22' })).toThrow(/pattern/i)
  })

  test('Pattern non-string → throws', () => {
    expect(() => generate(123, {})).toThrow(/pattern/i)
    expect(() => generate(null, {})).toThrow(/pattern/i)
  })

  test('Date inválida → throws', () => {
    expect(() => generate('{YYYY}', { date: 'no-soy-fecha' })).toThrow(/date/i)
    expect(() => generate('{YYYY}', { date: new Date('invalid') })).toThrow(/date/i)
  })

  test('Resultado > 60 chars → throws', () => {
    const longSku = 'X'.repeat(70)
    expect(() => generate('{SKU}', { date: '2026-05-22', sku: longSku }))
      .toThrow(/excede el máximo|60/i)
  })

  test('Resultado vacío (patrón que solo tiene variables faltantes) → throws', () => {
    expect(() => generate('{BANANA}', {})).toThrow(/vacío/i)
  })

  test('Resultado de exactamente 60 chars pasa', () => {
    const sku60 = 'A'.repeat(60)
    expect(generate('{SKU}', { date: '2026-05-22', sku: sku60 })).toBe(sku60)
    expect(sku60.length).toBe(MAX_LOT_NUMBER_LENGTH)
  })
})

describe('SaaS v2: lotNumberGenerator — metadata exportada', () => {
  test('supportedVariables lista las 9 variables', () => {
    const vars = supportedVariables()
    expect(vars).toContain('YYYY')
    expect(vars).toContain('YY')
    expect(vars).toContain('JJJ')
    expect(vars).toContain('SEQ')
    expect(vars).toContain('SKU')
    expect(vars.length).toBeGreaterThanOrEqual(9)
  })

  test('DEFAULT_PATTERN funciona end-to-end', () => {
    const result = generate(DEFAULT_PATTERN, {
      date: '2026-05-22',
      sku: 'TEST',
      seq: 5,
    })
    expect(result).toBe('20260522-TEST-005')
  })

  test('MAX_LOT_NUMBER_LENGTH = 60', () => {
    expect(MAX_LOT_NUMBER_LENGTH).toBe(60)
  })
})

describe('SaaS v2: lotNumberGenerator — pattern con texto adicional', () => {
  test('Prefijo y sufijo literales', () => {
    expect(generate('LOT-{YYYY}{MM}{DD}-END', { date: '2026-05-22' }))
      .toBe('LOT-20260522-END')
  })

  test('Separadores especiales (slash, punto, underscore)', () => {
    expect(generate('{YYYY}/{MM}.{DD}_{SEQ}', {
      date: '2026-05-22', seq: 9,
    })).toBe('2026/05.22_009')
  })

  test('SHIFT y LINE combinados', () => {
    expect(generate('T{SHIFT}_{LINE}_{YYYY}{JJJ}', {
      date: '2026-05-22', shift: 1, line: 'LINEA-A',
    })).toBe('T1_LINEA-A_2026142')
  })
})
