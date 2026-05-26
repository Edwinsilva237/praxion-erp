'use strict'

const request = require('supertest')
const app = require('../../src/app')
const { createTenant, loginAs, cleanupTestTenants } = require('../helpers/factory')
const { pool, query, withBypass } = require('../../src/db')

describe('Membresías user↔tenant', () => {
  let tenantA
  let tenantB
  let session // sesión del admin de A

  beforeAll(async () => {
    tenantA = await createTenant({ label: 'memberA' })
    tenantB = await createTenant({ label: 'memberB' })
    session = await loginAs({
      slug:     tenantA.tenant.slug,
      email:    tenantA.email,
      password: tenantA.password,
    })
  })

  afterAll(async () => {
    await cleanupTestTenants()
    await pool.end()
  })

  test('GET /memberships/me devuelve solo el home tenant inicialmente', async () => {
    const res = await request(app)
      .get('/api/memberships/me')
      .set('Authorization', `Bearer ${session.token}`)
      .expect(200)

    expect(res.body.activeTenantId).toBe(tenantA.tenant.id)
    expect(res.body.memberships).toHaveLength(1)
    expect(res.body.memberships[0].id).toBe(tenantA.tenant.id)
    expect(res.body.memberships[0].role).toBe('owner')
  })

  test('POST /memberships/switch falla con 403 si no hay membresía en target', async () => {
    const res = await request(app)
      .post('/api/memberships/switch')
      .set('Authorization', `Bearer ${session.token}`)
      .send({ tenantId: tenantB.tenant.id })
      .expect(403)

    expect(res.body.error).toMatch(/no tienes acceso/i)
  })

  test('POST /memberships/switch falla si target == actual', async () => {
    const res = await request(app)
      .post('/api/memberships/switch')
      .set('Authorization', `Bearer ${session.token}`)
      .send({ tenantId: tenantA.tenant.id })
      .expect(400)

    expect(res.body.error).toMatch(/ya estás en ese tenant/i)
  })

  test('Tras agregar membresía manual, /me incluye el segundo tenant', async () => {
    await withBypass(() => query(
      `INSERT INTO tenant_memberships (user_id, tenant_id, role) VALUES ($1, $2, 'member')`,
      [tenantA.user.id, tenantB.tenant.id]
    ))

    const res = await request(app)
      .get('/api/memberships/me')
      .set('Authorization', `Bearer ${session.token}`)
      .expect(200)

    expect(res.body.memberships).toHaveLength(2)
    const ids = res.body.memberships.map(m => m.id).sort()
    expect(ids).toEqual([tenantA.tenant.id, tenantB.tenant.id].sort())
  })

  test('POST /memberships/switch éxito: devuelve nuevo JWT bound al tenant B', async () => {
    const res = await request(app)
      .post('/api/memberships/switch')
      .set('Authorization', `Bearer ${session.token}`)
      .send({ tenantId: tenantB.tenant.id })
      .expect(200)

    expect(res.body.accessToken).toBeTruthy()
    expect(res.body.refreshToken).toBeTruthy()
    expect(res.body.tenant.id).toBe(tenantB.tenant.id)
    expect(res.body.membership.role).toBe('member')

    // Guardar para próximo test
    session.switchedToken        = res.body.accessToken
    session.switchedRefreshToken = res.body.refreshToken
  })

  test('Refresh token previo (de tenant A) queda revocado tras switch', async () => {
    const res = await request(app)
      .post('/api/auth/refresh')
      .set('X-Tenant-Slug', tenantA.tenant.slug)
      .send({ refreshToken: session.refreshToken })
    expect(res.status).toBe(401)
  })

  test('Refresh con el nuevo token + slug de tenant B funciona', async () => {
    const res = await request(app)
      .post('/api/auth/refresh')
      .set('X-Tenant-Slug', tenantB.tenant.slug)
      .send({ refreshToken: session.switchedRefreshToken })
      .expect(200)

    expect(res.body.accessToken).toBeTruthy()
    expect(res.body.refreshToken).toBeTruthy()
  })

  test('SuperAdmin: GET /tenants/:id/members lista miembros del tenant', async () => {
    // El admin de A puede ser platform admin si lo marcamos
    await withBypass(() => query(
      `UPDATE users SET is_platform_admin = TRUE WHERE id = $1`,
      [tenantA.user.id]
    ))
    // Re-login para que el flag se refleje en el JWT (no es necesario para
    // requirePlatformAdmin que lo lee fresco, pero confirma flow real).
    const fresh = await loginAs({
      slug: tenantA.tenant.slug,
      email: tenantA.email,
      password: tenantA.password,
    })

    const res = await request(app)
      .get(`/api/platform-admin/tenants/${tenantB.tenant.id}/members`)
      .set('Authorization', `Bearer ${fresh.token}`)
      .expect(200)

    // tenantB tiene su propio admin + el admin de A invitado (membresía manual)
    expect(res.body.length).toBeGreaterThanOrEqual(2)
    const adminAInB = res.body.find(m => m.user_id === tenantA.user.id)
    expect(adminAInB).toBeTruthy()
    expect(adminAInB.role).toBe('member')
    expect(adminAInB.is_home).toBe(false)
  })

  test('SuperAdmin: DELETE /tenants/:id/members/:userId quita membresía', async () => {
    const fresh = await loginAs({
      slug: tenantA.tenant.slug,
      email: tenantA.email,
      password: tenantA.password,
    })

    await request(app)
      .delete(`/api/platform-admin/tenants/${tenantB.tenant.id}/members/${tenantA.user.id}`)
      .set('Authorization', `Bearer ${fresh.token}`)
      .expect(204)

    const { rows } = await withBypass(() => query(
      `SELECT 1 FROM tenant_memberships WHERE user_id = $1 AND tenant_id = $2`,
      [tenantA.user.id, tenantB.tenant.id]
    ))
    expect(rows).toHaveLength(0)
  })

  test('SuperAdmin: no puede quitar membresía del home tenant', async () => {
    const fresh = await loginAs({
      slug: tenantA.tenant.slug,
      email: tenantA.email,
      password: tenantA.password,
    })

    const res = await request(app)
      .delete(`/api/platform-admin/tenants/${tenantA.tenant.id}/members/${tenantA.user.id}`)
      .set('Authorization', `Bearer ${fresh.token}`)
      .expect(400)

    expect(res.body.error).toMatch(/home/i)
  })
})
