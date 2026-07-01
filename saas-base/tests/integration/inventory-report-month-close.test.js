'use strict'

/**
 * Reporte de inventario AL CIERRE DE MES (getInventoryReport con countId).
 * Reconstruye el inventario valorizado desde la foto de inventory_count_lines:
 *   - cantidad final = física si se capturó; si la línea no se contó, la del sistema
 *   - costo = system_avg_cost, o captured_unit_cost si el sistema estaba en $0
 */

const { createTenant, cleanupTestTenants } = require('../helpers/factory')
const { pool, query, withBypass } = require('../../src/db')
const { getInventoryReport } = require('../../src/modules/reports/inventoryReport')
const { generateInventoryWorkbook } = require('../../src/modules/reports/inventoryReportExcel')
const { generateInventoryPdf } = require('../../src/modules/reports/inventoryReportPdf')

let tenantId, whFab, whDist, prodA, prodB

async function mkWarehouse(name, type) {
  return (await withBypass(() => query(
    `INSERT INTO warehouses (tenant_id,name,type,is_active,is_default)
     VALUES ($1,$2,$3,true,false) RETURNING id`, [tenantId, name, type]))).rows[0].id
}
async function mkProduct(sku, name) {
  return (await withBypass(() => query(
    `INSERT INTO products (tenant_id,sku,name,type,base_unit,sale_unit)
     VALUES ($1,$2,$3,'resale','pieza','pieza') RETURNING id`, [tenantId, sku, name]))).rows[0].id
}

// Crea un conteo con sus líneas (raw insert; probamos SOLO la reconstrucción del reporte).
async function mkCount({ number, scope = 'all', status = 'applied', lines }) {
  const cid = (await withBypass(() => query(
    `INSERT INTO inventory_counts (tenant_id,count_number,count_type,scope,count_date,status,applied_at)
     VALUES ($1,$2,'month_close',$3,CURRENT_DATE,$4,NOW()) RETURNING id`,
    [tenantId, number, scope, status]))).rows[0].id
  for (const l of lines) {
    await withBypass(() => query(
      `INSERT INTO inventory_count_lines
         (count_id,item_type,item_id,warehouse_id,system_qty,system_avg_cost,unit,physical_qty,captured_unit_cost,status)
       VALUES ($1,'product',$2,$3,$4,$5,'pza',$6,$7,$8)`,
      [cid, l.itemId, l.wh, l.systemQty, l.systemCost, l.physicalQty, l.capturedCost ?? null, l.status]))
  }
  return cid
}

describe('getInventoryReport — al cierre de mes', () => {
  beforeAll(async () => {
    const t = await createTenant({ label: 'invclose', planSlug: 'owner' })
    tenantId = t.tenant.id
    whFab  = await mkWarehouse('Fabrica', 'finished_product')
    whDist = await mkWarehouse('Distribucion', 'resale')
    prodA = await mkProduct('CL-A', 'Producto A')
    prodB = await mkProduct('CL-B', 'Producto B')
  })
  afterAll(async () => { await cleanupTestTenants(); await pool.end() })

  test('valúa con cantidad final × costo (física, sistema, y costo capturado)', async () => {
    const cid = await mkCount({ number: 'CONT-202606-CM', lines: [
      // Contado: física 90 × costo sistema 5 = 450
      { itemId: prodA, wh: whFab,  systemQty: 100, systemCost: 5, physicalQty: 90, status: 'applied' },
      // Sistema en $0 → usa costo capturado 3: 50 × 3 = 150
      { itemId: prodB, wh: whDist, systemQty: 50,  systemCost: 0, physicalQty: 50, capturedCost: 3, status: 'applied' },
      // Costo $0 sin captura → valor 0 (alerta) ; 10 × 0
      { itemId: prodA, wh: whDist, systemQty: 10,  systemCost: 0, physicalQty: 10, status: 'applied' },
      // No contado (física NULL) → usa sistema: 20 × 2 = 40
      { itemId: prodB, wh: whFab,  systemQty: 20,  systemCost: 2, physicalQty: null, status: 'skipped' },
    ] })

    const r = await getInventoryReport({ tenantId, countId: cid })
    expect(r.meta.mode).toBe('month_close')
    expect(r.meta.count_number).toBe('CONT-202606-CM')
    expect(r.meta.partial_scope).toBe(false)
    expect(r.totals.total_value).toBeCloseTo(450 + 150 + 0 + 40, 2)   // 640
    expect(r.totals.warehouses).toBe(2)
    // Alerta de costo $0 = la línea prodA@Dist
    expect(r.totals.zero_cost_count).toBe(1)
    expect(r.alerts.zero_cost[0].code).toBe('CL-A')
    // Por almacén
    const fab = r.by_warehouse.find(w => w.name === 'Fabrica')
    expect(fab.value).toBeCloseTo(490, 2)   // 450 + 40
  })

  test('marca partial_scope cuando el conteo no fue de todo el almacén', async () => {
    const cid = await mkCount({ number: 'CONT-202606-CM-2', scope: 'with_stock', lines: [
      { itemId: prodA, wh: whFab, systemQty: 5, systemCost: 4, physicalQty: 5, status: 'applied' },
    ] })
    const r = await getInventoryReport({ tenantId, countId: cid })
    expect(r.meta.partial_scope).toBe(true)
    expect(r.meta.scope).toBe('with_stock')
    expect(r.totals.total_value).toBeCloseTo(20, 2)
  })

  test('404 si el conteo no existe', async () => {
    await expect(getInventoryReport({ tenantId, countId: '00000000-0000-0000-0000-000000000000' }))
      .rejects.toMatchObject({ status: 404 })
  })

  test('modo actual (sin countId) sigue devolviendo meta.mode = current', async () => {
    const r = await getInventoryReport({ tenantId })
    expect(r.meta.mode).toBe('current')
  })

  test('Excel y PDF del cierre se generan sin crashear', async () => {
    const cid = await mkCount({ number: 'CONT-202606-CM-3', lines: [
      { itemId: prodA, wh: whFab, systemQty: 7, systemCost: 4, physicalQty: 7, status: 'applied' },
    ] })
    const xlsx = await generateInventoryWorkbook({ tenantId, tenantName: 'Test', countId: cid })
    expect(Buffer.byteLength(Buffer.from(xlsx))).toBeGreaterThan(0)
    const pdf = await generateInventoryPdf({ tenantId, countId: cid })
    expect(Buffer.isBuffer(pdf)).toBe(true)
    expect(pdf.length).toBeGreaterThan(0)
  })
})
