'use strict'

const request = require('supertest')
const app = require('../../src/app')
const { createTenant, loginAs, cleanupTestTenants } = require('../helpers/factory')
const { pool, query, withBypass } = require('../../src/db')

describe('Factura ocasional (cliente + productos a mano)', () => {
  let tenant
  let session
  const auth = (req) => req
    .set('Authorization', `Bearer ${session.token}`)
    .set('X-Tenant-Slug', tenant.tenant.slug)

  beforeAll(async () => {
    tenant = await createTenant({ label: 'ocasional', planSlug: 'pro' })
    session = await loginAs({
      slug: tenant.tenant.slug, email: tenant.email, password: tenant.password,
    })
    // Perfil fiscal mínimo → genera la serie default para folios.
    await auth(request(app).post('/api/fiscal-profiles'))
      .send({ rfc: 'XAXX010101000', taxName: 'EMISOR TEST', taxRegime: '601', zipCode: '60014', serie: 'A' })
      .expect(201)
  })

  afterAll(async () => {
    await cleanupTestTenants()
    await pool.end()
  })

  test('crea factura con líneas a mano, respetando IVA por línea (0% y 16%)', async () => {
    const res = await auth(request(app).post('/api/invoicing/invoices/occasional'))
      .send({
        receptor: {
          rfc: 'CACX7605101P8', taxName: 'CLIENTE OCASIONAL SA DE CV',
          taxRegimeCode: '612', zipCode: '60014', cfdiUse: 'G03',
        },
        useCfdi: 'G03', paymentMethod: 'PUE', paymentForm: '01',
        lines: [
          // Aguacate — IVA tasa 0% (producto del campo).
          { description: 'Aguacate Hass', satProductCode: '50202200', satUnitCode: 'KGM',
            unit: 'kg', quantity: 100, unitPrice: 50, objetoImp: '02', taxFactor: 'Tasa', taxRate: 0 },
          // Servicio de empaque — IVA 16%.
          { description: 'Servicio de empaque', satProductCode: '80141600', satUnitCode: 'E48',
            unit: 'servicio', quantity: 1, unitPrice: 100, objetoImp: '02', taxFactor: 'Tasa', taxRate: 16 },
        ],
      })
      .expect(201)

    // Subtotal = 5000 + 100 = 5100. IVA solo de la línea 16% = 16. Total = 5116.
    expect(Number(res.body.subtotal)).toBeCloseTo(5100, 2)
    expect(Number(res.body.tax_transferred)).toBeCloseTo(16, 2)
    expect(Number(res.body.total)).toBeCloseTo(5116, 2)
    expect(res.body.status).toBe('draft')

    // Las líneas persistieron su tratamiento fiscal.
    const { rows: lines } = await withBypass(() => query(
      `SELECT description, tax_rate, tax_factor, objeto_imp, product_id
         FROM invoice_lines WHERE invoice_id = $1 ORDER BY line_number`,
      [res.body.id]
    ))
    expect(lines).toHaveLength(2)
    expect(lines[0].product_id).toBeNull()          // producto NO dado de alta
    expect(Number(lines[0].tax_rate)).toBe(0)        // aguacate 0%
    expect(Number(lines[1].tax_rate)).toBe(16)       // empaque 16%

    // Se generó cobranza (CXC).
    const { rows: ar } = await withBypass(() => query(
      `SELECT amount_total FROM accounts_receivable
        WHERE document_type = 'invoice' AND document_id = $1`,
      [res.body.id]
    ))
    expect(ar).toHaveLength(1)
    expect(Number(ar[0].amount_total)).toBeCloseTo(5116, 2)
  })

  test('crea el cliente por debajo, marcado como ocasional y oculto del catálogo', async () => {
    const { rows: bp } = await withBypass(() => query(
      `SELECT is_occasional, tax_name FROM business_partners
        WHERE tenant_id = $1 AND rfc = $2`,
      [tenant.tenant.id, 'CACX7605101P8']
    ))
    expect(bp).toHaveLength(1)
    expect(bp[0].is_occasional).toBe(true)

    // No aparece en el listado normal de socios…
    const hidden = await auth(request(app).get('/api/business-partners')).expect(200)
    expect(hidden.body.data.find(p => p.rfc === 'CACX7605101P8')).toBeUndefined()
    // …pero sí con includeOccasional=true.
    const shown = await auth(request(app).get('/api/business-partners?includeOccasional=true')).expect(200)
    expect(shown.body.data.find(p => p.rfc === 'CACX7605101P8')).toBeDefined()
  })

  test('reusa el cliente ocasional si el RFC ya existe (no duplica)', async () => {
    await auth(request(app).post('/api/invoicing/invoices/occasional'))
      .send({
        receptor: { rfc: 'CACX7605101P8', taxName: 'CLIENTE OCASIONAL SA DE CV', taxRegimeCode: '612', zipCode: '60014' },
        lines: [{ description: 'Otra venta', satProductCode: '50202200', satUnitCode: 'KGM', quantity: 1, unitPrice: 200, taxRate: 16 }],
      })
      .expect(201)

    const { rows } = await withBypass(() => query(
      `SELECT COUNT(*)::int AS n FROM business_partners WHERE tenant_id = $1 AND rfc = $2`,
      [tenant.tenant.id, 'CACX7605101P8']
    ))
    expect(rows[0].n).toBe(1)
  })

  test('público en general usa el RFC genérico XAXX010101000', async () => {
    const res = await auth(request(app).post('/api/invoicing/invoices/occasional'))
      .send({
        receptor: { publicoEnGeneral: true },
        useCfdi: 'S01',
        lines: [{ description: 'Venta de mostrador', satProductCode: '50202200', satUnitCode: 'H87', quantity: 1, unitPrice: 116, taxRate: 16 }],
      })
      .expect(201)
    expect(res.body.status).toBe('draft')

    const { rows } = await withBypass(() => query(
      `SELECT is_occasional FROM business_partners WHERE tenant_id = $1 AND rfc = 'XAXX010101000'`,
      [tenant.tenant.id]
    ))
    expect(rows.length).toBeGreaterThanOrEqual(1)
  })

  test('aplica retenciones ISR + IVA (honorarios) y las descuenta del total', async () => {
    const res = await auth(request(app).post('/api/invoicing/invoices/occasional'))
      .send({
        receptor: { rfc: 'CACX7605101P8', taxName: 'CLIENTE OCASIONAL SA DE CV', taxRegimeCode: '612', zipCode: '60014' },
        useCfdi: 'G03', paymentMethod: 'PUE', paymentForm: '03',
        lines: [
          { description: 'Honorarios profesionales', satProductCode: '84111506', satUnitCode: 'E48',
            unit: 'servicio', quantity: 1, unitPrice: 1000, objetoImp: '02', taxFactor: 'Tasa', taxRate: 16 },
        ],
        retentions: [
          { taxType: 'ISR', rate: 10 },        // 1000 * 10%   = 100
          { taxType: 'IVA', rate: 10.6667 },   // 1000 * 10.67% = 106.67
        ],
      })
      .expect(201)

    // Subtotal 1000, IVA 160, retenido 100 + 106.67 = 206.67, total = 953.33.
    expect(Number(res.body.subtotal)).toBeCloseTo(1000, 2)
    expect(Number(res.body.tax_transferred)).toBeCloseTo(160, 2)
    expect(Number(res.body.tax_withheld)).toBeCloseTo(206.67, 2)
    expect(Number(res.body.total)).toBeCloseTo(953.33, 2)

    // Se guardaron las 2 retenciones.
    const { rows: rets } = await withBypass(() => query(
      `SELECT tax_type, rate, amount FROM invoice_retentions WHERE invoice_id = $1 ORDER BY tax_type`,
      [res.body.id]
    ))
    expect(rets).toHaveLength(2)
    const isr = rets.find(r => r.tax_type === 'ISR')
    const iva = rets.find(r => r.tax_type === 'IVA')
    expect(Number(isr.amount)).toBeCloseTo(100, 2)
    expect(Number(iva.amount)).toBeCloseTo(106.67, 2)
  })

  test('rechaza factura sin conceptos', async () => {
    const res = await auth(request(app).post('/api/invoicing/invoices/occasional'))
      .send({ receptor: { publicoEnGeneral: true }, lines: [] })
      .expect(400)
    expect(res.body.error).toMatch(/concepto|línea/i)
  })
})
