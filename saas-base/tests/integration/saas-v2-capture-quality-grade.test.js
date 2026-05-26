'use strict'

/**
 * SaaS v2 — Tests del refactor de capturePackage (§6f).
 *
 * Cubre:
 *  - Helper qualityGradeResolver: paths id, gradeNumber, productDefault,
 *    isSecondQuality boolean, errores (cross-tenant, inactivo, gradeNumber
 *    inválido).
 *  - HTTP POST /api/production/shifts/:id/packages con qualityGradeId.
 *  - Backward compat: isSecondQuality boolean sigue funcionando (resuelve a
 *    grade_number > 1).
 *  - shift_progress.quality_grade_id se popula en cada captura.
 *  - is_second_quality es derivado correctamente (grade > 1).
 *  - editPackage con qualityGradeId actualiza el grade.
 *  - Cross-tenant: qualityGradeId de otro tenant → 400.
 */

const { createTenant, loginAs, authedClient, cleanupTestTenants } = require('../helpers/factory')
const { pool, query, withBypass, withTransaction } = require('../../src/db')
const { resolveQualityGrade } = require('../../src/modules/production/qualityGradeResolver')

afterAll(async () => {
  await cleanupTestTenants()
  await pool.end()
})

let counter = 0
const uniq = (s) => `${s}${(Date.now() % 100000)}_${counter++}`

async function setupTenantShift() {
  const info = await createTenant({ label: uniq('cap'), planSlug: 'owner' })
  const sess = await loginAs({ slug: info.tenant.slug, email: info.email, password: info.password })
  const client = authedClient({ slug: info.tenant.slug, token: sess.token })
  const tenantId = info.tenant.id

  // Listar grades default seeded por migration 123 (primera/segunda/tercera)
  const grades = (await client.get('/api/process-config/quality-grades').expect(200)).body

  // Raw material + producto + orden + turno
  const { rows: rm } = await withBypass(() => query(
    `INSERT INTO raw_materials (tenant_id, name, resin_type, item_kind)
     VALUES ($1, $2, 'PE', 'raw_material') RETURNING id`,
    [tenantId, uniq('MP')]
  ))
  const rawMaterialId = rm[0].id

  const productRes = await client.post('/api/products', {
    sku: uniq('SKU-'), name: 'Producto test',
    type: 'corner_protector', resinType: 'PE', saleUnit: 'kg',
  }).expect(201)
  const productId = productRes.body.id

  // Orden y release vía SQL (igual que en 6b tests)
  const orderRes = await client.post('/api/production/orders', {
    productId, rawMaterialId,
    quantityPackages: 100, priority: 'normal',
  }).expect(201)
  const orderId = orderRes.body.id
  await withBypass(() => query(
    `UPDATE production_orders SET status='released' WHERE id=$1`, [orderId]
  ))

  // Turno
  const today = new Date().toISOString().slice(0, 10)
  const shiftRes = await client.post('/api/production/shifts', {
    shiftNumber: 1, shiftDate: today,
    operatorId: info.user.id, supervisorId: info.user.id,
  }).expect(201)

  return { info, client, tenantId, grades, productId, rawMaterialId, orderId, shiftId: shiftRes.body.id }
}

async function fetchProgress(progressId) {
  const { rows } = await withBypass(() => query(
    `SELECT id, real_weight_kg, is_second_quality, quality_grade_id,
            second_quality_product_id
     FROM shift_progress WHERE id = $1`, [progressId]
  ))
  return rows[0]
}

// ═══════════════════════════════════════════════════════════════════════════
//  Helper qualityGradeResolver
// ═══════════════════════════════════════════════════════════════════════════

describe('SaaS v2 §6f: qualityGradeResolver', () => {
  let ctx
  beforeAll(async () => { ctx = await setupTenantShift() })

  test('Resuelve por qualityGradeId válido', async () => {
    const primera = ctx.grades.find(g => g.code === 'primera')
    const row = await withTransaction((c) =>
      resolveQualityGrade(c, { tenantId: ctx.tenantId, qualityGradeId: primera.id })
    )
    expect(row.id).toBe(primera.id)
    expect(row.grade_number).toBe(1)
  })

  test('Resuelve por gradeNumber', async () => {
    const row = await withTransaction((c) =>
      resolveQualityGrade(c, { tenantId: ctx.tenantId, gradeNumber: 2 })
    )
    expect(row.code).toBe('segunda')
    expect(row.grade_number).toBe(2)
  })

  test('isSecondQuality=true → grade > 1 activo (primero)', async () => {
    const row = await withTransaction((c) =>
      resolveQualityGrade(c, { tenantId: ctx.tenantId, isSecondQuality: true })
    )
    expect(row.grade_number).toBeGreaterThan(1)
  })

  test('isSecondQuality=false → default product o grade=1', async () => {
    const row = await withTransaction((c) =>
      resolveQualityGrade(c, { tenantId: ctx.tenantId, isSecondQuality: false })
    )
    expect(row.grade_number).toBe(1)
  })

  test('productDefaultId tiene prioridad cuando no hay otra señal', async () => {
    const segunda = ctx.grades.find(g => g.code === 'segunda')
    const row = await withTransaction((c) =>
      resolveQualityGrade(c, { tenantId: ctx.tenantId, productDefaultId: segunda.id })
    )
    expect(row.id).toBe(segunda.id)
  })

  test('Sin ninguna señal → grade_number=1 (último fallback)', async () => {
    const row = await withTransaction((c) =>
      resolveQualityGrade(c, { tenantId: ctx.tenantId })
    )
    expect(row.grade_number).toBe(1)
  })

  test('qualityGradeId cross-tenant → 400', async () => {
    const other = await createTenant({ label: uniq('other'), planSlug: 'owner' })
    const primera = ctx.grades.find(g => g.code === 'primera')
    await expect(withTransaction((c) =>
      resolveQualityGrade(c, { tenantId: other.tenant.id, qualityGradeId: primera.id })
    )).rejects.toMatchObject({ status: 400 })
  })

  test('qualityGradeId inactivo → 400', async () => {
    const sess = await loginAs({ slug: ctx.info.tenant.slug, email: ctx.info.email, password: ctx.info.password })
    const cli = authedClient({ slug: ctx.info.tenant.slug, token: sess.token })
    const tercera = ctx.grades.find(g => g.code === 'tercera')
    await cli.patch(`/api/process-config/quality-grades/${tercera.id}`, { is_active: false }).expect(200)
    await expect(withTransaction((c) =>
      resolveQualityGrade(c, { tenantId: ctx.tenantId, qualityGradeId: tercera.id })
    )).rejects.toMatchObject({ status: 400 })
    // Re-activar para no contaminar otros tests
    await cli.patch(`/api/process-config/quality-grades/${tercera.id}`, { is_active: true }).expect(200)
  })

  test('gradeNumber fuera de rango → 400', async () => {
    await expect(withTransaction((c) =>
      resolveQualityGrade(c, { tenantId: ctx.tenantId, gradeNumber: 99 })
    )).rejects.toMatchObject({ status: 400 })
    await expect(withTransaction((c) =>
      resolveQualityGrade(c, { tenantId: ctx.tenantId, gradeNumber: 0 })
    )).rejects.toMatchObject({ status: 400 })
  })

  test('gradeNumber inexistente en tenant → 400', async () => {
    await expect(withTransaction((c) =>
      resolveQualityGrade(c, { tenantId: ctx.tenantId, gradeNumber: 4 })
    )).rejects.toMatchObject({ status: 400 })
  })
})

// ═══════════════════════════════════════════════════════════════════════════
//  POST /api/production/shifts/:id/packages
// ═══════════════════════════════════════════════════════════════════════════

describe('SaaS v2 §6f: POST /shifts/:id/packages con quality_grade_id', () => {
  let ctx
  beforeAll(async () => { ctx = await setupTenantShift() })

  test('Path SaaS v2: qualityGradeId popula columna y deriva is_second_quality=false para grade 1', async () => {
    const primera = ctx.grades.find(g => g.code === 'primera')
    const res = await ctx.client.post(`/api/production/shifts/${ctx.shiftId}/packages`, {
      productionOrderId: ctx.orderId,
      realWeightKg: 100, quantityUnits: 1,
      qualityGradeId: primera.id,
    }).expect(201)
    const row = await fetchProgress(res.body.id)
    expect(row.quality_grade_id).toBe(primera.id)
    expect(row.is_second_quality).toBe(false)
  })

  test('Path SaaS v2: qualityGradeId de grade 2 → is_second_quality=true derivado', async () => {
    const segunda = ctx.grades.find(g => g.code === 'segunda')
    const res = await ctx.client.post(`/api/production/shifts/${ctx.shiftId}/packages`, {
      productionOrderId: ctx.orderId,
      realWeightKg: 50, quantityUnits: 1,
      qualityGradeId: segunda.id,
    }).expect(201)
    const row = await fetchProgress(res.body.id)
    expect(row.quality_grade_id).toBe(segunda.id)
    expect(row.is_second_quality).toBe(true)
  })

  test('Path SaaS v2: qualityGradeId de grade 3 → is_second_quality=true', async () => {
    const tercera = ctx.grades.find(g => g.code === 'tercera')
    const res = await ctx.client.post(`/api/production/shifts/${ctx.shiftId}/packages`, {
      productionOrderId: ctx.orderId,
      realWeightKg: 30, quantityUnits: 1,
      qualityGradeId: tercera.id,
    }).expect(201)
    const row = await fetchProgress(res.body.id)
    expect(row.quality_grade_id).toBe(tercera.id)
    expect(row.is_second_quality).toBe(true)
  })

  test('Path SaaS v2: gradeNumber=2 también funciona', async () => {
    const res = await ctx.client.post(`/api/production/shifts/${ctx.shiftId}/packages`, {
      productionOrderId: ctx.orderId,
      realWeightKg: 25, quantityUnits: 1,
      gradeNumber: 2,
    }).expect(201)
    const row = await fetchProgress(res.body.id)
    expect(row.quality_grade_id).toBe(ctx.grades.find(g => g.code === 'segunda').id)
    expect(row.is_second_quality).toBe(true)
  })

  test('Legacy path: isSecondQuality=true sin grade → resuelve a primer grade > 1', async () => {
    const res = await ctx.client.post(`/api/production/shifts/${ctx.shiftId}/packages`, {
      productionOrderId: ctx.orderId,
      realWeightKg: 20, quantityUnits: 1,
      isSecondQuality: true,
    }).expect(201)
    const row = await fetchProgress(res.body.id)
    expect(row.quality_grade_id).toBe(ctx.grades.find(g => g.grade_number === 2).id)
    expect(row.is_second_quality).toBe(true)
  })

  test('Legacy path: isSecondQuality=false → quality_grade_id se popula con grade 1', async () => {
    const res = await ctx.client.post(`/api/production/shifts/${ctx.shiftId}/packages`, {
      productionOrderId: ctx.orderId,
      realWeightKg: 90, quantityUnits: 1,
      isSecondQuality: false,
    }).expect(201)
    const row = await fetchProgress(res.body.id)
    expect(row.is_second_quality).toBe(false)
    expect(row.quality_grade_id).toBe(ctx.grades.find(g => g.code === 'primera').id)
  })

  test('Sin señal de calidad: usa default del producto o grade 1', async () => {
    const res = await ctx.client.post(`/api/production/shifts/${ctx.shiftId}/packages`, {
      productionOrderId: ctx.orderId,
      realWeightKg: 80, quantityUnits: 1,
    }).expect(201)
    const row = await fetchProgress(res.body.id)
    expect(row.quality_grade_id).not.toBeNull()
    // El producto no tiene default_quality_grade_id seteado, así que cae a grade=1
    expect(row.is_second_quality).toBe(false)
  })

  test('qualityGradeId inválido → 400', async () => {
    const res = await ctx.client.post(`/api/production/shifts/${ctx.shiftId}/packages`, {
      productionOrderId: ctx.orderId,
      realWeightKg: 10, quantityUnits: 1,
      qualityGradeId: '00000000-0000-0000-0000-000000000000',
    })
    expect(res.status).toBe(400)
  })

  test('qualityGradeId cross-tenant → 400', async () => {
    const other = await setupTenantShift()
    const primeraOther = other.grades.find(g => g.code === 'primera')
    const res = await ctx.client.post(`/api/production/shifts/${ctx.shiftId}/packages`, {
      productionOrderId: ctx.orderId,
      realWeightKg: 10, quantityUnits: 1,
      qualityGradeId: primeraOther.id,
    })
    expect(res.status).toBe(400)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
//  PATCH /shifts/:id/packages/:pid — editPackage
// ═══════════════════════════════════════════════════════════════════════════

describe('SaaS v2 §6f: PATCH /shifts/:id/packages/:pid', () => {
  let ctx, pkgId
  beforeAll(async () => {
    ctx = await setupTenantShift()
    const res = await ctx.client.post(`/api/production/shifts/${ctx.shiftId}/packages`, {
      productionOrderId: ctx.orderId,
      realWeightKg: 100, quantityUnits: 1,
      qualityGradeId: ctx.grades.find(g => g.code === 'primera').id,
    }).expect(201)
    pkgId = res.body.id
  })

  test('Update con qualityGradeId actualiza el grade y deriva is_second_quality', async () => {
    const segunda = ctx.grades.find(g => g.code === 'segunda')
    const res = await ctx.client.patch(
      `/api/production/shifts/${ctx.shiftId}/packages/${pkgId}`,
      { qualityGradeId: segunda.id }
    ).expect(200)
    const row = await fetchProgress(pkgId)
    expect(row.quality_grade_id).toBe(segunda.id)
    expect(row.is_second_quality).toBe(true)
  })

  test('Update con gradeNumber=3 cambia el grade', async () => {
    const tercera = ctx.grades.find(g => g.code === 'tercera')
    await ctx.client.patch(
      `/api/production/shifts/${ctx.shiftId}/packages/${pkgId}`,
      { gradeNumber: 3 }
    ).expect(200)
    const row = await fetchProgress(pkgId)
    expect(row.quality_grade_id).toBe(tercera.id)
    expect(row.is_second_quality).toBe(true)
  })

  test('Update solo de peso preserva el quality_grade_id', async () => {
    const before = await fetchProgress(pkgId)
    await ctx.client.patch(
      `/api/production/shifts/${ctx.shiftId}/packages/${pkgId}`,
      { realWeightKg: 75 }
    ).expect(200)
    const row = await fetchProgress(pkgId)
    expect(row.quality_grade_id).toBe(before.quality_grade_id)
    expect(parseFloat(row.real_weight_kg)).toBe(75)
  })
})
