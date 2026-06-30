'use strict'

/**
 * Reporte de ventas en PDF — humo de generación.
 *
 * Verifica que generateSalesPdf:
 *   - produce un PDF válido con datos (incluyendo una factura CONSOLIDADA, para
 *     ejercitar el desglose facturado/sin-factura),
 *   - NO truena con un periodo SIN ventas (tablas vacías, paginación).
 *
 * El contenido y los montos exactos se validan aparte con extracción de texto
 * (pdf-parse v2 usa pdfjs con import dinámico, incompatible con el VM de jest).
 */

const { createTenant, cleanupTestTenants } = require('../helpers/factory')
const { pool, query, withBypass } = require('../../src/db')
const { generateSalesPdf } = require('../../src/modules/reports/salesReportPdf')

let tenantId

describe('generateSalesPdf', () => {
  beforeAll(async () => {
    const t = await createTenant({ label: 'salespdf', planSlug: 'owner' })
    tenantId = t.tenant.id
  })
  afterAll(async () => { await cleanupTestTenants(); await pool.end() })

  const monthRange = () => {
    const from = new Date(); from.setUTCDate(1)
    const to = new Date(from); to.setUTCMonth(to.getUTCMonth() + 1)
    const fmt = d => d.toISOString().slice(0, 10)
    return { from: fmt(from), to: fmt(to) }
  }

  test('periodo SIN ventas → genera un PDF válido sin reventar', async () => {
    const { from, to } = monthRange()
    const buf = await generateSalesPdf({ tenantId, from, to })
    expect(Buffer.isBuffer(buf)).toBe(true)
    expect(buf.slice(0, 5).toString()).toBe('%PDF-')
    expect(buf.length).toBeGreaterThan(1500)
  })

  test('con ventas + factura consolidada → genera un PDF más grande', async () => {
    const cust = (await withBypass(() => query(
      `INSERT INTO business_partners (tenant_id, type, name, rfc)
       VALUES ($1, 'customer', 'Cliente PDF', 'XAXX010101000') RETURNING id`, [tenantId]))).rows[0].id
    const prod = (await withBypass(() => query(
      `INSERT INTO products (tenant_id, sku, name, type, base_unit, sale_unit)
       VALUES ($1, 'PDF-1', 'Producto PDF', 'resale', 'pza', 'pza') RETURNING id`, [tenantId]))).rows[0].id

    const dn = (await withBypass(() => query(
      `INSERT INTO delivery_notes (tenant_id, type, document_number, partner_id, total_mxn, subtotal_mxn, status, delivered_at, issue_date)
       VALUES ($1, 'sale', 'R-PDF', $2, 1500, 1500, 'delivered', NOW(), CURRENT_DATE) RETURNING id`,
      [tenantId, cust]))).rows[0].id
    await withBypass(() => query(
      `INSERT INTO delivery_note_lines (delivery_note_id, product_id, quantity_ordered, quantity_delivered, unit_price, line_number)
       VALUES ($1, $2, 15, 15, 100, 1)`, [dn, prod]))

    // Factura consolidada (delivery_note_id NULL + invoice_remissions).
    const inv = (await withBypass(() => query(
      `INSERT INTO invoices (tenant_id, type, cfdi_type, document_number, partner_id, status, stamp_date, subtotal, tax_transferred, total, total_mxn, delivery_note_id)
       VALUES ($1, 'issued', 'I', 'F-PDF', $2, 'stamped', NOW(), 1500, 240, 1740, 1740, NULL) RETURNING id`,
      [tenantId, cust]))).rows[0].id
    await withBypass(() => query(
      `INSERT INTO invoice_remissions (invoice_id, delivery_note_id) VALUES ($1, $2)`, [inv, dn]))

    const { from, to } = monthRange()
    const buf = await generateSalesPdf({ tenantId, from, to })
    expect(buf.slice(0, 5).toString()).toBe('%PDF-')
    expect(buf.length).toBeGreaterThan(4000)
  })
})
