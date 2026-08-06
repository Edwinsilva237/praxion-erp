'use strict'

/**
 * Vales de salida (consumo interno a áreas) — migs 245/246 (2026-08-06).
 *
 * El almacenista libera material a un área sin venta de por medio: el vale baja
 * el stock con el costo promedio vigente (movement_type='internal_consumption'),
 * la cancelación reingresa el material, y el consumo se reporta valorizado por
 * área. Permisos: inventory:read / inventory:adjust (sin permiso nuevo).
 */

const { createTenant, loginAs, authedClient, cleanupTestTenants } = require('../helpers/factory')
const { pool, query, withBypass } = require('../../src/db')

let tenantId, client, warehouseId, rmId

async function stockOf(itemId) {
  const { rows } = await withBypass(() => query(
    `SELECT quantity, avg_cost FROM inventory_stock
      WHERE tenant_id=$1 AND warehouse_id=$2 AND item_type='raw_material' AND item_id=$3 AND status='available'`,
    [tenantId, warehouseId, itemId]))
  return rows[0] ? { qty: parseFloat(rows[0].quantity), cost: parseFloat(rows[0].avg_cost) } : { qty: 0, cost: 0 }
}

beforeAll(async () => {
  const info = await createTenant({ label: 'vales', planSlug: 'owner' })
  tenantId = info.tenant.id
  const sess = await loginAs({ slug: info.tenant.slug, email: info.email, password: info.password })
  client = authedClient({ slug: info.tenant.slug, token: sess.token })

  const { rows: wh } = await withBypass(() => query(
    `INSERT INTO warehouses (tenant_id, name, type, is_active) VALUES ($1,'Almacén insumos','raw_material',true) RETURNING id`,
    [tenantId]))
  warehouseId = wh[0].id

  const { rows: rm } = await withBypass(() => query(
    `INSERT INTO raw_materials (tenant_id, name, unit) VALUES ($1,'Caja de empaque','pza') RETURNING id`,
    [tenantId]))
  rmId = rm[0].id

  // Stock inicial: 100 pzas a costo promedio $12.50
  await withBypass(() => query(
    `INSERT INTO inventory_stock (tenant_id, warehouse_id, item_type, item_id, status, quantity, unit, avg_cost)
     VALUES ($1,$2,'raw_material',$3,'available',100,'pza',12.50)`,
    [tenantId, warehouseId, rmId]))
})

afterAll(async () => { await cleanupTestTenants(); await pool.end() })

describe('Vales de salida — consumo interno', () => {
  let areaId, voucherId

  test('crear área de consumo (y rechazar duplicada)', async () => {
    const res = await client.post('/api/inventory/consumption-areas', { name: 'Empaque' }).expect(201)
    areaId = res.body.id
    expect(res.body.name).toBe('Empaque')

    await client.post('/api/inventory/consumption-areas', { name: 'Empaque' }).expect(409)
  })

  test('crear vale: baja el stock con el costo promedio y genera folio VAL-', async () => {
    const res = await client.post('/api/inventory/consumption-vouchers', {
      warehouseId, areaId, receivedBy: 'Juan Pérez',
      notes: 'Material para línea 2',
      lines: [{ itemType: 'raw_material', itemId: rmId, quantity: 40 }],
    }).expect(201)

    voucherId = res.body.id
    expect(res.body.voucher_number).toMatch(/^VAL-/)
    expect(res.body.status).toBe('active')
    expect(parseFloat(res.body.total_value)).toBe(500)   // 40 × 12.50

    const st = await stockOf(rmId)
    expect(st.qty).toBe(60)   // 100 − 40
  })

  test('el kardex registra internal_consumption con referencia al vale', async () => {
    const { rows } = await withBypass(() => query(
      `SELECT movement_type, quantity, unit_cost FROM inventory_movements
        WHERE reference_type='consumption_voucher' AND reference_id=$1`, [voucherId]))
    expect(rows).toHaveLength(1)
    expect(rows[0].movement_type).toBe('internal_consumption')
    expect(parseFloat(rows[0].quantity)).toBe(-40)
    expect(parseFloat(rows[0].unit_cost)).toBe(12.5)
  })

  test('detalle del vale incluye líneas con nombre del artículo', async () => {
    const res = await client.get(`/api/inventory/consumption-vouchers/${voucherId}`).expect(200)
    expect(res.body.area_name).toBe('Empaque')
    expect(res.body.received_by).toBe('Juan Pérez')
    expect(res.body.lines).toHaveLength(1)
    expect(res.body.lines[0].item_name).toBe('Caja de empaque')
  })

  test('stock insuficiente → 400 y no descuenta nada', async () => {
    await client.post('/api/inventory/consumption-vouchers', {
      warehouseId, areaId, receivedBy: 'Juan Pérez',
      lines: [{ itemType: 'raw_material', itemId: rmId, quantity: 999 }],
    }).expect(400)

    const st = await stockOf(rmId)
    expect(st.qty).toBe(60)   // sin cambios
  })

  test('resumen por área acumula el consumo valorizado', async () => {
    const res = await client.get('/api/inventory/consumption-vouchers/summary-by-area').expect(200)
    const emp = res.body.find(r => r.area_id === areaId)
    expect(emp).toBeTruthy()
    expect(emp.vouchers).toBe(1)
    expect(parseFloat(emp.total_value)).toBe(500)
  })

  test('PDF del vale se genera', async () => {
    const res = await client.get(`/api/inventory/consumption-vouchers/${voucherId}/pdf`).expect(200)
    expect(res.headers['content-type']).toBe('application/pdf')
    expect(res.body.length).toBeGreaterThan(1000)
  })

  test('cancelar el vale reingresa el material y exige motivo', async () => {
    await client.post(`/api/inventory/consumption-vouchers/${voucherId}/cancel`, {}).expect(400)

    const res = await client.post(`/api/inventory/consumption-vouchers/${voucherId}/cancel`,
      { reason: 'Se capturó de más' }).expect(200)
    expect(res.body.status).toBe('cancelled')

    const st = await stockOf(rmId)
    expect(st.qty).toBe(100)   // reingresado

    // Doble cancelación → 409. El resumen ya no lo cuenta.
    await client.post(`/api/inventory/consumption-vouchers/${voucherId}/cancel`,
      { reason: 'otra vez' }).expect(409)
    const sum = await client.get('/api/inventory/consumption-vouchers/summary-by-area').expect(200)
    expect(sum.body.find(r => r.area_id === areaId)).toBeUndefined()
  })

  test('firma en pantalla (opcional): se guarda, se sirve y sin firma da 404', async () => {
    // PNG mínimo válido (1×1) como data URL — simula el pad de firma.
    const png1x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
    const res = await client.post('/api/inventory/consumption-vouchers', {
      warehouseId, areaId, receivedBy: 'María López',
      signatureDataUrl: `data:image/png;base64,${png1x1}`,
      lines: [{ itemType: 'raw_material', itemId: rmId, quantity: 2 }],
    }).expect(201)
    expect(res.body.receiver_signature_path).toBeTruthy()

    const sig = await client.get(`/api/inventory/consumption-vouchers/${res.body.id}/signature`).expect(200)
    expect(sig.headers['content-type']).toContain('image/png')

    // Formato inválido de firma → 400 y NO descuenta stock.
    const before = await stockOf(rmId)
    await client.post('/api/inventory/consumption-vouchers', {
      warehouseId, areaId, receivedBy: 'María López',
      signatureDataUrl: 'data:image/jpeg;base64,xxxx',
      lines: [{ itemType: 'raw_material', itemId: rmId, quantity: 1 }],
    }).expect(400)
    expect((await stockOf(rmId)).qty).toBe(before.qty)

    // Un vale sin firma responde 404 en el endpoint de firma.
    await client.get(`/api/inventory/consumption-vouchers/${voucherId}/signature`).expect(404)
  })

  test('área desactivada ya no acepta vales nuevos', async () => {
    await client.patch(`/api/inventory/consumption-areas/${areaId}`, { isActive: false }).expect(200)
    await client.post('/api/inventory/consumption-vouchers', {
      warehouseId, areaId, receivedBy: 'Juan Pérez',
      lines: [{ itemType: 'raw_material', itemId: rmId, quantity: 1 }],
    }).expect(409)
  })
})
