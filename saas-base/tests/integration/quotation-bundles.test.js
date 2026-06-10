'use strict'

/**
 * Paquetes de productos en cotizaciones (mig 204 — 2026-06-10).
 *
 * Extiende los bundles (mig 203) a cotizaciones: se pueden capturar paquetes
 * en una cotización (grupo atómico con precio prorrateado) y, al convertir la
 * cotización en pedido, los campos bundle_* viajan fielmente para que el
 * pedido conserve el agrupamiento.
 *
 * Cubre:
 *  - agregar paquete a cotización (server-side explode) escala cantidades
 *  - líneas de paquete atómicas: editar/borrar individual → 409
 *  - quitar el grupo completo recalcula totales
 *  - crear cotización con paquete (líneas con bundle_*) persiste el grupo
 *  - convertir a pedido conserva bundle_group_id + precio prorrateado
 *  - paquete USD en cotización MXN → 400
 */

const { createTenant, loginAs, authedClient, cleanupTestTenants } = require('../helpers/factory')
const { pool } = require('../../src/db')

afterAll(async () => {
  await cleanupTestTenants()
  await pool.end()
})

describe('Paquetes de productos en cotizaciones', () => {
  let client, partnerId, prodA, prodB, bundleId

  beforeAll(async () => {
    const t = await createTenant({ label: 'qbundle', planSlug: 'owner' })
    const sess = await loginAs({ slug: t.tenant.slug, email: t.email, password: t.password })
    client = authedClient({ slug: t.tenant.slug, token: sess.token })

    const pRes = await client.post('/api/business-partners', {
      name: 'Cliente Cotiza', type: 'customer', rfc: 'XAXX010101000', is_active: true,
    })
    partnerId = pRes.body.id

    const a = await client.post('/api/products', {
      sku: 'QB-A', name: 'Producto A', type: 'resale', basePrice: 60, baseCurrency: 'MXN',
    })
    prodA = a.body
    const b = await client.post('/api/products', {
      sku: 'QB-B', name: 'Producto B', type: 'resale', basePrice: 40, baseCurrency: 'MXN',
    })
    prodB = b.body

    // Paquete A+B @ $85 (lista 100 → 15% descuento → A=51, B=34)
    const bun = await client.post('/api/products/bundles', {
      name: 'Combo Cotiza', bundlePrice: 85, currency: 'MXN',
      items: [
        { productId: prodA.id, quantity: 1 },
        { productId: prodB.id, quantity: 1 },
      ],
    })
    bundleId = bun.body.id
  })

  test('agregar paquete a una cotización draft (server-side) escala cantidades', async () => {
    const cot = await client.post('/api/quotations', {
      partnerId, currency: 'MXN',
      lines: [{ productId: prodA.id, quantity: 1, unit: 'pieza', unitPrice: 60 }],
    })
    expect(cot.status).toBe(201)
    const quotationId = cot.body.id

    const add = await client.post(`/api/quotations/${quotationId}/bundles`, {
      bundleId, bundleQuantity: 2,
    })
    expect(add.status).toBe(201)

    const det = await client.get(`/api/quotations/${quotationId}`)
    const bundleLines = det.body.lines.filter(l => l.bundle_id === bundleId)
    expect(bundleLines.length).toBe(2)
    for (const l of bundleLines) {
      expect(parseFloat(l.quantity)).toBe(2)       // 1 × 2 paquetes
      expect(parseFloat(l.bundle_quantity)).toBe(2)
      expect(l.bundle_name).toBe('Combo Cotiza')
    }
    // línea suelta $60 + 2 paquetes × $85 = $230
    expect(parseFloat(det.body.subtotal_mxn)).toBeCloseTo(230, 2)
  })

  test('línea de paquete: editar/borrar individual → 409', async () => {
    const cot = await client.post('/api/quotations', {
      partnerId, currency: 'MXN',
      lines: [{ productId: prodA.id, quantity: 1, unit: 'pieza', unitPrice: 60 }],
    })
    const quotationId = cot.body.id
    await client.post(`/api/quotations/${quotationId}/bundles`, { bundleId, bundleQuantity: 1 })

    const det = await client.get(`/api/quotations/${quotationId}`)
    const bLine = det.body.lines.find(l => l.bundle_group_id)

    const upd = await client.patch(`/api/quotations/${quotationId}/lines/${bLine.id}`, { quantity: 9 })
    expect(upd.status).toBe(409)
    const del = await client.delete(`/api/quotations/${quotationId}/lines/${bLine.id}`)
    expect(del.status).toBe(409)
  })

  test('quitar el grupo completo recalcula el total', async () => {
    const cot = await client.post('/api/quotations', {
      partnerId, currency: 'MXN',
      lines: [{ productId: prodA.id, quantity: 1, unit: 'pieza', unitPrice: 60 }],
    })
    const quotationId = cot.body.id
    const add = await client.post(`/api/quotations/${quotationId}/bundles`, { bundleId, bundleQuantity: 1 })
    const groupId = add.body.lines.find(l => l.bundle_group_id).bundle_group_id

    const rem = await client.delete(`/api/quotations/${quotationId}/bundle-groups/${groupId}`)
    expect(rem.status).toBe(200)

    const det = await client.get(`/api/quotations/${quotationId}`)
    expect(det.body.lines.length).toBe(1)
    expect(parseFloat(det.body.subtotal_mxn)).toBeCloseTo(60, 2)
  })

  test('crear cotización CON paquete (líneas bundle_*) persiste el grupo', async () => {
    const cot = await client.post('/api/quotations', {
      partnerId, currency: 'MXN',
      lines: [
        { productId: prodA.id, quantity: 2, unit: 'pieza', unitPrice: 51,
          bundleId, bundleGroupId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
          bundleName: 'Combo Cotiza', bundleQuantity: 2 },
        { productId: prodB.id, quantity: 2, unit: 'pieza', unitPrice: 34,
          bundleId, bundleGroupId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
          bundleName: 'Combo Cotiza', bundleQuantity: 2 },
      ],
    })
    expect(cot.status).toBe(201)
    const bundleLines = cot.body.lines.filter(l => l.bundle_group_id)
    expect(bundleLines.length).toBe(2)
    expect(parseFloat(cot.body.subtotal_mxn)).toBeCloseTo(170, 2) // 2 × $85
  })

  test('convertir a pedido conserva el grupo de paquete y los precios prorrateados', async () => {
    const cot = await client.post('/api/quotations', {
      partnerId, currency: 'MXN',
      lines: [{ productId: prodA.id, quantity: 1, unit: 'pieza', unitPrice: 60 }],
    })
    const quotationId = cot.body.id
    await client.post(`/api/quotations/${quotationId}/bundles`, { bundleId, bundleQuantity: 3 })

    // sent → convert
    await client.post(`/api/quotations/${quotationId}/send`, { skipEmail: true })
    const conv = await client.post(`/api/quotations/${quotationId}/convert`)
    expect(conv.status).toBe(200)
    const orderId = conv.body.order.id

    const order = await client.get(`/api/sales/orders/${orderId}`)
    const bundleLines = order.body.lines.filter(l => l.bundle_id === bundleId)
    expect(bundleLines.length).toBe(2)
    // el grupo se conserva (mismo bundle_group_id en ambas líneas)
    const groups = new Set(bundleLines.map(l => l.bundle_group_id))
    expect(groups.size).toBe(1)
    for (const l of bundleLines) {
      expect(parseFloat(l.quantity)).toBe(3) // escalado a 3 paquetes
      expect(l.bundle_name).toBe('Combo Cotiza')
    }
    // línea suelta $60 + 3 paquetes × $85 = $315
    expect(parseFloat(order.body.subtotal_mxn)).toBeCloseTo(315, 2)
  })

  test('paquete USD en cotización MXN → 400 (guard de moneda en createQuotation)', async () => {
    const usd = await client.post('/api/products/bundles', {
      name: 'Combo USD Cot', bundlePrice: 10, currency: 'USD',
      items: [{ productId: prodA.id, quantity: 1 }],
    })
    // Camino de captura directa (líneas bundle_*): el guard de moneda salta antes
    // de cualquier prorrateo. (El endpoint /bundles explota primero y, con
    // producto MXN dentro de paquete USD, pediría TC — otro camino distinto.)
    const res = await client.post('/api/quotations', {
      partnerId, currency: 'MXN',
      lines: [{ productId: prodA.id, quantity: 1, unit: 'pieza', unitPrice: 60,
        bundleId: usd.body.id, bundleGroupId: 'cccccccc-dddd-eeee-ffff-000000000000',
        bundleName: 'Combo USD Cot', bundleQuantity: 1 }],
    })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/moneda|USD|MXN/i)
  })
})
