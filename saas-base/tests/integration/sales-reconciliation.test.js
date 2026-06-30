'use strict'

/**
 * Conciliación Dashboard vs Reporte de ventas (getSalesReconciliation).
 *
 * El "Acumulado del mes" del dashboard (facturas timbradas CON IVA + remisiones
 * sin factura) difiere de "Ventas del periodo" del reporte (remisiones del mes
 * SIN IVA). Esta conciliación descompone el facturado del dashboard por origen
 * para aislar en pesos exactos las dos causas: IVA y diferencia de base/fecha.
 */

const { createTenant, cleanupTestTenants } = require('../helpers/factory')
const { pool, query, withBypass } = require('../../src/db')
const { getSalesReconciliation } = require('../../src/modules/reports/salesReport')

let tenantId, cust, prod

const mkDN = async (num, deliveredAt, subtotal) => {
  const dn = (await withBypass(() => query(
    `INSERT INTO delivery_notes (tenant_id,type,document_number,partner_id,total_mxn,subtotal_mxn,status,delivered_at,issue_date)
     VALUES ($1,'sale',$2,$3,$4,$4,'delivered',$5::timestamptz,$5::date) RETURNING id`,
    [tenantId, num, cust, subtotal, deliveredAt]))).rows[0].id
  await withBypass(() => query(
    `INSERT INTO delivery_note_lines (delivery_note_id,product_id,quantity_ordered,quantity_delivered,unit_price,line_number)
     VALUES ($1,$2,1,1,$3,1)`, [dn, prod, subtotal]))
  return dn
}
const mkInv = async (num, sub, dnId) => (await withBypass(() => query(
  `INSERT INTO invoices (tenant_id,type,cfdi_type,document_number,partner_id,status,stamp_date,subtotal,tax_transferred,total,total_mxn,delivery_note_id)
   VALUES ($1,'issued','I',$2,$3,'stamped',NOW(),$4,$5,$6,$6,$7) RETURNING id`,
  [tenantId, num, cust, sub, sub * 0.16, sub * 1.16, dnId || null]))).rows[0].id

describe('getSalesReconciliation', () => {
  beforeAll(async () => {
    const t = await createTenant({ label: 'recon', planSlug: 'owner' })
    tenantId = t.tenant.id
    cust = (await withBypass(() => query(
      `INSERT INTO business_partners (tenant_id,type,name,rfc) VALUES ($1,'customer','Cli','XAXX010101000') RETURNING id`,
      [tenantId]))).rows[0].id
    prod = (await withBypass(() => query(
      `INSERT INTO products (tenant_id,sku,name,type,base_unit,sale_unit) VALUES ($1,'S1','P1','resale','pza','pza') RETURNING id`,
      [tenantId]))).rows[0].id

    // mes: remisión del periodo (1000) facturada CONSOLIDADA
    const dnMes = await mkDN('R-MES', '2026-06-10', 1000)
    const invMes = await mkInv('F-MES', 1000, null)
    await withBypass(() => query(`INSERT INTO invoice_remissions (invoice_id,delivery_note_id) VALUES ($1,$2)`, [invMes, dnMes]))
    // previa: remisión de MAYO (500) facturada en junio (liga directa)
    const dnPrev = await mkDN('R-PREV', '2026-05-15', 500)
    await mkInv('F-PREV', 500, dnPrev)
    // directa: factura sin remisión (2000)
    await mkInv('F-DIR', 2000, null)
    // sin factura: remisión del periodo (300)
    await mkDN('R-SF', '2026-06-20', 300)
  })

  afterAll(async () => { await cleanupTestTenants(); await pool.end() })

  test('descompone el facturado del dashboard por origen y el puente cuadra', async () => {
    const r = await getSalesReconciliation({ tenantId, from: '2026-06-01', to: '2026-07-01' })

    // Reporte: solo remisiones de junio, sin IVA.
    expect(r.report.total).toBeCloseTo(1300, 2)       // 1000 facturada + 300 sin factura
    expect(r.report.invoiced).toBeCloseTo(1000, 2)
    expect(r.report.uninvoiced).toBeCloseTo(300, 2)

    // Dashboard: facturado CON IVA (3 facturas) + sin factura.
    expect(r.dashboard.invoiced_with_iva).toBeCloseTo(4060, 2)  // 1160 + 580 + 2320
    expect(r.dashboard.invoiced_count).toBe(3)
    expect(r.dashboard.uninvoiced).toBeCloseTo(300, 2)

    // Buckets.
    expect(r.invoiced_buckets.mes).toMatchObject({ num: 1 })
    expect(r.invoiced_buckets.mes.subtotal_mxn).toBeCloseTo(1000, 2)
    expect(r.invoiced_buckets.mes.iva_mxn).toBeCloseTo(160, 2)
    expect(r.invoiced_buckets.previa.subtotal_mxn).toBeCloseTo(500, 2)
    expect(r.invoiced_buckets.directa.subtotal_mxn).toBeCloseTo(2000, 2)
    expect(r.invoiced_buckets.posterior.num).toBe(0)

    // Los buckets suman EXACTAMENTE el facturado del dashboard.
    const sumBuckets = ['mes', 'previa', 'directa', 'posterior']
      .reduce((s, k) => s + r.invoiced_buckets[k].total_mxn, 0)
    expect(sumBuckets).toBeCloseTo(r.dashboard.invoiced_with_iva, 2)

    // Puente: facturado del periodo (sin IVA) + sin factura = total del reporte.
    const equiv = r.invoiced_buckets.mes.subtotal_mxn + r.dashboard.uninvoiced
    expect(equiv).toBeCloseTo(r.report.total, 2)  // residual 0 en el caso limpio
  })
})
