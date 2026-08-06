'use strict'

// GET /api/users?permission=recurso:accion&active=1
// Filtro usado por Producción → Programación de turnos para mostrar solo
// usuarios que pueden capturar (production:create) en vez de todo el tenant.

const { createTenant, loginAs, authedClient, cleanupTestTenants } = require('../helpers/factory')
const { pool } = require('../../src/db')

describe('GET /users con filtro por permiso', () => {
  let tenant, client
  let capturista, sinRoles

  beforeAll(async () => {
    // Plan 'owner' — el free limita usuarios y la 2a invitación daría 402.
    tenant = await createTenant({ label: 'userperm', planSlug: 'owner' })
    const sess = await loginAs({ slug: tenant.tenant.slug, email: tenant.email, password: tenant.password })
    client = authedClient({ slug: tenant.tenant.slug, token: sess.token })

    // Usuario con un rol SIN production:create: no debe aparecer al filtrar.
    // (Invitar con roleIds: [] asigna el rol de sistema 'member', que sí
    // puede capturar — por eso creamos un rol vacío explícito.)
    const emptyRole = await client.post('/api/roles', {
      name: 'Rol sin captura (test)',
      permissionIds: [],
    }).expect(201)

    const resNoRole = await client.post('/api/users/invite', {
      email: `${tenant.tenant.slug}-sinroles@test.local`,
      fullName: 'Usuario Sin Captura',
      roleIds: [emptyRole.body.id],
    }).expect(201)
    sinRoles = resNoRole.body.user

    // Usuario con un rol que SÍ otorga production:create — usamos el mismo
    // rol del admin (el provision le asigna un rol con todos los permisos).
    const adminDetail = await client.get(`/api/users/${tenant.user.id}`).expect(200)
    const adminRoleIds = (adminDetail.body.roles || []).map(r => r.id)
    expect(adminRoleIds.length).toBeGreaterThan(0)

    const resCap = await client.post('/api/users/invite', {
      email: `${tenant.tenant.slug}-capturista@test.local`,
      fullName: 'Usuario Capturista',
      roleIds: adminRoleIds,
    }).expect(201)
    capturista = resCap.body.user
  })

  afterAll(async () => {
    await cleanupTestTenants()
    await pool.end()
  })

  test('sin filtro devuelve a todos', async () => {
    const res = await client.get('/api/users?limit=100').expect(200)
    const ids = res.body.data.map(u => u.id)
    expect(ids).toContain(tenant.user.id)
    expect(ids).toContain(sinRoles.id)
    expect(ids).toContain(capturista.id)
  })

  test('permission=production:create excluye a usuarios sin ese permiso', async () => {
    const res = await client.get('/api/users?limit=100&permission=production:create').expect(200)
    const ids = res.body.data.map(u => u.id)
    expect(ids).toContain(tenant.user.id)     // admin puede capturar
    expect(ids).toContain(capturista.id)
    expect(ids).not.toContain(sinRoles.id)
    // El total pagina sobre el conjunto filtrado, no sobre todo el tenant.
    expect(res.body.total).toBe(res.body.data.length)
  })

  test('active=1 excluye a usuarios desactivados', async () => {
    await client.patch(`/api/users/${capturista.id}`, { isActive: false }).expect(200)

    const res = await client
      .get('/api/users?limit=100&permission=production:create&active=1')
      .expect(200)
    const ids = res.body.data.map(u => u.id)
    expect(ids).toContain(tenant.user.id)
    expect(ids).not.toContain(capturista.id)
  })

  test('formato inválido de permission → 400', async () => {
    await client.get(`/api/users?permission=production'--`).expect(400)
  })
})
