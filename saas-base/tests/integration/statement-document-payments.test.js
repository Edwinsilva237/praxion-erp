'use strict'

/**
 * getDocumentPayments (estado de cuenta): plomería de resolución de pagos aplicados
 * por dirección. Las queries de pago (ar_payments / supplier_payment_applications)
 * ya están cubiertas en cxc/cxp; aquí cubrimos el enrutado por dirección, el caso
 * sin pagos y la dirección inválida.
 */

const { createTenant, cleanupTestTenants } = require('../helpers/factory')
const { pool } = require('../../src/db')
const { getDocumentPayments } = require('../../src/modules/reports/accountStatementReport')

const NOPE = '00000000-0000-0000-0000-000000000000'
let tenantId

describe('getDocumentPayments (estado de cuenta)', () => {
  beforeAll(async () => {
    const t = await createTenant({ label: 'stmtpays', planSlug: 'owner' })
    tenantId = t.tenant.id
  })
  afterAll(async () => { await cleanupTestTenants(); await pool.end() })

  test('docId sin pagos → { payments: [] } (out)', async () => {
    const r = await getDocumentPayments({ tenantId, direction: 'out', docId: NOPE })
    expect(r).toEqual({ payments: [] })
  })

  test('docId sin pagos → { payments: [] } (in)', async () => {
    const r = await getDocumentPayments({ tenantId, direction: 'in', docId: NOPE })
    expect(r).toEqual({ payments: [] })
  })

  test('dirección inválida lanza error', async () => {
    await expect(getDocumentPayments({ tenantId, direction: 'xxx', docId: NOPE }))
      .rejects.toThrow(/direction/i)
  })
})
