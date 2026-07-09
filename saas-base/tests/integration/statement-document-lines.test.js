'use strict'

/**
 * getDocumentLines (estado de cuenta): plomería de resolución de líneas por
 * dirección. La query de líneas CxP es la misma probada en getCXP; aquí cubrimos
 * el enrutado por dirección y el caso sin documento.
 */

const { createTenant, cleanupTestTenants } = require('../helpers/factory')
const { pool } = require('../../src/db')
const { getDocumentLines } = require('../../src/modules/reports/accountStatementReport')

let tenantId

describe('getDocumentLines (estado de cuenta)', () => {
  beforeAll(async () => {
    const t = await createTenant({ label: 'stmtlines', planSlug: 'owner' })
    tenantId = t.tenant.id
  })
  afterAll(async () => { await cleanupTestTenants(); await pool.end() })

  test('docId inexistente → { lines: [] } (out)', async () => {
    const r = await getDocumentLines({ tenantId, direction: 'out', docId: '00000000-0000-0000-0000-000000000000' })
    expect(r).toEqual({ lines: [] })
  })

  test('docId inexistente → { lines: [] } (in)', async () => {
    const r = await getDocumentLines({ tenantId, direction: 'in', docId: '00000000-0000-0000-0000-000000000000' })
    expect(r).toEqual({ lines: [] })
  })

  test('dirección inválida lanza error', async () => {
    await expect(getDocumentLines({ tenantId, direction: 'xxx', docId: '00000000-0000-0000-0000-000000000000' }))
      .rejects.toThrow(/direction/i)
  })
})
