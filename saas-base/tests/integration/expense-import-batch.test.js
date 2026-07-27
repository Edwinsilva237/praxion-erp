'use strict'

/**
 * Importación MANUAL en lote de CFDI recibidos (migración desde otro sistema).
 *
 * POST /api/purchases/expenses/import — sube varios XML/PDF/.zip y cada CFDI se
 * registra como gasto (o se desvía a complementos si es tipo P) con los mismos
 * candados del buzón: RFC receptor del tenant, anti-dup por UUID, respaldos.
 * Un archivo malo NO aborta el lote (resultado por archivo + resumen).
 */

const request = require('supertest')
const app = require('../../src/app')
const { pool, query, withBypass } = require('../../src/db')
const supplierInvoiceService = require('../../src/modules/purchases/supplierInvoiceService')
const { createTenant, loginAs, cleanupTestTenants } = require('../helpers/factory')
const { zipSync, strToU8 } = require('fflate')

let tenantId, slug, authToken, supplierId

const TENANT_RFC   = 'AAA010101AAA'
const SUPPLIER_RFC = 'PRO010101AB2'

function cfdiXml({ uuid, folio = '100', receptorRfc = TENANT_RFC, emisorRfc = SUPPLIER_RFC,
                   subtotal = 100, total = 116, metodoPago = 'PUE' }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" Serie="A" Folio="${folio}" Fecha="2026-07-01T12:00:00" SubTotal="${subtotal}" Moneda="MXN" Total="${total}" TipoDeComprobante="I" MetodoPago="${metodoPago}">
  <cfdi:Emisor Rfc="${emisorRfc}" Nombre="Proveedor Migrado SA" RegimenFiscal="601"/>
  <cfdi:Receptor Rfc="${receptorRfc}" Nombre="Tenant Test SA" UsoCFDI="G03"/>
  <cfdi:Conceptos>
    <cfdi:Concepto Cantidad="1" ClaveUnidad="E48" Descripcion="Servicio migrado" ValorUnitario="${subtotal}" Importe="${subtotal}"/>
  </cfdi:Conceptos>
  <cfdi:Complemento>
    <tfd:TimbreFiscalDigital xmlns:tfd="http://www.sat.gob.mx/TimbreFiscalDigital" UUID="${uuid}"/>
  </cfdi:Complemento>
</cfdi:Comprobante>`
}

/** CFDI tipo P (REP) mínimo con Pagos 2.0 — debe desviarse a complementos. */
function repXml({ uuid, docUuid }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" xmlns:pago20="http://www.sat.gob.mx/Pagos20" Serie="P" Folio="7" Fecha="2026-07-02T10:00:00" SubTotal="0" Moneda="XXX" Total="0" TipoDeComprobante="P">
  <cfdi:Emisor Rfc="${SUPPLIER_RFC}" Nombre="Proveedor Migrado SA" RegimenFiscal="601"/>
  <cfdi:Receptor Rfc="${TENANT_RFC}" Nombre="Tenant Test SA" UsoCFDI="CP01"/>
  <cfdi:Complemento>
    <pago20:Pagos Version="2.0">
      <pago20:Totales MontoTotalPagos="116"/>
      <pago20:Pago FechaPago="2026-07-02T12:00:00" FormaDePagoP="03" MonedaP="MXN" TipoCambioP="1" Monto="116">
        <pago20:DoctoRelacionado IdDocumento="${docUuid}" Serie="A" Folio="100" MonedaDR="MXN" EquivalenciaDR="1" NumParcialidad="1" ImpSaldoAnt="116" ImpPagado="116" ImpSaldoInsoluto="0" ObjetoImpDR="02"/>
      </pago20:Pago>
    </pago20:Pagos>
    <tfd:TimbreFiscalDigital xmlns:tfd="http://www.sat.gob.mx/TimbreFiscalDigital" UUID="${uuid}"/>
  </cfdi:Complemento>
</cfdi:Comprobante>`
}

const zipBuf = (files) => {
  const entries = {}
  for (const [name, content] of Object.entries(files)) entries[name] = strToU8(content)
  return Buffer.from(zipSync(entries))
}

const postImport = () => request(app)
  .post('/api/purchases/expenses/import')
  .set('X-Tenant-Slug', slug)
  .set('Authorization', `Bearer ${authToken}`)

beforeAll(async () => {
  const t = await createTenant({ label: 'impbatch', planSlug: 'owner' })
  tenantId = t.tenant.id
  slug = t.tenant.slug

  const session = await loginAs({ slug, email: t.email, password: t.password })
  authToken = session.token

  // RFC del tenant (receptor) — el candado lo compara.
  await withBypass(() => query(
    `INSERT INTO tenant_fiscal_profiles (tenant_id, rfc, tax_name, tax_regime, zip_code, is_active)
     VALUES ($1,$2,'TENANT TEST SA','601','12345',true)`,
    [tenantId, TENANT_RFC]))

  // Proveedor del catálogo con el RFC emisor → los gastos lo emparejan.
  const { rows: bp } = await withBypass(() => query(
    `INSERT INTO business_partners (tenant_id, type, name, rfc) VALUES ($1,'supplier','Proveedor Migrado SA',$2) RETURNING id`,
    [tenantId, SUPPLIER_RFC]))
  supplierId = bp[0].id
})

afterAll(async () => { await cleanupTestTenants(); await pool.end() })

test('lote mixto: 2 XML nuevos → ambos creados, emparejados por RFC, atribuidos al usuario', async () => {
  const res = await postImport()
    .attach('files', Buffer.from(cfdiXml({ uuid: 'ee000001-0000-0000-0000-000000000001', folio: 'M1' })), 'f1.xml')
    .attach('files', Buffer.from(cfdiXml({ uuid: 'ee000002-0000-0000-0000-000000000002', folio: 'M2' })), 'f2.xml')
  expect(res.status).toBe(200)
  expect(res.body.summary).toMatchObject({ created: 2, duplicates: 0, errors: 0 })
  expect(res.body.results).toHaveLength(2)
  expect(res.body.results.every(r => r.status === 'created' && r.supplierMatched)).toBe(true)

  const { rows } = await withBypass(() => query(
    `SELECT partner_id, is_expense, notes, created_by FROM supplier_invoices WHERE uuid_sat = $1`,
    ['ee000001-0000-0000-0000-000000000001']))
  expect(rows[0].partner_id).toBe(supplierId)
  expect(rows[0].is_expense).toBe(true)
  expect(rows[0].notes).toContain('Importado en lote')
  expect(rows[0].created_by).toBeTruthy()   // el usuario de la sesión, no el owner por token
})

test('re-importar el mismo XML → duplicate (idempotente) sin duplicar el gasto', async () => {
  const res = await postImport()
    .attach('files', Buffer.from(cfdiXml({ uuid: 'ee000001-0000-0000-0000-000000000001', folio: 'M1' })), 'f1.xml')
  expect(res.status).toBe(200)
  expect(res.body.summary).toMatchObject({ created: 0, duplicates: 1, errors: 0 })

  const { rows } = await withBypass(() => query(
    `SELECT COUNT(*)::int AS n FROM supplier_invoices WHERE uuid_sat = $1`,
    ['ee000001-0000-0000-0000-000000000001']))
  expect(rows[0].n).toBe(1)
})

test('archivo malo NO aborta el lote: el bueno se crea, el malo reporta error', async () => {
  const res = await postImport()
    .attach('files', Buffer.from(cfdiXml({ uuid: 'ee000003-0000-0000-0000-000000000003', folio: 'M3' })), 'ok.xml')
    .attach('files', Buffer.from('esto no es un CFDI'), 'roto.xml')
  expect(res.status).toBe(200)
  expect(res.body.summary.created).toBe(1)
  expect(res.body.summary.errors).toBe(1)
  const bad = res.body.results.find(r => r.filename === 'roto.xml')
  expect(bad.status).toBe('error')
  expect(bad.error).toBeTruthy()
})

test('candado RFC: CFDI con receptor ajeno → error en ese archivo, no en el lote', async () => {
  const res = await postImport()
    .attach('files', Buffer.from(cfdiXml({
      uuid: 'ee000004-0000-0000-0000-000000000004', receptorRfc: 'ZZZ010101ZZ9' })), 'ajena.xml')
  expect(res.status).toBe(200)
  expect(res.body.summary.errors).toBe(1)
  expect(res.body.results[0].error).toMatch(/RFC receptor/i)
})

test('.zip con varios XML → cada CFDI interno se procesa por separado', async () => {
  const zb = zipBuf({
    'a.xml': cfdiXml({ uuid: 'ee000005-0000-0000-0000-000000000005', folio: 'Z1' }),
    'b.xml': cfdiXml({ uuid: 'ee000006-0000-0000-0000-000000000006', folio: 'Z2' }),
  })
  const res = await postImport().attach('files', zb, { filename: 'lote.zip', contentType: 'application/zip' })
  expect(res.status).toBe(200)
  expect(res.body.summary.created).toBe(2)
})

test('CFDI tipo P (REP) en el lote → se desvía a complementos, NO crea gasto en $0', async () => {
  // Factura PPD previa a la que el REP referencia (auto-liga por UUID).
  const invUuid = 'ee000007-0000-0000-0000-000000000007'
  await withBypass(() => supplierInvoiceService.registerInvoice({
    tenantId, supplierId,
    documentNumber: 'A-REP1', uuidSat: invUuid, serie: 'A', folio: '100',
    rfcEmisor: SUPPLIER_RFC, invoiceDate: '2026-07-01',
    subtotal: 100, tax: 16, total: 116, metodoPagoSat: 'PPD',
  }))

  const repUuid = 'ee000008-0000-0000-0000-000000000008'
  const res = await postImport()
    .attach('files', Buffer.from(repXml({ uuid: repUuid, docUuid: invUuid })), 'rep.xml')
  expect(res.status).toBe(200)
  expect(res.body.results[0].kind).toBe('payment_complement')
  expect(res.body.summary.complements).toBe(1)

  // NO se creó un gasto con el UUID del REP.
  const { rows } = await withBypass(() => query(
    `SELECT COUNT(*)::int AS n FROM supplier_invoices WHERE uuid_sat = $1`, [repUuid]))
  expect(rows[0].n).toBe(0)
  // Sí quedó el complemento, con origen manual.
  const { rows: comp } = await withBypass(() => query(
    `SELECT source FROM supplier_payment_complements WHERE tenant_id = $1 AND cfdi_uuid = $2`,
    [tenantId, repUuid]))
  expect(comp[0].source).toBe('manual')
})

test('respaldo: el XML importado queda adjunto al gasto (categoría cfdi)', async () => {
  const uuid = 'ee000009-0000-0000-0000-000000000009'
  const res = await postImport()
    .attach('files', Buffer.from(cfdiXml({ uuid, folio: 'M9' })), 'respaldo.xml')
  expect(res.body.summary.created).toBe(1)

  const { rows } = await withBypass(() => query(
    `SELECT a.mime_type FROM attachments a
      JOIN supplier_invoices si ON si.id = a.entity_id
     WHERE a.entity_type = 'supplier_invoice' AND a.category = 'cfdi' AND si.uuid_sat = $1`,
    [uuid]))
  expect(rows).toHaveLength(1)
  expect(rows[0].mime_type).toContain('xml')
})

test('sin archivos → 400; zip sin XML/PDF → 422', async () => {
  const r1 = await postImport()
  expect(r1.status).toBe(400)

  const zb = zipBuf({ 'foto.jpg': 'JPG', 'nota.txt': 'hola' })
  const r2 = await postImport().attach('files', zb, { filename: 'cosas.zip', contentType: 'application/zip' })
  expect(r2.status).toBe(422)
})

test('sin sesión → 401', async () => {
  const res = await request(app)
    .post('/api/purchases/expenses/import')
    .set('X-Tenant-Slug', slug)
    .attach('files', Buffer.from(cfdiXml({ uuid: 'ee00000a-0000-0000-0000-00000000000a' })), 'x.xml')
  expect(res.status).toBe(401)
})
