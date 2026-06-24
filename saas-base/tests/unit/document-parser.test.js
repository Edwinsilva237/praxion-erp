'use strict'

/**
 * Unit test de documentParserService (carga de XML/PDF de factura de proveedor).
 *
 * Cubre:
 *   - XML CFDI → extrae UUID, emisor, totales y TODAS las líneas (sin red).
 *   - PDF DIGITAL (con capa de texto) sin API key → extracción por texto saca
 *     los totales (pdf-parse v2: clase PDFParse, no la función vieja).
 *   - PDF ESCANEADO (imagen, sin texto) → el texto viene vacío → REQUIERE la IA;
 *     sin ANTHROPIC_API_KEY degrada con 422 claro y NO llama a la red.
 *   - PDF por IA → llama a la API de Anthropic con los headers OBLIGATORIOS
 *     (x-api-key + anthropic-version) — guard de regresión del bug 401.
 */

// pdf-parse v2 exporta la clase PDFParse; la mockeamos para controlar qué
// "texto" trae el PDF (vacío = escaneado, con contenido = digital).
let mockGetText
jest.mock('pdf-parse', () => ({
  PDFParse: class {
    constructor() {}
    getText() { return mockGetText() }
  },
}))

const { parseSupplierDocument, parseTotalsFromText } = require('../../src/modules/purchases/documentParserService')

const SAMPLE_CFDI = `<?xml version="1.0" encoding="UTF-8"?>
<cfdi:Comprobante Serie="A" Folio="1234" Fecha="2026-06-09T10:30:00"
  SubTotal="1000.00" Total="1160.00" Moneda="MXN">
  <cfdi:Emisor Rfc="AAA010101AAA" Nombre="PROVEEDOR DEMO SA DE CV" RegimenFiscal="601"/>
  <cfdi:Receptor Rfc="XAXX010101000" Nombre="CLIENTE DEMO"/>
  <cfdi:Conceptos>
    <cfdi:Concepto Cantidad="10" Unidad="kg" Descripcion="Resina PET" ValorUnitario="60" Importe="600"/>
    <cfdi:Concepto Cantidad="10" Unidad="kg" Descripcion="Colorante azul" ValorUnitario="40" Importe="400"/>
  </cfdi:Conceptos>
  <cfdi:Complemento>
    <tfd:TimbreFiscalDigital UUID="abcd1234-ef56-7890-ab12-cd34ef567890"/>
  </cfdi:Complemento>
</cfdi:Comprobante>`

beforeEach(() => {
  // Por defecto el PDF "no trae texto" (escaneado): cada test ajusta si aplica.
  mockGetText = jest.fn().mockResolvedValue({ text: '' })
})
afterEach(() => {
  delete process.env.ANTHROPIC_API_KEY
  jest.restoreAllMocks()
})

describe('documentParserService — XML CFDI', () => {
  test('extrae UUID, emisor, totales y líneas', async () => {
    const r = await parseSupplierDocument(Buffer.from(SAMPLE_CFDI, 'utf8'), 'application/xml', 'factura.xml')
    expect(r.method).toBe('xml')
    expect(r.uuid).toBe('abcd1234-ef56-7890-ab12-cd34ef567890')
    expect(r.serie).toBe('A')
    expect(r.folio).toBe('1234')
    expect(r.invoiceDate).toBe('2026-06-09')
    expect(r.subtotal).toBe(1000)
    expect(r.total).toBe(1160)
    expect(r.tax).toBe(160)
    expect(r.emisor).toMatchObject({ rfc: 'AAA010101AAA', name: 'PROVEEDOR DEMO SA DE CV', regime: '601' })
    expect(r.lines).toHaveLength(2)
    expect(r.lines[0]).toMatchObject({ quantity: 10, unit: 'kg', description: 'Resina PET', unitPrice: 60, amount: 600 })
  })
})

describe('documentParserService — PDF digital (capa de texto)', () => {
  test('sin API key, extrae los totales por texto (pdf-parse v2)', async () => {
    delete process.env.ANTHROPIC_API_KEY
    mockGetText = jest.fn().mockResolvedValue({
      text: 'FACTURA\nRFC: AAA010101AAA\nFecha: 09/06/2026\nSubtotal: $1,000.00\nIVA: $160.00\nTotal: $1,160.00\n',
    })
    const r = await parseSupplierDocument(Buffer.from('pdf'), 'application/pdf', 'factura.pdf')
    expect(r.method).toBe('text')
    expect(r.total).toBe(1160)
    expect(r.subtotal).toBe(1000)
    expect(r.emisor.rfc).toBe('AAA010101AAA')
  })

  test('best-effort: saca serie/folio/emisor/moneda y NO confunde el Folio Fiscal (UUID)', async () => {
    delete process.env.ANTHROPIC_API_KEY
    mockGetText = jest.fn().mockResolvedValue({
      text: [
        'PROVEEDOR DEMO SA DE CV',
        'RFC: AAA010101AAA',
        'Serie: A   Folio: 1042',
        'Folio Fiscal: abcd1234-ef56-7890-ab12-cd34ef567890',
        'Moneda: USD',
        'Subtotal: 100.00', 'IVA: 16.00', 'Total: 116.00',
      ].join('\n'),
    })
    const r = await parseSupplierDocument(Buffer.from('pdf'), 'application/pdf', 'f.pdf')
    expect(r.method).toBe('text')
    expect(r.serie).toBe('A')
    expect(r.folio).toBe('1042')                 // NO el UUID
    expect(r.uuid).toBe('abcd1234-ef56-7890-ab12-cd34ef567890')
    expect(r.currency).toBe('USD')
    expect(r.emisor.name).toBe('PROVEEDOR DEMO SA DE CV')
  })

  test('NO toma "Cadena Original … del SAT" como razón social (bug reportado)', async () => {
    delete process.env.ANTHROPIC_API_KEY
    mockGetText = jest.fn().mockResolvedValue({
      text: [
        'PROVEEDOR REAL SA DE CV',
        'RFC: AAA010101AAA',
        'Subtotal: 100.00', 'IVA: 16.00', 'Total: 116.00',
        'Sello Digital del CFDI: abc123==',
        'Cadena Original del Complemento de Certificación Digital del SAT',
        'Sello del SAT: xyz789==',
      ].join('\n'),
    })
    const r = await parseSupplierDocument(Buffer.from('pdf'), 'application/pdf', 'f.pdf')
    expect(r.emisor.name).toBe('PROVEEDOR REAL SA DE CV')   // NO la línea del SAT
  })

  test('sin línea de razón social válida → emisor.name es null (no toma boilerplate)', async () => {
    delete process.env.ANTHROPIC_API_KEY
    mockGetText = jest.fn().mockResolvedValue({
      text: [
        'FACTURA',
        'RFC: AAA010101AAA',
        'Total: 116.00',
        'Cadena Original del Complemento de Certificación Digital del SAT',
      ].join('\n'),
    })
    const r = await parseSupplierDocument(Buffer.from('pdf'), 'application/pdf', 'f.pdf')
    expect(r.emisor.name).toBeNull()
    expect(r.emisor.rfc).toBe('AAA010101AAA')   // el RFC sí se recupera
  })

  test('razón social con "SELLOS" NO se confunde con boilerplate de sello', async () => {
    delete process.env.ANTHROPIC_API_KEY
    mockGetText = jest.fn().mockResolvedValue({
      text: [
        'SIDOR SELLOS METALICOS SA DE CV',
        'RFC: SID010101AB2',
        'Total: 100.00',
        'Cadena Original del Complemento de Certificación Digital del SAT',
      ].join('\n'),
    })
    const r = await parseSupplierDocument(Buffer.from('pdf'), 'application/pdf', 'f.pdf')
    expect(r.emisor.name).toBe('SIDOR SELLOS METALICOS SA DE CV')
  })

  test('persona FÍSICA por etiqueta: toma el nombre aunque no tenga sufijo societario', async () => {
    delete process.env.ANTHROPIC_API_KEY
    mockGetText = jest.fn().mockResolvedValue({
      text: [
        'FACTURA',
        'Nombre del Emisor: JUAN PEREZ LOPEZ',
        'RFC: PELJ800101XYZ',         // 13 chars = persona física
        'Total: 116.00',
        'Cadena Original del Complemento de Certificación Digital del SAT',
      ].join('\n'),
    })
    const r = await parseSupplierDocument(Buffer.from('pdf'), 'application/pdf', 'f.pdf')
    expect(r.emisor.name).toBe('JUAN PEREZ LOPEZ')
    expect(r.emisor.rfc).toBe('PELJ800101XYZ')
  })

  test('etiqueta "Razón Social:" con RFC pegado en la misma línea → recorta el RFC', async () => {
    delete process.env.ANTHROPIC_API_KEY
    mockGetText = jest.fn().mockResolvedValue({
      text: [
        'Razón Social: MARIA GARCIA HERNANDEZ   RFC: GAHM900202AB1',
        'Total: 50.00',
      ].join('\n'),
    })
    const r = await parseSupplierDocument(Buffer.from('pdf'), 'application/pdf', 'f.pdf')
    expect(r.emisor.name).toBe('MARIA GARCIA HERNANDEZ')   // sin el "RFC: ..."
  })

  test('la etiqueta del emisor gana sobre el sufijo societario de otra línea', async () => {
    delete process.env.ANTHROPIC_API_KEY
    mockGetText = jest.fn().mockResolvedValue({
      text: [
        'Nombre del Emisor: PEDRO RAMIREZ SOLIS',
        'Cliente: OTRA EMPRESA SA DE CV',     // no debe ganar (es otra línea con sufijo)
        'RFC: RASP750505QQ0',
        'Total: 80.00',
      ].join('\n'),
    })
    const r = await parseSupplierDocument(Buffer.from('pdf'), 'application/pdf', 'f.pdf')
    expect(r.emisor.name).toBe('PEDRO RAMIREZ SOLIS')
  })
})

describe('documentParserService — PDF escaneado (imagen, sin texto)', () => {
  test('sin API key NO llama a la red y degrada con 422 claro', async () => {
    delete process.env.ANTHROPIC_API_KEY
    mockGetText = jest.fn().mockResolvedValue({ text: '' }) // escaneado
    const fetchMock = jest.fn()
    global.fetch = fetchMock

    await expect(
      parseSupplierDocument(Buffer.from('scan'), 'application/pdf', 'scan.pdf')
    ).rejects.toMatchObject({ status: 422 })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test('con API key, lo lee con IA (visión) y manda los headers correctos', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test-123'
    mockGetText = jest.fn().mockResolvedValue({ text: '' }) // escaneado → fuerza IA
    const aiJson = {
      documentType: 'invoice', uuid: null, serie: null, folio: 'F-99',
      invoiceDate: '2026-06-01', currency: 'MXN', exchangeRate: null,
      subtotal: 500, tax: 80, total: 580,
      emisor: { rfc: 'BBB020202BBB', name: 'PROV PDF', regime: '601' },
      receptor: { rfc: null, name: null },
      lines: [{ quantity: 5, unit: 'pza', description: 'Caja', unitPrice: 100, amount: 500 }],
    }
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ content: [{ text: JSON.stringify(aiJson) }] }),
    })
    global.fetch = fetchMock

    const r = await parseSupplierDocument(Buffer.from('scan'), 'application/pdf', 'scan.pdf')

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.anthropic.com/v1/messages')
    expect(opts.headers['x-api-key']).toBe('sk-ant-test-123')
    expect(opts.headers['anthropic-version']).toBe('2023-06-01')

    expect(r.method).toBe('ai')
    expect(r.folio).toBe('F-99')
    expect(r.total).toBe(580)
    expect(r.lines).toHaveLength(1)
    expect(r.emisor.rfc).toBe('BBB020202BBB')
  })

  test('la IA limpia el cercado ```json``` que a veces devuelve el modelo', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test-123'
    mockGetText = jest.fn().mockResolvedValue({ text: '' })
    const aiText = '```json\n{"total": 99, "subtotal": 99, "tax": 0, "lines": [], "emisor": {}, "receptor": {}}\n```'
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ content: [{ text: aiText }] }),
    })
    const r = await parseSupplierDocument(Buffer.from('scan'), 'application/pdf', 'f.pdf')
    expect(r.method).toBe('ai')
    expect(r.total).toBe(99)
  })
})

describe('documentParserService — detección de moneda (bug "Dólares" en notas)', () => {
  const parsePdf = (lines) => {
    delete process.env.ANTHROPIC_API_KEY
    mockGetText = jest.fn().mockResolvedValue({ text: lines.join('\n') })
    return parseSupplierDocument(Buffer.from('pdf'), 'application/pdf', 'f.pdf')
  }

  test('CFDI en MXN con leyenda "…en Dólares…" en notas → MXN (no USD)', async () => {
    // Bug reportado (DeltaTrak): la nota legal disparaba USD y el total se
    // multiplicaba por el tipo de cambio.
    const r = await parsePdf([
      'DELTATRAK INTERNACIONAL MEXICO',
      'RFC: DIM1207131N0',
      'Subtotal: $5,463.95  IVA: $874.23  Total: $6,338.18',
      'Moneda: MXN - MXN',
      'las cotizaciones serán realizadas en Dólares. Para clientes nacionales',
      'cuya forma de pago sea en Moneda Nacional la facturación se realiza.',
    ])
    expect(r.currency).toBe('MXN')
  })

  test('etiqueta "Moneda: USD" → USD', async () => {
    const r = await parsePdf(['Total: 100.00', 'Moneda: USD'])
    expect(r.currency).toBe('USD')
  })

  test('sin etiqueta, sólo mención de dólares → USD', async () => {
    const r = await parsePdf(['Total: 100.00', 'Pago en dólares americanos'])
    expect(r.currency).toBe('USD')
  })

  test('sin etiqueta, importe con letra "Pesos … M.N." → MXN', async () => {
    const r = await parsePdf(['Total: 100.00', 'Importe con letra: cien Pesos 00/100 M.N.'])
    expect(r.currency).toBe('MXN')
  })
})

describe('documentParserService — formato no soportado', () => {
  test('rechaza un .txt', async () => {
    await expect(
      parseSupplierDocument(Buffer.from('hola'), 'text/plain', 'nota.txt')
    ).rejects.toMatchObject({ status: 400 })
  })
})

describe('parseTotalsFromText — reconciliación de totales (bug IVA=tasa)', () => {
  test('subtotal + total presentes → IVA = total − subtotal', () => {
    expect(parseTotalsFromText('Subtotal 1,000.00 IVA 160.00 Total 1,160.00'))
      .toEqual({ subtotal: 1000, tax: 160, total: 1160 })
  })

  test('IVA impreso como TASA (0.160000) NO se toma como importe', () => {
    // El bug reportado: tomaba 0.16 y lo sumaba (+0.16) en vez de 16%.
    const r = parseTotalsFromText('Subtotal: 1,000.00  IVA Tasa 0.160000  Total: 1,160.00')
    expect(r.subtotal).toBe(1000)
    expect(r.total).toBe(1160)
    expect(r.tax).toBe(160)        // derivado, NO 0.16
  })

  test('tasa sin subtotal legible → NO toma 0.16; estima 16% del total', () => {
    // La tasa 0.16 se descarta; como sólo queda el total, se estima IVA 16%.
    const r = parseTotalsFromText('IVA 0.160000   Total 1,160.00')
    expect(r.total).toBe(1160)
    expect(r.subtotal).toBe(1000)  // 1160 / 1.16
    expect(r.tax).toBe(160)        // NO 0.16
  })

  test('sólo total legible → estima desglose al 16% (no deja $0/$0)', () => {
    // Caso ISI CLEAN: el PDF sólo expuso "Total $12,180.00".
    const r = parseTotalsFromText('Total: $12,180.00')
    expect(r.total).toBe(12180)
    expect(r.subtotal).toBe(10500) // 12180 / 1.16
    expect(r.tax).toBe(1680)       // 12180 − 10500
  })

  test('total + IVA real (sin subtotal) → deriva el subtotal', () => {
    expect(parseTotalsFromText('Total 1,160.00 IVA 160.00'))
      .toEqual({ subtotal: 1000, tax: 160, total: 1160 })
  })

  test('terna inconsistente → recomputa el IVA de los extremos', () => {
    // IVA capturado (5) no cuadra; subtotal/total sí → IVA = 1160 − 1000.
    const r = parseTotalsFromText('Subtotal 1,000.00 IVA 5 Total 1,160.00')
    expect(r.tax).toBe(160)
  })

  test('PDF completo: un CFDI impreso con IVA como tasa ya NO guarda tax=0.16', async () => {
    delete process.env.ANTHROPIC_API_KEY
    mockGetText = jest.fn().mockResolvedValue({
      text: [
        'PROVEEDOR DEMO SA DE CV',
        'RFC: AAA010101AAA',
        'Subtotal: $1,000.00',
        'IVA (Tasa 0.160000):  $160.00',
        'Total: $1,160.00',
      ].join('\n'),
    })
    const r = await parseSupplierDocument(Buffer.from('pdf'), 'application/pdf', 'f.pdf')
    expect(r.subtotal).toBe(1000)
    expect(r.tax).toBe(160)
    expect(r.total).toBe(1160)
  })
})
