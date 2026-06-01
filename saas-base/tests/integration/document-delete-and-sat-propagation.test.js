'use strict'

/**
 * Cubre dos cambios de la sesión 2026-06-01:
 *
 *  A) Propagación de la clave de unidad SAT del producto → sus presentaciones.
 *     La factura toma sat_unit_code de product_pack_options (no del producto),
 *     así que al editar la clave del producto hay que propagarla a la(s)
 *     presentación(es) que tenían la clave vieja — sin pisar las que el usuario
 *     fijó a propósito con otra unidad. (Detonante real: "ROL"→"XRO".)
 *
 *  B) Hard delete de una factura en BORRADOR no timbrada (permiso invoicing:delete):
 *     borra la factura + revierte la CXC, y BLOQUEA cualquier factura timbrada
 *     (cfdi_uuid presente).
 */

const request = require('supertest')
const app = require('../../src/app')
const { createTenant, loginAs, cleanupTestTenants } = require('../helpers/factory')
const { pool, query, withBypass } = require('../../src/db')
const productService = require('../../src/modules/products/productService')
const orderService = require('../../src/modules/sales/orderService')
const deliveryNoteService = require('../../src/modules/sales/deliveryNoteService')

async function makePartner(tenantId, name = 'Cliente Test') {
  const { rows } = await withBypass(() => query(
    `INSERT INTO business_partners (tenant_id, type, name) VALUES ($1, 'customer', $2) RETURNING id`,
    [tenantId, name]
  ))
  return rows[0].id
}

afterAll(async () => {
  await cleanupTestTenants()
  await pool.end()
})

describe('A) Propagación de clave de unidad SAT a presentaciones', () => {
  let tenantId, userId

  beforeAll(async () => {
    const info = await createTenant({ label: 'satprop', planSlug: 'owner' })
    tenantId = info.tenant.id
    userId   = info.user.id
  })

  test('editar la clave del producto propaga a la presentación default, no a las demás', async () => {
    // Producto nuevo → se auto-crea una presentación default espejando satUnitCode.
    const product = await productService.createProduct({
      tenantId, userId,
      sku: 'PELI-TEST', name: 'Película de prueba',
      type: 'resale', isProduced: false,
      saleUnit: 'rollo', satUnitCode: 'H87', satProductCode: '44102305',
    })

    // Segunda presentación con OTRA clave (puesta a propósito) — no debe tocarse.
    await withBypass(() => query(
      `INSERT INTO product_pack_options (tenant_id, product_id, pack_unit, base_per_pack, sat_unit_code, is_default)
       VALUES ($1, $2, 'caja', 10, 'XBX', false)`,
      [tenantId, product.id]
    ))

    // Estado inicial: default H87, caja XBX.
    const before = await withBypass(() => query(
      `SELECT pack_unit, sat_unit_code, is_default FROM product_pack_options
        WHERE product_id = $1 ORDER BY is_default DESC`,
      [product.id]
    ))
    expect(before.rows.find(r => r.is_default).sat_unit_code).toBe('H87')
    expect(before.rows.find(r => r.pack_unit === 'caja').sat_unit_code).toBe('XBX')

    // Editar la clave del producto H87 → XRO.
    await productService.updateProduct({ tenantId, productId: product.id, satUnitCode: 'XRO', userId })

    const after = await withBypass(() => query(
      `SELECT pack_unit, sat_unit_code, is_default FROM product_pack_options
        WHERE product_id = $1`,
      [product.id]
    ))
    // La default (estaba en H87 = la clave vieja del producto) se propagó.
    expect(after.rows.find(r => r.is_default).sat_unit_code).toBe('XRO')
    // La presentación "caja" (XBX, intencional) NO se tocó.
    expect(after.rows.find(r => r.pack_unit === 'caja').sat_unit_code).toBe('XBX')
    // Y el producto quedó con la clave nueva.
    const { rows: prod } = await withBypass(() => query(
      `SELECT sat_unit_code FROM products WHERE id = $1`, [product.id]
    ))
    expect(prod[0].sat_unit_code).toBe('XRO')
  })
})

describe('B) Hard delete de factura en borrador no timbrada', () => {
  let tenant, session
  const auth = (req) => req
    .set('Authorization', `Bearer ${session.token}`)
    .set('X-Tenant-Slug', tenant.tenant.slug)

  beforeAll(async () => {
    tenant = await createTenant({ label: 'invdel', planSlug: 'pro' })
    session = await loginAs({
      slug: tenant.tenant.slug, email: tenant.email, password: tenant.password,
    })
    await auth(request(app).post('/api/fiscal-profiles'))
      .send({ rfc: 'XAXX010101000', taxName: 'EMISOR TEST', taxRegime: '601', zipCode: '60014', serie: 'A' })
      .expect(201)
  })

  afterAll(async () => {
    // El tenant se limpia en el cleanup global; nada extra aquí.
  })

  async function createDraftInvoice() {
    const res = await auth(request(app).post('/api/invoicing/invoices/occasional'))
      .send({
        receptor: {
          rfc: 'CACX7605101P8', taxName: 'CLIENTE OCASIONAL SA DE CV',
          taxRegimeCode: '612', zipCode: '60014', cfdiUse: 'G03',
        },
        useCfdi: 'G03', paymentMethod: 'PUE', paymentForm: '01',
        lines: [{ description: 'Servicio', satProductCode: '80141600', satUnitCode: 'E48',
          unit: 'servicio', quantity: 1, unitPrice: 100, objetoImp: '02', taxFactor: 'Tasa', taxRate: 16 }],
      })
      .expect(201)
    return res.body
  }

  test('elimina el borrador y revierte su CXC', async () => {
    const inv = await createDraftInvoice()

    await auth(request(app).delete(`/api/invoicing/invoices/${inv.id}`)).expect(200)

    const { rows: gone } = await withBypass(() => query(
      `SELECT 1 FROM invoices WHERE id = $1`, [inv.id]
    ))
    expect(gone).toHaveLength(0)
    const { rows: ar } = await withBypass(() => query(
      `SELECT 1 FROM accounts_receivable WHERE document_type = 'invoice' AND document_id = $1`, [inv.id]
    ))
    expect(ar).toHaveLength(0)
  })

  test('NO permite eliminar una factura timbrada (cfdi_uuid presente)', async () => {
    const inv = await createDraftInvoice()
    // Simular timbrado: status stamped + uuid.
    await withBypass(() => query(
      `UPDATE invoices SET status = 'stamped', cfdi_uuid = gen_random_uuid(), stamp_date = NOW()
        WHERE id = $1`, [inv.id]
    ))

    await auth(request(app).delete(`/api/invoicing/invoices/${inv.id}`)).expect(409)

    // Sigue ahí.
    const { rows } = await withBypass(() => query(`SELECT 1 FROM invoices WHERE id = $1`, [inv.id]))
    expect(rows).toHaveLength(1)
  })
})

describe('C) Hard delete de pedido sin documentos asociados', () => {
  let tenantId, userId, partnerId

  beforeAll(async () => {
    const info = await createTenant({ label: 'orddel', planSlug: 'owner' })
    tenantId = info.tenant.id
    userId   = info.user.id
    partnerId = await makePartner(tenantId)
  })

  test('elimina un pedido sin remisiones ni facturas', async () => {
    const { rows } = await withBypass(() => query(
      `INSERT INTO sales_orders (tenant_id, order_number, partner_id, status)
       VALUES ($1, 'PV-DEL-1', $2, 'draft') RETURNING id`,
      [tenantId, partnerId]
    ))
    const orderId = rows[0].id

    await orderService.deleteOrder({ tenantId, orderId, userId })

    const { rows: gone } = await withBypass(() => query(`SELECT 1 FROM sales_orders WHERE id = $1`, [orderId]))
    expect(gone).toHaveLength(0)
  })

  test('bloquea si el pedido tiene una remisión asociada', async () => {
    const { rows: o } = await withBypass(() => query(
      `INSERT INTO sales_orders (tenant_id, order_number, partner_id, status)
       VALUES ($1, 'PV-DEL-2', $2, 'confirmed') RETURNING id`,
      [tenantId, partnerId]
    ))
    const orderId = o[0].id
    await withBypass(() => query(
      `INSERT INTO delivery_notes (tenant_id, type, document_number, partner_id, sales_order_id, status)
       VALUES ($1, 'sale', 'REM-DEL-2', $2, $3, 'issued')`,
      [tenantId, partnerId, orderId]
    ))

    await expect(orderService.deleteOrder({ tenantId, orderId, userId }))
      .rejects.toThrow(/remisiones/i)
    // Sigue ahí.
    const { rows } = await withBypass(() => query(`SELECT 1 FROM sales_orders WHERE id = $1`, [orderId]))
    expect(rows).toHaveLength(1)
  })
})

describe('D) Hard delete de remisión sin movimientos', () => {
  let tenantId, userId, partnerId

  beforeAll(async () => {
    const info = await createTenant({ label: 'remdel', planSlug: 'owner' })
    tenantId = info.tenant.id
    userId   = info.user.id
    partnerId = await makePartner(tenantId)
  })

  test('elimina una remisión en estado issued', async () => {
    const { rows } = await withBypass(() => query(
      `INSERT INTO delivery_notes (tenant_id, type, document_number, partner_id, status)
       VALUES ($1, 'sale', 'REM-OK-1', $2, 'issued') RETURNING id`,
      [tenantId, partnerId]
    ))
    const noteId = rows[0].id

    await deliveryNoteService.deleteDelivery({ tenantId, noteId, userId })

    const { rows: gone } = await withBypass(() => query(`SELECT 1 FROM delivery_notes WHERE id = $1`, [noteId]))
    expect(gone).toHaveLength(0)
  })

  test('bloquea si la remisión ya fue entregada (movió inventario)', async () => {
    const { rows } = await withBypass(() => query(
      `INSERT INTO delivery_notes (tenant_id, type, document_number, partner_id, status)
       VALUES ($1, 'sale', 'REM-ENT-1', $2, 'delivered') RETURNING id`,
      [tenantId, partnerId]
    ))
    const noteId = rows[0].id

    await expect(deliveryNoteService.deleteDelivery({ tenantId, noteId, userId }))
      .rejects.toThrow(/inventario/i)
    const { rows: still } = await withBypass(() => query(`SELECT 1 FROM delivery_notes WHERE id = $1`, [noteId]))
    expect(still).toHaveLength(1)
  })
})

describe('E) nextInvoiceNumber a prueba de colisiones (contador de serie desfasado)', () => {
  let tenant, session
  const auth = (req) => req
    .set('Authorization', `Bearer ${session.token}`)
    .set('X-Tenant-Slug', tenant.tenant.slug)

  beforeAll(async () => {
    tenant = await createTenant({ label: 'foliodup', planSlug: 'pro' })
    session = await loginAs({
      slug: tenant.tenant.slug, email: tenant.email, password: tenant.password,
    })
    await auth(request(app).post('/api/fiscal-profiles'))
      .send({ rfc: 'XAXX010101000', taxName: 'EMISOR TEST', taxRegime: '601', zipCode: '60014', serie: 'A' })
      .expect(201)
  })

  function newOccasional() {
    return auth(request(app).post('/api/invoicing/invoices/occasional'))
      .send({
        receptor: { rfc: 'CACX7605101P8', taxName: 'CLIENTE OCASIONAL SA DE CV',
          taxRegimeCode: '612', zipCode: '60014', cfdiUse: 'G03' },
        useCfdi: 'G03', paymentMethod: 'PUE', paymentForm: '01',
        lines: [{ description: 'Servicio', satProductCode: '80141600', satUnitCode: 'E48',
          unit: 'servicio', quantity: 1, unitPrice: 100, objetoImp: '02', taxFactor: 'Tasa', taxRate: 16 }],
      })
  }

  test('si el contador quedó detrás de un folio ya emitido, NO choca: avanza al siguiente libre', async () => {
    const first = await newOccasional().expect(201)
    const firstNum = first.body.document_number   // p.ej. A-0001

    // Simular el desfase real: regresar folio_next al valor inicial.
    await withBypass(() => query(
      `UPDATE tenant_document_series SET folio_next = 1
        WHERE tenant_id = $1 AND entity_type = 'invoice'`,
      [tenant.tenant.id]
    ))

    // Con el bug viejo esto reventaba con "duplicate key inv_number_tenant" (500).
    // Con el fix, salta el folio ocupado y emite el siguiente libre.
    const second = await newOccasional().expect(201)
    expect(second.body.document_number).not.toBe(firstNum)

    // Ambos document_number son únicos en el tenant.
    const { rows } = await withBypass(() => query(
      `SELECT document_number, COUNT(*) c FROM invoices
        WHERE tenant_id = $1 GROUP BY document_number HAVING COUNT(*) > 1`,
      [tenant.tenant.id]
    ))
    expect(rows).toHaveLength(0)
  })
})
