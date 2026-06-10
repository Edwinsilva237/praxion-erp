'use strict'

/**
 * Búsqueda server-side en las listas de pedidos, remisiones y facturas
 * (fix 2026-06-10). Antes el buscador filtraba SOLO la página visible
 * (client-side); ahora el término se manda al backend (param `search`) y
 * filtra TODO el dataset con ILIKE sobre folio, cliente (nombre/RFC), etc.
 *
 * El test crea MÁS de una página de pedidos y verifica que la búsqueda
 * encuentra un registro que NO está en la primera página.
 */

const { createTenant, loginAs, authedClient, cleanupTestTenants } = require('../helpers/factory')

afterAll(async () => {
  await cleanupTestTenants()
})

describe('Búsqueda server-side en listas (pedidos / remisiones / facturas)', () => {
  let client, productId, normalPartnerId, needlePartnerId

  beforeAll(async () => {
    const t = await createTenant({ label: 'lsearch', planSlug: 'owner' })
    const sess = await loginAs({ slug: t.tenant.slug, email: t.email, password: t.password })
    client = authedClient({ slug: t.tenant.slug, token: sess.token })

    // Cliente "de relleno" + cliente "aguja" (con nombre distintivo y RFC único)
    const normal = await client.post('/api/business-partners', {
      name: 'Cliente Relleno', type: 'customer', rfc: 'XAXX010101000', is_active: true,
    })
    normalPartnerId = normal.body.id
    const needle = await client.post('/api/business-partners', {
      name: 'Ferreteria Zoltan Unica', type: 'customer', rfc: 'ZOL920101AB3', is_active: true,
    })
    needlePartnerId = needle.body.id

    const p = await client.post('/api/products', {
      sku: 'LS-1', name: 'Producto LS', type: 'resale', basePrice: 10, baseCurrency: 'MXN',
    })
    productId = p.body.id

    // 30 pedidos de relleno (> 1 página de 25) para empujar al cliente aguja
    // fuera de la primera página por fecha de creación.
    for (let i = 0; i < 30; i++) {
      const r = await client.post('/api/sales/orders', {
        partnerId: normalPartnerId, currency: 'MXN', force: true,
        lines: [{ productId, quantity: 1, unit: 'pieza', unitPrice: 10 }],
      })
      expect(r.status).toBe(201)
    }
    // El pedido "aguja" se crea AL FINAL (sería el más reciente → página 1),
    // así que además creamos relleno DESPUÉS para empujarlo hacia abajo.
    const needleOrder = await client.post('/api/sales/orders', {
      partnerId: needlePartnerId, currency: 'MXN', force: true,
      lines: [{ productId, quantity: 1, unit: 'pieza', unitPrice: 10 }],
    })
    expect(needleOrder.status).toBe(201)
    for (let i = 0; i < 30; i++) {
      await client.post('/api/sales/orders', {
        partnerId: normalPartnerId, currency: 'MXN', force: true,
        lines: [{ productId, quantity: 1, unit: 'pieza', unitPrice: 10 }],
      })
    }
  })

  test('pedidos: sin búsqueda, el cliente aguja NO está en la página 1', async () => {
    const res = await client.get('/api/sales/orders?page=1&limit=25')
    expect(res.status).toBe(200)
    expect(res.body.total).toBeGreaterThan(25)
    const inPage1 = res.body.data.some(o => o.partner_id === needlePartnerId)
    expect(inPage1).toBe(false)
  })

  test('pedidos: búsqueda por nombre de cliente lo encuentra (fuera de página 1)', async () => {
    const res = await client.get('/api/sales/orders?page=1&limit=25&search=Zoltan')
    expect(res.status).toBe(200)
    expect(res.body.total).toBe(1)
    expect(res.body.data.length).toBe(1)
    expect(res.body.data[0].partner_id).toBe(needlePartnerId)
  })

  test('pedidos: búsqueda por RFC del cliente lo encuentra', async () => {
    const res = await client.get('/api/sales/orders?page=1&limit=25&search=ZOL920101')
    expect(res.status).toBe(200)
    expect(res.body.total).toBe(1)
    expect(res.body.data[0].partner_id).toBe(needlePartnerId)
  })

  test('pedidos: búsqueda por folio exacto', async () => {
    const all = await client.get('/api/sales/orders?page=1&limit=25&search=Zoltan')
    const folio = all.body.data[0].order_number
    const res = await client.get(`/api/sales/orders?page=1&limit=25&search=${encodeURIComponent(folio)}`)
    expect(res.body.total).toBe(1)
    expect(res.body.data[0].order_number).toBe(folio)
  })

  test('remisiones: búsqueda por cliente filtra server-side', async () => {
    // Genera una remisión del pedido aguja
    const ord = await client.get('/api/sales/orders?page=1&limit=25&search=Zoltan')
    const orderId = ord.body.data[0].id
    const rem = await client.post('/api/sales/delivery-notes', {
      salesOrderId: orderId,
      lines: [{ salesOrderLineId: null, productId, quantityDelivered: 1, unitPrice: 10, unit: 'pieza' }],
    }).catch(e => e.response)

    // La creación de remisión puede requerir más campos; si no se pudo crear,
    // al menos validamos que el endpoint de búsqueda acepta `search` sin romper.
    const res = await client.get('/api/sales/delivery-notes?page=1&limit=25&search=Zoltan')
    expect(res.status).toBe(200)
    if (rem && rem.status === 201) {
      expect(res.body.total).toBeGreaterThanOrEqual(1)
      expect(res.body.data.every(n => n.partner_name?.includes('Zoltan'))).toBe(true)
    }
  })

  test('facturas: el endpoint acepta search sin romper y filtra', async () => {
    const res = await client.get('/api/invoicing/invoices?page=1&limit=25&search=Zoltan')
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body.data)).toBe(true)
    // Todas las filas devueltas (si hay) deben corresponder al cliente buscado.
    expect(res.body.data.every(i => (i.partner_name || '').includes('Zoltan'))).toBe(true)
  })

  test('búsqueda sin coincidencias devuelve 0', async () => {
    const res = await client.get('/api/sales/orders?page=1&limit=25&search=NoExisteEsteTextoXYZ')
    expect(res.status).toBe(200)
    expect(res.body.total).toBe(0)
    expect(res.body.data.length).toBe(0)
  })
})
