'use strict'

/**
 * SaaS v2 — Tests del módulo units (tenant_units + tenant_unit_conversions).
 *
 * Cubre:
 *  - GET lista unidades sembradas (15 default por tenant)
 *  - GET con filtros por unit_type / is_active
 *  - POST crea unidad con validaciones
 *  - Restricción: una sola base por unit_type
 *  - PATCH actualiza, soft-delete (is_active=false)
 *  - Conversiones: lista, crea, restricción same unit_type
 *  - Convert(): cálculo de valores convertidos
 */

const { createTenant, loginAs, authedClient, cleanupTestTenants } = require('../helpers/factory')
const { pool } = require('../../src/db')

afterAll(async () => {
  await cleanupTestTenants()
  await pool.end()
})

describe('SaaS v2: GET /api/process-config/units', () => {
  let client, tenantInfo

  beforeAll(async () => {
    tenantInfo = await createTenant({ label: 'unitslist', planSlug: 'owner' })
    const sess = await loginAs({
      slug: tenantInfo.tenant.slug, email: tenantInfo.email, password: tenantInfo.password,
    })
    client = authedClient({ slug: tenantInfo.tenant.slug, token: sess.token })
  })

  test('Tenant nuevo recibe 15 unidades default sembradas', async () => {
    const res = await client.get('/api/process-config/units').expect(200)
    expect(Array.isArray(res.body)).toBe(true)
    expect(res.body).toHaveLength(15)
    // Verificar que existen las unidades base esperadas
    const baseCodes = res.body.filter(u => u.is_base).map(u => u.code).sort()
    expect(baseCodes).toEqual(['L', 'h', 'kg', 'm', 'm2', 'pza'])
  })

  test('Filtra por unit_type=weight', async () => {
    const res = await client.get('/api/process-config/units?unitType=weight').expect(200)
    expect(res.body).toHaveLength(3)  // kg, g, ton
    res.body.forEach(u => expect(u.unit_type).toBe('weight'))
  })

  test('Filtra por isActive=true (todas las default vienen activas)', async () => {
    const res = await client.get('/api/process-config/units?isActive=true').expect(200)
    expect(res.body).toHaveLength(15)
    res.body.forEach(u => expect(u.is_active).toBe(true))
  })

  test('GET por id devuelve unidad específica', async () => {
    const list = await client.get('/api/process-config/units?unitType=weight').expect(200)
    const kg = list.body.find(u => u.code === 'kg')
    const res = await client.get(`/api/process-config/units/${kg.id}`).expect(200)
    expect(res.body.code).toBe('kg')
    expect(res.body.is_base).toBe(true)
  })

  test('GET por id inexistente devuelve 404', async () => {
    const res = await client.get('/api/process-config/units/00000000-0000-0000-0000-000000000000')
    expect(res.status).toBe(404)
  })
})

describe('SaaS v2: POST /api/process-config/units', () => {
  let client, tenantInfo

  beforeAll(async () => {
    tenantInfo = await createTenant({ label: 'unitscreate', planSlug: 'owner' })
    const sess = await loginAs({
      slug: tenantInfo.tenant.slug, email: tenantInfo.email, password: tenantInfo.password,
    })
    client = authedClient({ slug: tenantInfo.tenant.slug, token: sess.token })
  })

  test('Crea unidad nueva no-base', async () => {
    const res = await client.post('/api/process-config/units', {
      code: 'lb',
      name: 'Libra',
      symbol: 'lb',
      unit_type: 'weight',
      is_base: false,
      decimals: 2,
    }).expect(201)
    expect(res.body.code).toBe('lb')
    expect(res.body.is_base).toBe(false)
    expect(res.body.unit_type).toBe('weight')
  })

  test('Rechaza unit_type inválido', async () => {
    const res = await client.post('/api/process-config/units', {
      code: 'foo', name: 'Foo', symbol: 'f', unit_type: 'invented',
    })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/unit_type/)
  })

  test('Rechaza decimals fuera de rango', async () => {
    const res = await client.post('/api/process-config/units', {
      code: 'wat', name: 'wat', symbol: 'w', unit_type: 'weight', decimals: 10,
    })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/decimals/)
  })

  test('Rechaza código duplicado (409)', async () => {
    // kg ya existe en el seed
    const res = await client.post('/api/process-config/units', {
      code: 'kg', name: 'Kilo2', symbol: 'kg2', unit_type: 'weight',
    })
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/kg/)
  })

  test('Rechaza segunda base del mismo unit_type (409)', async () => {
    // kg ya es base de weight; intentamos crear otra base de weight
    const res = await client.post('/api/process-config/units', {
      code: 'kgnew', name: 'Kilo nuevo', symbol: 'k2',
      unit_type: 'weight', is_base: true,
    })
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/base/)
  })

  test('Faltan campos requeridos → 400', async () => {
    const r1 = await client.post('/api/process-config/units', { name: 'sin code' })
    expect(r1.status).toBe(400)
    const r2 = await client.post('/api/process-config/units', { code: 'x', name: 'y' })
    expect(r2.status).toBe(400)  // falta symbol
  })
})

describe('SaaS v2: PATCH /api/process-config/units/:id (update + soft-delete)', () => {
  let client, tenantInfo, kgId

  beforeAll(async () => {
    tenantInfo = await createTenant({ label: 'unitsupd', planSlug: 'owner' })
    const sess = await loginAs({
      slug: tenantInfo.tenant.slug, email: tenantInfo.email, password: tenantInfo.password,
    })
    client = authedClient({ slug: tenantInfo.tenant.slug, token: sess.token })
    const list = await client.get('/api/process-config/units?unitType=weight').expect(200)
    kgId = list.body.find(u => u.code === 'kg').id
  })

  test('Actualiza nombre y símbolo', async () => {
    const res = await client.patch(`/api/process-config/units/${kgId}`, {
      name: 'Kilogramo (renombrado)',
      symbol: 'Kg',
    }).expect(200)
    expect(res.body.name).toBe('Kilogramo (renombrado)')
    expect(res.body.symbol).toBe('Kg')
    // Otros campos no cambian
    expect(res.body.code).toBe('kg')
    expect(res.body.is_base).toBe(true)
  })

  test('Soft-delete vía is_active=false', async () => {
    const res = await client.patch(`/api/process-config/units/${kgId}`, {
      is_active: false,
    }).expect(200)
    expect(res.body.is_active).toBe(false)
    // Sigue existiendo en la BD
    const get = await client.get(`/api/process-config/units/${kgId}`).expect(200)
    expect(get.body.is_active).toBe(false)
  })

  test('Rechaza decimals fuera de rango', async () => {
    const res = await client.patch(`/api/process-config/units/${kgId}`, { decimals: 9 })
    expect(res.status).toBe(400)
  })

  test('404 para id inexistente', async () => {
    const res = await client.patch(
      '/api/process-config/units/00000000-0000-0000-0000-000000000000',
      { name: 'x' }
    )
    expect(res.status).toBe(404)
  })
})

describe('SaaS v2: GET /api/process-config/unit-conversions', () => {
  let client, tenantInfo

  beforeAll(async () => {
    tenantInfo = await createTenant({ label: 'convget', planSlug: 'owner' })
    const sess = await loginAs({
      slug: tenantInfo.tenant.slug, email: tenantInfo.email, password: tenantInfo.password,
    })
    client = authedClient({ slug: tenantInfo.tenant.slug, token: sess.token })
  })

  test('Tenant nuevo recibe 8 conversiones default sembradas', async () => {
    const res = await client.get('/api/process-config/unit-conversions').expect(200)
    expect(Array.isArray(res.body)).toBe(true)
    expect(res.body).toHaveLength(8)
    // Cada conversión incluye joins con from/to
    res.body.forEach(c => {
      expect(c).toHaveProperty('from_code')
      expect(c).toHaveProperty('to_code')
      expect(c.from_unit_type).toBe(c.to_unit_type)  // SOLO entre mismo tipo
    })
  })

  test('Conversión kg → g tiene factor 1000', async () => {
    const res = await client.get('/api/process-config/unit-conversions').expect(200)
    const kgg = res.body.find(c => c.from_code === 'kg' && c.to_code === 'g')
    expect(kgg).toBeTruthy()
    expect(parseFloat(kgg.factor)).toBe(1000)
  })
})

describe('SaaS v2: POST /api/process-config/unit-conversions', () => {
  let client, tenantInfo, units

  beforeAll(async () => {
    tenantInfo = await createTenant({ label: 'convcreate', planSlug: 'owner' })
    const sess = await loginAs({
      slug: tenantInfo.tenant.slug, email: tenantInfo.email, password: tenantInfo.password,
    })
    client = authedClient({ slug: tenantInfo.tenant.slug, token: sess.token })
    const list = await client.get('/api/process-config/units').expect(200)
    units = Object.fromEntries(list.body.map(u => [u.code, u]))
  })

  test('Crea conversión válida (lb → kg con factor 0.4536)', async () => {
    // Primero crear "lb" (no viene en seed)
    const lbRes = await client.post('/api/process-config/units', {
      code: 'lb', name: 'Libra', symbol: 'lb', unit_type: 'weight',
    }).expect(201)
    const lb = lbRes.body

    const res = await client.post('/api/process-config/unit-conversions', {
      from_unit_id: lb.id,
      to_unit_id:   units.kg.id,
      factor:       0.4536,
    }).expect(201)
    expect(parseFloat(res.body.factor)).toBeCloseTo(0.4536, 4)
  })

  test('Rechaza conversión entre unit_types distintos (weight ↔ volume)', async () => {
    const res = await client.post('/api/process-config/unit-conversions', {
      from_unit_id: units.kg.id,
      to_unit_id:   units.L.id,
      factor:       1,
    })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/unit_type/)
  })

  test('Rechaza factor <= 0', async () => {
    const res = await client.post('/api/process-config/unit-conversions', {
      from_unit_id: units.kg.id,
      to_unit_id:   units.g.id,
      factor:       -5,
    })
    expect(res.status).toBe(400)
  })

  test('Rechaza par duplicado (kg→g ya existe en seed)', async () => {
    const res = await client.post('/api/process-config/unit-conversions', {
      from_unit_id: units.kg.id,
      to_unit_id:   units.g.id,
      factor:       1000,
    })
    expect(res.status).toBe(409)
  })

  test('Rechaza from = to', async () => {
    const res = await client.post('/api/process-config/unit-conversions', {
      from_unit_id: units.kg.id,
      to_unit_id:   units.kg.id,
      factor:       1,
    })
    expect(res.status).toBe(400)
  })
})

describe('SaaS v2: POST /api/process-config/unit-conversions/convert', () => {
  let client, tenantInfo, units

  beforeAll(async () => {
    tenantInfo = await createTenant({ label: 'convcalc', planSlug: 'owner' })
    const sess = await loginAs({
      slug: tenantInfo.tenant.slug, email: tenantInfo.email, password: tenantInfo.password,
    })
    client = authedClient({ slug: tenantInfo.tenant.slug, token: sess.token })
    const list = await client.get('/api/process-config/units').expect(200)
    units = Object.fromEntries(list.body.map(u => [u.code, u]))
  })

  test('Convierte usando la conversión directa (kg → g)', async () => {
    const res = await client.post('/api/process-config/unit-conversions/convert', {
      from_unit_id: units.kg.id,
      to_unit_id:   units.g.id,
      quantity:     5,
    }).expect(200)
    expect(res.body.quantity_out).toBe(5000)
  })

  test('Convierte usando la inversa (g → kg) — calculada al vuelo', async () => {
    const res = await client.post('/api/process-config/unit-conversions/convert', {
      from_unit_id: units.g.id,
      to_unit_id:   units.kg.id,
      quantity:     2500,
    }).expect(200)
    expect(res.body.quantity_out).toBeCloseTo(2.5, 4)
  })

  test('Convierte vía base (ton → g pasa por kg)', async () => {
    // ton → kg (factor 1000) en seed; kg → g (factor 1000) en seed
    // 1 ton = 1000 kg = 1,000,000 g
    const res = await client.post('/api/process-config/unit-conversions/convert', {
      from_unit_id: units.ton.id,
      to_unit_id:   units.g.id,
      quantity:     1,
    }).expect(200)
    expect(res.body.quantity_out).toBeCloseTo(1_000_000, 0)
  })

  test('Rechaza conversión entre unit_types distintos (422)', async () => {
    const res = await client.post('/api/process-config/unit-conversions/convert', {
      from_unit_id: units.kg.id,
      to_unit_id:   units.L.id,
      quantity:     5,
    })
    expect(res.status).toBe(422)
  })

  test('Misma unidad de from y to → devuelve cantidad sin conversión', async () => {
    const res = await client.post('/api/process-config/unit-conversions/convert', {
      from_unit_id: units.kg.id,
      to_unit_id:   units.kg.id,
      quantity:     42,
    }).expect(200)
    expect(res.body.quantity_out).toBe(42)
  })

  test('Body incompleto → 400', async () => {
    const res = await client.post('/api/process-config/unit-conversions/convert', {
      from_unit_id: units.kg.id,
    })
    expect(res.status).toBe(400)
  })
})
