'use strict'

/**
 * Ingesta de correo entrante de facturas (mig 208 + modules/inbound).
 *
 * El Worker manda el adjunto → se rutea por token → candado RFC receptor →
 * match de proveedor por RFC emisor → alta de gasto con anti-dup por UUID.
 */

process.env.INBOUND_INGEST_SECRET = 'test-ingest-secret-123'

const request = require('supertest')
const app = require('../../src/app')
const { pool, query, withBypass } = require('../../src/db')
const inboundEmailService = require('../../src/modules/inbound/inboundEmailService')
const { createTenant, cleanupTestTenants } = require('../helpers/factory')

let tenantId, token, supplierId
const TENANT_RFC   = 'AAA010101AAA'
const SUPPLIER_RFC = 'PRO010101AB2'

// CFDI mínimo que el parser (documentParserService.parseXMLCFDI) sabe leer.
function cfdiXml({ uuid, folio = '555', receptorRfc = TENANT_RFC, emisorRfc = SUPPLIER_RFC, subtotal = 100, total = 116 }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" Serie="A" Folio="${folio}" Fecha="2026-06-10T12:00:00" SubTotal="${subtotal}" Moneda="MXN" Total="${total}">
  <cfdi:Emisor Rfc="${emisorRfc}" Nombre="Proveedor Correo SA" RegimenFiscal="601"/>
  <cfdi:Receptor Rfc="${receptorRfc}" Nombre="Tenant Test SA" UsoCFDI="G03"/>
  <cfdi:Conceptos>
    <cfdi:Concepto Cantidad="1" ClaveUnidad="E48" Descripcion="Servicio de flete" ValorUnitario="${subtotal}" Importe="${subtotal}"/>
  </cfdi:Conceptos>
  <cfdi:Complemento>
    <tfd:TimbreFiscalDigital xmlns:tfd="http://www.sat.gob.mx/TimbreFiscalDigital" UUID="${uuid}"/>
  </cfdi:Complemento>
</cfdi:Comprobante>`
}
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64')

beforeAll(async () => {
  const t = await createTenant({ label: 'inbound', planSlug: 'owner' })
  tenantId = t.tenant.id

  // Token del buzón (lo genera el DEFAULT de la mig 208).
  const { rows: tk } = await withBypass(() => query(
    `SELECT inbound_email_token FROM tenants WHERE id = $1`, [tenantId]))
  token = tk[0].inbound_email_token

  // RFC del tenant (receptor) — el candado lo compara.
  await withBypass(() => query(
    `INSERT INTO tenant_fiscal_profiles (tenant_id, rfc, tax_name, tax_regime, zip_code, is_active)
     VALUES ($1,$2,'TENANT TEST SA','601','12345',true)`,
    [tenantId, TENANT_RFC]))

  // Proveedor del catálogo con el RFC emisor → el gasto lo empareja.
  const { rows: bp } = await withBypass(() => query(
    `INSERT INTO business_partners (tenant_id, type, name, rfc) VALUES ($1,'supplier','Proveedor Correo SA',$2) RETURNING id`,
    [tenantId, SUPPLIER_RFC]))
  supplierId = bp[0].id
})

afterAll(async () => { await cleanupTestTenants(); await pool.end() })

test('token válido → crea el gasto y empareja al proveedor por RFC emisor', async () => {
  const r = await inboundEmailService.ingestInboundDocument({
    token, filename: 'factura.xml', mimetype: 'application/xml',
    contentBase64: b64(cfdiXml({ uuid: '11111111-2222-3333-4444-555555555555' })),
  })
  expect(r.status).toBe('created')
  expect(r.supplierMatched).toBe(true)

  const { rows } = await withBypass(() => query(
    `SELECT id, is_expense, partner_id, uuid_sat, total_mxn FROM supplier_invoices WHERE id = $1`, [r.expenseId]))
  expect(rows[0].is_expense).toBe(true)
  expect(rows[0].partner_id).toBe(supplierId)
  expect(rows[0].uuid_sat).toBe('11111111-2222-3333-4444-555555555555')
})

test('mismo UUID otra vez → duplicado (idempotente, no duplica)', async () => {
  const r = await inboundEmailService.ingestInboundDocument({
    token, filename: 'factura.xml', mimetype: 'application/xml',
    contentBase64: b64(cfdiXml({ uuid: '11111111-2222-3333-4444-555555555555' })),
  })
  expect(r.status).toBe('duplicate')
  const { rows } = await withBypass(() => query(
    `SELECT COUNT(*)::int AS n FROM supplier_invoices WHERE uuid_sat = $1`,
    ['11111111-2222-3333-4444-555555555555']))
  expect(rows[0].n).toBe(1)
})

test('RFC receptor que NO es del tenant → 403 (candado)', async () => {
  await expect(inboundEmailService.ingestInboundDocument({
    token, filename: 'ajena.xml', mimetype: 'application/xml',
    contentBase64: b64(cfdiXml({ uuid: '99999999-0000-0000-0000-999999999999', receptorRfc: 'ZZZ010101ZZ9' })),
  })).rejects.toMatchObject({ status: 403 })
})

test('token desconocido → 404', async () => {
  await expect(inboundEmailService.ingestInboundDocument({
    token: 'tokeninexistente00', filename: 'x.xml', mimetype: 'application/xml',
    contentBase64: b64(cfdiXml({ uuid: '22222222-2222-2222-2222-222222222222' })),
  })).rejects.toMatchObject({ status: 404 })
})

test('proveedor desconocido → gasto genérico (no se pierde)', async () => {
  const r = await inboundEmailService.ingestInboundDocument({
    token, filename: 'nuevo.xml', mimetype: 'application/xml',
    contentBase64: b64(cfdiXml({ uuid: '33333333-3333-3333-3333-333333333333', emisorRfc: 'XYZ010101XY8' })),
  })
  expect(r.status).toBe('created')
  expect(r.supplierMatched).toBe(false)
})

test('ruta POST /api/inbound/expense: sin secret → 401; con secret → 200', async () => {
  await request(app)
    .post('/api/inbound/expense')
    .send({ token, attachments: [] })
    .expect(401)

  const res = await request(app)
    .post('/api/inbound/expense')
    .set('X-Ingest-Secret', 'test-ingest-secret-123')
    .send({ token, from: 'proveedor@correo.mx', attachments: [
      { filename: 'ruta.xml', mimetype: 'application/xml',
        contentBase64: b64(cfdiXml({ uuid: '44444444-4444-4444-4444-444444444444', folio: '777' })) },
    ] })
  expect(res.status).toBe(200)
  expect(res.body.results[0].status).toBe('created')
})

// ── Paso 2: ver y rotar la dirección del buzón ──────────────────────────────

test('getInboxAddress: dirección = token@dominio y active=true (hay secret)', async () => {
  const info = await inboundEmailService.getInboxAddress(tenantId)
  expect(info.token).toBe(token)
  expect(info.address).toBe(`${token}@${info.domain}`)
  expect(info.active).toBe(true)   // INBOUND_INGEST_SECRET seteado al inicio del archivo
  // El trigger (mig 209) generó el formato legible <slug>.<6hex> para el tenant nuevo.
  expect(info.token).toMatch(/^[a-z0-9_-]+\.[0-9a-f]{6}$/)
})

test('rotateInboxToken: cambia el token, el nuevo rutea y el viejo deja de funcionar', async () => {
  const before  = await inboundEmailService.getInboxAddress(tenantId)
  const rotated = await inboundEmailService.rotateInboxToken(tenantId)
  expect(rotated.token).not.toBe(before.token)
  // Formato legible: <slug>.<6 hex>.
  expect(rotated.token).toMatch(/^[a-z0-9_-]+\.[0-9a-f]{6}$/)

  // El token viejo ya no rutea a ningún tenant → 404.
  await expect(inboundEmailService.ingestInboundDocument({
    token: before.token, filename: 'vieja.xml', mimetype: 'application/xml',
    contentBase64: b64(cfdiXml({ uuid: '55555555-5555-5555-5555-555555555555', folio: '888' })),
  })).rejects.toMatchObject({ status: 404 })

  // El token nuevo SÍ rutea y crea el gasto.
  const r = await inboundEmailService.ingestInboundDocument({
    token: rotated.token, filename: 'nueva.xml', mimetype: 'application/xml',
    contentBase64: b64(cfdiXml({ uuid: '66666666-6666-6666-6666-666666666666', folio: '889' })),
  })
  expect(r.status).toBe('created')
})

// ── Adjuntos comprimidos (.zip): los CFDI suelen llegar zippeados ───────────
const { zipSync, strToU8 } = require('fflate')
const zipB64 = (files) => {
  const entries = {}
  for (const [name, content] of Object.entries(files)) entries[name] = strToU8(content)
  return Buffer.from(zipSync(entries)).toString('base64')
}

describe('adjuntos comprimidos (.zip)', () => {
  let curToken
  beforeAll(async () => {
    // El test de rotación dejó el token global obsoleto → leer el vigente.
    const { rows } = await withBypass(() => query(
      `SELECT inbound_email_token FROM tenants WHERE id = $1`, [tenantId]))
    curToken = rows[0].inbound_email_token
  })

  test('expandAttachments: zip con XML+PDF → solo el XML (ignora el PDF redundante)', () => {
    const zb64 = zipB64({
      'factura.xml': cfdiXml({ uuid: 'aaaaaaaa-0000-0000-0000-000000000001', folio: 'Z1' }),
      'factura.pdf': '%PDF-1.4 contenido falso',
    })
    const out = inboundEmailService.expandAttachments([
      { filename: 'cfdi.zip', mimetype: 'application/zip', contentBase64: zb64 },
    ])
    expect(out).toHaveLength(1)
    expect(out[0].filename).toBe('factura.xml')
    expect(out[0].mimetype).toBe('application/xml')
  })

  test('expandAttachments: zip con dos XML → ambos; basura de macOS y no-CFDI se ignoran', () => {
    const zb64 = zipB64({
      'a.xml': '<x/>', 'b.xml': '<y/>',
      'logo.png': 'PNG', '__MACOSX/._a.xml': 'junk',
    })
    const out = inboundEmailService.expandAttachments([
      { filename: 'lote.zip', mimetype: 'application/octet-stream', contentBase64: zb64 },
    ])
    expect(out).toHaveLength(2)
    expect(out.every(a => a.filename.endsWith('.xml'))).toBe(true)
  })

  test('expandAttachments: zip solo con PDF → cae al PDF', () => {
    const zb64 = zipB64({ 'factura.pdf': '%PDF-1.4 x' })
    const out = inboundEmailService.expandAttachments([
      { filename: 'c.zip', mimetype: 'application/zip', contentBase64: zb64 },
    ])
    expect(out).toHaveLength(1)
    expect(out[0].mimetype).toBe('application/pdf')
  })

  test('expandAttachments: adjunto NO-zip se devuelve tal cual', () => {
    const att = { filename: 'f.xml', mimetype: 'application/xml', contentBase64: b64('<xml/>') }
    expect(inboundEmailService.expandAttachments([att])).toEqual([att])
  })

  test('ruta: un .zip con un CFDI XML → crea el gasto', async () => {
    const zb64 = zipB64({ 'factura.xml': cfdiXml({ uuid: 'aaaaaaaa-0000-0000-0000-000000000010', folio: 'ZIP1' }) })
    const res = await request(app)
      .post('/api/inbound/expense')
      .set('X-Ingest-Secret', 'test-ingest-secret-123')
      .send({ token: curToken, from: 'contador@correo.mx', attachments: [
        { filename: 'cfdi.zip', mimetype: 'application/zip', contentBase64: zb64 },
      ] })
    expect(res.status).toBe(200)
    expect(res.body.results[0].status).toBe('created')
  })

  test('ruta: zip sin XML/PDF (imágenes/notas) → 422 claro', async () => {
    const zb64 = zipB64({ 'foto.jpg': 'JPGDATA', 'nota.txt': 'hola' })
    const res = await request(app)
      .post('/api/inbound/expense')
      .set('X-Ingest-Secret', 'test-ingest-secret-123')
      .send({ token: curToken, attachments: [
        { filename: 'cosas.zip', mimetype: 'application/zip', contentBase64: zb64 },
      ] })
    expect(res.status).toBe(422)
  })
})
