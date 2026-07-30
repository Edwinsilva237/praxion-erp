'use strict'

/**
 * Envío de la OC por correo al proveedor (PDF adjunto).
 *
 * Mockeamos enqueueEmail para validar el flujo sin enviar correo real:
 *   - contactos del proveedor como destinatarios por default
 *   - una OC en BORRADOR se confirma al enviarla (draft → sent)
 *   - destinatarios explícitos del operador (normalizados/dedupe)
 *   - sin destinatarios → 400; OC cancelada → 409
 *   - listSupplierContacts: contactos + defaultRecipients; OC genérica → vacío
 */

jest.mock('../../src/queues/emailQueue', () => ({
  enqueueEmail: jest.fn().mockResolvedValue({ queued: true, jobId: 'x' }),
  emailQueue: null,
}))

const { pool, query, withBypass } = require('../../src/db')
const purchaseOrderService = require('../../src/modules/purchases/purchaseOrderService')
const { enqueueEmail } = require('../../src/queues/emailQueue')
const { createTenant, cleanupTestTenants } = require('../helpers/factory')

let tenantId, userId, supplierId, supplierNoEmailId, rmId, warehouseId

beforeAll(async () => {
  const t = await createTenant({ label: 'ocemail', planSlug: 'owner' })
  tenantId = t.tenant.id
  userId   = t.user.id

  const { rows: sup } = await withBypass(() => query(
    `INSERT INTO business_partners (tenant_id, type, name) VALUES ($1,'supplier','Prov Con Correo') RETURNING id`,
    [tenantId]
  ))
  supplierId = sup[0].id
  await withBypass(() => query(
    `INSERT INTO business_partner_contacts (business_partner_id, name, email, is_primary)
     VALUES ($1,'Compras','compras@prov.local',true),
            ($1,'Almacén','almacen@prov.local',false),
            ($1,'Sin correo',NULL,false)`,
    [supplierId]
  ))

  const { rows: sup2 } = await withBypass(() => query(
    `INSERT INTO business_partners (tenant_id, type, name) VALUES ($1,'supplier','Prov Sin Correo') RETURNING id`,
    [tenantId]
  ))
  supplierNoEmailId = sup2[0].id

  const { rows: rm } = await withBypass(() => query(
    `INSERT INTO raw_materials (tenant_id, name) VALUES ($1,'Resina Email') RETURNING id`,
    [tenantId]
  ))
  rmId = rm[0].id
  const { rows: wh } = await withBypass(() => query(
    `SELECT id FROM warehouses WHERE tenant_id = $1 ORDER BY created_at LIMIT 1`, [tenantId]
  ))
  warehouseId = wh[0].id
})

afterAll(async () => { await cleanupTestTenants(); await pool.end() })

beforeEach(() => enqueueEmail.mockClear())

async function makeOrder(partnerId = supplierId) {
  return purchaseOrderService.createOrder({
    tenantId, partnerId, currency: 'MXN', userId,
    lines: [{ itemType: 'raw_material', itemId: rmId, quantity: 100, unit: 'kg', unitPrice: 20, warehouseId }],
  })
}

test('listSupplierContacts: contactos con correo → defaultRecipients', async () => {
  const oc = await makeOrder()
  const res = await purchaseOrderService.listSupplierContacts({ tenantId, orderId: oc.id })
  expect(res.contacts).toHaveLength(3)
  expect(res.defaultRecipients.sort()).toEqual(['almacen@prov.local', 'compras@prov.local'])
})

test('listSupplierContacts: OC genérica (sin proveedor del catálogo) → vacío', async () => {
  const oc = await purchaseOrderService.createOrder({
    tenantId, isGeneric: true, genericSupplier: 'Ferretería de la esquina', currency: 'MXN', userId,
    lines: [{ itemType: 'raw_material', itemId: rmId, quantity: 5, unit: 'kg', unitPrice: 10, warehouseId }],
  })
  const res = await purchaseOrderService.listSupplierContacts({ tenantId, orderId: oc.id })
  expect(res.contacts).toEqual([])
  expect(res.defaultRecipients).toEqual([])
})

test('envía una OC en borrador: la confirma y manda a los contactos del proveedor', async () => {
  const oc = await makeOrder()
  expect(oc.status).toBe('draft')

  const res = await purchaseOrderService.sendOrderEmail({ tenantId, orderId: oc.id, userId })

  // Se confirmó al enviarse.
  expect(res.status).toBe('sent')
  expect(res.email.sent).toBe(true)
  expect(res.email.recipients.sort()).toEqual(['almacen@prov.local', 'compras@prov.local'])

  expect(enqueueEmail).toHaveBeenCalledTimes(1)
  const call = enqueueEmail.mock.calls[0][0]
  expect(call.tenantId).toBe(tenantId)
  expect(call.subject).toContain(oc.order_number)
  expect(call.attachments).toHaveLength(1)
  expect(call.attachments[0].filename).toBe(`${oc.order_number}.pdf`)
  expect(Buffer.isBuffer(call.attachments[0].content)).toBe(true)
  expect(call.attachments[0].content.slice(0, 4).toString()).toBe('%PDF')

  // Bitácora de status del confirm implícito.
  const { rows } = await withBypass(() => query(
    `SELECT 1 FROM document_status_log
      WHERE tenant_id=$1 AND entity_type='purchase_order' AND entity_id=$2
        AND from_status='draft' AND to_status='sent'`,
    [tenantId, oc.id]
  ))
  expect(rows).toHaveLength(1)
})

test('destinatarios explícitos del operador: normaliza, dedupe y NO usa los contactos', async () => {
  const oc = await makeOrder()
  const res = await purchaseOrderService.sendOrderEmail({
    tenantId, orderId: oc.id, userId,
    emails: ['Ventas@Otro.local', 'ventas@otro.local', 'no-es-correo', ''],
  })
  expect(res.email.recipients).toEqual(['ventas@otro.local'])
  expect(enqueueEmail.mock.calls[0][0].to).toEqual(['ventas@otro.local'])
})

test('reenviar una OC ya enviada NO cambia su status', async () => {
  const oc = await makeOrder()
  await purchaseOrderService.confirmOrder({ tenantId, orderId: oc.id, userId })
  const res = await purchaseOrderService.sendOrderEmail({ tenantId, orderId: oc.id, userId })
  expect(res.status).toBe('sent')
  expect(enqueueEmail).toHaveBeenCalledTimes(1)
})

test('sin destinatarios (proveedor sin contactos con correo) → 400 y NO confirma el borrador', async () => {
  const oc = await makeOrder(supplierNoEmailId)
  await expect(
    purchaseOrderService.sendOrderEmail({ tenantId, orderId: oc.id, userId })
  ).rejects.toMatchObject({ status: 400 })
  expect(enqueueEmail).not.toHaveBeenCalled()

  // El borrador sigue siendo borrador (la validación corre ANTES del confirm).
  const after = await purchaseOrderService.getOrder({ tenantId, orderId: oc.id })
  expect(after.status).toBe('draft')
})

test('OC cancelada → 409', async () => {
  const oc = await makeOrder()
  await purchaseOrderService.cancelOrder({ tenantId, orderId: oc.id, userId })
  await expect(
    purchaseOrderService.sendOrderEmail({ tenantId, orderId: oc.id, userId })
  ).rejects.toMatchObject({ status: 409 })
  expect(enqueueEmail).not.toHaveBeenCalled()
})
