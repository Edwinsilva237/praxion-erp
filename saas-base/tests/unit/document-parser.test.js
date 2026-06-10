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

const { parseSupplierDocument } = require('../../src/modules/purchases/documentParserService')

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

describe('documentParserService — formato no soportado', () => {
  test('rechaza un .txt', async () => {
    await expect(
      parseSupplierDocument(Buffer.from('hola'), 'text/plain', 'nota.txt')
    ).rejects.toMatchObject({ status: 400 })
  })
})
