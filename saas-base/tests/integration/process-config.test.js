'use strict'

/**
 * SaaS v2 — Tests del módulo process-config.
 *
 * Primer módulo de la conversión SaaS v2. Cubre:
 *  - GET retorna config con defaults para tenant nuevo
 *  - PATCH actualiza flags individuales y múltiples
 *  - Validación de enums (cost_method, allergen_mode, etc.)
 *  - Validación de tipos (boolean, integer)
 *  - Filtrado de campos no permitidos
 */

const { createTenant, loginAs, authedClient, cleanupTestTenants } = require('../helpers/factory')
const { pool } = require('../../src/db')

afterAll(async () => {
  await cleanupTestTenants()
  await pool.end()
})

describe('SaaS v2: GET /api/process-config', () => {
  let client, tenantInfo

  beforeAll(async () => {
    tenantInfo = await createTenant({ label: 'pcgread', planSlug: 'owner' })
    const sess = await loginAs({
      slug: tenantInfo.tenant.slug,
      email: tenantInfo.email,
      password: tenantInfo.password,
    })
    client = authedClient({ slug: tenantInfo.tenant.slug, token: sess.token })
  })

  test('Retorna configuración con defaults para tenant nuevo', async () => {
    const res = await client.get('/api/process-config').expect(200)

    expect(res.body.tenant_id).toBe(tenantInfo.tenant.id)
    // Defaults documentados en §2.2.1
    expect(res.body.uses_lots).toBe(false)
    expect(res.body.uses_expiry).toBe(false)
    expect(res.body.uses_fefo).toBe(false)
    expect(res.body.uses_handover).toBe(true)
    expect(res.body.uses_supervisor).toBe(true)
    expect(res.body.supervisor_validates).toBe(true)
    expect(res.body.pt_goes_to_wip_first).toBe(true)
    expect(res.body.mp_goes_to_wip_first).toBe(true)
    expect(res.body.allow_second_quality_in_order).toBe(false)
    expect(res.body.default_intra_shift_proration).toBe('time')
    expect(res.body.cost_method).toBe('weighted_avg')
    expect(res.body.treat_abnormal_scrap_as_loss).toBe(true)
    expect(res.body.allergen_mode).toBe('priority_only')
    expect(res.body.expiry_alert_days).toBeNull()
    expect(res.body.lot_number_pattern).toBeNull()
    expect(res.body.operation_mode).toBe('industrial')
    expect(res.body.allow_adhoc_shifts).toBe(false)
    expect(res.body.simplified_overhead).toBe(false)
  })
})

describe('SaaS v2: PATCH /api/process-config', () => {
  let client, tenantInfo

  beforeAll(async () => {
    tenantInfo = await createTenant({ label: 'pcgwrite', planSlug: 'owner' })
    const sess = await loginAs({
      slug: tenantInfo.tenant.slug,
      email: tenantInfo.email,
      password: tenantInfo.password,
    })
    client = authedClient({ slug: tenantInfo.tenant.slug, token: sess.token })
  })

  test('Actualiza un solo flag (uses_lots=true)', async () => {
    const res = await client.patch('/api/process-config', {
      uses_lots: true,
    }).expect(200)
    expect(res.body.uses_lots).toBe(true)
    // Los demás defaults se mantienen
    expect(res.body.uses_supervisor).toBe(true)
    expect(res.body.cost_method).toBe('weighted_avg')
  })

  test('Actualiza múltiples flags en una sola request', async () => {
    const res = await client.patch('/api/process-config', {
      uses_expiry: true,
      uses_fefo: true,
      cost_method: 'fifo',
      operation_mode: 'small',
      expiry_alert_days: 14,
    }).expect(200)
    expect(res.body.uses_expiry).toBe(true)
    expect(res.body.uses_fefo).toBe(true)
    expect(res.body.cost_method).toBe('fifo')
    expect(res.body.operation_mode).toBe('small')
    expect(res.body.expiry_alert_days).toBe(14)
  })

  test('Persiste los cambios — GET después de PATCH refleja la actualización', async () => {
    await client.patch('/api/process-config', { allergen_mode: 'strict' }).expect(200)
    const res = await client.get('/api/process-config').expect(200)
    expect(res.body.allergen_mode).toBe('strict')
  })

  test('Rechaza enum inválido en cost_method', async () => {
    const res = await client.patch('/api/process-config', { cost_method: 'invented_method' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/cost_method/)
  })

  test('Rechaza enum inválido en operation_mode', async () => {
    const res = await client.patch('/api/process-config', { operation_mode: 'mega_industrial' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/operation_mode/)
  })

  test('Rechaza enum inválido en allergen_mode', async () => {
    const res = await client.patch('/api/process-config', { allergen_mode: 'maybe' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/allergen_mode/)
  })

  test('Rechaza tipo no-boolean en uses_lots', async () => {
    const res = await client.patch('/api/process-config', { uses_lots: 'si' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/uses_lots/)
  })

  test('Rechaza expiry_alert_days negativo', async () => {
    const res = await client.patch('/api/process-config', { expiry_alert_days: -5 })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/expiry_alert_days/)
  })

  test('Acepta expiry_alert_days = null (sin alertas)', async () => {
    const res = await client.patch('/api/process-config', { expiry_alert_days: null }).expect(200)
    expect(res.body.expiry_alert_days).toBeNull()
  })

  test('Filtra silenciosamente campos no permitidos', async () => {
    // tenant_id no debe poderse cambiar, ni columns inventadas
    const res = await client.patch('/api/process-config', {
      uses_lots: false,
      tenant_id: 'fake-tenant',
      drop_table_users: true,
      created_at: '2020-01-01',
    }).expect(200)
    // Sólo uses_lots se aplicó; tenant_id se ignoró
    expect(res.body.uses_lots).toBe(false)
    expect(res.body.tenant_id).toBe(tenantInfo.tenant.id)
  })

  test('Body vacío devuelve 400', async () => {
    const res = await client.patch('/api/process-config', {})
    expect(res.status).toBe(400)
  })

  test('Body solo con campos no permitidos devuelve 400', async () => {
    const res = await client.patch('/api/process-config', { tenant_id: 'foo' })
    expect(res.status).toBe(400)
  })
})

describe('SaaS v2: Permisos process-config', () => {
  let client, tenantInfo

  beforeAll(async () => {
    tenantInfo = await createTenant({ label: 'pcgperm', planSlug: 'owner' })
    const sess = await loginAs({
      slug: tenantInfo.tenant.slug,
      email: tenantInfo.email,
      password: tenantInfo.password,
    })
    client = authedClient({ slug: tenantInfo.tenant.slug, token: sess.token })
  })

  test('Admin del tenant (owner) puede leer su config', async () => {
    await client.get('/api/process-config').expect(200)
  })

  test('Admin del tenant (owner) puede modificar su config', async () => {
    await client.patch('/api/process-config', { uses_lots: true }).expect(200)
  })

  test('Sin auth devuelve 401', async () => {
    const supertest = require('supertest')
    const app = require('../../src/app')
    const noAuthRes = await supertest(app)
      .get('/api/process-config')
      .set('X-Tenant-Slug', tenantInfo.tenant.slug)
    expect(noAuthRes.status).toBe(401)
  })
})
