'use strict'

/**
 * Reporte de ventas con MÉTODO DASHBOARD (universo: facturas timbradas + remisiones
 * no facturadas, sin IVA). Verifica que:
 *   - el total del reporte = total del dashboard SIN IVA (facturado_subtotal + sin factura),
 *   - by_customer y by_product SUMAN ese total,
 *   - una factura DIRECTA sin remisión SÍ aparece en las listas (antes no),
 *   - el margen (precio − costo) se conserva por producto.
 */

const { createTenant, cleanupTestTenants } = require('../helpers/factory')
const { pool, query, withBypass, withTransaction } = require('../../src/db')
const inventoryService = require('../../src/modules/inventory/inventoryService')
const { getSalesReport } = require('../../src/modules/reports/salesReport')

let tenantId, userId, partnerId, productId

describe('Reporte de ventas — método dashboard (universo sin IVA + margen)', () => {
  beforeAll(async () => {
    const t = await createTenant({ label: 'repuniv', planSlug: 'owner' })
    tenantId = t.tenant.id
    userId = t.user.id
    partnerId = (await withBypass(() => query(
      `INSERT INTO business_partners (tenant_id,type,name) VALUES ($1,'customer','Cli') RETURNING id`, [tenantId]))).rows[0].id
    productId = (await withBypass(() => query(
      `INSERT INTO products (tenant_id,sku,name,type,base_unit,sale_unit) VALUES ($1,'S1','Prod','resale','pza','pza') RETURNING id`, [tenantId]))).rows[0].id
    const wh = (await withBypass(() => query(
      `INSERT INTO warehouses (tenant_id,name,type,is_active) VALUES ($1,'PT','finished_product',true) RETURNING id`, [tenantId]))).rows[0].id
    // Costo: compra reciente unit_cost 50 → margen calculable.
    await withTransaction(c => inventoryService.recordMovement(c, {
      tenantId, warehouseId: wh, itemType: 'product', itemId: productId,
      movementType: 'purchase_entry', quantity: 100, unit: 'pza', unitCost: 50,
      statusTo: 'available', notes: 'x', createdBy: userId,
    }))

    const mkDN = async (num, sub, soLine) => {
      const dn = (await withBypass(() => query(
        `INSERT INTO delivery_notes (tenant_id,type,document_number,partner_id,total_mxn,subtotal_mxn,status,delivered_at,issue_date)
         VALUES ($1,'sale',$2,$3,$4,$4,'delivered',NOW(),CURRENT_DATE) RETURNING id`, [tenantId, num, partnerId, sub]))).rows[0].id
      await withBypass(() => query(
        `INSERT INTO delivery_note_lines (delivery_note_id,product_id,quantity_ordered,quantity_delivered,quantity_base,unit_price,line_number,sales_order_line_id)
         VALUES ($1,$2,1,1,1,$3,1,$4)`, [dn, productId, sub, soLine || null]))
      return dn
    }
    const mkInv = async (num, sub, dnId, withLine, soLine) => {
      const i = (await withBypass(() => query(
        `INSERT INTO invoices (tenant_id,type,cfdi_type,document_number,partner_id,status,stamp_date,subtotal,tax_transferred,total,total_mxn,delivery_note_id)
         VALUES ($1,'issued','I',$2,$3,'stamped',NOW(),$4,$5,$6,$6,$7) RETURNING id`,
        [tenantId, num, partnerId, sub, sub * 0.16, sub * 1.16, dnId || null]))).rows[0].id
      if (withLine) await withBypass(() => query(
        `INSERT INTO invoice_lines (invoice_id,product_id,description,quantity,quantity_base,unit,unit_price,tax_rate,sat_product_code,sat_unit_code,line_number,sales_order_line_id)
         VALUES ($1,$2,'P',1,1,'pza',$3,16,'01','H87',1,$4)`, [i, productId, sub, soLine || null]))
      return i
    }

    // consolidada (remisión 1000)
    const dnC = await mkDN('R-C', 1000); const iC = await mkInv('F-C', 1000, null, true)
    await withBypass(() => query(`INSERT INTO invoice_remissions (invoice_id,delivery_note_id) VALUES ($1,$2)`, [iC, dnC]))
    // anticipada (factura directa 700 + remisión ligada por sales_order_line_id)
    const ord = (await withBypass(() => query(
      `INSERT INTO sales_orders (tenant_id,order_number,partner_id,status,currency,subtotal_mxn,tax_mxn,total_mxn,direct_invoice,created_by)
       VALUES ($1,'OV',$2,'confirmed','MXN',700,112,812,true,$3) RETURNING id`, [tenantId, partnerId, userId]))).rows[0].id
    const ol = (await withBypass(() => query(
      `INSERT INTO sales_order_lines (sales_order_id,product_id,quantity,unit,unit_price,currency,line_number)
       VALUES ($1,$2,1,'pza',700,'MXN',1) RETURNING id`, [ord, productId]))).rows[0].id
    await mkInv('F-ANT', 700, null, true, ol); await mkDN('R-ANT', 700, ol)
    // directa SIN remisión (2000)
    await mkInv('F-DIR', 2000, null, true)
    // sin factura (300)
    await mkDN('R-SF', 300)
  })

  afterAll(async () => { await cleanupTestTenants(); await pool.end() })

  test('total = dashboard sin IVA; listas suman; directa incluida; margen presente', async () => {
    const rep = await getSalesReport({ tenantId, from: '2026-06-01', to: '2026-07-01' })
    const snap = rep.sales_snapshot

    // Universo sin IVA = facturado_subtotal (3700) + sin factura (300) = 4000.
    expect(rep.totals_current.revenue).toBeCloseTo(snap.invoiced_subtotal + snap.uninvoiced, 2)
    expect(rep.totals_current.revenue).toBeCloseTo(4000, 2)

    // Las listas suman el total.
    expect(rep.by_customer.reduce((s, c) => s + c.revenue, 0)).toBeCloseTo(4000, 2)
    expect(rep.by_product.reduce((s, p) => s + p.revenue, 0)).toBeCloseTo(4000, 2)

    // Split: facturado 3700 (consol 1000 + anticip 700 + directa 2000), sin factura 300.
    const c = rep.by_customer[0]
    expect(c.invoiced_revenue).toBeCloseTo(3700, 2)
    expect(c.uninvoiced_revenue).toBeCloseTo(300, 2)

    // Margen presente (precio − costo). 4 líneas × 1 × $50 = $200 de costo.
    const p = rep.by_product[0]
    expect(p.estimated_cost).toBeCloseTo(200, 2)
    expect(p.estimated_margin).toBeCloseTo(3800, 2)

    // El snapshot con IVA que viaja al encabezado coincide con el del dashboard.
    expect(snap.total).toBeCloseTo(snap.invoiced + snap.uninvoiced, 2)
  })
})
