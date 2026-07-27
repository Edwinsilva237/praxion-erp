'use strict'

/**
 * Exportación de facturación por cliente/periodo (Excel + ZIP).
 *
 * Las facturas del fixture se crean vía la IMPORTACIÓN (source='imported'):
 * es la única forma de tener facturas 'stamped' sin Facturapi, y de paso
 * cubre que el ZIP tome los archivos del respaldo importado.
 */

jest.mock('../../src/modules/invoicing/facturapiClient')

const request = require('supertest')
const ExcelJS = require('exceljs')
const { unzipSync } = require('fflate')
const app = require('../../src/app')
const { pool, query, withBypass } = require('../../src/db')
const importIssuedService = require('../../src/modules/invoicing/importIssuedService')
const { createTenant, loginAs, cleanupTestTenants } = require('../helpers/factory')

let tenantId, slug, authToken, userId, customerId

const TENANT_RFC   = 'AAA010101AAA'
const CUSTOMER_RFC = 'CLI010101CL5'

function issuedXml({ uuid, folio, fecha = '2026-06-15', total = 1160, subtotal = 1000 }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" Serie="EX" Folio="${folio}" Fecha="${fecha}T12:00:00" SubTotal="${subtotal}" Moneda="MXN" Total="${total}" TipoDeComprobante="I" MetodoPago="PUE">
  <cfdi:Emisor Rfc="${TENANT_RFC}" Nombre="TENANT TEST SA" RegimenFiscal="601"/>
  <cfdi:Receptor Rfc="${CUSTOMER_RFC}" Nombre="Cliente Export SA" DomicilioFiscalReceptor="64000" RegimenFiscalReceptor="601" UsoCFDI="G03"/>
  <cfdi:Conceptos><cfdi:Concepto Cantidad="1" ClaveUnidad="H87" Descripcion="X" ValorUnitario="${subtotal}" Importe="${subtotal}"/></cfdi:Conceptos>
  <cfdi:Complemento><tfd:TimbreFiscalDigital xmlns:tfd="http://www.sat.gob.mx/TimbreFiscalDigital" UUID="${uuid}"/></cfdi:Complemento>
</cfdi:Comprobante>`
}

const toFile = (xml, filename = 'f.xml') => ({
  filename, mimetype: 'application/xml',
  contentBase64: Buffer.from(xml, 'utf8').toString('base64'),
})

const headers = () => ({ 'X-Tenant-Slug': slug, Authorization: `Bearer ${authToken}` })

beforeAll(async () => {
  const t = await createTenant({ label: 'invexport', planSlug: 'owner' })
  tenantId = t.tenant.id
  slug = t.tenant.slug
  userId = t.user.id
  const session = await loginAs({ slug, email: t.email, password: t.password })
  authToken = session.token

  await withBypass(() => query(
    `INSERT INTO tenant_fiscal_profiles (tenant_id, rfc, tax_name, tax_regime, zip_code, is_active)
     VALUES ($1,$2,'TENANT TEST SA','601','12345',true)`, [tenantId, TENANT_RFC]))

  const { rows: bp } = await withBypass(() => query(
    `INSERT INTO business_partners (tenant_id, type, name, rfc)
     VALUES ($1,'customer','Cliente Export SA',$2) RETURNING id`, [tenantId, CUSTOMER_RFC]))
  customerId = bp[0].id

  // Dos facturas importadas: junio y julio (para el filtro de periodo).
  await importIssuedService.importBatch({
    tenantId, userId, files: [
      toFile(issuedXml({ uuid: 'ee000001-0000-0000-0000-000000000001', folio: '80', fecha: '2026-06-15' })),
      toFile(issuedXml({ uuid: 'ee000002-0000-0000-0000-000000000002', folio: '81', fecha: '2026-07-10' })),
    ],
  })
})

afterAll(async () => { await cleanupTestTenants(); await pool.end() })

async function readSheet(buffer, name) {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(buffer)
  return wb.getWorksheet(name)
}

test('export/excel: filtra por periodo y trae montos con IVA + fila de total', async () => {
  const res = await request(app)
    .get('/api/invoicing/export/excel?dateFrom=2026-06-01&dateTo=2026-06-30')
    .set(headers()).responseType('blob')
  expect(res.status).toBe(200)
  expect(res.headers['content-type']).toContain('spreadsheetml')

  const ws = await readSheet(res.body, 'Facturas')
  // Header + 1 factura de junio + fila TOTAL.
  expect(ws.rowCount).toBe(3)
  const row = ws.getRow(2)
  expect(row.getCell(1).value).toBe('EX-80')
  expect(row.getCell(3).value).toBe('Cliente Export SA')
  expect(row.getCell(8).value).toBe('Importada')
  expect(row.getCell(13).value).toBeCloseTo(1160, 2)   // Total CON IVA
})

test('export/excel: filtro por cliente ajeno → sin filas de datos', async () => {
  const { rows: other } = await withBypass(() => query(
    `INSERT INTO business_partners (tenant_id, type, name, rfc)
     VALUES ($1,'customer','Otro Cliente','OTR010101OT1') RETURNING id`, [tenantId]))
  const res = await request(app)
    .get(`/api/invoicing/export/excel?dateFrom=2026-01-01&dateTo=2026-12-31&partnerId=${other[0].id}`)
    .set(headers()).responseType('blob')
  expect(res.status).toBe(200)
  const ws = await readSheet(res.body, 'Facturas')
  expect(ws.rowCount).toBe(2)   // solo header + fila TOTAL en ceros
})

test('export/excel: hoja de complementos cuando se piden', async () => {
  const { rows: inv } = await withBypass(() => query(
    `SELECT id FROM invoices WHERE tenant_id = $1 AND cfdi_uuid = 'ee000001-0000-0000-0000-000000000001'`,
    [tenantId]))
  await withBypass(() => query(
    `INSERT INTO payment_complements
       (tenant_id, invoice_id, facturapi_id, cfdi_uuid, payment_date, payment_form, amount, currency, status)
     VALUES ($1,$2,'fapi-test','ee00cccc-0000-0000-0000-0000000000cc','2026-06-20','03',580,'MXN','stamped')`,
    [tenantId, inv[0].id]))

  const res = await request(app)
    .get('/api/invoicing/export/excel?dateFrom=2026-06-01&dateTo=2026-06-30&includeComplements=1')
    .set(headers()).responseType('blob')
  expect(res.status).toBe(200)
  const wc = await readSheet(res.body, 'Complementos de pago')
  expect(wc.rowCount).toBe(2)
  expect(wc.getRow(2).getCell(1).value).toBe('EX-80')
  expect(wc.getRow(2).getCell(4).value).toBeCloseTo(580, 2)
})

test('export/zip: XML de respaldo de las importadas + Resumen.xlsx + FALTANTES por el PDF', async () => {
  const res = await request(app)
    .get('/api/invoicing/export/zip?dateFrom=2026-06-01&dateTo=2026-07-31')
    .set(headers()).responseType('blob')
  expect(res.status).toBe(200)
  expect(res.headers['content-type']).toContain('zip')

  const files = unzipSync(new Uint8Array(res.body))
  const names = Object.keys(files)
  expect(names).toContain('Facturas/2026-06-15_EX-80.xml')
  expect(names).toContain('Facturas/2026-07-10_EX-81.xml')
  expect(names).toContain('Resumen.xlsx')
  // Se importaron sin PDF → el faltante queda anotado, no tira la descarga.
  expect(names).toContain('FALTANTES.txt')
  const faltantes = Buffer.from(files['FALTANTES.txt']).toString('utf8')
  expect(faltantes).toMatch(/EX-80.*sin PDF/i)
})

test('export: sin periodo → 400; zip sin documentos → 404', async () => {
  const bad = await request(app).get('/api/invoicing/export/excel').set(headers())
  expect(bad.status).toBe(400)

  const empty = await request(app)
    .get('/api/invoicing/export/zip?dateFrom=2001-01-01&dateTo=2001-01-31')
    .set(headers())
  expect(empty.status).toBe(404)
})
