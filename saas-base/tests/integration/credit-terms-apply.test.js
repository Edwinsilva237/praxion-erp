'use strict'

/**
 * Aplicar los días de crédito del socio a documentos ABIERTOS (recalcula el
 * vencimiento congelado). Verifica: recalcula facturas y remisiones abiertas,
 * NO toca pagadas, excluye notas de crédito, contado = vence el día de emisión,
 * y el conteo del preview.
 */

const { createTenant, loginAs, authedClient, cleanupTestTenants } = require('../helpers/factory')
const { pool, query, withBypass } = require('../../src/db')
const creditTerms = require('../../src/modules/financials/creditTermsService')

let tenantId, userId, partnerId, tenantSlug, httpToken

async function makePartner({ creditType = 'credit', creditDays = 0, supplierDays = null }) {
  const { rows } = await withBypass(() => query(
    `INSERT INTO business_partners (tenant_id, type, name, credit_type, credit_days, supplier_credit_days)
     VALUES ($1,'customer',$2,$3,$4,$5) RETURNING id`,
    [tenantId, 'Cliente Crédito', creditType, creditDays, supplierDays]))
  return rows[0].id
}

async function makeAR({ docType = 'invoice', number, issueDate, status = 'pending', dueDate = null }) {
  const { rows } = await withBypass(() => query(
    `INSERT INTO accounts_receivable
       (tenant_id, partner_id, document_type, document_id, document_number, amount_total, issue_date, due_date, status)
     VALUES ($1,$2,$3, gen_random_uuid(), $4, 100, $5, $6, $7) RETURNING id`,
    [tenantId, partnerId, docType, number, issueDate, dueDate, status]))
  return rows[0].id
}

async function dueOf(arId) {
  const { rows } = await withBypass(() => query(
    `SELECT to_char(due_date,'YYYY-MM-DD') AS d FROM accounts_receivable WHERE id = $1`, [arId]))
  return rows[0].d
}

beforeAll(async () => {
  const info = await createTenant({ label: 'creditterms', planSlug: 'owner' })
  tenantId = info.tenant.id
  userId = info.user.id
  tenantSlug = info.tenant.slug
  const auth = await loginAs({ slug: tenantSlug, email: info.email, password: info.password })
  httpToken = auth.token
})

afterAll(async () => { await cleanupTestTenants(); await pool.end() })

describe('applyCreditTerms — cliente (AR)', () => {
  let arInvoice, arRemission, arPaid, arCreditNote

  beforeAll(async () => {
    partnerId = await makePartner({ creditType: 'credit', creditDays: 30 })
    arInvoice    = await makeAR({ docType: 'invoice',     number: 'F-1', issueDate: '2026-06-01', status: 'pending', dueDate: null })
    arRemission  = await makeAR({ docType: 'remission',   number: 'R-1', issueDate: '2026-06-10', status: 'partial', dueDate: '2026-06-10' })
    arPaid       = await makeAR({ docType: 'invoice',     number: 'F-2', issueDate: '2026-06-01', status: 'paid',    dueDate: '2026-06-15' })
    arCreditNote = await makeAR({ docType: 'credit_note', number: 'NC-1', issueDate: '2026-06-01', status: 'pending', dueDate: null })
  })

  test('preview cuenta solo facturas y remisiones abiertas (excluye pagada y NC)', async () => {
    const impact = await creditTerms.previewCreditImpact({ tenantId, partnerId })
    expect(impact.customer.open_count).toBe(2)   // F-1 (pending) + R-1 (partial)
    expect(impact.partner.credit_days).toBe(30)
  })

  test('recalcula el vencimiento de los abiertos = emisión + días', async () => {
    const res = await creditTerms.applyCreditTerms({ tenantId, userId, partnerId, sides: ['customer'] })
    expect(res.customer_updated).toBe(2)
    expect(await dueOf(arInvoice)).toBe('2026-07-01')   // 2026-06-01 + 30
    expect(await dueOf(arRemission)).toBe('2026-07-10') // 2026-06-10 + 30
  })

  test('NO toca la pagada ni la nota de crédito', async () => {
    expect(await dueOf(arPaid)).toBe('2026-06-15')      // intacta
    expect(await dueOf(arCreditNote)).toBe(null)        // excluida
  })

  test('cambiar a contado deja el vencimiento el mismo día de emisión', async () => {
    await withBypass(() => query(
      `UPDATE business_partners SET credit_type='cash', credit_days=0 WHERE id=$1`, [partnerId]))
    const res = await creditTerms.applyCreditTerms({ tenantId, userId, partnerId, sides: ['customer'] })
    expect(res.customer_updated).toBe(2)
    expect(await dueOf(arInvoice)).toBe('2026-06-01')   // = emisión
    expect(await dueOf(arRemission)).toBe('2026-06-10')
  })
})

describe('rutas HTTP (business-partners) con permiso financials:update', () => {
  let client, httpPartnerId, arId

  beforeAll(async () => {
    client = authedClient({ slug: tenantSlug, token: httpToken })
    const p = await client.post('/api/business-partners', {
      type: 'customer', name: 'Cliente HTTP', creditType: 'credit', creditDays: 15,
    }).expect(201)
    httpPartnerId = p.body.id
    const ar = await withBypass(() => query(
      `INSERT INTO accounts_receivable
         (tenant_id, partner_id, document_type, document_id, document_number, amount_total, issue_date, status)
       VALUES ($1,$2,'invoice', gen_random_uuid(), 'FH-1', 100, '2026-06-01', 'pending') RETURNING id`,
      [tenantId, httpPartnerId]))
    arId = ar.rows[0].id
  })

  test('GET /credit-impact cuenta el documento abierto', async () => {
    const res = await client.get(`/api/business-partners/${httpPartnerId}/credit-impact`).expect(200)
    expect(res.body.customer.open_count).toBe(1)
  })

  test('POST /apply-credit-terms recalcula el vencimiento', async () => {
    const res = await client.post(`/api/business-partners/${httpPartnerId}/apply-credit-terms`, {
      sides: ['customer'],
    }).expect(200)
    expect(res.body.customer_updated).toBe(1)
    expect(await dueOf(arId)).toBe('2026-06-16')   // 2026-06-01 + 15
  })
})

describe('applyCreditTerms — validaciones', () => {
  test('sin lados → 400', async () => {
    await expect(creditTerms.applyCreditTerms({ tenantId, userId, partnerId, sides: [] }))
      .rejects.toThrow(/al menos un lado/i)
  })

  test('socio inexistente → 404', async () => {
    await expect(creditTerms.previewCreditImpact({ tenantId, partnerId: '00000000-0000-0000-0000-000000000000' }))
      .rejects.toThrow(/no encontrado/i)
  })
})
