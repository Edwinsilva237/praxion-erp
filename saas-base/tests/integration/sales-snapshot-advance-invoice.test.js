'use strict'

/**
 * Dashboard "Acumulado del mes" — venta ANTICIPADA no se cuenta doble.
 *
 * Flujo: el pedido se factura DIRECTO (factura con delivery_note_id NULL, NO
 * consolidada, líneas ligadas por sales_order_line_id) y DESPUÉS se entregan
 * remisiones. La venta es la factura (al timbrado); sus remisiones son solo
 * fulfillment y NO deben sumar otra vez en "sin factura".
 *
 * Bug (reportado 2026-06-30): financialSnapshot solo excluía remisiones ligadas
 * por delivery_note_id o invoice_remissions; le faltaba la 3ª rama (anticipada
 * vía sales_order_line_id) → la remisión se contaba en "sin factura" además de
 * su factura → total inflado. + verifica el desglose de IVA del facturado.
 */

const { createTenant, cleanupTestTenants } = require('../helpers/factory')
const { pool, query, withBypass } = require('../../src/db')
const { getFinancialSnapshot } = require('../../src/modules/reports/financialSnapshot')

let tenantId, userId, partnerId, productId

describe('financialSnapshot — venta anticipada sin doble conteo', () => {
  beforeAll(async () => {
    const t = await createTenant({ label: 'advsnap', planSlug: 'owner' })
    tenantId = t.tenant.id
    userId = t.user.id
    partnerId = (await withBypass(() => query(
      `INSERT INTO business_partners (tenant_id,type,name) VALUES ($1,'customer','Cli') RETURNING id`, [tenantId]))).rows[0].id
    productId = (await withBypass(() => query(
      `INSERT INTO products (tenant_id,sku,name,type,base_unit,sale_unit) VALUES ($1,'A1','P','resale','pza','pza') RETURNING id`, [tenantId]))).rows[0].id

    // Pedido + factura ANTICIPADA (subtotal 1000 + IVA 160), timbrada este mes.
    const ord = (await withBypass(() => query(
      `INSERT INTO sales_orders (tenant_id,order_number,partner_id,status,currency,subtotal_mxn,tax_mxn,total_mxn,direct_invoice,created_by)
       VALUES ($1,'OV-1',$2,'confirmed','MXN',1000,160,1160,true,$3) RETURNING id`, [tenantId, partnerId, userId]))).rows[0].id
    const oline = (await withBypass(() => query(
      `INSERT INTO sales_order_lines (sales_order_id,product_id,quantity,unit,unit_price,currency,line_number)
       VALUES ($1,$2,10,'pza',100,'MXN',1) RETURNING id`, [ord, productId]))).rows[0].id
    const inv = (await withBypass(() => query(
      `INSERT INTO invoices (tenant_id,type,cfdi_type,document_number,partner_id,status,stamp_date,subtotal,tax_transferred,total,total_mxn,delivery_note_id)
       VALUES ($1,'issued','I','FAC-ANT',$2,'stamped',NOW(),1000,160,1160,1160,NULL) RETURNING id`, [tenantId, partnerId]))).rows[0].id
    await withBypass(() => query(
      `INSERT INTO invoice_lines (invoice_id,product_id,description,quantity,unit,unit_price,tax_rate,sat_product_code,sat_unit_code,line_number,sales_order_line_id)
       VALUES ($1,$2,'P',10,'pza',100,16,'44102305','H87',1,$3)`, [inv, productId, oline]))

    // Entrega parcial: remisión de este mes ligada al pedido (sales_order_line_id).
    const dn = (await withBypass(() => query(
      `INSERT INTO delivery_notes (tenant_id,type,document_number,partner_id,status,currency,total_mxn,subtotal_mxn,delivered_at,issue_date,sales_order_id)
       VALUES ($1,'sale','REM-ANT',$2,'delivered','MXN',500,500,NOW(),CURRENT_DATE,$3) RETURNING id`, [tenantId, partnerId, ord]))).rows[0].id
    await withBypass(() => query(
      `INSERT INTO delivery_note_lines (delivery_note_id,product_id,quantity_ordered,quantity_delivered,unit_price,line_number,sales_order_line_id)
       VALUES ($1,$2,5,5,100,1,$3)`, [dn, productId, oline]))
  })

  afterAll(async () => { await cleanupTestTenants(); await pool.end() })

  test('la remisión de la venta anticipada NO se cuenta en "sin factura"', async () => {
    const yyyymm = new Date().toISOString().slice(0, 7)
    const s = (await getFinancialSnapshot({ tenantId, month: yyyymm })).sales

    expect(s.invoiced).toBeCloseTo(1160, 2)          // la factura anticipada (con IVA)
    expect(s.uninvoiced).toBeCloseTo(0, 2)           // ← antes 500 (doble conteo)
    expect(s.total).toBeCloseTo(1160, 2)             // la venta se cuenta UNA vez

    // IVA desglosado del facturado.
    expect(s.invoiced_subtotal).toBeCloseTo(1000, 2)
    expect(s.invoiced_iva).toBeCloseTo(160, 2)
  })
})
