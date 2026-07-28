'use strict'

/**
 * Notas de crédito: serie PROPIA + vínculo a la factura origen (mig 237).
 *
 * Bug que cubre: al emitir una NC sin serie tipo E configurada, la numeración
 * caía a la serie DEFAULT de facturas (la NC salía "A-0044" y consumía el
 * folio de facturas). Ahora se auto-crea una serie "NC" tipo E por perfil
 * fiscal, la NC guarda related_invoice_id, el detalle de la factura la lista
 * por ese vínculo y la lista de facturación se puede filtrar por cfdi_type.
 */

// Facturapi se mockea: el timbrado real vive fuera del alcance del test.
jest.mock('../../src/modules/invoicing/facturapiClient', () => ({
  getFacturapiForTenant: jest.fn(async () => ({
    invoices: {
      create: jest.fn(async () => ({
        id: `fap-${Math.random().toString(36).slice(2, 10)}`,
        uuid: require('crypto').randomUUID(),
        verification_url: 'https://verificacfdi.example/x',
      })),
    },
  })),
}))

const { createTenant, cleanupTestTenants } = require('../helpers/factory')
const { pool, query, withBypass } = require('../../src/db')
const creditNoteService = require('../../src/modules/invoicing/creditNoteService')
const invoiceService = require('../../src/modules/invoicing/invoiceService')

let tenantId, userId, partnerId, fiscalProfileId, invoiceSeriesId

async function makeStampedInvoice(docNumber, total = 1160) {
  const { rows } = await withBypass(() => query(
    `INSERT INTO invoices (tenant_id, type, cfdi_type, document_number, fiscal_profile_id,
                           partner_id, status, total, total_mxn, subtotal, cfdi_uuid, issue_date)
     VALUES ($1,'issued','I',$2,$3,$4,'stamped',$5,$5,$6,gen_random_uuid(),CURRENT_DATE)
     RETURNING id, document_number`,
    [tenantId, docNumber, fiscalProfileId, partnerId, total, total / 1.16]))
  return rows[0]
}

beforeAll(async () => {
  const t = await createTenant({ label: 'ncseries', planSlug: 'owner' })
  tenantId = t.tenant.id; userId = t.user.id

  const bp = await withBypass(() => query(
    `INSERT INTO business_partners (tenant_id, type, name, rfc)
     VALUES ($1,'customer','Cliente NC','XAXX010101000') RETURNING id`, [tenantId]))
  partnerId = bp.rows[0].id

  const fp = await withBypass(() => query(
    `INSERT INTO tenant_fiscal_profiles (tenant_id, rfc, tax_name, tax_regime, zip_code)
     VALUES ($1,'XAXX010101000','NC SERIES SA','601','60000') RETURNING id`, [tenantId]))
  fiscalProfileId = fp.rows[0].id

  // Serie DEFAULT de FACTURAS (la que el bug consumía por error).
  const s = await withBypass(() => query(
    `INSERT INTO tenant_document_series
       (tenant_id, entity_type, fiscal_profile_id, serie, folio_next, cfdi_type, is_default, is_active)
     VALUES ($1,'invoice',$2,'A',50,NULL,TRUE,TRUE) RETURNING id`, [tenantId, fiscalProfileId]))
  invoiceSeriesId = s.rows[0].id
})
afterAll(async () => { await cleanupTestTenants(); await pool.end() })

test('la NC auto-crea su serie "NC" tipo E y NO consume la serie de facturas', async () => {
  const inv = await makeStampedInvoice('A-0049')

  const cn = await creditNoteService.createCreditNote({
    tenantId, invoiceId: inv.id, reason: 'return',
    description: 'Devolución', amount: 100, paymentForm: '03', userId,
  })
  expect(cn.document_number).toBe('NC-0001')

  // La serie E quedó creada y la de facturas intacta (folio_next sigue en 50).
  const { rows: eSeries } = await withBypass(() => query(
    `SELECT serie, cfdi_type, folio_next FROM tenant_document_series
      WHERE tenant_id = $1 AND cfdi_type = 'E'`, [tenantId]))
  expect(eSeries).toHaveLength(1)
  expect(eSeries[0].serie).toBe('NC')
  expect(eSeries[0].folio_next).toBe(2)
  const { rows: invSeries } = await withBypass(() => query(
    `SELECT folio_next FROM tenant_document_series WHERE id = $1`, [invoiceSeriesId]))
  expect(invSeries[0].folio_next).toBe(50)

  // Vínculo explícito a la factura origen + uso CFDI de egreso (G02) por default.
  const { rows: cnRow } = await withBypass(() => query(
    `SELECT related_invoice_id, use_cfdi, tax_transferred, total FROM invoices WHERE id = $1`, [cn.id]))
  expect(cnRow[0].related_invoice_id).toBe(inv.id)
  expect(cnRow[0].use_cfdi).toBe('G02')
  expect(parseFloat(cnRow[0].tax_transferred)).toBeCloseTo(16, 2)   // 100 al 16%
  expect(parseFloat(cnRow[0].total)).toBeCloseTo(116, 2)

  // Segunda NC de la MISMA factura: folio consecutivo de la serie NC.
  const cn2 = await creditNoteService.createCreditNote({
    tenantId, invoiceId: inv.id, reason: 'discount', amount: 50, userId,
  })
  expect(cn2.document_number).toBe('NC-0002')

  // El detalle de la factura lista ambas por el vínculo (ya sin depender
  // del prefijo legacy "NC-{folio}").
  const det = await invoiceService.getInvoice({ tenantId, invoiceId: inv.id })
  expect(det.creditNotes.map(c => c.document_number).sort())
    .toEqual(['NC-0001', 'NC-0002'])
})

test('si el tenant ya configuró una serie tipo E, se respeta', async () => {
  // Simular tenant con serie E propia (borra la auto-creada del test anterior
  // y pone una con otro código).
  await withBypass(() => query(
    `UPDATE tenant_document_series SET serie = 'DEV', folio_next = 7
      WHERE tenant_id = $1 AND cfdi_type = 'E'`, [tenantId]))

  const inv = await makeStampedInvoice('A-0050')
  const cn = await creditNoteService.createCreditNote({
    tenantId, invoiceId: inv.id, reason: 'correction', amount: 10, userId,
  })
  expect(cn.document_number).toBe('DEV-0007')
})

test('taxRate editado en el formulario: 0% deja total = monto y valida tasas', async () => {
  const inv = await makeStampedInvoice('A-0051')
  const cn = await creditNoteService.createCreditNote({
    tenantId, invoiceId: inv.id, reason: 'return', amount: 200, taxRate: 0, useCfdi: 'S01', userId,
  })
  const { rows } = await withBypass(() => query(
    `SELECT total, tax_transferred, use_cfdi FROM invoices WHERE id = $1`, [cn.id]))
  expect(parseFloat(rows[0].total)).toBeCloseTo(200, 2)
  expect(parseFloat(rows[0].tax_transferred)).toBeCloseTo(0, 2)
  expect(rows[0].use_cfdi).toBe('S01')

  await expect(creditNoteService.createCreditNote({
    tenantId, invoiceId: inv.id, reason: 'return', amount: 10, taxRate: 11, userId,
  })).rejects.toMatchObject({ status: 400 })
})

test('listInvoices separa por cfdi_type: I sin NCs, E solo NCs con factura origen', async () => {
  const onlyInvoices = await invoiceService.listInvoices({ tenantId, cfdiType: 'I' })
  expect(onlyInvoices.data.every(r => r.cfdi_type === 'I')).toBe(true)

  const onlyNcs = await invoiceService.listInvoices({ tenantId, cfdiType: 'E' })
  expect(onlyNcs.data.length).toBeGreaterThanOrEqual(3)
  expect(onlyNcs.data.every(r => r.cfdi_type === 'E')).toBe(true)
  // Cada NC trae el folio de su factura origen para la pantalla nueva.
  expect(onlyNcs.data.every(r => r.related_invoice_number)).toBe(true)

  // Sin filtro: comportamiento previo (mezclada) — compatibilidad.
  const mixed = await invoiceService.listInvoices({ tenantId })
  const types = new Set(mixed.data.map(r => r.cfdi_type))
  expect(types.has('I') && types.has('E')).toBe(true)
})
