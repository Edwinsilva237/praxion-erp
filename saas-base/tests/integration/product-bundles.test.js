'use strict'

/**
 * Paquetes de productos (bundles, mig 203 — 2026-06-10).
 *
 * Un paquete es un combo COMERCIAL de catálogo: productos + cantidades +
 * precio especial. Al venderse se explota en líneas componente con precio
 * PRORRATEADO proporcional al precio de lista (mismo % de descuento
 * implícito), el inventario se descuenta por componente y la utilidad por
 * producto sale del reporte existente sin cambios.
 *
 * Cubre:
 *  - CRUD del paquete + validación "todos los componentes con precio de lista"
 *  - explode: prorrateo exacto, % implícito, ajuste de residuo (la suma de
 *    subtotales == precio del paquete), presentaciones (pack_factor)
 *  - pedido: persiste el grupo, bloquea editar/borrar línea individual (409),
 *    quitar el grupo completo recalcula totales
 *  - POST /orders/:id/bundles (explosión server-side en pedido draft)
 *  - guard de moneda: paquete USD en pedido MXN → 400
 */

const { createTenant, loginAs, authedClient, cleanupTestTenants } = require('../helpers/factory')
const { pool } = require('../../src/db')

afterAll(async () => {
  await cleanupTestTenants()
  await pool.end()
})

describe('Paquetes de productos (product bundles)', () => {
  let client, partnerId
  let prodA, prodB, prodSinPrecio
  let bundleId

  beforeAll(async () => {
    const t = await createTenant({ label: 'bundles', planSlug: 'owner' })
    const sess = await loginAs({ slug: t.tenant.slug, email: t.email, password: t.password })
    client = authedClient({ slug: t.tenant.slug, token: sess.token })

    const pRes = await client.post('/api/business-partners', {
      name: 'Cliente Paquetes', type: 'customer', rfc: 'XAXX010101000', is_active: true,
    })
    expect(pRes.status).toBe(201)
    partnerId = pRes.body.id

    // Productos con precio de lista (la base del prorrateo)
    const a = await client.post('/api/products', {
      sku: 'BUN-A', name: 'Producto A', type: 'resale', basePrice: 60, baseCurrency: 'MXN',
    })
    expect(a.status).toBe(201)
    prodA = a.body

    const b = await client.post('/api/products', {
      sku: 'BUN-B', name: 'Producto B', type: 'resale', basePrice: 40, baseCurrency: 'MXN',
    })
    expect(b.status).toBe(201)
    prodB = b.body

    const c = await client.post('/api/products', {
      sku: 'BUN-C', name: 'Producto C sin precio', type: 'resale',
    })
    expect(c.status).toBe(201)
    prodSinPrecio = c.body
  })

  test('crear paquete OK y aparece en la lista con conteo de componentes', async () => {
    const res = await client.post('/api/products/bundles', {
      name: 'Combo AB',
      description: 'A + B con precio especial',
      bundlePrice: 85,
      currency: 'MXN',
      items: [
        { productId: prodA.id, quantity: 1 },
        { productId: prodB.id, quantity: 1 },
      ],
    })
    expect(res.status).toBe(201)
    expect(res.body.name).toBe('Combo AB')
    bundleId = res.body.id

    const list = await client.get('/api/products/bundles')
    expect(list.status).toBe(200)
    const row = list.body.data.find(x => x.id === bundleId)
    expect(row).toBeTruthy()
    expect(row.items_count).toBe(2)
    expect(parseFloat(row.bundle_price)).toBe(85)
  })

  test('rechaza paquete con componente SIN precio de lista (422)', async () => {
    const res = await client.post('/api/products/bundles', {
      name: 'Combo roto',
      bundlePrice: 50,
      items: [
        { productId: prodA.id, quantity: 1 },
        { productId: prodSinPrecio.id, quantity: 1 },
      ],
    })
    expect(res.status).toBe(422)
    expect(res.body.error).toMatch(/precio de lista/i)
  })

  test('explode: prorrateo proporcional a lista = mismo % de descuento por línea', async () => {
    // Lista: A=60, B=40 → suma 100. Paquete $85 → 15% de descuento parejo:
    // A → 51, B → 34.
    const res = await client.get(`/api/products/bundles/${bundleId}/explode`)
    expect(res.status).toBe(200)
    expect(res.body.listTotal).toBeCloseTo(100, 4)
    expect(res.body.impliedDiscountPct).toBeCloseTo(15, 2)

    const byProduct = Object.fromEntries(res.body.lines.map(l => [l.productId, l]))
    expect(byProduct[prodA.id].unitPrice).toBeCloseTo(51, 4)
    expect(byProduct[prodB.id].unitPrice).toBeCloseTo(34, 4)

    // La suma de subtotales SIEMPRE cuadra con el precio del paquete
    const sum = res.body.lines.reduce((s, l) => s + l.subtotal, 0)
    expect(sum).toBeCloseTo(85, 3)
  })

  test('explode: residuo de redondeo se ajusta en la última línea (suma exacta)', async () => {
    // Lista: A×3 ($60 c/u = $180) + B×1 ($40) = $220. Paquete $100 → los
    // cocientes no son exactos a 4 decimales; la última línea absorbe el residuo.
    const cr = await client.post('/api/products/bundles', {
      name: 'Combo residuo',
      bundlePrice: 100,
      items: [
        { productId: prodA.id, quantity: 3 },
        { productId: prodB.id, quantity: 1 },
      ],
    })
    expect(cr.status).toBe(201)

    const res = await client.get(`/api/products/bundles/${cr.body.id}/explode`)
    expect(res.status).toBe(200)
    const sum = res.body.lines.reduce((s, l) => s + l.quantity * l.unitPrice, 0)
    expect(sum).toBeCloseTo(100, 3)
  })

  test('explode respeta presentaciones: el peso usa lista × factor', async () => {
    // A con presentación "rollo" ×5 → lista por rollo = $300; B suelto $40.
    // Paquete: 1 rollo A + 1 B = lista $340, precio $170 → 50% parejo:
    // rollo A → $150, B → $20.
    const pk = await client.post(`/api/products/${prodA.id}/pack-options`, {
      packUnit: 'rollo', basePerPack: 5, satUnitCode: 'XRO',
    })
    expect(pk.status).toBe(201)

    const cr = await client.post('/api/products/bundles', {
      name: 'Combo rollo',
      bundlePrice: 170,
      items: [
        { productId: prodA.id, packOptionId: pk.body.id, quantity: 1 },
        { productId: prodB.id, quantity: 1 },
      ],
    })
    expect(cr.status).toBe(201)

    const res = await client.get(`/api/products/bundles/${cr.body.id}/explode`)
    expect(res.status).toBe(200)
    const byProduct = Object.fromEntries(res.body.lines.map(l => [l.productId, l]))
    expect(res.body.listTotal).toBeCloseTo(340, 4)
    expect(byProduct[prodA.id].unitPrice).toBeCloseTo(150, 4)
    expect(byProduct[prodA.id].packFactor).toBe(5)
    expect(byProduct[prodB.id].unitPrice).toBeCloseTo(20, 4)
  })

  describe('paquete dentro del pedido', () => {
    let orderId, groupId

    beforeAll(async () => {
      // Simula lo que manda el frontend tras explode: líneas con marcador de grupo
      groupId = '11111111-2222-3333-4444-555555555555'
      const res = await client.post('/api/sales/orders', {
        partnerId, currency: 'MXN', force: true,
        lines: [
          { productId: prodA.id, quantity: 2, unit: 'pieza', unitPrice: 51,
            bundleId, bundleGroupId: groupId, bundleName: 'Combo AB', bundleQuantity: 2 },
          { productId: prodB.id, quantity: 2, unit: 'pieza', unitPrice: 34,
            bundleId, bundleGroupId: groupId, bundleName: 'Combo AB', bundleQuantity: 2 },
          { productId: prodB.id, quantity: 1, unit: 'pieza', unitPrice: 40 }, // línea suelta
        ],
      })
      expect(res.status).toBe(201)
      orderId = res.body.id
    })

    test('las líneas del pedido conservan el grupo y el snapshot del nombre', async () => {
      const det = await client.get(`/api/sales/orders/${orderId}`)
      expect(det.status).toBe(200)
      const bundleLines = det.body.lines.filter(l => l.bundle_group_id === groupId)
      expect(bundleLines.length).toBe(2)
      expect(bundleLines[0].bundle_name).toBe('Combo AB')
      expect(parseFloat(bundleLines[0].bundle_quantity)).toBe(2)
      // 2 paquetes × $85 + línea suelta $40 = $210
      expect(parseFloat(det.body.subtotal_mxn)).toBeCloseTo(210, 2)
    })

    test('editar una línea de paquete → 409 (el paquete es atómico)', async () => {
      const det = await client.get(`/api/sales/orders/${orderId}`)
      const line = det.body.lines.find(l => l.bundle_group_id === groupId)
      const res = await client.patch(`/api/sales/orders/${orderId}/lines/${line.id}`, { quantity: 99 })
      expect(res.status).toBe(409)
      expect(res.body.error).toMatch(/paquete/i)
    })

    test('borrar una línea de paquete individual → 409', async () => {
      const det = await client.get(`/api/sales/orders/${orderId}`)
      const line = det.body.lines.find(l => l.bundle_group_id === groupId)
      const res = await client.delete(`/api/sales/orders/${orderId}/lines/${line.id}`)
      expect(res.status).toBe(409)
    })

    test('quitar el grupo completo elimina sus líneas y recalcula el total', async () => {
      const res = await client.delete(`/api/sales/orders/${orderId}/bundle-groups/${groupId}`)
      expect(res.status).toBe(200)
      expect(res.body.removed).toBe(2)

      const det = await client.get(`/api/sales/orders/${orderId}`)
      expect(det.body.lines.length).toBe(1) // solo la línea suelta
      expect(parseFloat(det.body.subtotal_mxn)).toBeCloseTo(40, 2)
    })

    test('POST /orders/:id/bundles explota el paquete server-side en el draft', async () => {
      const res = await client.post(`/api/sales/orders/${orderId}/bundles`, {
        bundleId, bundleQuantity: 3,
      })
      expect(res.status).toBe(201)
      expect(res.body.lines.length).toBe(2)

      const det = await client.get(`/api/sales/orders/${orderId}`)
      const bundleLines = det.body.lines.filter(l => l.bundle_id === bundleId)
      expect(bundleLines.length).toBe(2)
      // 3 paquetes × $85 + línea suelta $40 = $295
      expect(parseFloat(det.body.subtotal_mxn)).toBeCloseTo(295, 2)
      // cantidades escaladas: A 1×3=3, B 1×3=3
      for (const l of bundleLines) expect(parseFloat(l.quantity)).toBe(3)
    })
  })

  test('paquete USD en pedido MXN → 400 con mensaje claro', async () => {
    const usd = await client.post('/api/products/bundles', {
      name: 'Combo USD', bundlePrice: 10, currency: 'USD',
      items: [{ productId: prodA.id, quantity: 1 }],
    })
    expect(usd.status).toBe(201)

    const res = await client.post('/api/sales/orders', {
      partnerId, currency: 'MXN', force: true,
      lines: [{ productId: prodA.id, quantity: 1, unitPrice: 10,
        bundleId: usd.body.id, bundleGroupId: '99999999-9999-9999-9999-999999999999',
        bundleName: 'Combo USD', bundleQuantity: 1 }],
    })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/moneda|USD/i)
  })

  test('eliminar paquete del catálogo NO toca pedidos: queda el snapshot del nombre', async () => {
    // Pedido nuevo con el paquete vía endpoint server-side
    const o = await client.post('/api/sales/orders', {
      partnerId, currency: 'MXN', force: true,
      lines: [{ productId: prodB.id, quantity: 1, unitPrice: 40 }],
    })
    expect(o.status).toBe(201)
    const add = await client.post(`/api/sales/orders/${o.body.id}/bundles`, { bundleId, bundleQuantity: 1 })
    expect(add.status).toBe(201)

    const del = await client.delete(`/api/products/bundles/${bundleId}`)
    expect(del.status).toBe(200)

    const det = await client.get(`/api/sales/orders/${o.body.id}`)
    const bundleLines = det.body.lines.filter(l => l.bundle_group_id)
    expect(bundleLines.length).toBe(2)
    expect(bundleLines[0].bundle_name).toBe('Combo AB')  // snapshot sobrevive
    expect(bundleLines[0].bundle_id).toBeNull()          // FK SET NULL
  })
})
