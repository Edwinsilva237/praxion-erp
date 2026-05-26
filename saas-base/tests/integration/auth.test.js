'use strict'

const request = require('supertest')
const app = require('../../src/app')
const { createTenant, loginAs, cleanupTestTenants } = require('../helpers/factory')
const { pool } = require('../../src/db')

describe('Autenticación', () => {
  let tenant

  beforeAll(async () => {
    tenant = await createTenant({ label: 'auth' })
  })

  afterAll(async () => {
    await cleanupTestTenants()
    await pool.end()
  })

  test('Login con credenciales correctas devuelve token', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .set('X-Tenant-Slug', tenant.tenant.slug)
      .send({ email: tenant.email, password: tenant.password })
      .expect(200)

    expect(res.body.accessToken).toBeTruthy()
    expect(res.body.refreshToken).toBeTruthy()
    expect(res.body.user.email).toBe(tenant.email)
    expect(res.body.tenant.slug).toBe(tenant.tenant.slug)
    expect(res.body.permissions).toContain('users:read')
  })

  test('Login con email mal: 401', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .set('X-Tenant-Slug', tenant.tenant.slug)
      .send({ email: 'noexiste@test.local', password: tenant.password })
    expect(res.status).toBe(401)
  })

  test('Login con password mal: 401', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .set('X-Tenant-Slug', tenant.tenant.slug)
      .send({ email: tenant.email, password: 'wrong_password' })
    expect(res.status).toBe(401)
  })

  test('Login con tenant slug inexistente: 404', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .set('X-Tenant-Slug', 'tenant-inexistente-xyz')
      .send({ email: tenant.email, password: tenant.password })
    expect(res.status).toBe(404)
  })

  test('Acceder a endpoint protegido sin token: 401', async () => {
    const res = await request(app)
      .get('/api/users')
      .set('X-Tenant-Slug', tenant.tenant.slug)
    expect(res.status).toBe(401)
  })

  test('Acceder a endpoint protegido con token inválido: 401', async () => {
    const res = await request(app)
      .get('/api/users')
      .set('X-Tenant-Slug', tenant.tenant.slug)
      .set('Authorization', 'Bearer not.a.real.token.at.all')
    expect(res.status).toBe(401)
  })

  test('Refresh token regenera la sesión', async () => {
    const sess = await loginAs({ slug: tenant.tenant.slug, email: tenant.email, password: tenant.password })

    const res = await request(app)
      .post('/api/auth/refresh')
      .set('X-Tenant-Slug', tenant.tenant.slug)
      .send({ refreshToken: sess.refreshToken })
      .expect(200)

    expect(res.body.accessToken).toBeTruthy()
    expect(res.body.refreshToken).toBeTruthy()
    // El refresh token se rota: el nuevo no debe ser igual al anterior.
    expect(res.body.refreshToken).not.toBe(sess.refreshToken)
  })

  test('Refresh con token inválido: 401', async () => {
    const res = await request(app)
      .post('/api/auth/refresh')
      .set('X-Tenant-Slug', tenant.tenant.slug)
      .send({ refreshToken: 'token-totalmente-falso' })
    expect(res.status).toBe(401)
  })
})
