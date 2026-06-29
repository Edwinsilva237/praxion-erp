'use strict'

/**
 * cxcService.listCXC: los agregados de las tarjetas (conteo + montos) se
 * calculan sobre TODA la cartera filtrada, no solo la página visible; y la
 * búsqueda libre es server-side (folio / cliente / RFC).
 */

const { createTenant, cleanupTestTenants } = require('../helpers/factory')
const { pool, query, withBypass } = require('../../src/db')
const cxcService = require('../../src/modules/financials/cxcService')

let tenantId, userId, partnerA, partnerB

async function newAR({ partnerId, number, total, paid = 0, due = 'CURRENT_DATE' }) {
  await withBypass(() => query(
    `INSERT INTO accounts_receivable
       (tenant_id, partner_id, document_type, document_id, document_number,
        currency, exchange_rate, amount_total, amount_paid, status, issue_date, due_date, created_by)
     VALUES ($1,$2,'remission',uuid_generate_v4(),$3,'MXN',1,$4,$5,$6,CURRENT_DATE,${due},$7)`,
    [tenantId, partnerId, number, total, paid,
     paid <= 0 ? 'pending' : (paid >= total ? 'paid' : 'partial'), userId]))
}

describe('listCXC — agregados y búsqueda', () => {
  beforeAll(async () => {
    const info = await createTenant({ label: 'cxclist', planSlug: 'owner' })
    tenantId = info.tenant.id
    userId   = info.user.id
    const { rows: a } = await withBypass(() => query(
      `INSERT INTO business_partners (tenant_id, type, name, rfc)
       VALUES ($1,'customer','ACME SA','ACM010101AAA') RETURNING id`, [tenantId]))
    partnerA = a[0].id
    const { rows: b } = await withBypass(() => query(
      `INSERT INTO business_partners (tenant_id, type, name, rfc)
       VALUES ($1,'customer','Beta SA','BET020202BBB') RETURNING id`, [tenantId]))
    partnerB = b[0].id

    // 3 docs de ACME (1000 c/u, uno con 400 pagado) + 1 de Beta (500).
    await newAR({ partnerId: partnerA, number: 'R-ACME-1', total: 1000 })
    await newAR({ partnerId: partnerA, number: 'R-ACME-2', total: 1000, paid: 400 })
    await newAR({ partnerId: partnerA, number: 'R-ACME-3', total: 1000, due: "CURRENT_DATE - 5" }) // vencido
    await newAR({ partnerId: partnerB, number: 'R-BETA-1', total: 500 })
  })

  afterAll(async () => { await cleanupTestTenants(); await pool.end() })

  test('los agregados cubren TODA la cartera aunque la página sea chica', async () => {
    const res = await cxcService.listCXC({ tenantId, page: 1, limit: 2 })
    expect(res.data).toHaveLength(2)              // página acotada
    expect(res.total).toBe(4)                     // conteo real
    expect(res.summary.total_invoiced).toBeCloseTo(3500, 2)  // 1000*3 + 500
    expect(res.summary.total_paid).toBeCloseTo(400, 2)
    expect(res.summary.total_pending).toBeCloseTo(3100, 2)   // 3500 - 400
    expect(res.summary.docs_overdue).toBe(1)
  })

  test('búsqueda server-side por cliente acota conteo y agregados', async () => {
    const res = await cxcService.listCXC({ tenantId, search: 'ACME', page: 1, limit: 50 })
    expect(res.total).toBe(3)
    expect(res.summary.total_invoiced).toBeCloseTo(3000, 2)
    expect(res.data.every(d => d.partner_name === 'ACME SA')).toBe(true)
  })

  test('búsqueda por folio encuentra el documento exacto', async () => {
    const res = await cxcService.listCXC({ tenantId, search: 'R-BETA-1', page: 1, limit: 50 })
    expect(res.total).toBe(1)
    expect(res.data[0].document_number).toBe('R-BETA-1')
  })

  test('búsqueda por RFC también funciona', async () => {
    const res = await cxcService.listCXC({ tenantId, search: 'BET020202', page: 1, limit: 50 })
    expect(res.total).toBe(1)
    expect(res.data[0].partner_name).toBe('Beta SA')
  })
})
