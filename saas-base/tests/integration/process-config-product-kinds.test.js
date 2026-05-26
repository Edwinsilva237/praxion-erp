'use strict'

/**
 * SaaS v2 — Tests de tenant_product_kinds.
 *
 * Cubre: lista (defaults vacíos), crear, validar meta-schema, auto-increment
 * de version, FKs cross-catálogo, soft-delete, política de evolution básica.
 */

const { createTenant, loginAs, authedClient, cleanupTestTenants } = require('../helpers/factory')
const { pool } = require('../../src/db')

afterAll(async () => {
  await cleanupTestTenants()
  await pool.end()
})

describe('SaaS v2: GET /api/process-config/product-kinds', () => {
  let client, tenantInfo

  beforeAll(async () => {
    tenantInfo = await createTenant({ label: 'pkread', planSlug: 'owner' })
    const sess = await loginAs({
      slug: tenantInfo.tenant.slug, email: tenantInfo.email, password: tenantInfo.password,
    })
    client = authedClient({ slug: tenantInfo.tenant.slug, token: sess.token })
  })

  test('Tenant nuevo tiene tabla vacía (no hay seed default)', async () => {
    const res = await client.get('/api/process-config/product-kinds').expect(200)
    expect(res.body).toEqual([])
  })

  test('GET por id inexistente → 404', async () => {
    const res = await client.get('/api/process-config/product-kinds/00000000-0000-0000-0000-000000000000')
    expect(res.status).toBe(404)
  })

  test('Filtra por isProduced después de crear uno is_produced=false', async () => {
    // Crear uno de reventa
    await client.post('/api/process-config/product-kinds', {
      code: 'reventa_x', name: 'Producto reventa', is_produced: false,
    }).expect(201)
    // Crear uno producido
    await client.post('/api/process-config/product-kinds', {
      code: 'fab_y', name: 'Fabricado Y', is_produced: true,
    }).expect(201)

    const produced = await client.get('/api/process-config/product-kinds?isProduced=true').expect(200)
    expect(produced.body).toHaveLength(1)
    expect(produced.body[0].code).toBe('fab_y')

    const notProduced = await client.get('/api/process-config/product-kinds?isProduced=false').expect(200)
    expect(notProduced.body).toHaveLength(1)
    expect(notProduced.body[0].code).toBe('reventa_x')
  })
})

describe('SaaS v2: POST /api/process-config/product-kinds (básico)', () => {
  let client, tenantInfo, kgUnitId, primeraGradeId

  beforeAll(async () => {
    tenantInfo = await createTenant({ label: 'pkcreate', planSlug: 'owner' })
    const sess = await loginAs({
      slug: tenantInfo.tenant.slug, email: tenantInfo.email, password: tenantInfo.password,
    })
    client = authedClient({ slug: tenantInfo.tenant.slug, token: sess.token })
    const units  = await client.get('/api/process-config/units').expect(200)
    const grades = await client.get('/api/process-config/quality-grades').expect(200)
    kgUnitId       = units.body.find(u => u.code === 'kg').id
    primeraGradeId = grades.body.find(g => g.grade_number === 1).id
  })

  test('Crea kind mínimo (sin schemas) → schemas default vacíos', async () => {
    const res = await client.post('/api/process-config/product-kinds', {
      code: 'minimo', name: 'Mínimo',
    }).expect(201)
    expect(res.body.code).toBe('minimo')
    expect(res.body.is_produced).toBe(true)
    expect(res.body.attribute_schema).toEqual({ version: 1, fields: [] })
    expect(res.body.capture_schema).toEqual({ version: 1, fields: [] })
  })

  test('Crea palomitas_dulces con attribute_schema y capture_schema completos', async () => {
    const res = await client.post('/api/process-config/product-kinds', {
      code: 'palomitas_dulces',
      name: 'Palomitas dulces',
      is_produced: true,
      base_unit_id: kgUnitId,
      default_quality_grade_id: primeraGradeId,
      requires_lots: true,
      default_shelf_life_days: 180,
      attribute_schema: {
        fields: [
          { code: 'sabor', label: 'Sabor', type: 'select',
            options: ['mantequilla', 'caramelo', 'queso'], required: true },
          { code: 'tamano_bolsa', label: 'Tamaño bolsa', type: 'select',
            options: ['50g', '100g', '200g'], required: true },
          { code: 'es_organico', label: 'Orgánico', type: 'boolean', default: false },
        ],
      },
      capture_schema: {
        fields: [
          { code: 'peso_kg', label: 'Peso (kg)', type: 'number', unit_code: 'kg',
            required: true, validation: { min: 0, max: 1000 } },
          { code: 'color_observado', label: 'Color', type: 'select',
            options: ['blanco', 'amarillento'], required: true, lot_critical: true },
        ],
      },
    }).expect(201)

    expect(res.body.code).toBe('palomitas_dulces')
    expect(res.body.base_unit_id).toBe(kgUnitId)
    expect(res.body.default_quality_grade_id).toBe(primeraGradeId)
    expect(res.body.requires_lots).toBe(true)
    expect(res.body.default_shelf_life_days).toBe(180)
    expect(res.body.attribute_schema.version).toBe(1)
    expect(res.body.attribute_schema.fields).toHaveLength(3)
    expect(res.body.capture_schema.fields).toHaveLength(2)
  })

  test('GET incluye base_unit_code y default_quality_grade_code', async () => {
    const list = await client.get('/api/process-config/product-kinds').expect(200)
    const palomitas = list.body.find(k => k.code === 'palomitas_dulces')
    expect(palomitas.base_unit_code).toBe('kg')
    expect(palomitas.default_quality_grade_code).toBe('primera')
    expect(palomitas.default_quality_grade_number).toBe(1)
  })

  test('Acepta capture_schema con ui_hint y presets (passthrough)', async () => {
    const res = await client.post('/api/process-config/product-kinds', {
      code: 'con_presets',
      name: 'Con presets',
      capture_schema: {
        fields: [
          {
            code: 'unidades', label: 'Unidades', type: 'number', default: 24,
            ui_hint: 'preset_buttons',
            presets: [
              { label: 'Caja completa', value: 24 },
              { label: 'Media caja', value: 12 },
            ],
          },
        ],
      },
    }).expect(201)
    expect(res.body.capture_schema.fields[0].ui_hint).toBe('preset_buttons')
    expect(res.body.capture_schema.fields[0].presets).toHaveLength(2)
  })

  test('Acepta camelCase en body', async () => {
    const res = await client.post('/api/process-config/product-kinds', {
      code: 'camel_case',
      name: 'CamelCase',
      isProduced: false,
      baseUnitId: kgUnitId,
      defaultShelfLifeDays: 30,
    }).expect(201)
    expect(res.body.is_produced).toBe(false)
    expect(res.body.base_unit_id).toBe(kgUnitId)
    expect(res.body.default_shelf_life_days).toBe(30)
  })

  test('Rechaza code duplicado (409)', async () => {
    const res = await client.post('/api/process-config/product-kinds', {
      code: 'palomitas_dulces', name: 'Dup',
    })
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/code/)
  })

  test('Rechaza POST sin code', async () => {
    const res = await client.post('/api/process-config/product-kinds', { name: 'Sin code' })
    expect(res.status).toBe(400)
  })

  test('Rechaza default_shelf_life_days <= 0', async () => {
    const res = await client.post('/api/process-config/product-kinds', {
      code: 'shelf_bad', name: 'Bad', default_shelf_life_days: 0,
    })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/shelf_life/)
  })

  test('Rechaza base_unit_id de otro tenant', async () => {
    const res = await client.post('/api/process-config/product-kinds', {
      code: 'unit_bad', name: 'Bad',
      base_unit_id: '00000000-0000-0000-0000-000000000000',
    })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/base_unit_id/)
  })

  test('Rechaza default_quality_grade_id inexistente', async () => {
    const res = await client.post('/api/process-config/product-kinds', {
      code: 'grade_bad', name: 'Bad',
      default_quality_grade_id: '00000000-0000-0000-0000-000000000000',
    })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/quality_grade/)
  })
})

describe('SaaS v2: POST product-kinds — validación de meta-schema', () => {
  let client, tenantInfo

  beforeAll(async () => {
    tenantInfo = await createTenant({ label: 'pkschema', planSlug: 'owner' })
    const sess = await loginAs({
      slug: tenantInfo.tenant.slug, email: tenantInfo.email, password: tenantInfo.password,
    })
    client = authedClient({ slug: tenantInfo.tenant.slug, token: sess.token })
  })

  test('Rechaza field con type inválido', async () => {
    const res = await client.post('/api/process-config/product-kinds', {
      code: 'bad1', name: 'Bad',
      attribute_schema: {
        fields: [{ code: 'x', label: 'X', type: 'unknown_type' }],
      },
    })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/attribute_schema/)
  })

  test('Rechaza field sin label', async () => {
    const res = await client.post('/api/process-config/product-kinds', {
      code: 'bad2', name: 'Bad',
      capture_schema: {
        fields: [{ code: 'x', type: 'text' }],
      },
    })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/label/)
  })

  test('Rechaza code de field con caracteres inválidos (mayúsculas/espacios)', async () => {
    const res = await client.post('/api/process-config/product-kinds', {
      code: 'bad3', name: 'Bad',
      attribute_schema: {
        fields: [{ code: 'Mi Campo', label: 'X', type: 'text' }],
      },
    })
    expect(res.status).toBe(400)
  })

  test('Rechaza select sin options', async () => {
    const res = await client.post('/api/process-config/product-kinds', {
      code: 'bad4', name: 'Bad',
      attribute_schema: {
        fields: [{ code: 'sabor', label: 'Sabor', type: 'select' }],
      },
    })
    expect(res.status).toBe(400)
  })

  test('Rechaza multiselect con options vacío', async () => {
    const res = await client.post('/api/process-config/product-kinds', {
      code: 'bad5', name: 'Bad',
      attribute_schema: {
        fields: [{ code: 'tags', label: 'Tags', type: 'multiselect', options: [] }],
      },
    })
    expect(res.status).toBe(400)
  })

  test('Rechaza fields con codes duplicados', async () => {
    const res = await client.post('/api/process-config/product-kinds', {
      code: 'bad6', name: 'Bad',
      attribute_schema: {
        fields: [
          { code: 'sabor', label: 'Sabor', type: 'text' },
          { code: 'sabor', label: 'Sabor 2', type: 'text' },
        ],
      },
    })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/duplicados/)
  })

  test('Acepta schema en formato array plano (compat con design doc)', async () => {
    const res = await client.post('/api/process-config/product-kinds', {
      code: 'array_plano', name: 'Array plano',
      attribute_schema: [
        { code: 'campo_a', label: 'A', type: 'text' },
      ],
    }).expect(201)
    expect(res.body.attribute_schema.version).toBe(1)
    expect(res.body.attribute_schema.fields).toHaveLength(1)
  })
})

describe('SaaS v2: PATCH product-kinds — auto-increment de version', () => {
  let client, tenantInfo, kindId

  beforeAll(async () => {
    tenantInfo = await createTenant({ label: 'pkupd', planSlug: 'owner' })
    const sess = await loginAs({
      slug: tenantInfo.tenant.slug, email: tenantInfo.email, password: tenantInfo.password,
    })
    client = authedClient({ slug: tenantInfo.tenant.slug, token: sess.token })
    const created = await client.post('/api/process-config/product-kinds', {
      code: 'versioned', name: 'Versioned',
      attribute_schema: { fields: [{ code: 'a', label: 'A', type: 'text' }] },
    }).expect(201)
    kindId = created.body.id
    expect(created.body.attribute_schema.version).toBe(1)
  })

  test('PATCH con mismos fields no incrementa version', async () => {
    const res = await client.patch(`/api/process-config/product-kinds/${kindId}`, {
      attribute_schema: { fields: [{ code: 'a', label: 'A', type: 'text' }] },
    }).expect(200)
    expect(res.body.attribute_schema.version).toBe(1)
  })

  test('PATCH agregando un field bumpa version a 2', async () => {
    const res = await client.patch(`/api/process-config/product-kinds/${kindId}`, {
      attribute_schema: {
        fields: [
          { code: 'a', label: 'A', type: 'text' },
          { code: 'b', label: 'B', type: 'boolean' },
        ],
      },
    }).expect(200)
    expect(res.body.attribute_schema.version).toBe(2)
    expect(res.body.attribute_schema.fields).toHaveLength(2)
  })

  test('PATCH quitando un field bumpa version a 3', async () => {
    const res = await client.patch(`/api/process-config/product-kinds/${kindId}`, {
      attribute_schema: {
        fields: [{ code: 'b', label: 'B', type: 'boolean' }],
      },
    }).expect(200)
    expect(res.body.attribute_schema.version).toBe(3)
    expect(res.body.attribute_schema.fields).toHaveLength(1)
  })

  test('PATCH con schema inválido NO modifica nada', async () => {
    const before = await client.get(`/api/process-config/product-kinds/${kindId}`).expect(200)
    await client.patch(`/api/process-config/product-kinds/${kindId}`, {
      attribute_schema: { fields: [{ code: 'x', type: 'invalid_type' }] },
    }).expect(400)
    const after = await client.get(`/api/process-config/product-kinds/${kindId}`).expect(200)
    expect(after.body.attribute_schema).toEqual(before.body.attribute_schema)
  })

  test('Soft-delete (is_active=false)', async () => {
    const res = await client.patch(`/api/process-config/product-kinds/${kindId}`, {
      is_active: false,
    }).expect(200)
    expect(res.body.is_active).toBe(false)
  })

  test('404 para id inexistente', async () => {
    const res = await client.patch(
      '/api/process-config/product-kinds/00000000-0000-0000-0000-000000000000',
      { name: 'x' }
    )
    expect(res.status).toBe(404)
  })
})
