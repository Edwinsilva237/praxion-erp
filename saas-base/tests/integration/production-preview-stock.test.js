'use strict'

/**
 * Golden master tests #4 y #5:
 *   - POST /api/production/orders/preview-stock  (orden NO existe aún, viene del form)
 *   - GET  /api/production/orders/:id/stock-availability  (orden YA existe)
 *
 * Ambos endpoints calculan disponibilidad de MP. Comparten lógica de fondo
 * pero entradas distintas:
 *   - preview-stock recibe productId + lengthMm + quantityPackages + mpFormula desde el form
 *   - stock-availability lee esos campos desde la orden existente
 *
 * Patrón documentado en docs/saas-v2/01-golden-master-pattern.md.
 */

const { createTenant, loginAs, authedClient, cleanupTestTenants } = require('../helpers/factory')
const {
  createRawMaterial,
  createProduct,
  createQualitySpec,
  seedRawMaterialStock,
  normalizeForSnapshot,
} = require('../helpers/productionFactory')
const { pool, query } = require('../../src/db')

// pool.end() global al final del archivo (un solo afterAll por archivo)
afterAll(async () => {
  await cleanupTestTenants()
  await pool.end()
})

describe('Golden master: POST /api/production/orders/preview-stock', () => {
  let client, tenantInfo, rawMaterial, product

  beforeAll(async () => {
    tenantInfo = await createTenant({ label: 'gmprev', planSlug: 'owner' })
    const sess = await loginAs({
      slug: tenantInfo.tenant.slug,
      email: tenantInfo.email,
      password: tenantInfo.password,
    })
    client = authedClient({ slug: tenantInfo.tenant.slug, token: sess.token })

    // Sembrar: raw material + producto + quality spec + stock
    rawMaterial = await createRawMaterial(client, {
      name: 'PP Virgen Test',
      resinType: 'PP',
      costPerKg: 25.50,
    })
    product = await createProduct(client, {
      sku: 'TEST-PROD-001',
      name: 'Esquinero PP Test',
      type: 'corner_protector',
      resinType: 'PP',
    })
    await createQualitySpec(client, product.id, {
      gramsPerLinearMeter: 50,    // 50 g/m
      tolerancePct: 5,
      unitsPerPackage: 50,         // 50 piezas por paquete
    })
    // 100 kg de stock disponible — suficiente para los cálculos del test
    await seedRawMaterialStock(tenantInfo.tenant.id, rawMaterial.id, 100)
  })

  test('Sin mpFormula devuelve early return con totales 0', async () => {
    const res = await client.post('/api/production/orders/preview-stock', {
      productId: product.id,
      lengthMm: 1000,
      quantityPackages: 10,
      // mpFormula vacía
      mpFormula: [],
    }).expect(200)

    expect(res.body.ok).toBe(true)
    expect(res.body.items).toEqual([])
    expect(res.body.totals.requiredKg).toBe(0)
    expect(res.body.totals.availableKg).toBe(0)
    expect(res.body.totals.missingKg).toBe(0)
  })

  test('Con fórmula y stock suficiente: ok=true, missingKg=0', async () => {
    const res = await client.post('/api/production/orders/preview-stock', {
      productId: product.id,
      lengthMm: 1000,        // 1 m
      quantityPackages: 10,  // 10 paq × 50 pcs = 500 pcs
      mpFormula: [
        { rawMaterialId: rawMaterial.id, percentage: 100 },
      ],
    }).expect(200)

    // Cálculo esperado:
    //   PT_kg = (50 g/m × 1 m × 500 pcs) / 1000 = 25 kg
    //   MP_required = 25 × (1 + 0.20 reproceso) = 30 kg
    //   stock = 100 kg → suficiente
    expect(res.body.ok).toBe(true)
    expect(res.body.totals.requiredKg).toBeCloseTo(30, 1)
    expect(res.body.totals.availableKg).toBeCloseTo(100, 1)
    expect(res.body.totals.missingKg).toBeCloseTo(0, 1)
    expect(res.body.items).toHaveLength(1)
    expect(res.body.items[0].rawMaterialId).toBe(rawMaterial.id)
    expect(res.body.items[0].name).toBe('PP Virgen Test')
    expect(res.body.items[0].percentage).toBe(100)
    expect(res.body.items[0].ok).toBe(true)

    // Snapshot completo
    expect(normalizeForSnapshot(res.body)).toMatchSnapshot()
  })

  test('Con fórmula pero stock insuficiente: ok=false, missingKg > 0', async () => {
    const res = await client.post('/api/production/orders/preview-stock', {
      productId: product.id,
      lengthMm: 5000,        // 5 m (mucho más MP requerida)
      quantityPackages: 100, // 100 paq × 50 pcs = 5000 pcs
      mpFormula: [
        { rawMaterialId: rawMaterial.id, percentage: 100 },
      ],
    }).expect(200)

    // PT_kg = (50 × 5 × 5000) / 1000 = 1250 kg
    // MP_required = 1250 × 1.2 = 1500 kg
    // stock = 100 kg → insuficiente
    expect(res.body.ok).toBe(false)
    expect(res.body.totals.requiredKg).toBeCloseTo(1500, 1)
    expect(res.body.totals.availableKg).toBeCloseTo(100, 1)
    expect(res.body.totals.missingKg).toBeCloseTo(1400, 1)
    expect(res.body.items[0].ok).toBe(false)
  })

  test('Faltan parámetros: respuesta vacía sin errores', async () => {
    // El endpoint no debe reventar si el formulario está incompleto
    // (se llama en cada keystroke del usuario)
    const res = await client.post('/api/production/orders/preview-stock', {
      // sin productId
      lengthMm: 1000,
      quantityPackages: 10,
      mpFormula: [{ rawMaterialId: rawMaterial.id, percentage: 100 }],
    }).expect(200)

    expect(res.body.ok).toBe(true)
    expect(res.body.items).toEqual([])
    expect(res.body.totals.requiredKg).toBe(0)
  })

  test('Sin quality spec: cálculo vuelve a 0 (early return)', async () => {
    // Crear otro producto SIN spec
    const noSpecProduct = await createProduct(client, {
      sku: 'TEST-PROD-NO-SPEC',
      name: 'Producto sin spec',
      type: 'corner_protector',
      resinType: 'PP',
    })

    const res = await client.post('/api/production/orders/preview-stock', {
      productId: noSpecProduct.id,
      lengthMm: 1000,
      quantityPackages: 10,
      mpFormula: [{ rawMaterialId: rawMaterial.id, percentage: 100 }],
    }).expect(200)

    // Sin spec, grams_per_m=0 → ptKgEstimado=0 → totalRequiredMpKg=0
    expect(res.body.totals.requiredKg).toBe(0)
    expect(res.body.meta.ptKgEstimado).toBe(0)
  })
})

describe('Golden master: GET /api/production/orders/:id/stock-availability', () => {
  let client, tenantInfo, rawMaterial, product, order

  beforeAll(async () => {
    tenantInfo = await createTenant({ label: 'gmsavail', planSlug: 'owner' })
    const sess = await loginAs({
      slug: tenantInfo.tenant.slug,
      email: tenantInfo.email,
      password: tenantInfo.password,
    })
    client = authedClient({ slug: tenantInfo.tenant.slug, token: sess.token })

    rawMaterial = await createRawMaterial(client, {
      name: 'PP Virgen Test',
      resinType: 'PP',
      costPerKg: 25.50,
    })
    product = await createProduct(client, {
      sku: 'TEST-PROD-001',
      name: 'Esquinero PP Test',
      type: 'corner_protector',
      resinType: 'PP',
    })
    await createQualitySpec(client, product.id, {
      gramsPerLinearMeter: 50,
      tolerancePct: 5,
      unitsPerPackage: 50,
    })
    await seedRawMaterialStock(tenantInfo.tenant.id, rawMaterial.id, 100)

    // Crear orden con fórmula MP explícita (para que stock-availability tenga qué leer)
    const orderRes = await client.post('/api/production/orders', {
      productId: product.id,
      rawMaterialId: rawMaterial.id,
      lengthMm: 1000,
      quantityPackages: 10,
      priority: 'normal',
      mpFormula: [
        { rawMaterialId: rawMaterial.id, percentage: 100 },
      ],
    })
    if (orderRes.status !== 201) {
      throw new Error(`createOrder failed: ${orderRes.status} ${JSON.stringify(orderRes.body)}`)
    }
    order = orderRes.body
  })

  test('Stock suficiente para la orden: ok=true', async () => {
    const res = await client.get(`/api/production/orders/${order.id}/stock-availability`).expect(200)

    expect(res.body.ok).toBe(true)
    expect(res.body.totals.requiredKg).toBeCloseTo(30, 1)
    expect(res.body.totals.availableKg).toBeCloseTo(100, 1)
    expect(res.body.totals.missingKg).toBeCloseTo(0, 1)

    // Snapshot completo
    expect(normalizeForSnapshot(res.body)).toMatchSnapshot()
  })

  test('Devuelve 404 para orden inexistente', async () => {
    const res = await client.get(
      '/api/production/orders/00000000-0000-0000-0000-000000000000/stock-availability'
    )
    expect(res.status).toBe(404)
  })
})
