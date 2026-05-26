'use strict'

// Tests de aislamiento entre tenants. Verifican que tenant A nunca puede ver
// ni modificar datos de tenant B, ni siquiera con manipulaciones del request.

const { createTenant, loginAs, authedClient, cleanupTestTenants } = require('../helpers/factory')
const { pool } = require('../../src/db')

describe('Aislamiento entre tenants', () => {
  let tenantA, tenantB
  let clientA, clientB

  beforeAll(async () => {
    // Dos tenants independientes con sus propios admins.
    tenantA = await createTenant({ label: 'tenantA' })
    tenantB = await createTenant({ label: 'tenantB' })

    const sessA = await loginAs({ slug: tenantA.tenant.slug, email: tenantA.email, password: tenantA.password })
    const sessB = await loginAs({ slug: tenantB.tenant.slug, email: tenantB.email, password: tenantB.password })

    clientA = authedClient({ slug: tenantA.tenant.slug, token: sessA.token })
    clientB = authedClient({ slug: tenantB.tenant.slug, token: sessB.token })
  })

  afterAll(async () => {
    await cleanupTestTenants()
    await pool.end()
  })

  test('Tenant A crea un producto; tenant B no lo ve en su listado', async () => {
    const created = await clientA.post('/api/products', {
      sku: 'PROD-A-1', name: 'Producto exclusivo de A', type: 'resale', base_unit: 'pieza',
    }).expect(201)
    expect(created.body.tenant_id).toBe(tenantA.tenant.id)

    const listB = await clientB.get('/api/products').expect(200)
    const skusB = listB.body.data.map(p => p.sku)
    expect(skusB).not.toContain('PROD-A-1')
  })

  test('Token de tenant A con header X-Tenant-Slug de tenant B → 403', async () => {
    // Tomamos el token de A pero apuntamos al slug de B.
    const sessA = await loginAs({ slug: tenantA.tenant.slug, email: tenantA.email, password: tenantA.password })

    const res = await require('supertest')(require('../../src/app'))
      .get('/api/products')
      .set('X-Tenant-Slug', tenantB.tenant.slug)
      .set('Authorization', `Bearer ${sessA.token}`)

    // El authGuard rechaza con 403 porque el tenant del token no coincide
    // con el del header. Defensa de primer candado independiente de RLS.
    expect(res.status).toBe(403)
  })

  test('Tenant A no puede leer detalles de un producto de B por UUID', async () => {
    const prodB = await clientB.post('/api/products', {
      sku: 'PROD-B-1', name: 'Producto de B', type: 'resale', base_unit: 'pieza',
    }).expect(201)

    // A intenta accederlo directo por ID. Debe ser 404 (filtro por tenant en query).
    const res = await clientA.get(`/api/products/${prodB.body.id}`)
    expect(res.status).toBe(404)
  })

  test('Tenant A no puede modificar un producto de B', async () => {
    const prodB = await clientB.post('/api/products', {
      sku: 'PROD-B-2', name: 'Otro de B', type: 'resale', base_unit: 'pieza',
    }).expect(201)

    const res = await clientA.patch(`/api/products/${prodB.body.id}`, { name: 'HACKEADO' })
    expect(res.status).toBe(404)

    // Verificar que el nombre NO cambió
    const fresh = await clientB.get(`/api/products/${prodB.body.id}`).expect(200)
    expect(fresh.body.name).toBe('Otro de B')
  })

  test('Cada tenant solo ve sus propios usuarios', async () => {
    const listA = await clientA.get('/api/users').expect(200)
    const emailsA = listA.body.data.map(u => u.email)
    expect(emailsA).toContain(tenantA.email)
    expect(emailsA).not.toContain(tenantB.email)

    const listB = await clientB.get('/api/users').expect(200)
    const emailsB = listB.body.data.map(u => u.email)
    expect(emailsB).toContain(tenantB.email)
    expect(emailsB).not.toContain(tenantA.email)
  })
})
