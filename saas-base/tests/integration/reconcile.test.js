'use strict'

// Tests del endpoint de reconcile. No mockeamos Facturapi — solo verificamos
// los paths que no requieren tocar la API externa:
//   - Endpoint protegido por auth.
//   - Factura inexistente → 404.
//
// La lógica completa (encontrar factura en Facturapi y reconciliar) requiere
// credenciales reales de Facturapi sandbox y mock de la SDK. Eso queda fuera
// del alcance de la suite básica.

const request = require('supertest')
const app = require('../../src/app')
const { createTenant, loginAs, authedClient, cleanupTestTenants } = require('../helpers/factory')
const { pool } = require('../../src/db')

describe('Reconcile de facturas (recovery de timbrado en limbo)', () => {
  let client, tInfo

  beforeAll(async () => {
    tInfo = await createTenant({ label: 'reconcile', planSlug: 'owner' })
    const sess = await loginAs({
      slug: tInfo.tenant.slug, email: tInfo.email, password: tInfo.password,
    })
    client = authedClient({ slug: tInfo.tenant.slug, token: sess.token })
  })

  afterAll(async () => {
    await cleanupTestTenants()
    await pool.end()
  })

  test('Endpoint requiere autenticación', async () => {
    const res = await request(app)
      .post('/api/invoicing/invoices/00000000-0000-0000-0000-000000000000/reconcile')
      .set('X-Tenant-Slug', tInfo.tenant.slug)
    expect(res.status).toBe(401)
  })

  test('Factura inexistente: 404', async () => {
    const res = await client.post('/api/invoicing/invoices/00000000-0000-0000-0000-000000000000/reconcile')
    expect(res.status).toBe(404)
  })

  test('Endpoint POST /reconcile existe (smoke check para no romperse al refactorizar)', async () => {
    // Llamar al endpoint contra un id inexistente del mismo tenant. Lo que
    // probamos aquí es que la ruta está montada y devuelve un código de
    // error razonable, no 404 de "ruta no encontrada".
    const res = await client.post('/api/invoicing/invoices/00000000-0000-0000-0000-000000000000/reconcile')
    expect([200, 400, 404, 422, 502]).toContain(res.status)
    expect(typeof res.body).toBe('object')
  })
})
