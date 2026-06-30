'use strict'

/**
 * Reporte de inventario (valor y existencias a la fecha): datos + generación
 * de Excel y PDF (humo).
 */

const { createTenant, cleanupTestTenants } = require('../helpers/factory')
const { pool, query, withBypass } = require('../../src/db')
const { getInventoryReport } = require('../../src/modules/reports/inventoryReport')
const { generateInventoryWorkbook } = require('../../src/modules/reports/inventoryReportExcel')
const { generateInventoryPdf } = require('../../src/modules/reports/inventoryReportPdf')
const ExcelJS = require('exceljs')

let tenantId, fabrica, mp, prod, raw, prodZero

describe('Reporte de inventario', () => {
  beforeAll(async () => {
    const t = await createTenant({ label: 'invrep', planSlug: 'owner' })
    tenantId = t.tenant.id
    fabrica = (await withBypass(() => query(
      `INSERT INTO warehouses (tenant_id,name,type,is_active,is_default) VALUES ($1,'Fabrica','finished_product',true,true) RETURNING id`, [tenantId]))).rows[0].id
    mp = (await withBypass(() => query(
      `INSERT INTO warehouses (tenant_id,name,type,is_active,is_default) VALUES ($1,'MP','raw_material',true,true) RETURNING id`, [tenantId]))).rows[0].id
    prod = (await withBypass(() => query(
      `INSERT INTO products (tenant_id,sku,name,type,base_unit,sale_unit) VALUES ($1,'PRO-1','Esquinero negro','corner_protector','pieza','pieza') RETURNING id`, [tenantId]))).rows[0].id
    prodZero = (await withBypass(() => query(
      `INSERT INTO products (tenant_id,sku,name,type,base_unit,sale_unit) VALUES ($1,'PRO-2','Sin costo','corner_protector','pieza','pieza') RETURNING id`, [tenantId]))).rows[0].id
    raw = (await withBypass(() => query(
      `INSERT INTO raw_materials (tenant_id,code,name) VALUES ($1,'MP-1','Resina PE') RETURNING id`, [tenantId]))).rows[0].id

    await withBypass(() => query(
      `INSERT INTO inventory_stock (tenant_id,warehouse_id,item_type,item_id,status,quantity,unit,avg_cost) VALUES
         ($1,$2,'product',$3,'available',1000,'pieza',46.56),
         ($1,$4,'raw_material',$5,'available',500,'kg',32),
         ($1,$2,'product',$6,'available',200,'pieza',0)`,
      [tenantId, fabrica, prod, mp, raw, prodZero]))
  })
  afterAll(async () => { await cleanupTestTenants(); await pool.end() })

  test('datos: valor total, por almacén/tipo, alerta de costo $0', async () => {
    const r = await getInventoryReport({ tenantId })
    // 1000×46.56 + 500×32 + 200×0 = 46560 + 16000 = 62560
    expect(r.totals.total_value).toBeCloseTo(62560, 2)
    expect(r.totals.distinct_items).toBe(3)
    expect(r.totals.warehouses).toBe(2)

    const fab = r.by_warehouse.find(w => w.name === 'Fabrica')
    expect(fab.value).toBeCloseTo(46560, 2)

    const pt = r.by_warehouse_type.find(g => g.type === 'finished_product')
    expect(pt.value).toBeCloseTo(46560, 2)

    // El producto a costo $0 (con existencia) sale en alertas.
    expect(r.totals.zero_cost_count).toBe(1)
    expect(r.alerts.zero_cost[0].code).toBe('PRO-2')
  })

  test('Excel: 5 hojas con datos', async () => {
    const buf = await generateInventoryWorkbook({ tenantId, tenantName: 'Test SA' })
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(buf)
    expect(wb.worksheets.map(w => w.name)).toEqual(
      expect.arrayContaining(['Resumen', 'Por almacén', 'Por tipo', 'Detalle', 'Alertas']))
  })

  test('PDF: genera un documento válido', async () => {
    const buf = await generateInventoryPdf({ tenantId })
    expect(buf.slice(0, 5).toString()).toBe('%PDF-')
    expect(buf.length).toBeGreaterThan(3000)
  })
})
