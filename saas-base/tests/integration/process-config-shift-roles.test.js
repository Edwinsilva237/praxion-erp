'use strict'

/**
 * SaaS v2 — Tests de tenant_shift_roles.
 */

const { createTenant, loginAs, authedClient, cleanupTestTenants } = require('../helpers/factory')
const { pool } = require('../../src/db')

afterAll(async () => {
  await cleanupTestTenants()
  await pool.end()
})

describe('SaaS v2: GET /api/process-config/shift-roles', () => {
  let client, tenantInfo

  beforeAll(async () => {
    tenantInfo = await createTenant({ label: 'srread', planSlug: 'owner' })
    const sess = await loginAs({
      slug: tenantInfo.tenant.slug, email: tenantInfo.email, password: tenantInfo.password,
    })
    client = authedClient({ slug: tenantInfo.tenant.slug, token: sess.token })
  })

  test('Tenant nuevo recibe 5 roles default sembrados', async () => {
    const res = await client.get('/api/process-config/shift-roles').expect(200)
    expect(res.body).toHaveLength(5)
    expect(res.body.map(r => r.code)).toEqual([
      'capturista', 'supervisor', 'calidad', 'alimentador', 'maquinista',
    ])
  })

  test('Capturista es el único is_required por default', async () => {
    const res = await client.get('/api/process-config/shift-roles').expect(200)
    const required = res.body.filter(r => r.is_required)
    expect(required).toHaveLength(1)
    expect(required[0].code).toBe('capturista')
  })

  test('capturista, supervisor y maquinista son is_unique_per_shift; calidad y alimentador no', async () => {
    const res = await client.get('/api/process-config/shift-roles').expect(200)
    const byCode = Object.fromEntries(res.body.map(r => [r.code, r]))
    expect(byCode.capturista.is_unique_per_shift).toBe(true)
    expect(byCode.supervisor.is_unique_per_shift).toBe(true)
    expect(byCode.maquinista.is_unique_per_shift).toBe(true)
    expect(byCode.calidad.is_unique_per_shift).toBe(false)
    expect(byCode.alimentador.is_unique_per_shift).toBe(false)
  })

  test('Capabilities default correctas (capturista can_capture, supervisor can_validate)', async () => {
    const res = await client.get('/api/process-config/shift-roles').expect(200)
    const byCode = Object.fromEntries(res.body.map(r => [r.code, r]))
    expect(byCode.capturista.can_capture).toBe(true)
    expect(byCode.capturista.can_handover).toBe(true)
    expect(byCode.capturista.can_validate).toBe(false)
    expect(byCode.supervisor.can_validate).toBe(true)
    expect(byCode.supervisor.can_handover).toBe(true)
    expect(byCode.supervisor.can_capture).toBe(false)
    expect(byCode.calidad.can_capture).toBe(false)
    expect(byCode.alimentador.can_capture).toBe(false)
  })

  test('Filtra por isActive=true', async () => {
    const res = await client.get('/api/process-config/shift-roles?isActive=true').expect(200)
    expect(res.body).toHaveLength(5)
  })

  test('Filtra por isRequired=true', async () => {
    const res = await client.get('/api/process-config/shift-roles?isRequired=true').expect(200)
    expect(res.body).toHaveLength(1)
    expect(res.body[0].code).toBe('capturista')
  })

  test('GET por id devuelve un rol', async () => {
    const list = await client.get('/api/process-config/shift-roles').expect(200)
    const cap = list.body.find(r => r.code === 'capturista')
    const res = await client.get(`/api/process-config/shift-roles/${cap.id}`).expect(200)
    expect(res.body.code).toBe('capturista')
    expect(res.body.is_required).toBe(true)
  })

  test('GET por id inexistente devuelve 404', async () => {
    const res = await client.get('/api/process-config/shift-roles/00000000-0000-0000-0000-000000000000')
    expect(res.status).toBe(404)
  })
})

describe('SaaS v2: POST /api/process-config/shift-roles', () => {
  let client, tenantInfo

  beforeAll(async () => {
    tenantInfo = await createTenant({ label: 'srcreate', planSlug: 'owner' })
    const sess = await loginAs({
      slug: tenantInfo.tenant.slug, email: tenantInfo.email, password: tenantInfo.password,
    })
    client = authedClient({ slug: tenantInfo.tenant.slug, token: sess.token })
  })

  test('Crea un rol nuevo (encargado de turno)', async () => {
    const res = await client.post('/api/process-config/shift-roles', {
      code: 'encargado',
      name: 'Encargado de turno',
      is_unique_per_shift: true,
      can_validate: true,
      can_handover: true,
      sort_order: 25,
    }).expect(201)
    expect(res.body.code).toBe('encargado')
    expect(res.body.is_required).toBe(false)
    expect(res.body.is_unique_per_shift).toBe(true)
    expect(res.body.can_validate).toBe(true)
    expect(res.body.is_active).toBe(true)
  })

  test('Acepta camelCase en body', async () => {
    const res = await client.post('/api/process-config/shift-roles', {
      code: 'auxiliar',
      name: 'Auxiliar',
      isUniquePerShift: false,
      canCapture: true,
    }).expect(201)
    expect(res.body.is_unique_per_shift).toBe(false)
    expect(res.body.can_capture).toBe(true)
  })

  test('Rechaza POST sin code', async () => {
    const res = await client.post('/api/process-config/shift-roles', {
      name: 'Sin code',
    })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/code/)
  })

  test('Rechaza POST sin name', async () => {
    const res = await client.post('/api/process-config/shift-roles', {
      code: 'sin_name',
    })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/name/)
  })

  test('Rechaza code duplicado (409)', async () => {
    const res = await client.post('/api/process-config/shift-roles', {
      code: 'capturista', name: 'Duplicado',
    })
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/code/)
  })

  test('Rechaza boolean inválido en is_required', async () => {
    const res = await client.post('/api/process-config/shift-roles', {
      code: 'malo', name: 'Malo', is_required: 'true',
    })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/is_required/)
  })
})

describe('SaaS v2: PATCH /api/process-config/shift-roles/:id', () => {
  let client, tenantInfo, capId, supId, calId, alimId, maqId

  beforeAll(async () => {
    tenantInfo = await createTenant({ label: 'srupd', planSlug: 'owner' })
    const sess = await loginAs({
      slug: tenantInfo.tenant.slug, email: tenantInfo.email, password: tenantInfo.password,
    })
    client = authedClient({ slug: tenantInfo.tenant.slug, token: sess.token })
    const list = await client.get('/api/process-config/shift-roles').expect(200)
    const byCode = Object.fromEntries(list.body.map(r => [r.code, r.id]))
    capId  = byCode.capturista
    supId  = byCode.supervisor
    calId  = byCode.calidad
    alimId = byCode.alimentador
    maqId  = byCode.maquinista
  })

  test('Actualiza name', async () => {
    const res = await client.patch(`/api/process-config/shift-roles/${calId}`, {
      name: 'Inspector de calidad',
    }).expect(200)
    expect(res.body.name).toBe('Inspector de calidad')
  })

  test('Cambia can_capture en supervisor a true', async () => {
    const res = await client.patch(`/api/process-config/shift-roles/${supId}`, {
      can_capture: true,
    }).expect(200)
    expect(res.body.can_capture).toBe(true)
  })

  test('Cambia is_unique_per_shift de maquinista a false', async () => {
    const res = await client.patch(`/api/process-config/shift-roles/${maqId}`, {
      is_unique_per_shift: false,
    }).expect(200)
    expect(res.body.is_unique_per_shift).toBe(false)
  })

  test('Soft-delete (is_active=false) de un rol no-requerido', async () => {
    const res = await client.patch(`/api/process-config/shift-roles/${alimId}`, {
      is_active: false,
    }).expect(200)
    expect(res.body.is_active).toBe(false)
  })

  test('Rechaza desactivar el último rol requerido activo', async () => {
    // capturista es el único is_required=true; intentar desactivarlo debe fallar
    const res = await client.patch(`/api/process-config/shift-roles/${capId}`, {
      is_active: false,
    })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/requerido/)
  })

  test('Rechaza quitar is_required del último requerido activo', async () => {
    const res = await client.patch(`/api/process-config/shift-roles/${capId}`, {
      is_required: false,
    })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/requerido/)
  })

  test('Permite marcar otro rol como is_required y luego desmarcar el original', async () => {
    // Marcar supervisor como requerido
    await client.patch(`/api/process-config/shift-roles/${supId}`, {
      is_required: true,
    }).expect(200)
    // Ahora sí se puede desmarcar capturista
    const res = await client.patch(`/api/process-config/shift-roles/${capId}`, {
      is_required: false,
    }).expect(200)
    expect(res.body.is_required).toBe(false)
  })

  test('Rechaza body sin campos válidos', async () => {
    const res = await client.patch(`/api/process-config/shift-roles/${calId}`, {})
    expect(res.status).toBe(400)
  })

  test('404 para id inexistente', async () => {
    const res = await client.patch(
      '/api/process-config/shift-roles/00000000-0000-0000-0000-000000000000',
      { name: 'x' }
    )
    expect(res.status).toBe(404)
  })
})
