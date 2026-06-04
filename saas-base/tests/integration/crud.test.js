'use strict'

const { createTenant, loginAs, authedClient, cleanupTestTenants } = require('../helpers/factory')
const { pool } = require('../../src/db')

describe('CRUD básico', () => {
  let client, tenantInfo

  beforeAll(async () => {
    tenantInfo = await createTenant({ label: 'crud', planSlug: 'owner' })
    const sess = await loginAs({
      slug: tenantInfo.tenant.slug, email: tenantInfo.email, password: tenantInfo.password,
    })
    client = authedClient({ slug: tenantInfo.tenant.slug, token: sess.token })
  })

  afterAll(async () => {
    await cleanupTestTenants()
    await pool.end()
  })

  describe('Productos', () => {
    let productId

    test('Crea un producto', async () => {
      const res = await client.post('/api/products', {
        sku:       'CRUD-001',
        name:      'Producto CRUD test',
        type:      'resale',
        base_unit: 'pieza',
      }).expect(201)

      productId = res.body.id
      expect(res.body.sku).toBe('CRUD-001')
      expect(res.body.tenant_id).toBe(tenantInfo.tenant.id)
    })

    test('Lista el producto creado', async () => {
      const res = await client.get('/api/products').expect(200)
      const found = res.body.data.find(p => p.id === productId)
      expect(found).toBeTruthy()
      expect(found.name).toBe('Producto CRUD test')
    })

    test('Obtiene el producto por ID', async () => {
      const res = await client.get(`/api/products/${productId}`).expect(200)
      expect(res.body.id).toBe(productId)
      expect(res.body.name).toBe('Producto CRUD test')
    })

    test('Actualiza el producto', async () => {
      const res = await client.patch(`/api/products/${productId}`, {
        name: 'Nombre actualizado',
      }).expect(200)
      expect(res.body.name).toBe('Nombre actualizado')
    })

    test('Rechaza SKU duplicado', async () => {
      const res = await client.post('/api/products', {
        sku:       'CRUD-001',
        name:      'Otro producto con SKU repetido',
        type:      'resale',
        base_unit: 'pieza',
      })
      expect(res.status).toBeGreaterThanOrEqual(400)
      expect(res.status).toBeLessThan(500)
    })
  })

  describe('Business Partners', () => {
    test('Crea un cliente', async () => {
      const res = await client.post('/api/business-partners', {
        name:       'Cliente de prueba',
        type:       'customer',
        rfc:        'XAXX010101000',
        tax_name:   'CLIENTE DE PRUEBA SA DE CV',
        is_active:  true,
      })
      expect(res.status).toBe(201)
      expect(res.body.name).toBe('Cliente de prueba')
    })

    test('Lista business partners', async () => {
      const res = await client.get('/api/business-partners').expect(200)
      expect(Array.isArray(res.body.data || res.body)).toBe(true)
    })

    test("role=customer/supplier incluye a los socios 'both'; type exacto NO", async () => {
      const created = await client.post('/api/business-partners', {
        name: 'Socio Ambos QA', type: 'both', rfc: 'AMB010101AB1',
        tax_name: 'SOCIO AMBOS QA', is_active: true,
      })
      expect(created.status).toBe(201)
      const id = created.body.id

      const ids = (r) => (r.body.data || r.body).map((p) => p.id)
      const asCustomer   = await client.get('/api/business-partners?role=customer').expect(200)
      const asSupplier   = await client.get('/api/business-partners?role=supplier').expect(200)
      const exactCust    = await client.get('/api/business-partners?type=customer').expect(200)

      expect(ids(asCustomer)).toContain(id)        // 'both' cuenta como cliente
      expect(ids(asSupplier)).toContain(id)        // y como proveedor
      expect(ids(exactCust)).not.toContain(id)     // type exacto (Socios) lo excluye
    })
  })

  describe('Tenant actual', () => {
    test('GET /api/tenants/current devuelve los datos del tenant', async () => {
      const res = await client.get('/api/tenants/current').expect(200)
      expect(res.body.id).toBe(tenantInfo.tenant.id)
      expect(res.body.slug).toBe(tenantInfo.tenant.slug)
    })
  })
})
