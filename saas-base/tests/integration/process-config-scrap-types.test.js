'use strict'

/**
 * SaaS v2 — Tests de tenant_scrap_types.
 *
 * Cubre:
 *  - Seed default (4 tipos: arranque, operacion, contaminada, desecho)
 *  - CRUD con validaciones
 *  - linked_raw_material_id (validar existencia)
 *  - allows_reprocess_of_expired solo si destination=reprocess
 *  - default_recovery_value_pct rango [0,100]
 */

const { createTenant, loginAs, authedClient, cleanupTestTenants } = require('../helpers/factory')
const { pool } = require('../../src/db')

afterAll(async () => {
  await cleanupTestTenants()
  await pool.end()
})

describe('SaaS v2: GET /api/process-config/scrap-types', () => {
  let client, tenantInfo

  beforeAll(async () => {
    tenantInfo = await createTenant({ label: 'scrlist', planSlug: 'owner' })
    const sess = await loginAs({
      slug: tenantInfo.tenant.slug, email: tenantInfo.email, password: tenantInfo.password,
    })
    client = authedClient({ slug: tenantInfo.tenant.slug, token: sess.token })
  })

  test('Tenant nuevo recibe 4 tipos default sembrados', async () => {
    const res = await client.get('/api/process-config/scrap-types').expect(200)
    expect(res.body).toHaveLength(4)
    const codes = res.body.map(t => t.code).sort()
    expect(codes).toEqual(['arranque', 'contaminada', 'desecho', 'operacion'])
  })

  test('Tipo "operacion" trae destination=reprocess y recovery=30', async () => {
    const res = await client.get('/api/process-config/scrap-types').expect(200)
    const operacion = res.body.find(t => t.code === 'operacion')
    expect(operacion.default_destination).toBe('reprocess')
    expect(parseFloat(operacion.default_recovery_value_pct)).toBe(30)
    expect(operacion.is_normal).toBe(true)
  })

  test('Defaults vienen con linked_raw_material_id=null', async () => {
    const res = await client.get('/api/process-config/scrap-types').expect(200)
    res.body.forEach(t => {
      expect(t.linked_raw_material_id).toBeNull()
    })
  })

  test('Filtra por destination=discard', async () => {
    const res = await client.get('/api/process-config/scrap-types?destination=discard').expect(200)
    // arranque, contaminada, desecho → 3 con discard
    expect(res.body).toHaveLength(3)
    res.body.forEach(t => expect(t.default_destination).toBe('discard'))
  })
})

describe('SaaS v2: POST /api/process-config/scrap-types', () => {
  let client, tenantInfo

  beforeAll(async () => {
    tenantInfo = await createTenant({ label: 'scrcreate', planSlug: 'owner' })
    const sess = await loginAs({
      slug: tenantInfo.tenant.slug, email: tenantInfo.email, password: tenantInfo.password,
    })
    client = authedClient({ slug: tenantInfo.tenant.slug, token: sess.token })
  })

  test('Crea tipo "rotas" (frituras) con recovery=30%', async () => {
    const res = await client.post('/api/process-config/scrap-types', {
      code: 'rotas',
      name: 'Papas rotas',
      default_destination: 'reprocess',
      default_recovery_value_pct: 30,
    }).expect(201)
    expect(res.body.code).toBe('rotas')
    expect(parseFloat(res.body.default_recovery_value_pct)).toBe(30)
  })

  test('Crea tipo anormal (is_normal=false)', async () => {
    const res = await client.post('/api/process-config/scrap-types', {
      code: 'derrame',
      name: 'Derrame accidental',
      default_destination: 'discard',
      is_normal: false,
    }).expect(201)
    expect(res.body.is_normal).toBe(false)
  })

  test('Rechaza default_destination inválido', async () => {
    const res = await client.post('/api/process-config/scrap-types', {
      code: 'foo', name: 'Foo', default_destination: 'invented',
    })
    expect(res.status).toBe(400)
  })

  test('Rechaza recovery > 100', async () => {
    const res = await client.post('/api/process-config/scrap-types', {
      code: 'foo2', name: 'Foo', default_destination: 'sell',
      default_recovery_value_pct: 150,
    })
    expect(res.status).toBe(400)
  })

  test('Rechaza recovery negativo', async () => {
    const res = await client.post('/api/process-config/scrap-types', {
      code: 'foo3', name: 'Foo', default_destination: 'sell',
      default_recovery_value_pct: -5,
    })
    expect(res.status).toBe(400)
  })

  test('Rechaza allows_reprocess_of_expired si destination ≠ reprocess', async () => {
    const res = await client.post('/api/process-config/scrap-types', {
      code: 'foo4', name: 'Foo',
      default_destination: 'discard',
      allows_reprocess_of_expired: true,
    })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/reprocess/)
  })

  test('Acepta allows_reprocess_of_expired=true si destination=reprocess', async () => {
    const res = await client.post('/api/process-config/scrap-types', {
      code: 'reproc_exp', name: 'Reprocesable expirado',
      default_destination: 'reprocess',
      allows_reprocess_of_expired: true,
    }).expect(201)
    expect(res.body.allows_reprocess_of_expired).toBe(true)
  })

  test('Rechaza linked_raw_material_id que no existe', async () => {
    const res = await client.post('/api/process-config/scrap-types', {
      code: 'foo5', name: 'Foo',
      default_destination: 'reprocess',
      linked_raw_material_id: '00000000-0000-0000-0000-000000000000',
    })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/linked/)
  })

  test('Acepta linked_raw_material_id válido (regrind)', async () => {
    // Primero crear un raw material
    const rmRes = await client.post('/api/raw-materials', {
      name: 'Regrind PP',
      resinType: 'PP',
      materialType: 'regrind',
    }).expect(201)

    const res = await client.post('/api/process-config/scrap-types', {
      code: 'regrind_link', name: 'Regrind vinculado',
      default_destination: 'reprocess',
      default_recovery_value_pct: 80,
      linked_raw_material_id: rmRes.body.id,
    }).expect(201)
    expect(res.body.linked_raw_material_id).toBe(rmRes.body.id)
  })

  test('Rechaza código duplicado', async () => {
    const res = await client.post('/api/process-config/scrap-types', {
      code: 'arranque', name: 'Dup', default_destination: 'discard',
    })
    expect(res.status).toBe(409)
  })
})

describe('SaaS v2: PATCH /api/process-config/scrap-types/:id', () => {
  let client, tenantInfo, operacionId, arranqueId

  beforeAll(async () => {
    tenantInfo = await createTenant({ label: 'scrupd', planSlug: 'owner' })
    const sess = await loginAs({
      slug: tenantInfo.tenant.slug, email: tenantInfo.email, password: tenantInfo.password,
    })
    client = authedClient({ slug: tenantInfo.tenant.slug, token: sess.token })
    const list = await client.get('/api/process-config/scrap-types').expect(200)
    operacionId = list.body.find(t => t.code === 'operacion').id
    arranqueId  = list.body.find(t => t.code === 'arranque').id
  })

  test('Actualiza name y recovery_value', async () => {
    const res = await client.patch(`/api/process-config/scrap-types/${operacionId}`, {
      name: 'Merma de operación',
      default_recovery_value_pct: 50,
    }).expect(200)
    expect(res.body.name).toBe('Merma de operación')
    expect(parseFloat(res.body.default_recovery_value_pct)).toBe(50)
  })

  test('Cambia destination y allows_reprocess_of_expired juntos', async () => {
    const res = await client.patch(`/api/process-config/scrap-types/${operacionId}`, {
      default_destination: 'reprocess',
      allows_reprocess_of_expired: true,
    }).expect(200)
    expect(res.body.allows_reprocess_of_expired).toBe(true)
  })

  test('Rechaza recovery fuera de rango', async () => {
    const res = await client.patch(`/api/process-config/scrap-types/${arranqueId}`, {
      default_recovery_value_pct: 200,
    })
    expect(res.status).toBe(400)
  })

  test('Soft-delete vía is_active=false', async () => {
    const res = await client.patch(`/api/process-config/scrap-types/${arranqueId}`, {
      is_active: false,
    }).expect(200)
    expect(res.body.is_active).toBe(false)
  })

  test('404 para id inexistente', async () => {
    const res = await client.patch(
      '/api/process-config/scrap-types/00000000-0000-0000-0000-000000000000',
      { name: 'x' }
    )
    expect(res.status).toBe(404)
  })
})
