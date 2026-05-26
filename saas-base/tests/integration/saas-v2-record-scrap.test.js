'use strict'

/**
 * SaaS v2 — Tests del refactor de recordScrap (§6b).
 *
 * Cubre:
 *  - Path SaaS v2 con scrapTypeId  → scrap_type_id + recovery_value_pct poblados
 *  - Path SaaS v2 con scrapTypeCode → resuelve el catálogo silenciosamente
 *  - Path legacy enum (scrapType='desecho') → comportamiento backward compat
 *  - Cross-tenant: scrapTypeId de otro tenant → 400
 *  - scrapTypeId inválido / inactivo → 400
 *  - destination mapping: 'sell' → 'venta'
 *  - is_abnormal calculado contra expected_scrap_pct (orden override > receta)
 *  - Helper scrapTypeResolver y abnormalScrapEvaluator unitarios
 */

const { createTenant, loginAs, authedClient, cleanupTestTenants } = require('../helpers/factory')
const { pool, query, withBypass, withTransaction } = require('../../src/db')
const {
  resolveScrapType, legacyScrapTypeFor, legacyDestinationFor,
  DESTINATION_LEGACY_MAP,
} = require('../../src/modules/production/scrapTypeResolver')
const { evaluateAbnormal } = require('../../src/modules/production/abnormalScrapEvaluator')

afterAll(async () => {
  await cleanupTestTenants()
  await pool.end()
})

let counter = 0
const uniq = (s) => `${s}${(Date.now() % 100000)}_${counter++}`

async function setupTenantWithShift() {
  const info = await createTenant({ label: uniq('scr'), planSlug: 'owner' })
  const sess = await loginAs({ slug: info.tenant.slug, email: info.email, password: info.password })
  const client = authedClient({ slug: info.tenant.slug, token: sess.token })
  const tenantId = info.tenant.id

  // El seed de migration 122 ya creó 4 scrap-types default. Creamos uno
  // adicional con código SaaS v2 para los tests.
  const scrapType = (await client.post('/api/process-config/scrap-types', {
    code: 'finos_polvo',
    name: 'Finos / Polvo (test)',
    default_destination: 'sell',
    default_recovery_value_pct: 10,
    is_normal: true,
    sort_order: 99,
  }).expect(201)).body

  // Raw material + producto + receta + orden + turno
  const { rows: rm } = await withBypass(() => query(
    `INSERT INTO raw_materials (tenant_id, name, resin_type, item_kind)
     VALUES ($1, $2, 'PE', 'raw_material') RETURNING id`,
    [tenantId, uniq('MP')]
  ))
  const rawMaterialId = rm[0].id

  const productRes = await client.post('/api/products', {
    sku: uniq('SKU-'),
    name: 'Pellet test',
    type: 'corner_protector',
    resinType: 'PE',
    saleUnit: 'kg',
    basePrice: 20,
  }).expect(201)
  const productId = productRes.body.id

  const { rows: u } = await withBypass(() => query(
    `SELECT id FROM tenant_units WHERE tenant_id = $1 AND code = 'kg'`, [tenantId]
  ))
  const kgUnitId = u[0].id

  // Receta con 15% scrap esperado
  const recipeRes = await client.post('/api/recipes', {
    product_id: productId,
    name: 'Receta test',
    yield_quantity: 1.0,
    yield_unit_id: kgUnitId,
    expected_scrap_pct: 15.0,
    components: [{ raw_material_id: rawMaterialId, quantity: 1.18, unit_id: kgUnitId, sort_order: 10 }],
  }).expect(201)
  const recipeId = recipeRes.body.id

  // Orden con recipe_id (no liberamos: recordScrap acepta order en cualquier estado
  // activable y release requiere stock seedeado que no nos interesa aquí)
  const orderRes = await client.post('/api/production/orders', {
    productId, rawMaterialId,
    quantityPackages: 1000, priority: 'normal', recipeId,
  }).expect(201)
  const orderId = orderRes.body.id
  // Cambiamos status a 'released' vía SQL para que el shift acepte capturas/loads
  await withBypass(() => query(
    `UPDATE production_orders SET status = 'released' WHERE id = $1`,
    [orderId]
  ))

  // Turno
  const today = new Date().toISOString().slice(0, 10)
  const shiftRes = await client.post('/api/production/shifts', {
    shiftNumber: 1,
    shiftDate: today,
    operatorId: info.user.id,
    supervisorId: info.user.id,
  }).expect(201)
  const shiftId = shiftRes.body.id

  // Cargar 1000 kg MP (para que evaluateAbnormal tenga base)
  await client.post(`/api/production/shifts/${shiftId}/mp-loads`, {
    rawMaterialId, kg: 1000, unitId: kgUnitId, quantity: 1000,
  }).expect(201)

  return { info, client, tenantId, scrapType, rawMaterialId, productId, orderId, shiftId, recipeId, kgUnitId }
}

async function fetchScrap(scrapId) {
  const { rows } = await withBypass(() => query(
    `SELECT id, scrap_type, destination, scrap_type_id, recovery_value_pct,
            is_abnormal, kg, production_order_id
     FROM shift_scrap WHERE id = $1`, [scrapId]
  ))
  return rows[0]
}

// ═══════════════════════════════════════════════════════════════════════════
//  Helpers puros — scrapTypeResolver
// ═══════════════════════════════════════════════════════════════════════════

describe('SaaS v2 §6b: scrapTypeResolver (unit)', () => {
  test('legacyScrapTypeFor: code en enum legacy → mismo code', () => {
    expect(legacyScrapTypeFor({ code: 'arranque' })).toBe('arranque')
    expect(legacyScrapTypeFor({ code: 'operacion' })).toBe('operacion')
    expect(legacyScrapTypeFor({ code: 'contaminada' })).toBe('contaminada')
    expect(legacyScrapTypeFor({ code: 'desecho' })).toBe('desecho')
  })

  test('legacyScrapTypeFor: code custom → fallback "desecho"', () => {
    expect(legacyScrapTypeFor({ code: 'finos_polvo' })).toBe('desecho')
    expect(legacyScrapTypeFor({ code: 'etiquetas_tapas' })).toBe('desecho')
  })

  test('legacyScrapTypeFor: null → null', () => {
    expect(legacyScrapTypeFor(null)).toBe(null)
  })

  test('legacyDestinationFor: mapea catálogo → enum legacy', () => {
    expect(legacyDestinationFor({ default_destination: 'reprocess' })).toBe('regrind')
    expect(legacyDestinationFor({ default_destination: 'sell' })).toBe('venta')
    expect(legacyDestinationFor({ default_destination: 'discard' })).toBe('desecho')
  })

  test('DESTINATION_LEGACY_MAP cubre los 3 destinos del catálogo', () => {
    expect(DESTINATION_LEGACY_MAP).toEqual({
      reprocess: 'regrind',
      sell:      'venta',
      discard:   'desecho',
    })
  })
})

describe('SaaS v2 §6b: resolveScrapType (DB)', () => {
  let ctx
  beforeAll(async () => { ctx = await setupTenantWithShift() })

  test('resuelve por scrapTypeId válido', async () => {
    const row = await withTransaction((c) =>
      resolveScrapType(c, { tenantId: ctx.tenantId, scrapTypeId: ctx.scrapType.id })
    )
    expect(row.id).toBe(ctx.scrapType.id)
    expect(row.code).toBe('finos_polvo')
    expect(parseFloat(row.default_recovery_value_pct)).toBe(10)
  })

  test('resuelve por scrapTypeCode (catálogo encontrado)', async () => {
    const row = await withTransaction((c) =>
      resolveScrapType(c, { tenantId: ctx.tenantId, scrapTypeCode: 'finos_polvo' })
    )
    expect(row.id).toBe(ctx.scrapType.id)
  })

  test('por code legacy del enum no en catálogo nuevo → null', async () => {
    // 'desecho' SÍ está sembrado por la migración 122 — debe encontrar el seed.
    const row = await withTransaction((c) =>
      resolveScrapType(c, { tenantId: ctx.tenantId, scrapTypeCode: 'desecho' })
    )
    expect(row).not.toBeNull()
    expect(row.code).toBe('desecho')
  })

  test('code totalmente inexistente → null', async () => {
    const row = await withTransaction((c) =>
      resolveScrapType(c, { tenantId: ctx.tenantId, scrapTypeCode: 'no_existe_xyz' })
    )
    expect(row).toBeNull()
  })

  test('scrapTypeId cross-tenant → 400', async () => {
    const other = await createTenant({ label: uniq('other'), planSlug: 'owner' })
    await expect(withTransaction((c) =>
      resolveScrapType(c, { tenantId: other.tenant.id, scrapTypeId: ctx.scrapType.id })
    )).rejects.toMatchObject({ status: 400 })
  })

  test('scrapTypeId inactivo → 400', async () => {
    const sess = await loginAs({ slug: ctx.info.tenant.slug, email: ctx.info.email, password: ctx.info.password })
    const cli = authedClient({ slug: ctx.info.tenant.slug, token: sess.token })
    const created = (await cli.post('/api/process-config/scrap-types', {
      code: uniq('inact_'), name: 'Inactivo', default_destination: 'discard',
    }).expect(201)).body
    await cli.patch(`/api/process-config/scrap-types/${created.id}`, { is_active: false }).expect(200)

    await expect(withTransaction((c) =>
      resolveScrapType(c, { tenantId: ctx.tenantId, scrapTypeId: created.id })
    )).rejects.toMatchObject({ status: 400 })
  })

  test('sin scrapTypeId ni scrapTypeCode → 400', async () => {
    await expect(withTransaction((c) =>
      resolveScrapType(c, { tenantId: ctx.tenantId })
    )).rejects.toMatchObject({ status: 400 })
  })
})

// ═══════════════════════════════════════════════════════════════════════════
//  POST /api/production/shifts/:id/scrap — flujos completos
// ═══════════════════════════════════════════════════════════════════════════

describe('SaaS v2 §6b: POST /shifts/:id/scrap con scrapTypeId', () => {
  let ctx
  beforeAll(async () => { ctx = await setupTenantWithShift() })

  test('Popula scrap_type_id, recovery_value_pct, mapea destination', async () => {
    const res = await ctx.client.post(`/api/production/shifts/${ctx.shiftId}/scrap`, {
      scrapTypeId: ctx.scrapType.id,
      destination: 'sell',          // formato SaaS v2 → debe mapear a 'venta'
      kg: 50,
      productionOrderId: ctx.orderId,
      notes: 'Test SaaS v2 path',
    }).expect(201)
    expect(res.body.id).toBeTruthy()

    const row = await fetchScrap(res.body.id)
    expect(row.scrap_type_id).toBe(ctx.scrapType.id)
    expect(parseFloat(row.recovery_value_pct)).toBe(10)
    expect(row.scrap_type).toBe('desecho')         // fallback legacy (finos_polvo no está en enum)
    expect(row.destination).toBe('venta')          // 'sell' mapeado
    expect(row.is_abnormal).toBe(false)            // 50 < 1000 * 15% = 150
  })

  test('scrapTypeCode (sin Id) también resuelve catálogo', async () => {
    const res = await ctx.client.post(`/api/production/shifts/${ctx.shiftId}/scrap`, {
      scrapType: 'finos_polvo',
      kg: 30,
      productionOrderId: ctx.orderId,
    }).expect(201)
    const row = await fetchScrap(res.body.id)
    expect(row.scrap_type_id).toBe(ctx.scrapType.id)
    expect(parseFloat(row.recovery_value_pct)).toBe(10)
    expect(row.destination).toBe('venta')          // default del catálogo
  })

  test('Code legacy enum del seed ("operacion") usa catálogo seedeado', async () => {
    const res = await ctx.client.post(`/api/production/shifts/${ctx.shiftId}/scrap`, {
      scrapType: 'operacion',
      kg: 5,
      productionOrderId: ctx.orderId,
    }).expect(201)
    const row = await fetchScrap(res.body.id)
    // 'operacion' del seed tiene default_destination='reprocess', recovery=30%
    expect(row.scrap_type_id).not.toBeNull()
    expect(row.scrap_type).toBe('operacion')
    expect(row.destination).toBe('regrind')        // mapeado de 'reprocess'
    expect(parseFloat(row.recovery_value_pct)).toBe(30)
  })

  test('scrapTypeId inválido → 400', async () => {
    const res = await ctx.client.post(`/api/production/shifts/${ctx.shiftId}/scrap`, {
      scrapTypeId: '00000000-0000-0000-0000-000000000000',
      kg: 10,
    })
    expect(res.status).toBe(400)
  })

  test('Sin scrapType ni scrapTypeId → 400', async () => {
    const res = await ctx.client.post(`/api/production/shifts/${ctx.shiftId}/scrap`, {
      kg: 10,
    })
    expect(res.status).toBe(400)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
//  is_abnormal — evaluación contra expected_scrap_pct
// ═══════════════════════════════════════════════════════════════════════════

describe('SaaS v2 §6b: is_abnormal contra expected_scrap_pct', () => {
  let ctx
  beforeAll(async () => { ctx = await setupTenantWithShift() })

  test('Scrap dentro del umbral (50 kg sobre 1000 MP × 15%) → is_abnormal=false', async () => {
    const res = await ctx.client.post(`/api/production/shifts/${ctx.shiftId}/scrap`, {
      scrapTypeId: ctx.scrapType.id,
      kg: 50,
      productionOrderId: ctx.orderId,
    }).expect(201)
    const row = await fetchScrap(res.body.id)
    expect(row.is_abnormal).toBe(false)
  })

  test('Scrap supera umbral acumulado → is_abnormal=true', async () => {
    // Ya hay 50 kg del test anterior + 120 kg nuevo = 170 > 150 (15% de 1000)
    const res = await ctx.client.post(`/api/production/shifts/${ctx.shiftId}/scrap`, {
      scrapTypeId: ctx.scrapType.id,
      kg: 120,
      productionOrderId: ctx.orderId,
    }).expect(201)
    const row = await fetchScrap(res.body.id)
    expect(row.is_abnormal).toBe(true)
  })

  test('Sin productionOrderId → is_abnormal=false (no se evalúa)', async () => {
    const res = await ctx.client.post(`/api/production/shifts/${ctx.shiftId}/scrap`, {
      scrapTypeId: ctx.scrapType.id,
      kg: 999,
    }).expect(201)
    const row = await fetchScrap(res.body.id)
    expect(row.is_abnormal).toBe(false)
    expect(row.production_order_id).toBe(null)
  })

  test('Order override gana sobre recipe default', async () => {
    // Fresh tenant para no contaminar el contador
    const fresh = await setupTenantWithShift()
    // Setear override 5% en la orden (sobrescribe el 15% de la receta)
    await withBypass(() => query(
      `UPDATE production_orders SET expected_scrap_pct = 5 WHERE id = $1`,
      [fresh.orderId]
    ))
    // 80 kg > 1000 * 5% = 50 → abnormal=true (con receta sería 150 → normal)
    const res = await fresh.client.post(`/api/production/shifts/${fresh.shiftId}/scrap`, {
      scrapTypeId: fresh.scrapType.id,
      kg: 80,
      productionOrderId: fresh.orderId,
    }).expect(201)
    const row = await fetchScrap(res.body.id)
    expect(row.is_abnormal).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
//  Backward compat — legacy path sin catálogo
// ═══════════════════════════════════════════════════════════════════════════

describe('SaaS v2 §6b: backward compat (no catalog match)', () => {
  let ctx
  beforeAll(async () => { ctx = await setupTenantWithShift() })

  test('code con seed legacy ("arranque") usa catálogo del seed', async () => {
    // Seed migration 122 inserta 'arranque' con destination=discard, recovery=0
    const res = await ctx.client.post(`/api/production/shifts/${ctx.shiftId}/scrap`, {
      scrapType: 'arranque',
      kg: 5,
      productionOrderId: ctx.orderId,
    }).expect(201)
    const row = await fetchScrap(res.body.id)
    // Encuentra el seed del catálogo → poblado
    expect(row.scrap_type_id).not.toBeNull()
    expect(row.scrap_type).toBe('arranque')
    expect(row.destination).toBe('desecho')        // discard → desecho
    expect(parseFloat(row.recovery_value_pct)).toBe(0)
  })

  test('Si el catálogo NO tiene el code, persiste solo en columnas legacy', async () => {
    // Desactivamos 'desecho' del catálogo para forzar el fallback
    const fresh = await setupTenantWithShift()
    const sess = await loginAs({ slug: fresh.info.tenant.slug, email: fresh.info.email, password: fresh.info.password })
    const cli = authedClient({ slug: fresh.info.tenant.slug, token: sess.token })
    const list = (await cli.get('/api/process-config/scrap-types').expect(200)).body
    const desecho = list.find(t => t.code === 'desecho')
    await cli.patch(`/api/process-config/scrap-types/${desecho.id}`, { is_active: false }).expect(200)

    const res = await fresh.client.post(`/api/production/shifts/${fresh.shiftId}/scrap`, {
      scrapType: 'desecho',
      destination: 'desecho',         // formato legacy
      kg: 10,
      productionOrderId: fresh.orderId,
    }).expect(201)
    const row = await fetchScrap(res.body.id)
    expect(row.scrap_type_id).toBe(null)           // catálogo inactivo → null
    expect(row.scrap_type).toBe('desecho')         // se persiste legacy enum
    expect(row.recovery_value_pct).toBe(null)
  })
})
