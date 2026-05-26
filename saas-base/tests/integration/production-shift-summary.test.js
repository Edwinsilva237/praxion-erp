'use strict'

/**
 * Golden master test #7: GET /api/production/shifts/:id/summary
 *
 * El más COMPLEJO del módulo de producción. Captura:
 *   - Paquetes producidos (1ra y 2da calidad) con peso/longitud/unidades
 *   - Cargas de MP
 *   - Incidencias
 *   - Costos calculados (Modelo D Opción C)
 *   - Métricas: metros producidos, scrap estimado, costo unitario, costo/metro
 *
 * Esta función contiene la mayor parte de la LÓGICA HARDCODED del costeo viejo.
 * Cualquier refactor que la cambie debe actualizar el snapshot conscientemente.
 *
 * Patrón documentado en docs/saas-v2/01-golden-master-pattern.md.
 */

const { createTenant, loginAs, authedClient, cleanupTestTenants } = require('../helpers/factory')
const {
  createRawMaterial,
  createProduct,
  createQualitySpec,
  seedRawMaterialStock,
  createOrder,
  releaseOrder,
  openShift,
  capturePackage,
  loadMp,
  reportIncident,
  normalizeForSnapshot,
} = require('../helpers/productionFactory')
const { pool } = require('../../src/db')

afterAll(async () => {
  await cleanupTestTenants()
  await pool.end()
})

describe('Golden master: GET /api/production/shifts/:id/summary', () => {
  let client, tenantInfo, sessionUser
  let rawMaterial, product, order, shift

  beforeAll(async () => {
    tenantInfo = await createTenant({ label: 'gmsummary', planSlug: 'owner' })
    const sess = await loginAs({
      slug: tenantInfo.tenant.slug,
      email: tenantInfo.email,
      password: tenantInfo.password,
    })
    sessionUser = sess.user
    client = authedClient({ slug: tenantInfo.tenant.slug, token: sess.token })

    // ─── Setup completo del escenario ──────────────────────────────────────
    rawMaterial = await createRawMaterial(client, {
      name: 'PP Virgen Test',
      resinType: 'PP',
      costPerKg: 25.00,
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

    // Crear orden con fórmula (sirve para que el costeo encuentre blended_cost)
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
    await releaseOrder(client, order.id)

    // Abrir turno
    shift = await openShift(client, {
      lineId: 1, shiftNumber: '1',
      operatorId: sessionUser.id, supervisorId: sessionUser.id,
    })

    // Cargar MP — 30 kg (cantidad suficiente para los paquetes)
    await loadMp(client, shift.id, {
      rawMaterialId: rawMaterial.id,
      kg: 30,
      notes: 'Carga inicial',
    })

    // Capturar 2 paquetes buenos (1ra calidad)
    await capturePackage(client, shift.id, {
      productionOrderId: order.id,
      quantityUnits: 50,
      realWeightKg: 2.5,           // peso teórico = 50g/m × 1m × 50 = 2.5 kg
      theoreticalWeightKg: 2.5,
      lengthMm: 1000,
      isSecondQuality: false,
    })
    await capturePackage(client, shift.id, {
      productionOrderId: order.id,
      quantityUnits: 50,
      realWeightKg: 2.6,
      theoreticalWeightKg: 2.5,
      lengthMm: 1000,
      isSecondQuality: false,
    })

    // Capturar 1 paquete de 2da calidad
    await capturePackage(client, shift.id, {
      productionOrderId: order.id,
      quantityUnits: 50,
      realWeightKg: 2.4,
      theoreticalWeightKg: 2.5,
      lengthMm: 1000,
      isSecondQuality: true,
      secondQualityProductId: product.id,  // mismo producto como 2da por simplicidad
    })

    // Registrar una incidencia
    await reportIncident(client, shift.id, {
      category: 'paro_maquina',
      description: 'Cambio de molde — 15 min',
      durationMin: 15,
    })
  })

  test('Devuelve resumen estructurado (shift/production/materials/costs)', async () => {
    const res = await client.get(`/api/production/shifts/${shift.id}/summary`).expect(200)

    // El summary es un DTO con 4 secciones principales + incidents
    expect(res.body).toHaveProperty('shift')
    expect(res.body).toHaveProperty('production')
    expect(res.body).toHaveProperty('materials')
    expect(res.body).toHaveProperty('costs')
    expect(res.body).toHaveProperty('incidents')

    // Shift info básica
    expect(res.body.shift.id).toBe(shift.id)
    expect(res.body.shift.status).toBe('active')
    expect(res.body.shift.shiftNumber).toBe('1')
    expect(res.body.shift.lineId).toBe(1)
    expect(res.body.shift.operatorName).toBe('Test Admin')

    // Snapshot completo — captura toda la lógica de Modelo D Opción C
    expect(normalizeForSnapshot(res.body)).toMatchSnapshot()
  })

  test('Cálculos production: unidades buenas y segunda', async () => {
    const res = await client.get(`/api/production/shifts/${shift.id}/summary`).expect(200)

    // 2 paquetes buenos × 50 unidades = 100 unidades buenas
    expect(res.body.production.goodUnits).toBe(100)
    // 1 paquete segunda × 50 unidades = 50 unidades segunda
    expect(res.body.production.secondUnits).toBe(50)
    expect(res.body.production.totalPackages).toBe(2)  // paquetes buenos
    // Metros: 2 paquetes × 50 unidades × 1m = 100 metros
    expect(res.body.production.totalMeters).toBeCloseTo(100, 1)
  })

  test('Cálculos materials: MP cargada, kg PT, scrap', async () => {
    const res = await client.get(`/api/production/shifts/${shift.id}/summary`).expect(200)

    // 30 kg cargados
    expect(res.body.materials.totalMpKg).toBe(30)
    // PT bueno: 2.5 + 2.6 = 5.1 kg
    expect(res.body.materials.goodKg).toBeCloseTo(5.1, 2)
    // PT segunda: 2.4 kg
    expect(res.body.materials.secondKg).toBeCloseTo(2.4, 2)
    // Scrap estimado: 30 - 5.1 - 2.4 = 22.5 kg
    expect(res.body.materials.scrapKg).toBeCloseTo(22.5, 2)
  })

  test('Costos: estructura Modelo D con costPerUnit y costPerMeter', async () => {
    const res = await client.get(`/api/production/shifts/${shift.id}/summary`).expect(200)

    // Estructura del breakdown de costos
    expect(res.body.costs).toHaveProperty('avgCostPerKg')
    expect(res.body.costs).toHaveProperty('costSource')
    expect(res.body.costs).toHaveProperty('mpCostTotal')
    expect(res.body.costs).toHaveProperty('fixedTotal')
    expect(res.body.costs).toHaveProperty('totalCost')
    expect(res.body.costs).toHaveProperty('costPerUnit')
    expect(res.body.costs).toHaveProperty('costPerMeter')
    expect(res.body.costs).toHaveProperty('reprocessFactor')

    // Costo MP: 5.1 kg buenos × $25/kg = $127.5 (Modelo D imputa solo PT bueno)
    expect(res.body.costs.avgCostPerKg).toBe(25)
    // Verificación de coherencia: costPerUnit = totalCost / goodUnits
    if (res.body.production.goodUnits > 0) {
      const expectedCpu = res.body.costs.totalCost / res.body.production.goodUnits
      expect(res.body.costs.costPerUnit).toBeCloseTo(expectedCpu, 4)
    }
  })

  test('Incidencias capturadas', async () => {
    const res = await client.get(`/api/production/shifts/${shift.id}/summary`).expect(200)
    expect(res.body.incidents).toHaveLength(1)
    expect(res.body.incidents[0].category).toBe('paro_maquina')
    expect(res.body.incidents[0].duration_min).toBe(15)
  })

  test('Devuelve 404 para shift inexistente', async () => {
    const res = await client.get(
      '/api/production/shifts/00000000-0000-0000-0000-000000000000/summary'
    )
    expect(res.status).toBe(404)
  })
})
