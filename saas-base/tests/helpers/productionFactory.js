'use strict'

// Helpers específicos para tests del módulo de producción.
// Construyen escenarios mínimos (raw materials, productos, órdenes) vía HTTP
// para que las pruebas operen exclusivamente contra la API pública.
// Para fixtures internas (stock de inventario, warehouses), usa DB directa.
//
// Uso típico:
//   const { seedProductionScenario } = require('../helpers/productionFactory')
//   const data = await seedProductionScenario({ client })
//   const res = await client.get('/api/production/queue')

const { query, withBypass } = require('../../src/db')

/**
 * Crea una materia prima vía POST /api/raw-materials.
 */
async function createRawMaterial(client, {
  name = 'PP Virgen Test',
  resinType = 'PP',
  materialType = 'virgin',
  unit = 'kg',
  costPerKg = 25.50,
  leadTimeDays = 7,
} = {}) {
  const res = await client.post('/api/raw-materials', {
    name, resinType, materialType, unit, costPerKg, leadTimeDays,
  })
  if (res.status !== 201) {
    throw new Error(`createRawMaterial failed: status ${res.status} body ${JSON.stringify(res.body)}`)
  }
  return res.body
}

/**
 * Crea un producto vía POST /api/products.
 * Default es type='corner_protector' que es lo que producción consume.
 */
async function createProduct(client, {
  sku,
  name = 'Esquinero PP Test',
  type = 'corner_protector',
  baseUnit = 'pieza',
  resinType = 'PP',
} = {}) {
  if (!sku) throw new Error('createProduct requiere sku')
  const res = await client.post('/api/products', {
    sku, name, type, base_unit: baseUnit, resin_type: resinType,
  })
  if (res.status !== 201) {
    throw new Error(`createProduct failed: status ${res.status} body ${JSON.stringify(res.body)}`)
  }
  return res.body
}

/**
 * Crea una orden de producción en estado 'draft'.
 */
async function createOrder(client, {
  productId,
  rawMaterialId,
  quantityPackages = 10,
  priority = 'normal',
  notes,
}) {
  if (!productId || !rawMaterialId) {
    throw new Error('createOrder requiere productId y rawMaterialId')
  }
  const res = await client.post('/api/production/orders', {
    productId, rawMaterialId, quantityPackages, priority, notes,
  })
  if (res.status !== 201) {
    throw new Error(`createOrder failed: status ${res.status} body ${JSON.stringify(res.body)}`)
  }
  return res.body
}

/**
 * Libera una orden (draft -> released) vía POST /api/production/orders/:id/release.
 * Si hay bajo stock, pasamos lowStockOverrideReason para no bloquear el test.
 */
async function releaseOrder(client, orderId, { overrideReason = 'test fixture' } = {}) {
  const res = await client.post(`/api/production/orders/${orderId}/release`, {
    lowStockOverrideReason: overrideReason,
  })
  if (res.status !== 200) {
    throw new Error(`releaseOrder failed: status ${res.status} body ${JSON.stringify(res.body)}`)
  }
  return res.body
}

/**
 * Crea una quality spec para el producto vía POST /api/products/:id/quality-specs.
 * Necesaria para que previewStockForNewOrder y stock-availability calculen
 * correctamente el MP teórico requerido.
 */
async function createQualitySpec(client, productId, {
  gramsPerLinearMeter = 50,
  tolerancePct = 5,
  unitsPerPackage = 50,
  notes = 'spec de test',
} = {}) {
  const res = await client.post(`/api/products/${productId}/quality-specs`, {
    gramsPerLinearMeter, tolerancePct, unitsPerPackage, notes,
  })
  if (res.status !== 201) {
    throw new Error(`createQualitySpec failed: status ${res.status} body ${JSON.stringify(res.body)}`)
  }
  return res.body
}

/**
 * Programa un turno futuro vía POST /api/production/scheduled-shifts.
 * Requiere que el tenant tenga al menos una orden en 'released' o 'in_progress'
 * (regla de negocio del endpoint).
 */
async function scheduleShift(client, {
  productionOrderId,
  shiftNumber = '1',
  scheduledDate,
  scheduledStart = '08:00:00',
  operatorId,
  supervisorId,
  lineId = 1,
  notes,
}) {
  if (!operatorId || !supervisorId) {
    throw new Error('scheduleShift requiere operatorId y supervisorId')
  }
  const date = scheduledDate || new Date(Date.now() + 24*60*60*1000).toISOString().slice(0, 10)
  const res = await client.post('/api/production/scheduled-shifts', {
    productionOrderId, shiftNumber,
    scheduledDate: date, scheduledStart,
    operatorId, supervisorId, lineId, notes,
  })
  if (res.status !== 201) {
    throw new Error(`scheduleShift failed: status ${res.status} body ${JSON.stringify(res.body)}`)
  }
  return res.body
}

/**
 * Abre un turno de producción vía POST /api/production/shifts.
 * Necesita operatorId y supervisorId (pueden ser el mismo usuario admin).
 */
async function openShift(client, {
  lineId = 1,
  shiftNumber = '1',
  shiftDate,
  operatorId,
  supervisorId,
}) {
  if (!operatorId || !supervisorId) {
    throw new Error('openShift requiere operatorId y supervisorId')
  }
  // Default a fecha de hoy en formato YYYY-MM-DD
  const today = shiftDate || new Date().toISOString().slice(0, 10)
  const res = await client.post('/api/production/shifts', {
    lineId, shiftNumber, shiftDate: today, operatorId, supervisorId,
  })
  if (res.status !== 201) {
    throw new Error(`openShift failed: status ${res.status} body ${JSON.stringify(res.body)}`)
  }
  return res.body
}

/**
 * Captura un paquete producido en un turno activo vía POST /shifts/:id/packages.
 */
async function capturePackage(client, shiftId, {
  productionOrderId,
  quantityUnits = 50,
  realWeightKg,
  theoreticalWeightKg,
  lengthMm = 1000,
  isSecondQuality = false,
  secondQualityProductId,
  notes,
}) {
  if (!realWeightKg) throw new Error('capturePackage requiere realWeightKg')
  const res = await client.post(`/api/production/shifts/${shiftId}/packages`, {
    productionOrderId, quantityUnits, realWeightKg, theoreticalWeightKg,
    lengthMm, isSecondQuality, secondQualityProductId, notes,
  })
  if (res.status !== 201) {
    throw new Error(`capturePackage failed: status ${res.status} body ${JSON.stringify(res.body)}`)
  }
  return res.body
}

/**
 * Registra carga de MP en un turno activo vía POST /shifts/:id/mp-loads.
 */
async function loadMp(client, shiftId, {
  rawMaterialId,
  kg,
  isReplacement = false,
  notes,
  lotId,
  unitId,
  quantity,
}) {
  if (!rawMaterialId || !kg) throw new Error('loadMp requiere rawMaterialId y kg')
  const res = await client.post(`/api/production/shifts/${shiftId}/mp-loads`, {
    rawMaterialId, kg, isReplacement, notes, lotId, unitId, quantity,
  })
  if (res.status !== 201) {
    throw new Error(`loadMp failed: status ${res.status} body ${JSON.stringify(res.body)}`)
  }
  return res.body
}

/**
 * Registra una incidencia en el turno vía POST /shifts/:id/incidents.
 */
async function reportIncident(client, shiftId, {
  category = 'paro_maquina',
  description = 'Test incident',
  durationMin = 15,
}) {
  const res = await client.post(`/api/production/shifts/${shiftId}/incidents`, {
    category, description, durationMin,
  })
  if (res.status !== 201) {
    throw new Error(`reportIncident failed: status ${res.status} body ${JSON.stringify(res.body)}`)
  }
  return res.body
}

/**
 * Inserta stock directamente en inventory_stock (DB directa, no vía HTTP).
 *
 * Razón del approach: el flujo HTTP para sembrar stock requeriría crear un
 * adjustment con razón + notas + lines (más fixture brittle). Para tests de
 * lectura, insertar directo es más simple y rápido.
 *
 * Asume que existe un warehouse del tipo solicitado (seed migración 040 los crea).
 */
async function seedRawMaterialStock(tenantId, rawMaterialId, quantityKg, {
  warehouseType = 'raw_material',
  avgCost = 25.50,
} = {}) {
  return withBypass(async () => {
    // Encontrar o crear el warehouse del tipo apropiado.
    // Los tenants nuevos provisionados via /api/tenants/provision NO tienen
    // warehouses auto-creados (la migración 040 solo seedea tenants existentes).
    let { rows: warehouses } = await query(
      `SELECT id FROM warehouses
       WHERE tenant_id=$1 AND type=$2 AND is_active=true
       ORDER BY created_at LIMIT 1`,
      [tenantId, warehouseType]
    )
    let warehouseId
    if (warehouses.length === 0) {
      const created = await query(
        `INSERT INTO warehouses (tenant_id, name, type, description, is_active)
         VALUES ($1, $2, $3, $4, true)
         RETURNING id`,
        [tenantId, `Almacén ${warehouseType} test`, warehouseType, 'Auto-creado por test fixture']
      )
      warehouseId = created.rows[0].id
    } else {
      warehouseId = warehouses[0].id
    }

    // Insertar/actualizar inventory_stock
    const { rows } = await query(
      `INSERT INTO inventory_stock
         (tenant_id, warehouse_id, item_type, item_id, quantity, avg_cost, status)
       VALUES ($1, $2, 'raw_material', $3, $4, $5, 'available')
       ON CONFLICT (tenant_id, warehouse_id, item_type, item_id, status)
       DO UPDATE SET quantity = inventory_stock.quantity + EXCLUDED.quantity
       RETURNING id, quantity`,
      [tenantId, warehouseId, rawMaterialId, quantityKg, avgCost]
    )
    return rows[0]
  })
}

/**
 * Siembra un escenario mínimo: 1 raw material, 1 producto, N órdenes.
 * Para que la cola tenga al menos algunas órdenes liberadas.
 *
 * Retorna { rawMaterial, product, orders } con orders en orden de creación.
 */
async function seedProductionScenario(client, {
  numOrders = 3,
  releaseFirst = 2,
} = {}) {
  const rawMaterial = await createRawMaterial(client)
  // SKU determinístico — cleanupTestTenants borra el tenant anterior antes de
  // la siguiente corrida, así que no hay colisión. SKU estable = snapshot estable.
  const product = await createProduct(client, { sku: 'TEST-PROD-001' })

  const orders = []
  for (let i = 0; i < numOrders; i++) {
    const o = await createOrder(client, {
      productId: product.id,
      rawMaterialId: rawMaterial.id,
      quantityPackages: 10 + i * 5,
      priority: i === 0 ? 'urgente' : (i === 1 ? 'alta' : 'normal'),
      notes: `Orden de prueba ${i + 1}`,
    })
    orders.push(o)
  }

  // Liberar las primeras N órdenes para que aparezcan en /queue
  for (let i = 0; i < Math.min(releaseFirst, orders.length); i++) {
    await releaseOrder(client, orders[i].id)
  }

  return { rawMaterial, product, orders }
}

/**
 * Normaliza una respuesta para snapshot determinístico.
 * Reemplaza UUIDs, timestamps ISO, fechas, y otros campos no-determinísticos
 * con placeholders estables.
 */
function normalizeForSnapshot(value) {
  if (Array.isArray(value)) return value.map(normalizeForSnapshot)
  if (value && typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) {
      out[k] = normalizeField(k, v)
    }
    return out
  }
  return value
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
// Email de test (test-* @ test.local) lleva timestamp del slug, hay que normalizar
const TEST_EMAIL_RE = /^test-[a-z0-9-]+@test\.local$/

function normalizeField(key, value) {
  if (value == null) return value
  if (typeof value === 'string') {
    if (UUID_RE.test(value)) return '<UUID>'
    if (ISO_DATE_RE.test(value)) return '<TIMESTAMP>'
    if (DATE_RE.test(value)) return '<DATE>'
    if (TEST_EMAIL_RE.test(value)) return '<TEST_EMAIL>'
    // order_number / orderNumber: VARCHAR(20) que tiene secuencia/fecha,
    // normalizar tanto la versión snake_case (del SQL crudo) como camelCase
    // (de DTOs en getShiftSummary, scheduledShiftService, etc.)
    if (key === 'order_number' || key === 'orderNumber') return '<ORDER_NUMBER>'
    return value
  }
  if (Array.isArray(value)) return value.map(normalizeForSnapshot)
  if (typeof value === 'object') return normalizeForSnapshot(value)
  return value
}

module.exports = {
  createRawMaterial,
  createProduct,
  createOrder,
  releaseOrder,
  createQualitySpec,
  seedRawMaterialStock,
  openShift,
  scheduleShift,
  capturePackage,
  loadMp,
  reportIncident,
  seedProductionScenario,
  normalizeForSnapshot,
}
