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
const { hasPermission } = require('../../src/modules/roles/permissionService')

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

describe('F) Prevención: rechaza claves de unidad SAT inválidas al guardar', () => {
  let tenantId, userId, productId

  beforeAll(async () => {
    const info = await createTenant({ label: 'satval', planSlug: 'owner' })
    tenantId = info.tenant.id
    userId   = info.user.id
    const p = await productService.createProduct({
      tenantId, userId, sku: 'VAL-OK', name: 'Producto válido',
      type: 'resale', isProduced: false, saleUnit: 'rollo', satUnitCode: 'XRO',
    })
    productId = p.id
  })

  test('rechaza crear producto con clave de unidad inválida (ROL)', async () => {
    await expect(productService.createProduct({
      tenantId, userId, sku: 'VAL-BAD', name: 'Producto malo',
      type: 'resale', isProduced: false, saleUnit: 'rollo', satUnitCode: 'ROL',
    })).rejects.toThrow(/no existe en el catálogo del SAT/i)
  })

  test('rechaza editar el producto a una clave inválida', async () => {
    await expect(productService.updateProduct({
      tenantId, productId, satUnitCode: 'ROL', userId,
    })).rejects.toThrow(/no existe/i)
  })

  test('rechaza crear presentación con clave inválida; acepta válida y bloquea editarla a inválida', async () => {
    await expect(productService.createPackOption({
      tenantId, productId, packUnit: 'caja', basePerPack: 10, satUnitCode: 'ROL', userId,
    })).rejects.toThrow(/no existe/i)

    const opt = await productService.createPackOption({
      tenantId, productId, packUnit: 'tarima', basePerPack: 100, satUnitCode: 'XPL', userId,
    })
    expect(opt.sat_unit_code).toBe('XPL')

    await expect(productService.updatePackOption({
      tenantId, packOptionId: opt.id, satUnitCode: 'ROL', userId,
    })).rejects.toThrow(/no existe/i)
  })
})

describe('G) Permisos finos de evidencia aislados de la edición', () => {
  let tenantId, deliverUserId, evidenceUserId

  async function makeUserWithPerms(tenantId, roleName, perms) {
    const { rows: r } = await withBypass(() => query(
      `INSERT INTO roles (tenant_id, name) VALUES ($1, $2) RETURNING id`,
      [tenantId, roleName]
    ))
    const roleId = r[0].id
    for (const [resource, action] of perms) {
      await withBypass(() => query(
        `INSERT INTO role_permissions (role_id, permission_id)
         SELECT $1, id FROM permissions WHERE resource = $2 AND action = $3`,
        [roleId, resource, action]
      ))
    }
    const { rows: u } = await withBypass(() => query(
      `INSERT INTO users (tenant_id, email, full_name) VALUES ($1, $2, $3) RETURNING id`,
      [tenantId, `${roleName}@test.local`, roleName]
    ))
    const userId = u[0].id
    await withBypass(() => query(
      `INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)`, [userId, roleId]
    ))
    return userId
  }

  beforeAll(async () => {
    const info = await createTenant({ label: 'perms', planSlug: 'owner' })
    tenantId = info.tenant.id
    deliverUserId  = await makeUserWithPerms(tenantId, 'repartidor', [['sales', 'deliver'], ['sales', 'read']])
    evidenceUserId = await makeUserWithPerms(tenantId, 'apoyoalmacen', [['purchases', 'upload_evidence'], ['purchases', 'read']])
  })

  test('mig 186 creó los permisos finos', async () => {
    const { rows } = await withBypass(() => query(
      `SELECT resource, action FROM permissions
        WHERE (resource='sales' AND action='deliver')
           OR (resource='purchases' AND action='upload_evidence')`
    ))
    expect(rows).toHaveLength(2)
  })

  test('rol repartidor: tiene sales:deliver pero NO sales:update', async () => {
    expect(await hasPermission(deliverUserId, 'sales', 'deliver')).toBe(true)
    expect(await hasPermission(deliverUserId, 'sales', 'update')).toBe(false)
    expect(await hasPermission(deliverUserId, 'sales', 'create')).toBe(false)
  })

  test('rol apoyo almacén: tiene purchases:upload_evidence pero NO create/update', async () => {
    expect(await hasPermission(evidenceUserId, 'purchases', 'upload_evidence')).toBe(true)
    expect(await hasPermission(evidenceUserId, 'purchases', 'create')).toBe(false)
    expect(await hasPermission(evidenceUserId, 'purchases', 'update')).toBe(false)
  })
})

describe('H) getDeliveryNote no duplica líneas por facturas canceladas', () => {
  let tenantId, userId, partnerId, productId

  beforeAll(async () => {
    const info = await createTenant({ label: 'remdup', planSlug: 'owner' })
    tenantId = info.tenant.id
    userId   = info.user.id
    partnerId = await makePartner(tenantId)
    const p = await productService.createProduct({
      tenantId, userId, sku: 'DUP-1', name: 'Producto dup',
      type: 'resale', isProduced: false, satUnitCode: 'H87',
    })
    productId = p.id
  })

  test('una línea referenciada por una factura CANCELADA y una ACTIVA aparece UNA vez', async () => {
    const { rows: dn } = await withBypass(() => query(
      `INSERT INTO delivery_notes (tenant_id, type, document_number, partner_id, status)
       VALUES ($1,'sale','REM-DUP-1',$2,'delivered') RETURNING id`,
      [tenantId, partnerId]
    ))
    const noteId = dn[0].id
    const { rows: dnl } = await withBypass(() => query(
      `INSERT INTO delivery_note_lines
         (delivery_note_id, product_id, quantity_ordered, quantity_delivered, unit_price, line_number)
       VALUES ($1,$2,100,100,5,1) RETURNING id`,
      [noteId, productId]
    ))
    const lineId = dnl[0].id

    // Factura CANCELADA (intento fallido) que referencia la línea.
    const { rows: invC } = await withBypass(() => query(
      `INSERT INTO invoices (tenant_id, type, document_number, partner_id, status)
       VALUES ($1,'issued','E-CANCEL',$2,'cancelled') RETURNING id`, [tenantId, partnerId]
    ))
    await withBypass(() => query(
      `INSERT INTO invoice_lines (invoice_id, product_id, description, quantity, unit_price, line_number, delivery_note_line_id)
       VALUES ($1,$2,'x',100,5,1,$3)`, [invC[0].id, productId, lineId]
    ))

    // Factura ACTIVA (la buena) que referencia la MISMA línea.
    const { rows: invA } = await withBypass(() => query(
      `INSERT INTO invoices (tenant_id, type, document_number, partner_id, status)
       VALUES ($1,'issued','E-4538',$2,'stamped') RETURNING id`, [tenantId, partnerId]
    ))
    await withBypass(() => query(
      `INSERT INTO invoice_lines (invoice_id, product_id, description, quantity, unit_price, line_number, delivery_note_line_id)
       VALUES ($1,$2,'x',100,5,1,$3)`, [invA[0].id, productId, lineId]
    ))

    const note = await deliveryNoteService.getDeliveryNote({ tenantId, noteId })
    // Sin el fix saldrían 2 filas (fantasma por la cancelada). Con el fix: 1.
    expect(note.lines).toHaveLength(1)
    expect(note.lines[0].invoice_number).toBe('E-4538')
  })
})

describe('I) Guard anti-duplicado de pedidos (override con force)', () => {
  let tenantId, userId, partnerId, productId

  beforeAll(async () => {
    const info = await createTenant({ label: 'orddup', planSlug: 'owner' })
    tenantId = info.tenant.id
    userId   = info.user.id
    partnerId = await makePartner(tenantId)
    const p = await productService.createProduct({
      tenantId, userId, sku: 'ODUP-1', name: 'Producto pedido',
      type: 'resale', isProduced: false, satUnitCode: 'H87',
    })
    productId = p.id
  })

  const orderArgs = (force) => ({
    tenantId, partnerId, userId, force,
    lines: [{ productId, quantity: 10, unit: 'pieza', unitPrice: 5 }],
  })

  test('bloquea un 2º pedido idéntico reciente; force lo permite', async () => {
    const first = await orderService.createOrder(orderArgs(false))
    expect(first.order_number).toBeTruthy()

    // Segundo idéntico (mismo cliente + mismo total, < 5 min) → bloqueado.
    await expect(orderService.createOrder(orderArgs(false)))
      .rejects.toThrow(/duplicado/i)

    // Con force=true se crea de todos modos (pedido legítimo repetido).
    const forced = await orderService.createOrder(orderArgs(true))
    expect(forced.id).not.toBe(first.id)
  })
})

describe('J) Pedido consolidado: status pegado "Remisionado" se auto-corrige', () => {
  let tenantId, userId, partnerId, prodA, prodB

  beforeAll(async () => {
    const info = await createTenant({ label: 'consol', planSlug: 'owner' })
    tenantId = info.tenant.id
    userId   = info.user.id
    partnerId = await makePartner(tenantId)
    prodA = (await productService.createProduct({ tenantId, userId, sku: 'CON-A', name: 'A',
      type: 'resale', isProduced: false, satUnitCode: 'H87' })).id
    prodB = (await productService.createProduct({ tenantId, userId, sku: 'CON-B', name: 'B',
      type: 'resale', isProduced: false, satUnitCode: 'H87' })).id
  })

  test('recalcOrderStatus saca al pedido NO-principal de "in_delivery"; getOrder muestra la remisión consolidada', async () => {
    const oA = await orderService.createOrder({ tenantId, partnerId, userId, force: true,
      lines: [{ productId: prodA, quantity: 10, unit: 'pieza', unitPrice: 5 }] })
    const oB = await orderService.createOrder({ tenantId, partnerId, userId, force: true,
      lines: [{ productId: prodB, quantity: 4, unit: 'pieza', unitPrice: 5 }] })
    const { rows: lA } = await withBypass(() => query(`SELECT id FROM sales_order_lines WHERE sales_order_id=$1`, [oA.id]))
    const { rows: lB } = await withBypass(() => query(`SELECT id FROM sales_order_lines WHERE sales_order_id=$1`, [oB.id]))

    // Remisión CONSOLIDADA entregada: header = oA, líneas referencian oA y oB.
    const { rows: dn } = await withBypass(() => query(
      `INSERT INTO delivery_notes (tenant_id, type, document_number, partner_id, sales_order_id, status)
       VALUES ($1,'sale','REM-CONS-1',$2,$3,'delivered') RETURNING id`, [tenantId, partnerId, oA.id]
    ))
    const noteId = dn[0].id
    await withBypass(() => query(
      `INSERT INTO delivery_note_lines
         (delivery_note_id, product_id, sales_order_id, sales_order_line_id, quantity_ordered, quantity_delivered, unit_price, line_number)
       VALUES ($1,$2,$3,$4,10,10,5,1), ($1,$5,$6,$7,4,4,5,2)`,
      [noteId, prodA, oA.id, lA[0].id, prodB, oB.id, lB[0].id]
    ))

    // Simular el bug: oB (no-principal) quedó pegado en 'in_delivery'.
    await withBypass(() => query(`UPDATE sales_orders SET status='in_delivery' WHERE id=$1`, [oB.id]))

    // Auto-corrección: re-deriva el status real desde la remisión entregada.
    await orderService.recalcOrderStatus({ tenantId, orderId: oB.id })
    const { rows: after } = await withBypass(() => query(`SELECT status FROM sales_orders WHERE id=$1`, [oB.id]))
    expect(after[0].status).not.toBe('in_delivery')
    expect(['delivered', 'partially_delivered', 'invoiced']).toContain(after[0].status)

    // El detalle de oB ahora SÍ muestra la remisión consolidada.
    const detail = await orderService.getOrder({ tenantId, orderId: oB.id })
    expect(detail.deliveryNotes.some(d => d.document_number === 'REM-CONS-1')).toBe(true)
  })
})
