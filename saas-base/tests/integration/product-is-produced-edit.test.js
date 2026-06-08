'use strict'

/**
 * Editar el flag is_produced ("se fabrica internamente") de un producto.
 *
 * Bug operativo: un producto que se debía fabricar se creó por error como reventa
 * y la UI no dejaba cambiarlo. Ahora se permite editar el flag:
 *   - reventa → fabricado: SIEMPRE (el caso del usuario).
 *   - fabricado → reventa: bloqueado si ya tiene órdenes de producción.
 */

const { createTenant, loginAs, authedClient, cleanupTestTenants } = require('../helpers/factory')
const { createRawMaterial, createOrder, releaseOrder } = require('../helpers/productionFactory')
const { pool } = require('../../src/db')

afterAll(async () => {
  await cleanupTestTenants()
  await pool.end()
})

let n = 0
const sku = (s) => `${s}-${Date.now() % 100000}-${n++}`

describe('PATCH /products/:id — editar is_produced', () => {
  let client

  beforeAll(async () => {
    const info = await createTenant({ label: 'isprod', planSlug: 'owner' })
    const sess = await loginAs({ slug: info.tenant.slug, email: info.email, password: info.password })
    client = authedClient({ slug: info.tenant.slug, token: sess.token })
  })

  test('reventa → fabricado: se permite (el caso del Esquinero mal marcado)', async () => {
    const p = await client.post('/api/products', {
      sku: sku('RESALE'), name: 'Esquinero 2.40', type: 'resale', isProduced: false,
    }).expect(201)
    expect(p.body.is_produced).toBe(false)

    await client.patch(`/api/products/${p.body.id}`, { isProduced: true }).expect(200)
    const got = await client.get(`/api/products/${p.body.id}`).expect(200)
    expect(got.body.is_produced).toBe(true)
  })

  test('fabricado → reventa SIN órdenes: se permite', async () => {
    const p = await client.post('/api/products', {
      sku: sku('PROD'), name: 'Prod sin ordenes', type: 'corner_protector', isProduced: true,
    }).expect(201)
    expect(p.body.is_produced).toBe(true)

    await client.patch(`/api/products/${p.body.id}`, { isProduced: false }).expect(200)
    const got = await client.get(`/api/products/${p.body.id}`).expect(200)
    expect(got.body.is_produced).toBe(false)
  })

  test('fabricado → reventa CON órdenes de producción: bloqueado', async () => {
    const p = await client.post('/api/products', {
      sku: sku('PRODORD'), name: 'Prod con orden', type: 'corner_protector', isProduced: true,
    }).expect(201)
    const rm = await createRawMaterial(client, { name: sku('MP') })
    await createOrder(client, { productId: p.body.id, rawMaterialId: rm.id, quantityPackages: 5 })

    const res = await client.patch(`/api/products/${p.body.id}`, { isProduced: false })
    expect(res.status).toBe(400)
    // Sigue siendo fabricado.
    const got = await client.get(`/api/products/${p.body.id}`).expect(200)
    expect(got.body.is_produced).toBe(true)
  })
})
